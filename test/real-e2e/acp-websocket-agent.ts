#!/usr/bin/env bun

/**
 * Fake ACP agent that speaks the Agent Client Protocol over a WebSocket
 * transport instead of stdio. It exists so the real-e2e suite can drive the
 * websocket transport end to end (real built binary -> real AcpClient ->
 * real WebSocketAcpTransport -> real ws wire).
 *
 * The agent binds an ephemeral port, writes the resolved ws:// URL to the file
 * named by RELAY_WS_AGENT_URL_FILE so the harness can template it into the
 * Relay config, and then scripts deterministic responses for the smoke.
 *
 * Supported env:
 *   RELAY_WS_AGENT_URL_FILE   path to write the resolved ws:// URL to (required)
 *   RELAY_WS_AGENT_FRAMING    "json" (default) or "ndjson"
 *   RELAY_REAL_E2E_PROMPT_LOG ndjson event log used by the harness for assertions
 *   RELAY_REAL_E2E_PROMPT_DELAY_MS  delay (ms) applied to "slow ..." prompts to allow cancel
 */

import * as fs from "node:fs";

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type Framing = "json" | "ndjson";

const framing: Framing = process.env.RELAY_WS_AGENT_FRAMING === "ndjson" ? "ndjson" : "json";
const urlFile = process.env.RELAY_WS_AGENT_URL_FILE ?? "";
const promptLog = process.env.RELAY_REAL_E2E_PROMPT_LOG ?? "";
const permissionOptions = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
] as const;

const defaultSessionId = "ws-e2e-session";
let currentSessionId = defaultSessionId;
let sessionCounter = 0;
let cancelGeneration = 0;
let nextClientRequestId = 1;
const pendingClientResponses = new Map<number | string, (message: JsonRpcMessage) => void>();

let socket: { send: (data: string) => void } | null = null;

function logEvent(event: Record<string, unknown>): void {
  if (!promptLog) return;
  fs.appendFileSync(promptLog, `${JSON.stringify(event)}\n`, "utf8");
}

function send(message: unknown): void {
  if (!socket) return;
  const json = JSON.stringify(message);
  socket.send(framing === "ndjson" ? `${json}\n` : json);
}

function result(id: number | string | undefined, value: unknown): void {
  if (id === undefined) return;
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id: number | string | undefined, message: string): void {
  if (id === undefined) return;
  send({ jsonrpc: "2.0", id, error: { code: -32601, message } });
}

function sessionUpdate(update: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: currentSessionId, update } });
}

function requestClient(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
  const id = `ws-e2e-client-request-${nextClientRequestId++}`;
  return new Promise((resolve) => {
    pendingClientResponses.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function promptText(params: unknown): string {
  const prompt = (params as { prompt?: Array<{ type?: string; text?: string }> } | null)?.prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function envDelayMs(name: string): number {
  const delay = Number.parseInt(process.env[name] ?? "0", 10);
  return Number.isFinite(delay) && delay > 0 ? delay : 0;
}

async function sleep(ms: number, generation: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (generation !== cancelGeneration) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
  }
}

function parseFrame(raw: string): JsonRpcMessage[] {
  const lines =
    framing === "ndjson"
      ? raw
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean)
      : [raw.trim()].filter(Boolean);
  const messages: JsonRpcMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as JsonRpcMessage);
    } catch {
      // Tolerate non-JSON noise the same way the real transport does.
    }
  }
  return messages;
}

async function handle(message: JsonRpcMessage): Promise<void> {
  if (!message.method) {
    if (message.id !== undefined) {
      const resolve = pendingClientResponses.get(message.id);
      if (resolve) {
        pendingClientResponses.delete(message.id);
        resolve(message);
      }
    }
    return;
  }

  switch (message.method) {
    case "initialize":
      result(message.id, {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } },
        authMethods: [],
      });
      return;
    case "session/new": {
      currentSessionId = sessionCounter === 0 ? defaultSessionId : `${defaultSessionId}-${sessionCounter + 1}`;
      sessionCounter++;
      result(message.id, { sessionId: currentSessionId, availableCommands: [] });
      return;
    }
    case "session/load":
      currentSessionId = String((message.params as { sessionId?: unknown } | null)?.sessionId ?? defaultSessionId);
      result(message.id, { sessionId: currentSessionId });
      return;
    case "session/resume":
      currentSessionId = String((message.params as { sessionId?: unknown } | null)?.sessionId ?? defaultSessionId);
      result(message.id, { sessionId: currentSessionId });
      return;
    case "session/list":
      result(message.id, { sessions: [{ sessionId: defaultSessionId, title: "ws e2e session" }] });
      return;
    case "session/prompt": {
      const text = promptText(message.params);
      logEvent({ event: "prompt", text });
      const generation = cancelGeneration;

      const delay = text.includes("slow") ? envDelayMs("RELAY_REAL_E2E_PROMPT_DELAY_MS") : 0;
      if (delay > 0) {
        await sleep(delay, generation);
        if (generation !== cancelGeneration) {
          result(message.id, { stopReason: "cancelled", usage: { inputTokens: 1, outputTokens: 0 } });
          return;
        }
      }

      if (text.includes("websocket diff e2e")) {
        sessionUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "ws_diff",
          title: "ws_diff_tool",
          kind: "edit",
          status: "pending",
        });
        sessionUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "ws_diff",
          status: "completed",
          content: [
            {
              type: "diff",
              path: `${process.cwd()}/ws-diff.txt`,
              oldText: "alpha\nbeta\n",
              newText: "alpha\nBETA\ngamma\n",
            },
          ],
        });
        sessionUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "websocket diff e2e complete" },
        });
        result(message.id, { usage: { inputTokens: 1, outputTokens: 1 } });
        return;
      }

      if (text.includes("websocket permission e2e")) {
        sessionUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "websocket permission started" },
        });
        const approval = await requestClient("session/request_permission", {
          sessionId: currentSessionId,
          toolCall: {
            toolCallId: "ws-permission",
            title: "Write",
            kind: "edit",
            rawInput: { path: "README.md", action: "websocket permission" },
          },
          options: permissionOptions,
        });
        logEvent({ event: "ws-permission-approval", approval });
        sessionUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "websocket permission complete" },
        });
        result(message.id, { usage: { inputTokens: 1, outputTokens: 1 } });
        return;
      }

      sessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `ack: ${text.replaceAll("\n", " ↵ ")}` },
      });
      result(message.id, { usage: { inputTokens: 1, outputTokens: 1 } });
      return;
    }
    case "session/cancel":
      cancelGeneration++;
      result(message.id, {});
      return;
    case "session/set_mode":
    case "session/setMode":
    case "session/set_config_option":
      result(message.id, {});
      return;
    default:
      error(message.id, `Unsupported method: ${message.method}`);
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    if (server.upgrade(request)) return undefined;
    return new Response("Expected websocket upgrade", { status: 400 });
  },
  websocket: {
    open(ws) {
      socket = ws;
    },
    message(ws, raw) {
      socket = ws;
      const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");
      for (const message of parseFrame(text)) {
        void handle(message).catch((err) => process.stderr.write(`ws agent handler error: ${err}\n`));
      }
    },
    close() {
      socket = null;
    },
  },
});

const wsUrl = `ws://127.0.0.1:${server.port}/acp`;
if (urlFile) fs.writeFileSync(urlFile, wsUrl, "utf8");
process.stderr.write(`ws acp agent listening at ${wsUrl} (framing=${framing})\n`);
