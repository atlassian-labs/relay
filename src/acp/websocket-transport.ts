import { Effect } from "effect";
import { AcpConnectionClosedError, AcpProtocolError, RelayError, errorMessage } from "../effect/errors";
import { getRelayLogger } from "../logging/logger";
import { isAcpJsonRpcMessage, parseJsonLine, relayAcpStream, type AnyMessage, type RelayAcpStream } from "./sdk";
import type {
  AcpLaunchOptions,
  AcpTransport,
  AcpTransportCallbacks,
  AcpTransportConnection,
  AcpTransportError,
  AcpWebSocketFraming,
} from "./transport";

type BunWebSocketConstructor = {
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
  new (url: string | URL, options?: Bun.WebSocketOptions): WebSocket;
  new (url: string | URL, protocols?: string | string[]): WebSocket;
};

const BunWebSocket = WebSocket as unknown as BunWebSocketConstructor;

function isOpen(websocket: WebSocket): boolean {
  return websocket.readyState === BunWebSocket.OPEN;
}

function isConnectingOrOpen(websocket: WebSocket): boolean {
  return websocket.readyState === BunWebSocket.CONNECTING || websocket.readyState === BunWebSocket.OPEN;
}

function websocketCloseMessage(event: CloseEvent): string {
  const reason = event.reason ? `: ${event.reason}` : "";
  return `ACP websocket closed (${event.code}${reason})`;
}

async function textFromWebSocketData(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data instanceof Blob) return data.text();
  return String(data);
}

function parseMessage(raw: string, framing: AcpWebSocketFraming): readonly unknown[] {
  const lines =
    framing === "ndjson"
      ? raw
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean)
      : [raw.trim()].filter(Boolean);
  // Tolerate non-JSON lines (e.g. keepalives/log noise) the same way the stdio
  // transport does, skipping unparseable lines instead of tearing down the session.
  const messages: unknown[] = [];
  for (const line of lines) {
    const message = parseJsonLine(line);
    if (message !== undefined) messages.push(message);
  }
  return messages;
}

function createWebSocketStream(
  websocket: WebSocket,
  framing: AcpWebSocketFraming,
  onUnexpectedClose: (event?: CloseEvent) => void,
): RelayAcpStream {
  let readableController: ReadableStreamDefaultController<AnyMessage> | null = null;
  let closed = false;
  let expectedClose = false;
  let cleanupReadableListeners: (() => void) | null = null;
  let messageQueue: Promise<void> = Promise.resolve();

  const closeWithError = (error: unknown): void => {
    if (closed) return;
    closed = true;
    try {
      readableController?.error(error);
    } catch {
      // The readable may already be closed or errored.
    }
  };

  const closeSocket = (code = 1000, reason = "Relay closing ACP websocket"): void => {
    expectedClose = true;
    if (websocket.readyState === BunWebSocket.CLOSED || websocket.readyState === BunWebSocket.CLOSING) return;
    try {
      websocket.close(code, reason);
    } catch {
      // Ignore close failures during cleanup.
    }
  };

  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      readableController = controller;
      const onMessage = (event: MessageEvent) => {
        const data = event.data as unknown;
        // effect-shape-allow: websocket message conversion is a transport Promise bridge.
        messageQueue = messageQueue
          .then(async () => {
            const raw = await textFromWebSocketData(data);
            for (const message of parseMessage(raw, framing)) {
              if (!isAcpJsonRpcMessage(message)) {
                closeWithError(new AcpProtocolError({ message: "Invalid ACP JSON-RPC envelope", data: message }));
                return;
              }
              if (!closed) controller.enqueue(message);
            }
          })
          .catch((cause) => closeWithError(new AcpProtocolError({ message: errorMessage(cause), cause })));
      };
      const onError = () => {
        closeWithError(new RelayError({ message: "ACP websocket error" }));
      };
      const onClose = (event: CloseEvent) => {
        cleanupReadableListeners?.();
        if (closed) return;
        closed = true;
        if (expectedClose) {
          controller.close();
          return;
        }
        controller.error(new AcpConnectionClosedError({ message: websocketCloseMessage(event) }));
        onUnexpectedClose(event);
      };
      websocket.addEventListener("message", onMessage);
      websocket.addEventListener("error", onError);
      websocket.addEventListener("close", onClose);
      cleanupReadableListeners = () => {
        websocket.removeEventListener("message", onMessage);
        websocket.removeEventListener("error", onError);
        websocket.removeEventListener("close", onClose);
      };
    },
    cancel(reason) {
      closed = true;
      cleanupReadableListeners?.();
      cleanupReadableListeners = null;
      closeSocket(1000, reason instanceof Error ? reason.message : "Relay cancelled ACP websocket");
    },
  });

  const writable = new WritableStream<AnyMessage>({
    write(message) {
      if (closed || !isOpen(websocket)) {
        return Promise.reject(new AcpConnectionClosedError({ message: "ACP websocket is not open" }));
      }
      websocket.send(framing === "ndjson" ? `${JSON.stringify(message)}\n` : JSON.stringify(message));
      return Promise.resolve();
    },
    close() {
      closed = true;
      cleanupReadableListeners?.();
      cleanupReadableListeners = null;
      closeSocket();
    },
    abort(reason) {
      closed = true;
      cleanupReadableListeners?.();
      cleanupReadableListeners = null;
      closeSocket(1000, reason instanceof Error ? reason.message : "Relay aborted ACP websocket");
    },
  });

  return relayAcpStream({
    readable,
    writable,
    close: async () => {
      if (closed) return;
      closed = true;
      cleanupReadableListeners?.();
      cleanupReadableListeners = null;
      closeSocket();
      await messageQueue.catch(() => undefined);
    },
  });
}

export class WebSocketAcpTransport implements AcpTransport {
  readonly kind = "websocket" as const;
  private websocket: WebSocket | null = null;
  private exitNotified = false;

  constructor(
    private readonly opts: AcpLaunchOptions,
    private readonly callbacks: AcpTransportCallbacks = {},
  ) {}

  private notifyExit(event?: CloseEvent): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    getRelayLogger().info("acp.websocket.closed", {
      code: event?.code ?? null,
      reason: event?.reason || null,
    });
    this.callbacks.onProcessExit?.({
      code: event?.code,
      expected: false,
      reason: "websocket-close",
      transport: "websocket",
      message: event ? websocketCloseMessage(event) : "ACP websocket closed",
    });
  }

  connect = Effect.fn("WebSocketAcpTransport.connect")(() =>
    Effect.gen({ self: this }, function* () {
      const url = String(this.opts.url ?? "").trim();
      if (!url) return yield* Effect.fail(new RelayError({ message: "ACP websocket URL is required" }));
      const framing = this.opts.framing ?? "json";
      const protocols = this.opts.protocols?.length ? [...this.opts.protocols] : undefined;
      const headers = this.opts.headers ? { ...this.opts.headers } : undefined;

      getRelayLogger().info("acp.websocket.connect.start", {
        url: safeWebSocketUrl(url),
        protocolCount: protocols?.length ?? 0,
        framing,
      });

      const websocket = yield* Effect.try({
        try: () =>
          new BunWebSocket(url, {
            ...(protocols ? { protocols } : {}),
            ...(headers ? { headers } : {}),
          }),
        catch: (cause) => new RelayError({ message: `Failed to create ACP websocket: ${errorMessage(cause)}`, cause }),
      });
      websocket.binaryType = "arraybuffer";
      this.websocket = websocket;

      yield* Effect.callback<void, RelayError>((resume) => {
        if (isOpen(websocket)) {
          resume(Effect.void);
          return Effect.void;
        }
        let settled = false;
        const cleanup = () => {
          websocket.removeEventListener("open", onOpen);
          websocket.removeEventListener("error", onError);
          websocket.removeEventListener("close", onClose);
        };
        const complete = (effect: Effect.Effect<void, RelayError>) => {
          if (settled) return;
          settled = true;
          cleanup();
          resume(effect);
        };
        const onOpen = () => complete(Effect.void);
        const onError = () => complete(Effect.fail(new RelayError({ message: "ACP websocket error during connect" })));
        const onClose = (event: CloseEvent) =>
          complete(Effect.fail(new RelayError({ message: websocketCloseMessage(event) })));
        websocket.addEventListener("open", onOpen);
        websocket.addEventListener("error", onError);
        websocket.addEventListener("close", onClose);
        return Effect.sync(cleanup);
      });

      getRelayLogger().info("acp.websocket.connect.ready", { url: safeWebSocketUrl(url) });
      const stream = createWebSocketStream(websocket, framing, (event) => this.notifyExit(event));
      return {
        stream,
        diagnosticLogPath: null,
        waitForStartupOutput: () => Effect.void,
        startupOutput: () => "",
      } satisfies AcpTransportConnection;
    }),
  ) satisfies () => Effect.Effect<AcpTransportConnection, AcpTransportError>;

  dispose = Effect.fn("WebSocketAcpTransport.dispose")(() =>
    Effect.sync(() => {
      // Relay-initiated teardown; suppress the disconnect notification.
      this.exitNotified = true;
      const websocket = this.websocket;
      this.websocket = null;
      if (!websocket || !isConnectingOrOpen(websocket)) return;
      try {
        websocket.close(1000, "Relay disposing ACP websocket");
      } catch {
        // Ignore close failures during cleanup.
      }
    }).pipe(Effect.catch(() => Effect.void)),
  );
}

function safeWebSocketUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = url.search ? "?<redacted>" : "";
    return url.toString();
  } catch {
    return raw;
  }
}
