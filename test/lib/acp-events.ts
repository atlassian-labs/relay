import type { FileChanges } from "../../src/core/types";
import type { SlashCommand } from "../../src/ui/autocomplete";
import type { RelaySessionUpdate } from "../../src/acp/sdk";

export type AcpEvent = RelaySessionUpdate;

export function acpUserMessageChunk(text: string): AcpEvent {
  return {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text },
  };
}

export function acpAgentMessageChunk(text: string): AcpEvent {
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  };
}

export function acpThinkingChunk(text: string): AcpEvent {
  return {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text },
  };
}

export function acpToolCallStart(opts: {
  toolCallId: string;
  toolName: string;
  toolKind?: string;
  rawInput?: unknown;
  status?: "pending" | "in_progress" | "completed" | "failed" | "running" | "success" | "error";
}): AcpEvent {
  return {
    sessionUpdate: "tool_call",
    toolCallId: opts.toolCallId,
    title: opts.toolName,
    kind: opts.toolKind,
    rawInput: opts.rawInput,
    status: normalizeAcpStatus(opts.status),
  } as AcpEvent;
}

export function acpToolCallUpdate(opts: {
  toolCallId: string;
  toolName?: string;
  toolKind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed" | "running" | "success" | "error";
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  fileChanges?: FileChanges;
}): AcpEvent {
  const rawOutput =
    opts.fileChanges && opts.rawOutput === undefined ? { fileChanges: opts.fileChanges } : opts.rawOutput;

  return {
    sessionUpdate: "tool_call_update",
    toolCallId: opts.toolCallId,
    title: opts.toolName,
    kind: opts.toolKind,
    status: normalizeAcpStatus(opts.status),
    rawInput: opts.rawInput,
    rawOutput,
    content: opts.content,
  } as AcpEvent;
}

export function acpToolTextContent(text: string): unknown[] {
  return [{ type: "content", content: { type: "text", text } }];
}

export function acpToolDiffContent(opts: { path: string; oldText?: string | null; newText: string }): unknown[] {
  return [{ type: "diff", path: opts.path, oldText: opts.oldText, newText: opts.newText }];
}

export function acpToolMixedContent(
  items: Array<string | { path: string; oldText?: string | null; newText: string }>,
): unknown[] {
  return items.map((item) => (typeof item === "string" ? acpToolTextContent(item)[0] : acpToolDiffContent(item)[0]));
}

export function acpUsageUpdate(opts: {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  size?: number;
  used?: number;
}): AcpEvent {
  return {
    sessionUpdate: "usage_update",
    size: opts.size,
    used: opts.used,
    usage: {
      inputTokens: opts.inputTokens ?? 0,
      outputTokens: opts.outputTokens ?? 0,
      cachedReadTokens: opts.cachedReadTokens ?? 0,
      cachedWriteTokens: opts.cachedWriteTokens ?? 0,
    },
  } as AcpEvent;
}

export function acpCurrentModeUpdate(modeId: string): AcpEvent {
  return {
    sessionUpdate: "current_mode_update",
    currentModeId: modeId,
  };
}

export function acpSessionInfoUpdate(title: string): AcpEvent {
  return {
    sessionUpdate: "session_info_update",
    title,
  };
}

export function acpAvailableCommands(commands: SlashCommand[]): AcpEvent {
  return {
    sessionUpdate: "available_commands_update",
    availableCommands: commands.map(({ name, description }) => ({ name, description })),
  };
}

export function acpPromptResponse(
  opts: {
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    contextWindowTokens?: number;
  } = {},
): Record<string, unknown> {
  return {
    stopReason: "end_turn",
    _meta: opts.contextWindowTokens === undefined ? undefined : { contextWindowTokens: opts.contextWindowTokens },
    usage: {
      inputTokens: opts.inputTokens ?? 0,
      outputTokens: opts.outputTokens ?? 0,
      cachedReadTokens: opts.cachedReadTokens ?? 0,
      cachedWriteTokens: opts.cachedWriteTokens ?? 0,
    },
  };
}

function normalizeAcpStatus(status: string | undefined): string | undefined {
  switch (status) {
    case "running":
      return "in_progress";
    case "success":
      return "completed";
    case "error":
      return "failed";
    case undefined:
    default:
      return status;
  }
}
