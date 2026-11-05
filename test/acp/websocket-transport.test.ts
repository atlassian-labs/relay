import { afterEach, describe, expect, test } from "bun:test";
import { AcpClient, type AcpClientCallbacks } from "../../src/acp/client";
import { ApprovalResponse } from "../../src/core/events";

type Framing = "json" | "ndjson";
type RecordedRequest = {
  readonly method: string;
  readonly params?: unknown;
};

type WebSocketHarness = {
  readonly url: string;
  readonly requests: RecordedRequest[];
  readonly headers: Array<Record<string, string>>;
  closeActiveSocket: (code?: number, reason?: string) => void;
  sendRaw: (raw: string) => void;
};

const servers: Array<ReturnType<typeof Bun.serve>> = [];

function callbacks(overrides: Partial<AcpClientCallbacks> = {}): AcpClientCallbacks {
  return {
    onSessionUpdate: () => undefined,
    onPermissionRequest: (request) => request.respond(ApprovalResponse.DENY),
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageText(message: string | Buffer<ArrayBuffer>): string {
  return typeof message === "string" ? message : message.toString("utf-8");
}

function parseMessages(raw: string, framing: Framing): unknown[] {
  if (framing === "ndjson") {
    return raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  }
  return [JSON.parse(raw) as unknown];
}

function formatMessage(message: unknown, framing: Framing): string {
  const json = JSON.stringify(message);
  return framing === "ndjson" ? `${json}\n` : json;
}

type HarnessSocket = { send: (data: string) => void; close: (code?: number, reason?: string) => void };

function startAcpWebSocketServer(framing: Framing): WebSocketHarness {
  const requests: RecordedRequest[] = [];
  const headers: Array<Record<string, string>> = [];
  let activeSocket: HarnessSocket | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const captured: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        captured[key.toLowerCase()] = value;
      });
      headers.push(captured);
      if (server.upgrade(request)) return undefined;
      return new Response("Expected websocket upgrade", { status: 400 });
    },
    websocket: {
      open(websocket) {
        activeSocket = websocket;
      },
      message(websocket, message) {
        activeSocket = websocket;
        for (const parsed of parseMessages(messageText(message), framing)) {
          if (!isRecord(parsed)) continue;
          const method = typeof parsed.method === "string" ? parsed.method : "";
          requests.push({ method, params: parsed.params });
          if (method === "initialize") {
            websocket.send(
              formatMessage(
                {
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
                },
                framing,
              ),
            );
          } else if (method === "session/new") {
            websocket.send(
              formatMessage(
                {
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: { sessionId: "websocket-session" },
                },
                framing,
              ),
            );
          }
        }
      },
    },
  });
  servers.push(server);
  return {
    url: server.url.toString().replace(/^http/u, "ws"),
    requests,
    headers,
    closeActiveSocket: (code = 1011, reason = "agent crashed") => activeSocket?.close(code, reason),
    sendRaw: (raw: string) => activeSocket?.send(raw),
  };
}

afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop(true);
});

describe("WebSocket ACP transport", () => {
  test("connects AcpClient over one JSON-RPC object per websocket message", async () => {
    const harness = startAcpWebSocketServer("json");
    const client = new AcpClient(callbacks(), {
      cwd: process.cwd(),
      transport: "websocket",
      url: harness.url,
    });

    try {
      await client.connect();
      const result = await client.newSession(process.cwd());

      expect(result.sessionId).toBe("websocket-session");
      expect(harness.requests.map((request) => request.method)).toEqual(["initialize", "session/new"]);
    } finally {
      await client.disposeAsync();
    }
  });

  test("connects AcpClient over NDJSON websocket frames", async () => {
    const harness = startAcpWebSocketServer("ndjson");
    const client = new AcpClient(callbacks(), {
      cwd: process.cwd(),
      transport: "websocket",
      url: harness.url,
      framing: "ndjson",
    });

    try {
      await client.connect();
      const result = await client.newSession(process.cwd());

      expect(result.sessionId).toBe("websocket-session");
      expect(harness.requests.map((request) => request.method)).toEqual(["initialize", "session/new"]);
    } finally {
      await client.disposeAsync();
    }
  });

  test("forwards configured headers on the upgrade request", async () => {
    const harness = startAcpWebSocketServer("json");
    const client = new AcpClient(callbacks(), {
      cwd: process.cwd(),
      transport: "websocket",
      url: harness.url,
      headers: { Authorization: "Bearer test-token", "X-Relay-Test": "yes" },
    });

    try {
      await client.connect();
      await client.newSession(process.cwd());

      expect(harness.headers.length).toBeGreaterThan(0);
      const captured = harness.headers[0];
      expect(captured.authorization).toBe("Bearer test-token");
      expect(captured["x-relay-test"]).toBe("yes");
    } finally {
      await client.disposeAsync();
    }
  });

  test("tolerates non-JSON websocket lines instead of tearing down the session", async () => {
    const harness = startAcpWebSocketServer("ndjson");
    const client = new AcpClient(callbacks(), {
      cwd: process.cwd(),
      transport: "websocket",
      url: harness.url,
      framing: "ndjson",
    });

    try {
      await client.connect();
      // Inject noise (keepalive/log line) that is not valid JSON; it must be skipped.
      harness.sendRaw("ping\n");
      harness.sendRaw(":keepalive\n");
      const result = await client.newSession(process.cwd());

      expect(result.sessionId).toBe("websocket-session");
    } finally {
      await client.disposeAsync();
    }
  });

  test("reports onProcessExit when the websocket closes unexpectedly", async () => {
    const harness = startAcpWebSocketServer("json");
    const exits: Array<{ code?: number; signal?: string }> = [];
    const client = new AcpClient(callbacks({ onProcessExit: (event) => exits.push(event) }), {
      cwd: process.cwd(),
      transport: "websocket",
      url: harness.url,
    });

    try {
      await client.connect();
      await client.newSession(process.cwd());

      harness.closeActiveSocket(1011, "agent crashed");
      await Promise.race([
        (async () => {
          while (exits.length === 0) await Bun.sleep(10);
        })(),
        Bun.sleep(2_000),
      ]);

      expect(exits).toEqual([
        expect.objectContaining({
          code: 1011,
          connected: true,
          expected: false,
          reason: "websocket-close",
        }),
      ]);
    } finally {
      await client.disposeAsync();
    }
  });

  test("does not report onProcessExit on intentional dispose", async () => {
    const harness = startAcpWebSocketServer("json");
    const exits: Array<{ code?: number; signal?: string }> = [];
    const client = new AcpClient(callbacks({ onProcessExit: (event) => exits.push(event) }), {
      cwd: process.cwd(),
      transport: "websocket",
      url: harness.url,
    });

    await client.connect();
    await client.newSession(process.cwd());
    await client.disposeAsync();
    await Bun.sleep(50);

    expect(exits.length).toBe(0);
  });

  test("surfaces a clean error when the websocket connection is refused", async () => {
    // Bind then immediately release a port so the connection is refused quickly.
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    const refusedUrl = probe.url.toString().replace(/^http/u, "ws");
    probe.stop(true);

    const client = new AcpClient(callbacks(), {
      cwd: process.cwd(),
      transport: "websocket",
      url: refusedUrl,
    });

    try {
      let failed = false;
      await client.connect().catch(() => {
        failed = true;
      });
      expect(failed).toBe(true);
    } finally {
      await client.disposeAsync();
    }
  });

  test("rejects a websocket runner with no url", async () => {
    const client = new AcpClient(callbacks(), {
      cwd: process.cwd(),
      transport: "websocket",
      url: "",
    });

    try {
      let failed = false;
      await client.connect().catch(() => {
        failed = true;
      });
      expect(failed).toBe(true);
    } finally {
      await client.disposeAsync();
    }
  });
});
