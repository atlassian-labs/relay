#!/usr/bin/env bun

import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
import { getConfig, getConfigDir } from "../src/config";

const SHOWCASE_PROMPT = "relay ui showcase";
const QUEUE_SHOWCASE_PROMPT = "relay queue showcase";
const ALTA_STEER_META_KEY = "alta/steer";
const SESSION_ID = "relay-ui-showcase-session";
const QUEUE_TURN_MIN_MS = 10_000;
const QUEUE_TURN_MAX_MS = 15_000;
const QUEUE_STREAM_INTERVAL_MS = 750;
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

type JsonRpcId = number | string;
type JsonRpcMessage = {
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
};

type PendingRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function launchShowcase(): Promise<void> {
  const queueOnly = process.argv.includes("--queue");
  const sourceConfigDir = getConfigDir();
  const activeTheme = getConfig().ui.theme;
  const tempRoot = mkdtempSync(join(tmpdir(), "relay-ui-showcase-"));
  const configDir = join(tempRoot, "config", "relay");
  mkdirSync(configDir, { recursive: true });

  const sourceThemesDir = join(sourceConfigDir, "themes");
  if (existsSync(sourceThemesDir)) {
    cpSync(sourceThemesDir, join(configDir, "themes"), { recursive: true });
  }

  const pluginPath = join(repoRoot, "scripts", "dev-ui-showcase-plugin.ts");
  writeFileSync(
    join(configDir, "config.toml"),
    `[ui]\ntheme = ${JSON.stringify(activeTheme)}\nshow_tips = false\n\n[notifications]\nterminal_enabled = false\nsound_enabled = false\n\n[plugins]\nenabled = true\npaths = [${JSON.stringify(pluginPath)}]\n`,
    "utf-8",
  );

  const acpCommand = `${shellQuote(process.execPath)} run ${shellQuote(scriptPath)} --agent`;
  const child = Bun.spawn(
    [process.execPath, "run", "--conditions=browser", join(repoRoot, "src", "index.ts"), "acp", acpCommand],
    {
      cwd: repoRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(tempRoot, "config"),
        XDG_CACHE_HOME: join(tempRoot, "cache"),
        RELAY_DISABLE_NOTIFICATIONS: "1",
        RELAY_UI_SHOWCASE_MODE: queueOnly ? "queue" : "components",
      },
    },
  );

  const cleanup = () => rmSync(tempRoot, { recursive: true, force: true });
  process.on("SIGTERM", () => child.kill());
  process.on("SIGINT", () => child.kill());

  try {
    process.exitCode = await child.exited;
  } finally {
    cleanup();
  }
}

const pendingRequests = new Map<string, PendingRequest>();
const queueShowcaseMode = process.env.RELAY_UI_SHOWCASE_MODE === "queue";
let nextRequestId = 1000;
let nextSteeringId = 1;
let currentSessionId = SESSION_ID;
let cancelQueueShowcaseTurn: (() => void) | null = null;

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function result(id: JsonRpcId | undefined, value: unknown): void {
  if (id !== undefined) write({ id, result: value });
}

function rpcError(id: JsonRpcId | undefined, message: string): void {
  if (id !== undefined) write({ id, error: { code: -32601, message } });
}

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextRequestId++;
  const response = new Promise<unknown>((resolveResponse, rejectResponse) => {
    pendingRequests.set(String(id), { resolve: resolveResponse, reject: rejectResponse });
  });
  write({ id, method, params });
  return response;
}

function handleResponse(message: JsonRpcMessage): boolean {
  if (message.method !== undefined || message.id === undefined) return false;
  const pending = pendingRequests.get(String(message.id));
  if (!pending) return true;
  pendingRequests.delete(String(message.id));
  if (message.error) pending.reject(new Error(message.error.message ?? "Showcase request failed"));
  else pending.resolve(message.result);
  return true;
}

function sendUpdate(update: Record<string, unknown>): void {
  write({ method: "session/update", params: { sessionId: currentSessionId, update } });
}

function sendAssistant(text: string): void {
  sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
}

function promptText(params: unknown): string {
  if (!isRecord(params) || !Array.isArray(params.prompt)) return "";
  return params.prompt
    .filter((part): part is Record<string, unknown> => isRecord(part))
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

function isSteeringPrompt(params: unknown): boolean {
  return (
    queueShowcaseMode && isRecord(params) && isRecord(params._meta) && Object.hasOwn(params._meta, ALTA_STEER_META_KEY)
  );
}

function formatResponse(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function runShowcaseTurn(id: JsonRpcId | undefined): Promise<void> {
  sendAssistant(
    "This is a disposable fake chat session. I’ll present each interactive Relay UI one at a time.\n\n**1. Permission pane** — the entire composer, queue header, and footer are temporarily replaced.\n",
  );

  const toolCallId = "showcase-bash-permission";
  const toolCall = {
    toolCallId,
    title: "Bash",
    kind: "execute",
    rawInput: {
      command: "git push origin feature/relay-ui-showcase",
      reason: "Publish the UI showcase branch for review.",
    },
  };
  sendUpdate({ sessionUpdate: "tool_call", ...toolCall, status: "pending" });
  const permission = await request("session/request_permission", {
    sessionId: currentSessionId,
    toolCall,
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      {
        optionId: "allow-session",
        name: "Allow similar git push commands for this session",
        kind: "allow_always",
      },
      { optionId: "deny-once", name: "Deny and continue without running it", kind: "reject_once" },
    ],
  });
  sendUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "completed",
    rawOutput: { permissionResponse: permission },
  });

  sendAssistant(
    `Permission response recorded: \`${formatResponse(permission)}\`.\n\n**2. Single-question elicitation** — choose one release strategy.\n`,
  );
  const singleElicitation = await request("elicitation/create", {
    sessionId: currentSessionId,
    elicitationId: "showcase-release-strategy-question",
    mode: "form",
    message: "Choose a release strategy for this fake deployment.",
    requestedSchema: {
      type: "object",
      title: "Release strategy",
      properties: {
        strategy: {
          type: "string",
          title: "How should Relay roll out this release?",
          description: "Choose the rollout behavior for the fake deployment.",
          enum: ["Canary", "Rolling", "All at once"],
        },
      },
      required: ["strategy"],
    },
  });

  sendAssistant(
    `Single-question response recorded: \`${formatResponse(singleElicitation)}\`.\n\n**3. Multi-field elicitation** — answer each tab, then use the Submit review tab.\n`,
  );
  const formElicitation = await request("elicitation/create", {
    sessionId: currentSessionId,
    elicitationId: "showcase-deployment-form",
    mode: "form",
    message: "Choose the deployment settings for this fake release.",
    requestedSchema: {
      type: "object",
      title: "Deployment settings",
      properties: {
        environment: {
          type: "string",
          title: "Environment",
          description: "Where should Relay deploy this fake release?",
          enum: ["Development", "Staging", "Production"],
        },
        region: {
          type: "string",
          title: "Region",
          description: "Choose the target region.",
          enum: ["us-east-1", "us-west-2", "eu-west-1"],
        },
        validation: {
          type: "string",
          title: "Validation",
          description: "Choose the validation level before deployment.",
          enum: ["Smoke tests", "Full test suite", "Skip validation"],
        },
      },
      required: ["environment", "region", "validation"],
    },
  });

  sendAssistant(
    `Multi-field response recorded: \`${formatResponse(formElicitation)}\`.\n\n**4–6. Reusable confirmation popup** — the showcase plugin will now display Overclock install, Bitbucket approve, and Bitbucket merge examples in sequence. Resolve each popup to advance.\n`,
  );
  result(id, { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } });
}

async function runQueueShowcaseTurn(id: JsonRpcId | undefined, params: unknown): Promise<void> {
  const input = promptText(params).trim();
  const initialTurn = input.toLowerCase().includes(QUEUE_SHOWCASE_PROMPT);
  const durationMs = QUEUE_TURN_MIN_MS + Math.floor(Math.random() * (QUEUE_TURN_MAX_MS - QUEUE_TURN_MIN_MS + 1));
  const durationSeconds = Math.round(durationMs / 1000);

  sendAssistant(
    initialTurn
      ? `**Queue sandbox** — every fake turn streams for about 10–15 seconds. Prompts typed while a turn runs enter Relay’s local queue and each starts its own fake turn when it reaches the front.\n\nUse Option/Alt+Up or Down to select and edit a queued row, Tab to steer it into the active turn, Ctrl+D to delete it, Enter to save it, or Escape to restore it. Queue edits are automatically submitted when the active turn completes. No prompts are sent to an LLM.\n\nStarting a ${durationSeconds}-second fake turn: `
      : `**Fake response to:** ${input || "(empty prompt)"}\n\nStreaming for about ${durationSeconds} seconds so you can add, edit, steer, reorder, and delete queued prompts. `,
  );

  const outcome = await new Promise<"completed" | "cancelled">((resolveTurn) => {
    let settled = false;
    let chunk = 0;
    const finish = (value: "completed" | "cancelled") => {
      if (settled) return;
      settled = true;
      clearInterval(streamTimer);
      clearTimeout(completionTimer);
      resolveTurn(value);
    };
    const streamTimer = setInterval(() => {
      const phrases = [
        "Generating a faux response... ",
        "Keeping the turn active for queue testing... ",
        "Streaming another safe test chunk... ",
      ];
      sendAssistant(phrases[chunk++ % phrases.length] ?? "Generating... ");
    }, QUEUE_STREAM_INTERVAL_MS);
    const completionTimer = setTimeout(() => finish("completed"), durationMs);
    cancelQueueShowcaseTurn = () => finish("cancelled");
  });

  cancelQueueShowcaseTurn = null;
  if (outcome === "completed")
    sendAssistant("\n\nFake turn complete. Relay will now submit the next queued prompt, if any.");
  result(id, {
    stopReason: outcome === "completed" ? "end_turn" : "cancelled",
    usage: { inputTokens: 1, outputTokens: outcome === "completed" ? 24 : 0 },
  });
}

async function handleRequest(message: JsonRpcMessage): Promise<void> {
  if (!message.method) return;
  switch (message.method) {
    case "initialize":
      result(message.id, {
        protocolVersion: 1,
        agentInfo: { name: "relay-ui-showcase-agent", version: "1.0.0" },
        agentCapabilities: queueShowcaseMode ? { _meta: { [ALTA_STEER_META_KEY]: { version: "0.1.0" } } } : {},
        authMethods: [],
      });
      return;
    case "session/new":
      currentSessionId = `${SESSION_ID}-${Date.now().toString(36)}`;
      result(message.id, { sessionId: currentSessionId });
      return;
    case "session/load":
      result(message.id, { sessionId: currentSessionId });
      return;
    case "session/list":
      result(message.id, { sessions: [] });
      return;
    case "session/prompt": {
      if (isSteeringPrompt(message.params)) {
        const steeringText = promptText(message.params).trim();
        if (steeringText) sendAssistant(`\n\nSteering received: **${steeringText}**\n\n`);
        result(message.id, {
          _meta: {
            [ALTA_STEER_META_KEY]: { accepted: true, steeringId: `showcase-steer-${nextSteeringId++}` },
          },
        });
        return;
      }
      const text = promptText(message.params).toLowerCase();
      if (queueShowcaseMode) {
        await runQueueShowcaseTurn(message.id, message.params);
      } else if (text.includes(SHOWCASE_PROMPT)) {
        await runShowcaseTurn(message.id);
      } else {
        sendAssistant(
          `Type \`${SHOWCASE_PROMPT}\` to replay the component sequence or \`${QUEUE_SHOWCASE_PROMPT}\` to open the queue sandbox.`,
        );
        result(message.id, { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } });
      }
      return;
    }
    case "session/cancel":
      cancelQueueShowcaseTurn?.();
      result(message.id, {});
      return;
    case "session/set_mode":
    case "session/setMode":
    case "session/set_config_option":
      result(message.id, {});
      return;
    default:
      rpcError(message.id, `Unsupported method: ${message.method}`);
  }
}

async function runAgent(): Promise<void> {
  const lines = readline.createInterface({ input: process.stdin });
  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const message = JSON.parse(line) as JsonRpcMessage;
      if (handleResponse(message)) continue;
      void handleRequest(message).catch((cause) => {
        process.stderr.write(`UI showcase agent error: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        rpcError(message.id, cause instanceof Error ? cause.message : String(cause));
      });
    } catch (cause) {
      process.stderr.write(
        `UI showcase agent parse error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
    }
  }
}

if (process.argv.includes("--agent")) {
  await runAgent();
} else {
  await launchShowcase();
}
