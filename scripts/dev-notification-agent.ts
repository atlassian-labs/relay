#!/usr/bin/env bun

import * as readline from "node:readline";

type JsonRpcId = number | string;

type JsonRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const defaultSessionId = "notification-dev-session";
const pendingRequests = new Map<string, PendingRequest>();

let currentSessionId = defaultSessionId;
let nextRequestId = 1000;
let permissionCounter = 0;
let elicitationCounter = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function result(id: JsonRpcId | undefined, value: unknown): void {
  if (id === undefined) return;
  write({ id, result: value });
}

function error(id: JsonRpcId | undefined, code: number, message: string): void {
  if (id === undefined) return;
  write({ id, error: { code, message } });
}

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextRequestId++;
  const key = String(id);
  const promise = new Promise<unknown>((resolve, reject) => {
    pendingRequests.set(key, { resolve, reject });
  });
  write({ id, method, params });
  return promise;
}

function handleResponse(message: JsonRpcMessage): boolean {
  if (message.method !== undefined || message.id === undefined) return false;

  const key = String(message.id);
  const pending = pendingRequests.get(key);
  if (!pending) return true;

  pendingRequests.delete(key);
  if (message.error) {
    pending.reject(new Error(message.error.message ?? `ACP request ${message.id} failed`));
    return true;
  }

  pending.resolve(message.result);
  return true;
}

function promptText(params: unknown): string {
  if (!isRecord(params) || !Array.isArray(params.prompt)) return "";
  return params.prompt
    .filter((part): part is { type: string; text: string } => {
      return isRecord(part) && part.type === "text" && typeof part.text === "string";
    })
    .map((part) => part.text)
    .join("");
}

function requestedSessionId(params: unknown): string {
  if (!isRecord(params) || typeof params.sessionId !== "string" || params.sessionId.length === 0) {
    return defaultSessionId;
  }
  return params.sessionId;
}

function promptResponse() {
  return {
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function formatValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sendAgentMessage(text: string): void {
  write({
    method: "session/update",
    params: {
      sessionId: currentSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}

function sendStopTurn(): void {
  write({
    method: "session/update",
    params: {
      sessionId: currentSessionId,
      update: { sessionUpdate: "stop_turn" },
    },
  });
}

async function triggerPermission(longShape: boolean): Promise<void> {
  const toolCallId = `notification-permission-${++permissionCounter}`;
  sendAgentMessage(`Requesting permission ${toolCallId}`);
  const response = await request("session/request_permission", {
    sessionId: currentSessionId,
    toolCall: {
      toolCallId,
      title: longShape ? "Bash notification fixture with long input" : "Bash",
      kind: "execute",
      rawInput: longShape
        ? {
            command: "printf 'semi;colon and multiline\\nnotification fixture'",
            reason:
              "Tests permission notifications with longer text, semicolons, and multiline content before the user replies.",
            cwd: process.cwd(),
          }
        : {
            command: "echo relay osc-777 permission fixture",
            reason: "Tests Relay permission notifications.",
          },
    },
  });
  sendAgentMessage(`Permission response: ${formatValue(response)}`);
}

async function triggerElicitation(urlShape: boolean): Promise<void> {
  const elicitationId = `notification-elicitation-${++elicitationCounter}`;
  sendAgentMessage(`Requesting elicitation ${elicitationId}`);
  const response = await request("elicitation/create", {
    sessionId: currentSessionId,
    elicitationId,
    mode: urlShape ? "url" : "form",
    message: urlShape
      ? "Notification fixture URL question"
      : "Notification fixture question: choose a target environment.",
    ...(urlShape
      ? { url: "https://example.com/relay-notification-fixture" }
      : {
          requestedSchema: {
            type: "object",
            title: "Notification fixture",
            properties: {
              target: {
                type: "string",
                title: "Target",
                description: "Target environment for this notification fixture.",
                enum: ["local", "staging", "production"],
              },
            },
            required: ["target"],
          },
        }),
  });
  sendAgentMessage(`Elicitation response: ${formatValue(response)}`);
}

function sendHelp(): void {
  sendAgentMessage(`Notification fixture commands:
- completion: normal assistant completion
- stop: send a stop_turn update, then complete
- permission: request a tool permission
- permission-long: request a longer permission payload
- question: request a form elicitation
- question-url: request a URL elicitation
- error: return an ACP prompt error
- all: permission, question, stop_turn, completion`);
}

async function handlePrompt(message: JsonRpcMessage): Promise<void> {
  const text = promptText(message.params);
  const command = text.trim().toLowerCase();

  if (command.includes("error")) {
    error(message.id, -32000, "Notification fixture prompted error response");
    return;
  }

  if (command.includes("all")) {
    await triggerPermission(false);
    await triggerElicitation(false);
    sendStopTurn();
    sendAgentMessage("All notification fixture steps completed.");
    result(message.id, promptResponse());
    return;
  }

  if (command.includes("permission-long")) {
    await triggerPermission(true);
    result(message.id, promptResponse());
    return;
  }

  if (command.includes("permission")) {
    await triggerPermission(false);
    result(message.id, promptResponse());
    return;
  }

  if (command.includes("question-url")) {
    await triggerElicitation(true);
    result(message.id, promptResponse());
    return;
  }

  if (command.includes("question") || command.includes("elicitation")) {
    await triggerElicitation(false);
    result(message.id, promptResponse());
    return;
  }

  if (command.includes("stop")) {
    sendStopTurn();
    sendAgentMessage("Stop-turn fixture completed.");
    result(message.id, promptResponse());
    return;
  }

  if (command.includes("help") || command.length === 0) {
    sendHelp();
    result(message.id, promptResponse());
    return;
  }

  sendAgentMessage(`Completion fixture response for: ${text.replaceAll("\n", " ↵ ")}`);
  result(message.id, promptResponse());
}

async function handleRequest(message: JsonRpcMessage): Promise<void> {
  if (!message.method) return;

  switch (message.method) {
    case "initialize":
      result(message.id, {
        protocolVersion: 1,
        agentInfo: { name: "relay-notification-dev-agent", version: "1.0.0" },
        agentCapabilities: {},
        authMethods: [],
      });
      return;
    case "session/new":
      currentSessionId = `notification-dev-session-${Date.now().toString(36)}`;
      result(message.id, { sessionId: currentSessionId });
      return;
    case "session/load":
      currentSessionId = requestedSessionId(message.params);
      result(message.id, { sessionId: currentSessionId });
      return;
    case "session/list":
      result(message.id, { sessions: [] });
      return;
    case "session/prompt":
      await handlePrompt(message);
      return;
    case "session/cancel":
      result(message.id, {});
      return;
    case "session/set_mode":
    case "session/setMode":
    case "session/set_config_option":
      result(message.id, {});
      return;
    default:
      error(message.id, -32601, `Unsupported method: ${message.method}`);
  }
}

async function handleLine(line: string): Promise<void> {
  const parsed = JSON.parse(line) as JsonRpcMessage;
  if (handleResponse(parsed)) return;
  await handleRequest(parsed);
}

const lines = readline.createInterface({ input: process.stdin });

for await (const rawLine of lines) {
  const line = rawLine.trim();
  if (!line) continue;
  void handleLine(line).catch((cause) => {
    process.stderr.write(`notification fixture error: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  });
}
