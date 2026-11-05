#!/usr/bin/env bun
import * as fs from "node:fs";

type JsonRpc = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

const transcriptPath = process.argv[2];
const mode = process.argv[3];
if (!transcriptPath) throw new Error("transcript path is required");

let buffer = "";
let promptCount = 0;
const sessionId = "web-playwright-session";
let pendingPermissionRequestId: string | null = null;
let pendingPermissionPromptId: number | string | null = null;

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

function sendUpdate(update: Record<string, unknown>): void {
  send({ method: "session/update", params: { sessionId, update } });
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromContent).join("");
  if (!value || typeof value !== "object") return "";
  const recordValue = value as Record<string, unknown>;
  if (typeof recordValue.text === "string") return recordValue.text;
  if ("content" in recordValue) return textFromContent(recordValue.content);
  return "";
}

function promptText(params: Record<string, unknown> | undefined): string {
  return textFromContent(params?.prompt);
}

function sessionResult() {
  return {
    sessionId,
    configOptions: [
      {
        id: "model",
        category: "model",
        type: "select",
        currentValue: "model-a",
        options: [
          { id: "model-a", name: "Model A" },
          { id: "model-b", name: "Model B" },
          { id: "model-c", name: "Model C" },
          { id: "model-d", name: "Model D" },
          { id: "model-e", name: "Model E" },
          { id: "model-f", name: "Model F" },
          { id: "model-g", name: "Model G" },
          { id: "model-h", name: "Model H" },
          { id: "model-i", name: "Model I" },
          { id: "model-j", name: "Model J" },
          { id: "model-k", name: "Model K" },
          { id: "model-l", name: "Model L" },
          { id: "model-m", name: "Model M" },
          { id: "model-n", name: "Model N" },
          { id: "model-o", name: "Model O" },
          { id: "model-p", name: "Model P" },
          { id: "model-q", name: "Model Q" },
          { id: "model-r", name: "Model R" },
        ],
      },
    ],
    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
  };
}

record({ event: "started" });

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

async function handleLine(line: string): Promise<void> {
  let message: JsonRpc;
  try {
    message = JSON.parse(line) as JsonRpc;
  } catch (error) {
    record({ event: "invalid-json", line, error: String(error) });
    return;
  }

  record({ event: "request", method: message.method, params: message.params, result: message.result });
  if (pendingPermissionRequestId && String(message.id) === pendingPermissionRequestId) {
    completePermissionTurn(message);
    return;
  }
  if (!message.method || message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      send({
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "relay-web-playwright-agent", version: "1" },
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { list: {} },
          },
        },
      });
      return;
    case "session/new":
      send({ id: message.id, result: sessionResult() });
      return;
    case "session/load":
      sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "web restored line\n" },
      });
      sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "  web restored indent" },
      });
      sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "web-restored-tool",
        title: "read_file",
        status: "completed",
        rawOutput: "web restored tool output",
      });
      send({ id: message.id, result: sessionResult() });
      return;
    case "session/list":
      if (mode === "alta-internal-sessions") {
        send({
          id: message.id,
          result: [
            {
              sessionId: "junk-cache-session",
              title:
                "/Users/me/.cache/alta/agents/axiom-asumer@2026.26.2522/node_modules/@atlassian/alta-agent-axiom-asumer/agent.yml",
              updatedAt: "2026-06-28T04:00:00.000Z",
            },
            {
              sessionId: "junk-package-session",
              title: "axiom-asumer",
              updatedAt: "2026-06-28T05:00:00.000Z",
            },
            { sessionId, title: "Useful web session", updatedAt: "2026-06-27T04:00:00.000Z" },
          ],
        });
        return;
      }
      send({
        id: message.id,
        result: [{ sessionId, title: "Playwright session", updatedAt: new Date().toISOString() }],
      });
      return;
    case "session/set_config_option":
    case "session/set_mode":
    case "session/setMode":
      send({ id: message.id, result: {} });
      return;
    case "session/prompt": {
      promptCount += 1;
      const text = promptText(message.params);
      record({ event: "prompt", index: promptCount, text });
      if (mode === "exit-after-first-prompt" && promptCount === 1 && !transcriptContains("intentional-web-exit")) {
        sendUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "web exit fixture streamed before process exit" },
        });
        record({ event: "intentional-web-exit", code: 0 });
        setTimeout(() => process.exit(0), 50);
        return;
      }
      if (text.includes("custom permission")) runPermissionTurn(message.id);
      else runTurn(message.id);
      return;
    }
    default:
      send({ id: message.id, error: { code: -32601, message: `Unsupported method: ${message.method}` } });
  }
}

function selectedOptionId(message: JsonRpc): string {
  const result = message.result;
  const outcome = result?.outcome;
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return "cancelled";
  const data = outcome as Record<string, unknown>;
  return typeof data.optionId === "string" ? data.optionId : String(data.outcome ?? "cancelled");
}

function runPermissionTurn(id: number | string): void {
  const requestId = `permission-${promptCount}`;
  pendingPermissionRequestId = requestId;
  pendingPermissionPromptId = id;
  sendUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "web-permission-tool",
    title: "permission_write",
    kind: "edit",
    status: "pending",
    rawInput: { path: "README.md", content: "web permission smoke" },
  });
  send({
    id: requestId,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: {
        toolCallId: "web-permission-tool",
        title: "permission_write",
        kind: "edit",
        rawInput: { path: "README.md", content: "web permission smoke" },
      },
      options: [
        { optionId: "custom-allow", name: "Allow custom", kind: "allow_always" },
        { optionId: "custom-reject", name: "Reject custom", kind: "reject_once" },
      ],
    },
  });
}

function completePermissionTurn(message: JsonRpc): void {
  const promptId = pendingPermissionPromptId;
  const optionId = selectedOptionId(message);
  pendingPermissionRequestId = null;
  pendingPermissionPromptId = null;
  sendUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "web-permission-tool",
    status: optionId.includes("reject") ? "failed" : "completed",
    rawOutput: { selectedOptionId: optionId },
  });
  sendUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `Permission selected: ${optionId}` },
  });
  if (promptId !== null) send({ id: promptId, result: { stopReason: "end_turn" } });
}

function runTurn(id: number | string): void {
  const chunks = [
    "## Web turn complete\n\n",
    "- Markdown **renders** as structured content.\n",
    "- Long text stays inside the transcript instead of escaping the layout.\n\n",
    "```ts\nconst answer = 42;\nconsole.log(answer);\n```\n",
  ];

  setTimeout(
    () => sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunks[0] } }),
    180,
  );
  setTimeout(
    () => sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunks[1] } }),
    260,
  );
  setTimeout(
    () => sendUpdate({ sessionUpdate: "tool_call", toolCallId: "web-tool-1", title: "read_file", status: "pending" }),
    310,
  );
  setTimeout(
    () =>
      sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "web-tool-1",
        title: "read_file",
        status: "completed",
        rawOutput: "src/example.ts\n\nconst answer = 42;\nexport default answer;\n",
      }),
    360,
  );
  setTimeout(
    () =>
      sendUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "web-diff-1",
        title: "find_and_replace_code",
        status: "pending",
      }),
    390,
  );
  setTimeout(
    () =>
      sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "web-diff-1",
        title: "find_and_replace_code",
        status: "completed",
        content: [
          {
            type: "diff",
            path: "src/example.ts",
            oldText: "const answer = 41;\n",
            newText: "const answer = 42;\n",
          },
        ],
      }),
    440,
  );
  setTimeout(
    () => sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunks[2] } }),
    500,
  );
  setTimeout(
    () => sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunks[3] } }),
    560,
  );
  setTimeout(() => send({ id, result: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } }), 620);
}
