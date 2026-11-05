#!/usr/bin/env bun

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
};

const defaultSessionId = "real-e2e-session";
const altaSteerMetaKey = "alta/steer";
const altaSubagentMetaKey = "alta/subagent";
const permissionOptions = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
] as const;
const e2eStateDir = process.env.RELAY_REAL_E2E_PROMPT_LOG
  ? path.dirname(process.env.RELAY_REAL_E2E_PROMPT_LOG)
  : process.cwd();
const sessionCounterPath = path.join(e2eStateDir, ".relay-real-e2e-session-counter");
let sessionCounter = readSessionCounter();
let currentSessionId = defaultSessionId;
const activeTurnInputEnabled = process.env.RELAY_REAL_E2E_ACTIVE_TURN_INPUT === "1";
const activeTurnInputs: string[] = [];
let nextClientRequestId = 1;
const pendingClientResponses = new Map<number | string, (message: JsonRpcMessage) => void>();

function readSessionCounter(): number {
  try {
    const raw = fs.readFileSync(sessionCounterPath, "utf8").trim();
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeSessionCounter(value: number): void {
  fs.writeFileSync(sessionCounterPath, `${value}\n`, "utf8");
}

function write(message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeAfterEventLoopTurns(message: unknown, turns: number): void {
  if (turns <= 0) {
    write(message);
    return;
  }
  setTimeout(() => writeAfterEventLoopTurns(message, turns - 1), 0);
}

function requestClient(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
  const id = `real-e2e-client-request-${nextClientRequestId++}`;
  return new Promise((resolve) => {
    pendingClientResponses.set(id, resolve);
    write({ jsonrpc: "2.0", id, method, params });
  });
}

function notificationConfigUpdate() {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: currentSessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [
          {
            id: "relay.notifications.sound_enabled",
            type: "boolean",
            currentValue: true,
          },
        ],
      },
    },
  };
}

function sessionUpdate(update: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: currentSessionId,
      update,
    },
  };
}

function writeSessionUpdate(update: Record<string, unknown>): void {
  write(sessionUpdate(update));
}

function writeSessionUpdateWithMeta(update: Record<string, unknown>, meta: Record<string, unknown>): void {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: currentSessionId,
      update,
      _meta: meta,
    },
  });
}

function writeSubagentUpdate(update: Record<string, unknown>, meta: Record<string, unknown>): void {
  writeSessionUpdateWithMeta(update, { [altaSubagentMetaKey]: meta });
}

function result(id: number | string | undefined, value: unknown) {
  if (id === undefined) return;
  write({ jsonrpc: "2.0", id, result: value });
}

function error(id: number | string | undefined, message: string) {
  if (id === undefined) return;
  write({ jsonrpc: "2.0", id, error: { code: -32601, message } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function promptText(params: unknown): string {
  const prompt = (params as { prompt?: Array<{ type?: string; text?: string }> } | null)?.prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function isAltaSteerPrompt(params: unknown): boolean {
  return isRecord(params) && isRecord(params._meta) && Object.hasOwn(params._meta, altaSteerMetaKey);
}

function altaSteerResponse(accepted: boolean, reason?: string): Record<string, unknown> {
  return {
    _meta: {
      [altaSteerMetaKey]: {
        accepted,
        ...(accepted ? { steeringId: `real-active-turn-input-${activeTurnInputs.length}` } : {}),
        ...(reason ? { reason } : {}),
      },
    },
  };
}

function recordE2eEvent(event: Record<string, unknown>): void {
  const logPath = process.env.RELAY_REAL_E2E_PROMPT_LOG;
  if (!logPath) return;
  fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, "utf8");
}

function recordPromptText(text: string): void {
  recordE2eEvent({ event: "prompt", text });
}

function availableCommands(): Array<{ name: string; description: string }> {
  if (process.env.RELAY_REAL_E2E_EMPTY_AVAILABLE_COMMANDS === "1") return [];
  const commands = [{ name: "copy", description: "agent copy command should not appear while browsing" }];
  if (process.env.RELAY_REAL_E2E_ADVERTISE_REAL_SKILL_COMMAND === "1") {
    commands.push({ name: "real-skill", description: "agent-side real skill command" });
  }
  if (process.env.RELAY_REAL_E2E_ADVERTISE_REVIEW_COMMAND === "1") {
    commands.push({ name: "review", description: "agent-side review command" });
  }
  return commands;
}

function emitAvailableCommandsUpdate(commands: Array<{ name: string; description: string }>): void {
  recordE2eEvent({ event: "available-commands-update", commands: commands.map((command) => command.name) });
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: currentSessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: commands,
      },
    },
  });
}

function scheduleAvailableCommandsUpdates(firstDelayMs: number): void {
  const firstCommands = availableCommands();
  if (firstDelayMs > 0) setTimeout(() => emitAvailableCommandsUpdate(firstCommands), firstDelayMs);
  else emitAvailableCommandsUpdate(firstCommands);

  const lateDelayMs = envDelayMs("RELAY_REAL_E2E_LATE_AVAILABLE_COMMANDS_UPDATE_MS");
  if (lateDelayMs <= 0) return;
  setTimeout(() => {
    emitAvailableCommandsUpdate([
      ...availableCommands(),
      { name: "late-settings-skill", description: "late command must not hijack settings overlay" },
    ]);
  }, lateDelayMs);
}

function realSkillArgsFromInvocation(invocation: string): string {
  return invocation.match(/^\/real-skill(?:[\t ]+([\s\S]*))?$/)?.[1] ?? "";
}

function rawRealSkillPrompt(invocation: string, malformed = false): string {
  const args = realSkillArgsFromInvocation(invocation);
  const skillMarkdown = [
    "---",
    `name: ${malformed ? "other-skill" : "real-skill"}`,
    "description: Real compact skill smoke skill",
    "register_cmd: true",
    "---",
    "",
    "Use the real skill body.",
    ...(args ? ["", `ARGUMENTS: ${args}`] : []),
  ];
  return (malformed ? [invocation, ...skillMarkdown] : skillMarkdown).join("\n");
}

function longScrollResponse(prefix: string): string {
  return Array.from({ length: 70 }, (_, index) => `${prefix}-${String(index).padStart(2, "0")}`).join("\n");
}

function scrollResponsePrefix(text: string): string | undefined {
  if (text.includes("real scroll first")) return "SCROLL-FIRST";
  if (text.includes("real scroll second")) return "SCROLL-SECOND";
  if (text.includes("real scroll third")) return "SCROLL-THIRD";
  if (text.includes("real scroll fourth")) return "SCROLL-FOURTH";
  return undefined;
}

function stressLine(index: number): string {
  const label = String(index).padStart(3, "0");
  return `STRESS-FIRST-${label} ${"burst-content ".repeat(5)}${label}\n`;
}

function stressToolOutput(index: number): string {
  const label = String(index).padStart(2, "0");
  return Array.from({ length: 8 }, (_, lineIndex) => `stress-tool-${label}-line-${lineIndex}`).join("\n");
}

async function emitTuiStressBurst(id: number | string | undefined, generation: number): Promise<void> {
  writeSessionUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "STRESS-FIRST-START\n" },
  });
  recordE2eEvent({ event: "tui-stress-start" });
  await sleep(750, generation);
  if (generation !== cancelGeneration) {
    result(id, { stopReason: "cancelled", usage: { inputTokens: 1, outputTokens: 0 } });
    return;
  }

  for (let index = 0; index < 220; index++) {
    if (index % 29 === 0) {
      writeSessionUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: `STRESS-THINK-${String(index).padStart(3, "0")}\n` },
      });
    }
    if (index % 37 === 0) {
      writeSessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: stressLine(index) },
      });
      writeSessionUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: `STRESS-INTERLEAVED-THINK-${String(index).padStart(3, "0")}\n` },
      });
      writeSessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: stressLine(index + 1) },
      });
    } else {
      writeSessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: stressLine(index) },
      });
    }
    if (index % 45 === 0) {
      writeSessionUpdate({
        sessionUpdate: "usage_update",
        usage: { inputTokens: index + 1, outputTokens: index + 2 },
        size: 200000,
        used: 1000 + index,
      });
    }
  }

  for (let index = 0; index < 14; index++) {
    const toolCallId = `stress-tool-${index}`;
    writeSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId,
      title: "stress_read",
      kind: "read",
      rawInput: { path: `stress-${index}.txt`, lines: 8 },
      status: "pending",
    });
    writeSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId,
      title: "stress_read",
      kind: "read",
      rawInput: { path: `stress-${index}.txt`, lines: 8 },
      rawOutput: stressToolOutput(index),
      status: "completed",
    });
  }

  writeSessionUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "STRESS-FIRST-END\n" },
  });
  recordE2eEvent({ event: "tui-stress-end" });
  result(id, { stopReason: "end_turn", usage: { inputTokens: 13, outputTokens: 377 } });
}

function emitMalformedStress(id: number | string | undefined): void {
  process.stdout.write("{not-json-from-real-acp-stress\n");
  writeSessionUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "MALFORMED-STRESS-OK" },
  });
  result(id, { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } });
}

let cancelGeneration = 0;
let activePromptRequests = 0;

function envDelayMs(name: string): number {
  const delay = Number.parseInt(process.env[name] ?? "0", 10);
  return Number.isFinite(delay) && delay > 0 ? delay : 0;
}

function promptDelayMs(text: string): number {
  const finalQueueDelay = Number.parseInt(process.env.RELAY_REAL_E2E_FINAL_QUEUE_DELAY_MS ?? "0", 10);
  if (Number.isFinite(finalQueueDelay) && finalQueueDelay > 0 && text.includes("queued real prompt two edited")) {
    return finalQueueDelay;
  }

  const delay = envDelayMs("RELAY_REAL_E2E_PROMPT_DELAY_MS");
  if (delay <= 0) return 0;
  return text.includes("slow real queue prompt") ||
    text.includes("hanging real queue prompt") ||
    text.includes("slow real history prompt") ||
    text.includes("slow real active-turn prompt") ||
    text.includes("startup initial real prompt")
    ? delay
    : 0;
}

async function sleep(ms: number, generation: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (generation !== cancelGeneration) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
  }
}

async function handle(message: JsonRpcMessage) {
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

  recordE2eEvent({ event: "request", method: message.method });

  switch (message.method) {
    case "initialize":
      recordE2eEvent({
        event: "initialize-client-capabilities",
        clientCapabilities: (message.params as Record<string, unknown> | undefined)?.clientCapabilities,
      });
      result(message.id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {} },
          ...(activeTurnInputEnabled ? { _meta: { [altaSteerMetaKey]: { version: "0.1.0" } } } : {}),
        },
        authMethods: [],
      });
      return;
    case "session/new": {
      const delay = envDelayMs("RELAY_REAL_E2E_SESSION_NEW_DELAY_MS");
      if (delay > 0) await sleep(delay, cancelGeneration);
      currentSessionId = sessionCounter === 0 ? defaultSessionId : `real-e2e-session-${sessionCounter + 1}`;
      sessionCounter++;
      writeSessionCounter(sessionCounter);
      const commandUpdateDelayMs = envDelayMs("RELAY_REAL_E2E_DELAY_AVAILABLE_COMMANDS_UPDATE_MS");
      const sessionResult: Record<string, unknown> = { sessionId: currentSessionId };
      if (commandUpdateDelayMs <= 0) sessionResult.availableCommands = availableCommands();
      result(message.id, sessionResult);
      scheduleAvailableCommandsUpdates(commandUpdateDelayMs);
      return;
    }
    case "session/load": {
      currentSessionId = String((message.params as { sessionId?: unknown } | null)?.sessionId ?? defaultSessionId);
      // Stream recorded history (one ACP update per line) before answering, as real agents do.
      if (process.env.RELAY_REAL_E2E_HISTORY_FILE) {
        for (const line of fs.readFileSync(process.env.RELAY_REAL_E2E_HISTORY_FILE, "utf8").split("\n")) {
          if (line) writeSessionUpdate(JSON.parse(line) as Record<string, unknown>);
        }
      }
      const historyText = process.env.RELAY_REAL_E2E_LOAD_HISTORY_TEXT;
      if (historyText)
        writeSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: historyText } });
      const responseDelay = envDelayMs("RELAY_REAL_E2E_LOAD_RESPONSE_DELAY_MS");
      if (responseDelay > 0) await sleep(responseDelay, cancelGeneration); // like an agent connecting MCP servers
      result(message.id, { sessionId: currentSessionId });
      if (process.env.RELAY_REAL_E2E_REPLAY_NOTIFICATION_CONFIG === "1") {
        writeAfterEventLoopTurns(notificationConfigUpdate(), 20);
      }
      return;
    }
    case "session/list":
      result(message.id, { sessions: [] });
      return;
    case "session/prompt": {
      const text = promptText(message.params);
      if (isAltaSteerPrompt(message.params)) {
        if (activePromptRequests <= 0) {
          recordE2eEvent({ event: "active-turn-input", method: "session/prompt", accepted: false, text });
          result(message.id, altaSteerResponse(false, "no-active-turn"));
          return;
        }
        activeTurnInputs.push(text);
        recordE2eEvent({
          event: "active-turn-input",
          method: "session/prompt",
          accepted: true,
          hasSteerMeta: true,
          text,
        });
        result(message.id, altaSteerResponse(true));
        return;
      }
      if (process.env.RELAY_REAL_E2E_REJECT_CONCURRENT_PROMPTS === "1" && activePromptRequests > 0) {
        recordE2eEvent({ event: "concurrent-prompt", text });
        error(message.id, "Concurrent ACP prompt");
        return;
      }
      activePromptRequests++;
      try {
        recordPromptText(text);
        if (process.env.RELAY_REAL_E2E_LIVE_NOTIFICATION_CONFIG === "1" && text.includes("live config sound guard")) {
          write(notificationConfigUpdate());
        }
        const delay = promptDelayMs(text);
        const generation = cancelGeneration;
        if (delay > 0) {
          await sleep(delay, generation);
          if (generation !== cancelGeneration) {
            if (text.includes("hanging real queue prompt")) return;
            result(message.id, { stopReason: "cancelled", usage: { inputTokens: 1, outputTokens: 0 } });
            return;
          }
        }
        if (text.includes("single choice elicitation e2e")) {
          const marker = text.includes("cancel") ? "cancel" : "submit";
          const cancelProbe = marker === "cancel";
          const fieldKey = cancelProbe ? "decision" : "environment";
          const elicitation = await requestClient("elicitation/create", {
            sessionId: currentSessionId,
            mode: "form",
            message: cancelProbe ? "Keep this release?" : "Choose a deployment environment",
            requestedSchema: {
              type: "object",
              properties: {
                [fieldKey]: {
                  type: "string",
                  title: cancelProbe ? "Keep this release?" : "Which environment should receive the release?",
                  oneOf: cancelProbe
                    ? [
                        { const: "keep", title: "Keep" },
                        { const: "cancel", title: "Cancel" },
                      ]
                    : [
                        { const: "staging", title: "Staging" },
                        { const: "production", title: "Production" },
                      ],
                },
              },
              required: [fieldKey],
            },
          });
          recordE2eEvent({ event: "elicitation-response", marker, response: elicitation.result });
          const action = isRecord(elicitation.result) ? String(elicitation.result.action ?? "unknown") : "unknown";
          writeSessionUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `elicitation ${marker} ${action}` },
          });
          result(message.id, { usage: { inputTokens: 1, outputTokens: 1 } });
          return;
        }
        if (text.includes("terminal title smoke e2e")) {
          writeSessionUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "terminal title smoke started" },
          });
          await sleep(350, generation);
          if (generation !== cancelGeneration) {
            result(message.id, { stopReason: "cancelled", usage: { inputTokens: 1, outputTokens: 0 } });
            return;
          }

          const approval = await requestClient("session/request_permission", {
            sessionId: currentSessionId,
            toolCall: {
              toolCallId: "terminal-title-smoke-approval",
              title: "Write",
              kind: "edit",
              rawInput: { path: "README.md", action: "terminal title smoke" },
            },
            options: permissionOptions,
          });
          recordE2eEvent({ event: "terminal-title-approval", approval });
          if (generation !== cancelGeneration) {
            result(message.id, { stopReason: "cancelled", usage: { inputTokens: 1, outputTokens: 0 } });
            return;
          }

          await sleep(550, generation);
          if (generation !== cancelGeneration) {
            result(message.id, { stopReason: "cancelled", usage: { inputTokens: 1, outputTokens: 0 } });
            return;
          }
          writeSessionUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "terminal title smoke complete" },
          });
          result(message.id, { usage: { inputTokens: 1, outputTokens: 1 } });
          return;
        }
        if (text.includes("terminal title late activity e2e")) {
          writeSessionUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "terminal title late activity started" },
          });
          await sleep(250, generation);
          if (generation !== cancelGeneration) {
            result(message.id, { stopReason: "cancelled", usage: { inputTokens: 1, outputTokens: 0 } });
            return;
          }

          const approval = await requestClient("session/request_permission", {
            sessionId: currentSessionId,
            toolCall: {
              toolCallId: "terminal-title-late-approval",
              title: "Write",
              kind: "edit",
              rawInput: { path: "README.md", action: "terminal title late activity" },
            },
            options: permissionOptions,
          });
          recordE2eEvent({ event: "terminal-title-late-approval", approval });
          result(message.id, { usage: { inputTokens: 1, outputTokens: 1 } });
          setTimeout(() => {
            if (generation !== cancelGeneration) return;
            writeSessionUpdate({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "terminal title late activity complete" },
            });
          }, 650);
          return;
        }
        if (text.includes("quiet status heartbeat e2e")) {
          write({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: currentSessionId,
              update: {
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: "quiet status heartbeat reasoning" },
              },
            },
          });
          const quietDelay = Number.parseInt(process.env.RELAY_REAL_E2E_QUIET_STATUS_DELAY_MS ?? "0", 10);
          if (Number.isFinite(quietDelay) && quietDelay > 0) await sleep(quietDelay, generation);
          write({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: currentSessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "quiet status heartbeat complete" },
              },
            },
          });
          result(message.id, { usage: { inputTokens: 1, outputTokens: 1 } });
          return;
        }
        if (text.includes("real tui stress burst e2e")) {
          await emitTuiStressBurst(message.id, generation);
          return;
        }
        if (text.includes("real tui stress malformed e2e")) {
          emitMalformedStress(message.id);
          return;
        }
        const rawSkillEchoMode = process.env.RELAY_REAL_E2E_RAW_SKILL_ECHO;
        if (rawSkillEchoMode && text.startsWith("/real-skill")) {
          const malformed = rawSkillEchoMode === "malformed";
          write({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: currentSessionId,
              update: {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text: rawRealSkillPrompt(text, malformed) },
              },
            },
          });
          write({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: currentSessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: malformed
                    ? "ack: malformed raw real-skill prompt received"
                    : "ack: raw real-skill prompt received",
                },
              },
            },
          });
          result(message.id, { usage: { inputTokens: 1, outputTokens: 1 } });
          return;
        }
        if (process.env.RELAY_REAL_E2E_COMPACT_SKILL_ACK === "1" && text.includes('<skill name="real-skill"')) {
          write({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: currentSessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "ack: real-skill prompt received" },
              },
            },
          });
          result(message.id, { usage: { inputTokens: 1, outputTokens: 1 } });
          return;
        }
        const scrollPrefix = scrollResponsePrefix(text);
        if (scrollPrefix) {
          write({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: currentSessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: longScrollResponse(scrollPrefix) },
              },
            },
          });
          recordE2eEvent({ event: "long-scroll-response", prefix: scrollPrefix });
          result(message.id, { usage: { inputTokens: 1, outputTokens: 1 } });
          return;
        }
        if (text.includes("subagent live stream e2e")) {
          const scoutInvokeId = "invoke-scout-real-e2e";
          const reviewerInvokeId = "invoke-reviewer-real-e2e";
          const scoutToolId = "child-grep-real-e2e";
          writeSessionUpdate({
            sessionUpdate: "tool_call",
            toolCallId: scoutInvokeId,
            title: "invoke_agent",
            kind: "other",
            rawInput: {
              agent: "scout",
              message: "Map Relay ACP subagent flow before editing",
              background: false,
            },
            status: "in_progress",
          });
          writeSessionUpdate({
            sessionUpdate: "tool_call",
            toolCallId: reviewerInvokeId,
            title: "invoke_agent",
            kind: "other",
            rawInput: {
              agent: "reviewer",
              message: "Check subagent live stream isolation",
              background: true,
            },
            status: "in_progress",
          });
          writeSubagentUpdate(
            {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "scout inspecting mapping" },
            },
            { invokingToolCallId: scoutInvokeId, childSessionId: "child-scout-real-e2e" },
          );
          writeSubagentUpdate(
            {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "reviewer stays isolated" },
            },
            { invokingToolCallId: reviewerInvokeId, childSessionId: "child-reviewer-real-e2e" },
          );
          writeSubagentUpdate(
            {
              sessionUpdate: "tool_call",
              toolCallId: scoutToolId,
              title: "grep",
              kind: "search",
              rawInput: { pattern: "subagent", path: "src" },
              status: "in_progress",
            },
            { invokingToolCallId: scoutInvokeId, childSessionId: "child-scout-real-e2e" },
          );
          await sleep(3000, generation);
          if (generation !== cancelGeneration) {
            result(message.id, { stopReason: "cancelled", usage: { inputTokens: 1, outputTokens: 0 } });
            return;
          }
          writeSubagentUpdate(
            {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "bad metadata leak sentinel" },
            },
            { invokingToolCallId: 42, childSessionId: "bad-child-real-e2e" },
          );
          writeSubagentUpdate(
            {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "orphan child leak sentinel" },
            },
            { invokingToolCallId: "missing-parent-real-e2e", childSessionId: "orphan-child-real-e2e" },
          );
          writeSubagentUpdate(
            {
              sessionUpdate: "tool_call_update",
              toolCallId: scoutToolId,
              title: "grep",
              kind: "search",
              rawOutput: "Found 1 match",
              status: "completed",
            },
            { invokingToolCallId: scoutInvokeId, childSessionId: "child-scout-real-e2e" },
          );
          writeSubagentUpdate(
            {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "scout found renderer seam" },
            },
            { invokingToolCallId: scoutInvokeId, childSessionId: "child-scout-real-e2e", status: "completed" },
          );
          writeSubagentUpdate(
            {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "reviewer checked isolation" },
            },
            {
              invokingToolCallId: reviewerInvokeId,
              childSessionId: "child-reviewer-real-e2e",
              status: "completed",
            },
          );
          writeSessionUpdate({
            sessionUpdate: "tool_call_update",
            toolCallId: scoutInvokeId,
            title: "invoke_agent",
            rawOutput: "scout complete",
            status: "completed",
          });
          writeSessionUpdate({
            sessionUpdate: "tool_call_update",
            toolCallId: reviewerInvokeId,
            title: "invoke_agent",
            rawOutput: "reviewer still isolated",
            status: "completed",
          });
          writeSessionUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "subagent live stream e2e complete" },
          });
          recordE2eEvent({ event: "subagent-live-stream-complete" });
          result(message.id, { usage: { inputTokens: 1, outputTokens: 1 } });
          return;
        }
        if (text.includes("normalized diff e2e")) {
          write({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: currentSessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "call_relay_real_diff",
                title: "custom_diff_tool",
                kind: "edit",
                status: "pending",
              },
            },
          });
          write({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: currentSessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "call_relay_real_diff",
                status: "completed",
                content: [
                  {
                    type: "diff",
                    path: `${process.cwd()}/src/relay-real-diff.txt`,
                    oldText: "alpha\nbeta\n",
                    newText: "alpha\nBETA\ngamma\n",
                  },
                ],
              },
            },
          });
          write({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: currentSessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "normalized diff e2e complete" },
              },
            },
          });
          result(message.id, { usage: { inputTokens: 1, outputTokens: 1 } });
          return;
        }
        const suffix =
          text.includes("slow real active-turn prompt") && activeTurnInputs.length > 0
            ? ` guidance: ${activeTurnInputs.join(" | ")}`
            : "";
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: currentSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `ack: ${text.replaceAll("\n", " ↵ ")}${suffix}` },
            },
          },
        });
        result(message.id, { usage: { inputTokens: 1, outputTokens: 1 } });
        return;
      } finally {
        activePromptRequests--;
      }
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

const lines = readline.createInterface({ input: process.stdin });

for await (const rawLine of lines) {
  const line = rawLine.trim();
  if (!line) continue;
  try {
    void handle(JSON.parse(line) as JsonRpcMessage).catch((err) => {
      process.stderr.write(`bad message: ${err}\n`);
    });
  } catch (err) {
    process.stderr.write(`bad message: ${err}\n`);
  }
}
