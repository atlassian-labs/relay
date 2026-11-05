import { $RAW } from "solid-js/store";
import type { ChatBlock, ToolBlock } from "../state";
import type { RelayPluginEvent, RelayThreadEventContext, RelayToolLifecycleStatus } from "../../plugins";

export type PluginEventContext = RelayThreadEventContext & {
  readonly raw?: unknown;
};

type PluginMessageBlockType = "content" | "thinking";

type PluginMessageSnapshot = {
  readonly kind: "message";
  readonly id: string;
  readonly blockType: PluginMessageBlockType;
  readonly content: string;
  readonly finalized: boolean;
};

type PluginToolSnapshot = {
  readonly kind: "tool";
  readonly id: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: RelayToolLifecycleStatus;
  readonly input: unknown;
  readonly output: unknown;
};

export type PluginBlockSnapshot =
  | PluginMessageSnapshot
  | PluginToolSnapshot
  | { readonly kind: "other"; readonly id: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolStatus(value: ToolBlock["status"]): RelayToolLifecycleStatus {
  return value;
}

function rawToolInput(update: Record<string, unknown>, toolCall: Record<string, unknown>): unknown {
  return update.rawInput ?? toolCall.rawInput ?? toolCall.input ?? undefined;
}

function rawToolOutput(update: Record<string, unknown>, toolCall: Record<string, unknown>): unknown {
  return update.rawOutput ?? toolCall.rawOutput ?? toolCall.output ?? undefined;
}

function toolStatusFromRaw(value: unknown): RelayToolLifecycleStatus {
  if (value === "pending" || value === "running" || value === "success" || value === "error" || value === "approval") {
    return value;
  }
  if (value === "completed" || value === "complete" || value === "succeeded" || value === "success") return "success";
  if (value === "failed" || value === "error") return "error";
  if (value === "in_progress" || value === "running") return "running";
  return "pending";
}

function terminalStatus(status: RelayToolLifecycleStatus): boolean {
  return status === "success" || status === "error";
}

function messageEvent(
  type: Extract<RelayPluginEvent["type"], "message:start" | "message:update" | "message:end">,
  block: PluginMessageSnapshot,
  ctx: PluginEventContext,
  delta?: string,
): Extract<RelayPluginEvent, { readonly type: "message:start" | "message:update" | "message:end" }> {
  return {
    type,
    threadId: ctx.threadId,
    sessionId: ctx.sessionId,
    cwd: ctx.cwd,
    blockId: block.id,
    role: "assistant",
    blockType: block.blockType,
    content: block.content,
    ...(delta !== undefined ? { delta } : {}),
    ...(ctx.raw !== undefined ? { raw: ctx.raw } : {}),
  };
}

function toolEvent(
  type: Extract<RelayPluginEvent["type"], "tool:start" | "tool:update" | "tool:end">,
  block: PluginToolSnapshot,
  ctx: PluginEventContext,
): Extract<RelayPluginEvent, { readonly type: "tool:start" | "tool:update" | "tool:end" }> {
  return {
    type,
    threadId: ctx.threadId,
    sessionId: ctx.sessionId,
    cwd: ctx.cwd,
    blockId: block.id,
    toolName: block.toolName,
    toolCallId: block.toolCallId,
    status: block.status,
    input: block.input,
    output: block.output,
    ...(ctx.raw !== undefined ? { raw: ctx.raw } : {}),
  };
}

function toolSnapshotChanged(before: PluginToolSnapshot, after: PluginToolSnapshot): boolean {
  return (
    before.toolName !== after.toolName ||
    before.toolCallId !== after.toolCallId ||
    before.status !== after.status ||
    before.input !== after.input ||
    before.output !== after.output
  );
}

function pluginBlockSnapshot(block: ChatBlock): PluginBlockSnapshot {
  if (block.type === "content" || block.type === "thinking") {
    return {
      kind: "message",
      id: block.id,
      blockType: block.type,
      content: block.content,
      finalized: block.finalized,
    };
  }
  if (block.type === "tool") {
    return {
      kind: "tool",
      id: block.id,
      toolCallId: block.toolCallId,
      toolName: block.toolName,
      status: toolStatus(block.status),
      input: block.rawInput ?? block.display,
      output: block.rawOutput ?? block.details ?? null,
    };
  }
  return { kind: "other", id: block.id };
}

// Runs twice per streamed update, so read the raw array: store proxy reads are about 40x slower.
export function snapshotPluginBlocks(blocks: readonly ChatBlock[]): readonly PluginBlockSnapshot[] {
  return ((blocks as { [$RAW]?: readonly ChatBlock[] })[$RAW] ?? blocks).map(pluginBlockSnapshot);
}

/** Every event type `pluginEventsFromBlockTransition` emits. Its return type enforces this list. */
export const PLUGIN_BLOCK_EVENT_TYPES = [
  "message:start",
  "message:update",
  "message:end",
  "tool:start",
  "tool:update",
  "tool:end",
] as const satisfies readonly RelayPluginEvent["type"][];

type PluginBlockEvent = Extract<RelayPluginEvent, { readonly type: (typeof PLUGIN_BLOCK_EVENT_TYPES)[number] }>;

export function pluginEventsFromBlockTransition(
  before: readonly PluginBlockSnapshot[],
  after: readonly PluginBlockSnapshot[],
  ctx: PluginEventContext,
): readonly PluginBlockEvent[] {
  const events: PluginBlockEvent[] = [];
  const beforeById = new Map(before.map((block) => [block.id, block]));

  for (const block of after) {
    const previous = beforeById.get(block.id);
    if (block.kind === "message") {
      const previousMessage = previous?.kind === "message" ? previous : null;
      if (!previousMessage) {
        events.push(messageEvent("message:start", block, ctx));
        if (block.content.length > 0) events.push(messageEvent("message:update", block, ctx, block.content));
        if (block.finalized) events.push(messageEvent("message:end", block, ctx));
        continue;
      }
      if (previousMessage.content !== block.content) {
        const delta = block.content.startsWith(previousMessage.content)
          ? block.content.slice(previousMessage.content.length)
          : block.content;
        events.push(messageEvent("message:update", block, ctx, delta));
      }
      if (!previousMessage.finalized && block.finalized) {
        events.push(messageEvent("message:end", block, ctx));
      }
      continue;
    }

    if (block.kind === "tool") {
      const previousTool = previous?.kind === "tool" ? previous : null;
      if (!previousTool) {
        events.push(toolEvent("tool:start", block, ctx));
        events.push(toolEvent("tool:update", block, ctx));
        if (terminalStatus(block.status)) events.push(toolEvent("tool:end", block, ctx));
        continue;
      }
      if (toolSnapshotChanged(previousTool, block)) events.push(toolEvent("tool:update", block, ctx));
      if (!terminalStatus(previousTool.status) && terminalStatus(block.status)) {
        events.push(toolEvent("tool:end", block, ctx));
      }
    }
  }

  return events;
}

export function pluginToolUpdateEvent(
  update: unknown,
  ctx: PluginEventContext,
): Extract<RelayPluginEvent, { readonly type: "tool:update" }> | null {
  if (!isRecord(update)) return null;
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return null;
  const toolCall = isRecord(update.toolCall) ? update.toolCall : {};
  const toolName = String(update.title ?? update.kind ?? toolCall.title ?? toolCall.kind ?? "tool");
  const toolCallId = String(update.toolCallId ?? toolCall.toolCallId ?? "");
  const status = toolStatusFromRaw(update.status ?? toolCall.status);
  return {
    type: "tool:update",
    threadId: ctx.threadId,
    sessionId: ctx.sessionId,
    cwd: ctx.cwd,
    blockId: toolCallId,
    toolName,
    toolCallId,
    status,
    input: rawToolInput(update, toolCall),
    output: rawToolOutput(update, toolCall),
    raw: update,
  };
}
