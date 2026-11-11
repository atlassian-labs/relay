#!/usr/bin/env bun
import * as fs from "fs";

type JsonRpc = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

const transcriptPath = process.argv[2];
const mode = process.argv[3];
if (!transcriptPath) throw new Error("transcript path is required");

function record(event: Record<string, unknown>): void {
  fs.appendFileSync(transcriptPath, `${JSON.stringify({ at: Date.now(), ...event })}\n`, "utf-8");
}

function transcriptContains(text: string): boolean {
  try {
    return fs.readFileSync(transcriptPath, "utf-8").includes(text);
  } catch {
    return false;
  }
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

let buffer = "";
let promptCount = 0;
let foregroundSessionId = "real-new-session";
const internalAltaCacheTitle =
  "/Users/me/.cache/alta/agents/axiom-example@2026.26.2522/node_modules/@atlassian/alta-agent-axiom-example/agent.yml";
const internalAltaPackageNameTitle = "axiom-example";

record({ event: "started", pid: process.pid });

if (mode === "ignore-sigterm") {
  process.on("SIGTERM", () => record({ event: "sigterm-ignored", pid: process.pid }));
}

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const index = buffer.indexOf("\n");
    if (index === -1) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    void handleLine(line);
  }
});

process.stdin.on("end", () => record({ event: "stdin-end" }));

async function handleLine(line: string): Promise<void> {
  let message: JsonRpc;
  try {
    message = JSON.parse(line) as JsonRpc;
  } catch (error) {
    record({ event: "invalid-json", line, error: String(error) });
    return;
  }
  record({ event: "request", method: message.method, params: message.params });
  if (!message.method) return;
  if (message.id === undefined) {
    if (message.method === "session/cancel") {
      record({ event: "cancel", params: message.params });
    }
    return;
  }

  switch (message.method) {
    case "initialize":
      send({
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "relay-real-e2e-agent", version: "1" },
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: {
              list: {},
              ...(mode === "fork" ? { fork: {} } : {}),
            },
          },
        },
      });
      if (mode === "exit-after-initialize") {
        record({ event: "intentional-startup-exit", code: 0 });
        setTimeout(() => process.exit(0), 10);
      }
      return;
    case "session/new":
      foregroundSessionId = "real-new-session";
      send({ id: message.id, result: sessionResult(foregroundSessionId, "model-a") });
      return;
    case "session/fork":
      send({ id: message.id, result: sessionResult("real-forked-session", "model-a") });
      return;
    case "session/list":
      if (mode === "cache-history-only-junk") {
        send({
          id: message.id,
          result: [
            { sessionId: "junk-cache-session", title: internalAltaCacheTitle, updatedAt: "2026-06-28T04:00:00.000Z" },
            {
              sessionId: "junk-package-name-session",
              title: internalAltaPackageNameTitle,
              updatedAt: "2026-06-28T05:00:00.000Z",
            },
          ],
        });
        return;
      }
      if (mode === "cache-history-with-real") {
        send({
          id: message.id,
          result: [
            { sessionId: "junk-cache-session", title: internalAltaCacheTitle, updatedAt: "2026-06-28T04:00:00.000Z" },
            {
              sessionId: "junk-package-name-session",
              title: internalAltaPackageNameTitle,
              updatedAt: "2026-06-28T05:00:00.000Z",
            },
            { sessionId: "real-history-session", title: "Useful real session", updatedAt: "2026-06-27T04:00:00.000Z" },
          ],
        });
        return;
      }
      send({
        id: message.id,
        result: [
          { sessionId: "older-session", title: "Older", updatedAt: "2024-01-01T00:00:00.000Z" },
          { sessionId: "latest-session", title: "Latest", updatedAt: "2024-01-02T00:00:00.000Z" },
        ],
      });
      return;
    case "session/load": {
      const sessionId = String(message.params?.sessionId ?? "loaded-session");
      if (mode === "cache-history-with-real" && sessionId === "real-history-session") {
        send({
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "real restored from cache history" },
            },
          },
        });
        send({ id: message.id, result: sessionResult(sessionId, "model-a") });
        return;
      }
      if (mode === "restore-rich-history") {
        const restoredTextUpdates = [
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "restored line one\n" },
          },
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "  restored indent" },
          },
        ];
        const restoredToolUpdate = {
          sessionUpdate: "tool_call_update",
          toolCallId: "restore-tool-only",
          title: "Search",
          status: "completed",
          rawInput: { query: "restore" },
          content: [{ type: "content", content: { type: "text", text: "tool restored output" } }],
        };
        for (const update of restoredTextUpdates) {
          record({ event: "restore-rich-history-update", update });
          send({ method: "session/update", params: { sessionId, update } });
        }
        record({ event: "restore-rich-history-update", update: restoredToolUpdate });
        send({ method: "session/update", params: { sessionId, update: restoredToolUpdate } });
      }
      send({ id: message.id, result: sessionResult(sessionId, "model-a") });
      return;
    }
    case "session/set_config_option":
      if (mode === "slow-config") {
        record({ event: "set-config-start", params: message.params });
        setTimeout(() => {
          record({ event: "set-config-complete", params: message.params });
          send({ id: message.id, result: {} });
        }, 500);
        return;
      }
      send({ id: message.id, result: {} });
      return;
    case "session/prompt": {
      promptCount += 1;
      const prompt = Array.isArray(message.params?.prompt) ? message.params.prompt : [];
      const firstPromptPart = prompt[0];
      const promptText =
        firstPromptPart && typeof firstPromptPart === "object" && "text" in firstPromptPart
          ? firstPromptPart.text
          : undefined;
      const text = String(promptText ?? message.params?.text ?? "");
      record({ event: "prompt", index: promptCount, text });
      if (
        mode === "exit-after-first-prompt" &&
        promptCount === 1 &&
        !transcriptContains("intentional-unexpected-exit")
      ) {
        send({
          method: "session/update",
          params: {
            sessionId: String(message.params?.sessionId ?? ""),
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "exit fixture streamed before process exit" },
            },
          },
        });
        record({ event: "intentional-unexpected-exit", code: 0 });
        setTimeout(() => process.exit(0), 50);
        return;
      }
      if (text.includes("child exit second prompt")) {
        record({ event: "child-exit-second-prompt-complete" });
        send({
          method: "session/update",
          params: {
            sessionId: String(message.params?.sessionId ?? ""),
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "child exit second prompt complete" },
            },
          },
        });
        send({ id: message.id, result: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } });
        return;
      }
      if (text.includes("reload while running")) {
        setTimeout(() => {
          send({
            method: "session/update",
            params: {
              sessionId: String(message.params?.sessionId ?? ""),
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done after reload" } },
            },
          });
          send({ id: message.id, result: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } });
        }, 1000);
        return;
      }
      if (text.includes("long running")) {
        setTimeout(() => {
          send({ id: message.id, result: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } });
        }, 2000);
        return;
      }
      send({ id: message.id, result: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } });
      return;
    }
    default:
      send({ id: message.id, error: { code: -32601, message: `Unsupported method: ${message.method}` } });
  }
}

function sessionResult(sessionId: string, currentModelId: string) {
  return {
    sessionId,
    configOptions: [
      {
        id: "model",
        category: "model",
        type: "select",
        currentValue: currentModelId,
        options: [
          { id: "model-a", name: "Model A" },
          { id: "model-b", name: "Model B" },
        ],
      },
    ],
    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
  };
}
