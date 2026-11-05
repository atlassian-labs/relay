import type { Usage } from "../core/types";
import { skillInvocationsMatch, userBlockSkillInvocation } from "../core/user-message";
import { activityFromAcpSessionUpdate, type AcpActivity } from "../acp/activity";
import type { PromptResponse } from "../acp/sdk";
import {
  nextBlockId,
  type ChatBlock,
  type ContentBlock,
  type MessageContentItem,
  type ThinkingBlock,
  type ToolBlock,
  type ToolContentItem,
  type ToolDiff,
  type ToolSubagentProgressItem,
  type ToolSubagentState,
  type ToolSubagentStatus,
  type UserBlock,
} from "../core/conversation";
import {
  acpStatusToToolStatus,
  formatToolArgs,
  formatToolOutput,
  tryExtractFileChanges,
  usageFromAcp,
} from "../acp/client";
import {
  acpThreadEventFromSessionUpdate,
  relayAcpSessionUpdate,
  textFromAcpThreadContent,
  textFromAcpThreadToolContent,
  type AcpThreadContent,
  type AcpThreadEvent,
  type AcpThreadToolContent,
  type RelayAcpSessionUpdate,
} from "../acp/thread-events";
import { parseAltaSubagentMetadata, type AcpMetadataEnvelope, type AltaSubagentMetadata } from "../acp/subagents";
import { nowMs } from "../platform/time";

export type RelayAcpPromptResponse = PromptResponse | (Record<string, unknown> & { readonly stopReason?: unknown });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type AcpTextSegment = { type: "content" | "thinking"; text: string; contentItem: MessageContentItem };
type AcpToolEvent = Extract<AcpThreadEvent, { type: "toolCall" }>;

function isSystemReminderContent(content: AcpThreadContent): boolean {
  return content.type === "text" && content.text.trimStart().startsWith("system-reminder:");
}

function messageContentItemFromThreadContent(content: AcpThreadContent): MessageContentItem {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "image":
      return { type: "image", data: content.data, mimeType: content.mimeType };
    case "audio":
      return { type: "audio", data: content.data, mimeType: content.mimeType };
    case "resourceLink":
      return {
        type: "resourceLink",
        name: content.name,
        uri: content.uri,
        description: content.description,
        mimeType: content.mimeType,
      };
    case "resource":
      return {
        type: "resource",
        uri: content.uri,
        mimeType: content.mimeType,
        text: content.text,
        blob: content.blob,
      };
  }
}

function toolContentItemFromThreadContent(content: AcpThreadToolContent): ToolContentItem | undefined {
  switch (content.type) {
    case "diff":
      return { type: "diff", diff: { path: content.path, oldText: content.oldText, newText: content.newText } };
    case "terminal":
      return { type: "terminal", terminalId: content.terminalId };
    case "content": {
      const item = messageContentItemFromThreadContent(content.content);
      return item.type === "text" ? { type: "text", text: item.text } : item;
    }
  }
}

function extractToolContent(content: readonly AcpThreadToolContent[] | undefined): ToolContentItem[] | undefined {
  if (!content) return undefined;
  const items = content
    .map((item) => toolContentItemFromThreadContent(item))
    .filter((item): item is ToolContentItem => item !== undefined);
  return items.length > 0 ? items : undefined;
}

function textSegmentsFromThreadContent(
  content: AcpThreadContent | undefined,
  fallbackType: AcpTextSegment["type"],
): AcpTextSegment[] {
  if (!content) return [];
  const text = textFromAcpThreadContent(content, "message");
  return text ? [{ type: fallbackType, text, contentItem: messageContentItemFromThreadContent(content) }] : [];
}

function appendContentItem(app: AcpConversationAdapter, blockId: string, item: MessageContentItem): void {
  const block = app.state.blocks.findLast((entry) => entry.id === blockId);
  if (!block || (block.type !== "content" && block.type !== "thinking" && block.type !== "user")) return;
  app.updateBlock(blockId, { contentItems: [...(block.contentItems ?? []), item] } as Partial<ChatBlock>);
}

function appendedMessageContentItems(
  block: ContentBlock | ThinkingBlock | UserBlock,
  item: MessageContentItem,
): MessageContentItem[] {
  const items = block.contentItems ?? [];
  const last = items.at(-1);
  if (block.type === "user" || item.type !== "text" || last?.type !== "text") return [...items, item];
  return [...items.slice(0, -1), { type: "text", text: last.text + item.text }];
}

/**
 * Appends an ACP text fragment and its structured content item to an existing message block.
 *
 * Adjacent assistant text chunks are coalesced so a long stream does not build
 * and repeatedly copy an item array with one entry per token.
 *
 * @param app - Conversation adapter that owns the canonical block state.
 * @param blockId - Identifier of the content, thinking, or user block to extend.
 * @param text - Plain-text fragment to append to the block content.
 * @param item - Structured ACP content item corresponding to the appended text.
 * @returns Nothing; the adapter is updated in place.
 */
function appendTextContentItem(
  app: AcpConversationAdapter,
  blockId: string,
  text: string,
  item: MessageContentItem,
): void {
  const block = app.state.blocks.findLast((entry) => entry.id === blockId);
  if (!block || (block.type !== "content" && block.type !== "thinking" && block.type !== "user")) return;
  app.updateBlock(blockId, {
    content: `${block.content}${text}`,
    contentItems: appendedMessageContentItems(block, item),
  } as Partial<ChatBlock>);
}

function toolContentItemText(item: ToolContentItem): string | undefined {
  switch (item.type) {
    case "text":
      return item.text;
    case "image":
      return "`Image`";
    case "audio":
      return "`Audio`";
    case "resourceLink":
      return item.uri;
    case "resource":
      return item.text ?? item.uri;
    case "terminal":
      return `Terminal: ${item.terminalId}`;
    case "diff":
      return undefined;
  }
}

function textFromToolContent(content: ToolContentItem[] | undefined): string {
  if (!content) return "";
  return content
    .map((item) => toolContentItemText(item))
    .filter(Boolean)
    .join("\n");
}

function firstDiffFromToolContent(content: ToolContentItem[] | undefined): ToolDiff | undefined {
  return content?.find((item): item is Extract<ToolContentItem, { type: "diff" }> => item.type === "diff")?.diff;
}

function statusValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function commandFromRawInput(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const nested = isRecord(value.tool_call_part) ? value.tool_call_part : undefined;
  const command = value.command ?? value.cmd ?? nested?.command ?? nested?.cmd;
  return typeof command === "string" && command.trim() ? command : undefined;
}

function toolNameFromRawInput(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const toolName = value.tool_name;
  if (typeof toolName !== "string" || !toolName.trim()) return undefined;
  return value.tool_call_part !== undefined ? toolName : undefined;
}

function looksLikeShellCommand(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/(?:^|\s)(?:&&|\|\||\||;|>|<)(?:\s|$)/.test(trimmed)) return true;
  return /^(?:\.?\/|git|bun|npm|pnpm|yarn|node|python3?|bash|zsh|sh|ls|rg|grep|find|sed|awk|curl|mkdir|rm|cp|mv|chmod|go|cargo|docker)\b/.test(
    trimmed,
  );
}

export interface AcpConversationAdapter {
  state: {
    blocks: ChatBlock[];
    currentBlockId: string | null;
    elapsedSeconds?: number;
    running?: boolean;
    spinnerActive?: boolean;
    cwd?: string;
  };
  addBlock: (block: ChatBlock) => void;
  updateBlock: (id: string, updates: Partial<ChatBlock>) => void;
  appendToBlock: (id: string, text: string) => void;
  removeBlock: (id: string) => void;
  setCurrentBlockId: (id: string | null) => void;
  setState: (...args: unknown[]) => void;
  onActivity?: (activity: AcpActivity) => void;
  /** Indexed lookup of the last tool block for a call; without it, lookups scan the transcript from the end. */
  findToolBlock?: (toolCallId: string) => ToolBlock | undefined;
}

function ensureStreamingBlock(app: AcpConversationAdapter, type: "content" | "thinking"): string {
  const currentId = app.state.currentBlockId;
  if (currentId) {
    const current = app.state.blocks.findLast((b) => b.id === currentId);
    if (current?.type === type) return currentId;
    app.updateBlock(currentId, { finalized: true });
    app.setCurrentBlockId(null);
  }

  const id = nextBlockId();
  const block: ContentBlock | ThinkingBlock = {
    type,
    id,
    content: "",
    finalized: false,
  };
  app.addBlock(block);
  app.setCurrentBlockId(id);
  return id;
}

function finishStreamingBlock(app: AcpConversationAdapter, type: "content" | "thinking" | "user") {
  const currentId = app.state.currentBlockId;
  if (!currentId) return;
  const current = app.state.blocks.findLast((b) => b.id === currentId);
  if (current?.type !== type) return;
  if (type !== "user") app.updateBlock(currentId, { finalized: true });
  app.setCurrentBlockId(null);
}

function ensureUserMessageBlock(app: AcpConversationAdapter): string {
  const currentId = app.state.currentBlockId;
  if (currentId) {
    const current = app.state.blocks.findLast((b) => b.id === currentId);
    if (current?.type === "user") return currentId;
    if (current?.type === "content" || current?.type === "thinking") app.updateBlock(currentId, { finalized: true });
    app.setCurrentBlockId(null);
  }

  const id = nextBlockId();
  const block: UserBlock = { type: "user", id, content: "", origin: "acp" };
  app.addBlock(block);
  app.setCurrentBlockId(id);
  return id;
}

function finishUserMessageBlock(app: AcpConversationAdapter) {
  finishStreamingBlock(app, "user");
}

function removeDuplicateLocalSlashSkillEcho(app: AcpConversationAdapter, acpUserBlockId: string): void {
  const blocks = app.state.blocks;
  const acpBlockIndex = blocks.findLastIndex((block) => block.id === acpUserBlockId);
  const acpBlock = blocks[acpBlockIndex];
  if (acpBlockIndex < 1 || acpBlock?.type !== "user" || acpBlock.origin !== "acp") return;
  const acpSkill = userBlockSkillInvocation(acpBlock);
  if (!acpSkill) return;

  for (let index = acpBlockIndex - 1; index >= 0; index--) {
    const candidate = blocks[index];
    if (candidate.type !== "user") {
      if (candidate.type === "content" || candidate.type === "thinking" || candidate.type === "tool") break;
      continue;
    }
    const candidateSkill =
      candidate.origin === "acp" ? null : userBlockSkillInvocation(candidate, { allowLocalSlash: true });
    if (skillInvocationsMatch(candidateSkill, acpSkill)) {
      app.removeBlock(candidate.id);
    }
    return;
  }
}

export function findLastToolBlock(blocks: readonly ChatBlock[], toolCallId: string): ToolBlock | undefined {
  return blocks.findLast((block): block is ToolBlock => block.type === "tool" && block.toolCallId === toolCallId);
}

function findToolBlock(app: AcpConversationAdapter, toolCallId: string): ToolBlock | undefined {
  return app.findToolBlock ? app.findToolBlock(toolCallId) : findLastToolBlock(app.state.blocks, toolCallId);
}

function toolNameFromUpdate(update: AcpToolEvent, rawInput: unknown, fallback = "tool"): string {
  const kind = update.kind;
  if (kind === "execute") return "bash";
  const rawToolName = toolNameFromRawInput(rawInput);
  if (rawToolName) return rawToolName;
  if (commandFromRawInput(rawInput)) return "bash";
  if (typeof update.title === "string" && !update.rawInput && looksLikeShellCommand(update.title)) return "bash";
  return typeof update.title === "string" && update.title ? update.title : fallback;
}

const MAX_SUBAGENT_PROGRESS_ITEMS = 6;
const MAX_SUBAGENT_PROGRESS_TEXT = 240;

function compactProgressText(text: string, max = MAX_SUBAGENT_PROGRESS_TEXT): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function markdownProgressText(text: string, max = MAX_SUBAGENT_PROGRESS_TEXT): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1).trimEnd()}…` : normalized;
}

function subagentStatusFromMetadata(metadata: AltaSubagentMetadata): ToolSubagentStatus | undefined {
  switch (metadata.status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
    case "running":
      return "running";
    case undefined:
    default:
      return undefined;
  }
}

function subagentProgressFromEvent(event: AcpThreadEvent): ToolSubagentProgressItem | null {
  switch (event.type) {
    case "agentMessage": {
      const text = event.content ? textFromAcpThreadContent(event.content, "message") : undefined;
      return text ? { kind: "message", text: markdownProgressText(text) } : null;
    }
    case "agentThought": {
      const text = event.content ? textFromAcpThreadContent(event.content, "message") : undefined;
      return text ? { kind: "thinking", text: markdownProgressText(text) } : null;
    }
    case "toolCall": {
      const status = acpStatusToToolStatus(statusValue(event.status));
      const toolName = toolNameFromUpdate(event, event.rawInput, "tool");
      const activityName = toolName === "tool" && event.kind ? event.kind : toolName;
      return {
        kind: "tool",
        text: compactProgressText(activityName),
        status,
        toolCallId: event.toolCallId,
      };
    }
    case "availableCommands":
    case "configOption":
    case "currentMode":
    case "plan":
    case "planRemoved":
    case "planUpdate":
    case "sessionInfo":
    case "usage":
    case "userMessage":
    default:
      return null;
  }
}

function appendSubagentProgress(
  progress: readonly ToolSubagentProgressItem[],
  item: ToolSubagentProgressItem | null,
): ToolSubagentProgressItem[] {
  if (!item) return [...progress];
  const next = [...progress];
  if (item.kind === "tool" && item.toolCallId) {
    const existingIndex = next.findIndex(
      (candidate) => candidate.kind === "tool" && candidate.toolCallId === item.toolCallId,
    );
    if (existingIndex >= 0) {
      const existing = next[existingIndex];
      next[existingIndex] = {
        ...existing,
        ...item,
        text: item.text === "tool" ? existing.text : item.text,
      };
      return next.slice(-MAX_SUBAGENT_PROGRESS_ITEMS);
    }
  }
  const last = next.at(-1);
  if ((item.kind === "message" || item.kind === "thinking") && last?.kind === item.kind && !last.toolCallId) {
    next[next.length - 1] = { ...last, text: markdownProgressText(`${last.text} ${item.text}`) };
  } else {
    next.push(item);
  }
  return next.slice(-MAX_SUBAGENT_PROGRESS_ITEMS);
}

function rawOutputSessionId(block: ToolBlock): string | undefined {
  if (isRecord(block.rawOutput) && typeof block.rawOutput.sessionId === "string") return block.rawOutput.sessionId;
  if (typeof block.rawOutput === "string") return /subagent-[A-Za-z0-9_-]+/u.exec(block.rawOutput)?.[0];
  return undefined;
}

function delegatedPrompt(block: ToolBlock): string | undefined {
  if (!isRecord(block.rawInput)) return undefined;
  const prompt = block.rawInput.message ?? block.rawInput.prompt;
  return typeof prompt === "string" && prompt.trim() ? prompt : undefined;
}

function findSubagentParent(app: AcpConversationAdapter, metadata: AltaSubagentMetadata): ToolBlock | undefined {
  if (metadata.invokingToolCallId) {
    const anchored = findToolBlock(app, metadata.invokingToolCallId);
    if (anchored) return anchored;
  }
  if (!metadata.childSessionId) return undefined;
  for (let index = app.state.blocks.length - 1; index >= 0; index--) {
    const block = app.state.blocks[index];
    if (
      block.type === "tool" &&
      (block.subagent?.childSessionId === metadata.childSessionId ||
        rawOutputSessionId(block) === metadata.childSessionId)
    ) {
      return block;
    }
  }
  return undefined;
}

type PendingSubagentUpdate = {
  readonly update: unknown;
  readonly event: AcpThreadEvent;
  readonly metadata: AltaSubagentMetadata;
};

const MAX_PENDING_SUBAGENT_SESSIONS = 32;
const MAX_PENDING_SUBAGENT_UPDATES_PER_SESSION = 200;
const pendingSubagentUpdates = new WeakMap<AcpConversationAdapter, Map<string, PendingSubagentUpdate[]>>();

function queuePendingSubagentUpdate(
  app: AcpConversationAdapter,
  childSessionId: string,
  pending: PendingSubagentUpdate,
): void {
  let bySession = pendingSubagentUpdates.get(app);
  if (!bySession) {
    bySession = new Map();
    pendingSubagentUpdates.set(app, bySession);
  }
  if (!bySession.has(childSessionId) && bySession.size >= MAX_PENDING_SUBAGENT_SESSIONS) {
    const oldestSessionId = bySession.keys().next().value;
    if (typeof oldestSessionId === "string") bySession.delete(oldestSessionId);
  }
  const updates = bySession.get(childSessionId) ?? [];
  updates.push(pending);
  bySession.set(childSessionId, updates.slice(-MAX_PENDING_SUBAGENT_UPDATES_PER_SESSION));
}

function childUpdateWithoutAttribution(update: unknown): unknown {
  if (!isRecord(update) || !isRecord(update._meta)) return update;
  const meta = { ...update._meta };
  delete meta["alta/subagent"];
  return { ...update, _meta: meta };
}

function applyUpdateToSubagentConversation(update: unknown, state: ToolSubagentState, cwd?: string): ToolSubagentState {
  const nested = {
    blocks: [...(state.blocks ?? [])],
    currentBlockId: state.currentBlockId ?? null,
    cwd,
  };
  const adapter: AcpConversationAdapter = {
    state: nested,
    addBlock: (block) => nested.blocks.push(block),
    updateBlock: (id, updates) => {
      const index = nested.blocks.findIndex((block) => block.id === id);
      if (index >= 0) nested.blocks[index] = { ...nested.blocks[index], ...updates } as ChatBlock;
    },
    appendToBlock: (id, text) => {
      const index = nested.blocks.findIndex((entry) => entry.id === id);
      const block = nested.blocks[index];
      if (block && (block.type === "content" || block.type === "thinking" || block.type === "user")) {
        nested.blocks[index] = { ...block, content: block.content + text };
      }
    },
    removeBlock: (id) => {
      nested.blocks = nested.blocks.filter((block) => block.id !== id);
    },
    setCurrentBlockId: (id) => {
      nested.currentBlockId = id;
    },
    setState: (key: unknown, value: unknown) => {
      if (key !== "blocks" && key !== "currentBlockId") return;
      const name = key as "blocks" | "currentBlockId";
      const previous = nested[name];
      (nested as Record<string, unknown>)[name] =
        typeof value === "function" ? (value as (old: unknown) => unknown)(previous) : value;
    },
  };
  applyAcpSessionUpdate(childUpdateWithoutAttribution(update), adapter);
  const updated = { ...state, blocks: nested.blocks, currentBlockId: nested.currentBlockId };
  return state.status === "running" ? updated : finalizeSubagentConversation(updated);
}

function finalizeSubagentConversation(state: ToolSubagentState): ToolSubagentState {
  const currentBlockId = state.currentBlockId;
  if (!currentBlockId) return state;
  const blocks = (state.blocks ?? []).map((block) => {
    if (block.id !== currentBlockId || (block.type !== "content" && block.type !== "thinking")) return block;
    return { ...block, finalized: true };
  });
  return { ...state, blocks, currentBlockId: null };
}

function subagentStateFromInvokingToolResult(
  state: ToolSubagentState | undefined,
  mappedStatus: ToolBlock["status"],
): ToolSubagentState | undefined {
  if (!state || state.background === true || (mappedStatus !== "success" && mappedStatus !== "error")) return state;
  const terminalStatus: ToolSubagentStatus = mappedStatus;
  const terminalState =
    state.status === "running" ? { ...state, status: terminalStatus, finishedAt: state.finishedAt ?? nowMs() } : state;
  return finalizeSubagentConversation(terminalState);
}

function reduceSubagentState(
  existing: ToolSubagentState | undefined,
  metadata: AltaSubagentMetadata,
  event: AcpThreadEvent,
  invokingToolCallId: string,
): ToolSubagentState {
  const progress = appendSubagentProgress(existing?.progress ?? [], subagentProgressFromEvent(event));
  const status = subagentStatusFromMetadata(metadata) ?? existing?.status ?? "running";
  return {
    ...existing,
    invokingToolCallId,
    childSessionId: metadata.childSessionId ?? existing?.childSessionId,
    parentSessionId: metadata.parentSessionId ?? existing?.parentSessionId,
    agentName: metadata.agentName ?? existing?.agentName,
    background: metadata.background ?? existing?.background,
    status,
    progress,
    blocks: existing?.blocks ?? [],
    currentBlockId: existing?.currentBlockId ?? null,
    startedAt: existing?.startedAt ?? nowMs(),
    ...(status === "running" ? {} : { finishedAt: existing?.finishedAt ?? nowMs() }),
  };
}

function routeSubagentUpdate(
  update: unknown,
  event: AcpThreadEvent,
  metadata: AltaSubagentMetadata,
  app: AcpConversationAdapter,
): boolean {
  const parent = findSubagentParent(app, metadata);
  if (!parent) return false;

  let state = reduceSubagentState(parent.subagent, metadata, event, parent.toolCallId);
  const prompt = parent.subagent ? undefined : delegatedPrompt(parent);
  if (prompt) {
    state = {
      ...state,
      blocks: [{ type: "user", id: nextBlockId(), content: prompt, origin: "acp" }],
      currentBlockId: null,
    };
  }
  app.updateBlock(parent.id, {
    subagent: applyUpdateToSubagentConversation(update, state, app.state.cwd),
  } as Partial<ToolBlock>);
  return true;
}

function drainPendingSubagentUpdates(app: AcpConversationAdapter, block: ToolBlock): void {
  const childSessionId = rawOutputSessionId(block);
  if (!childSessionId) return;
  const bySession = pendingSubagentUpdates.get(app);
  const pending = bySession?.get(childSessionId);
  if (!pending) return;
  bySession?.delete(childSessionId);
  if (bySession?.size === 0) pendingSubagentUpdates.delete(app);
  for (const item of pending) routeSubagentUpdate(item.update, item.event, item.metadata, app);
}

function applyAltaSubagentUpdate(
  update: unknown,
  event: AcpThreadEvent | null,
  app: AcpConversationAdapter,
  envelope?: AcpMetadataEnvelope,
): boolean {
  const parsed = parseAltaSubagentMetadata(update, envelope);
  if (parsed.kind === "absent") return false;
  if (parsed.kind === "invalid" || !event) return true;
  if (routeSubagentUpdate(update, event, parsed.metadata, app)) return true;

  if (!parsed.metadata.invokingToolCallId && parsed.metadata.childSessionId) {
    queuePendingSubagentUpdate(app, parsed.metadata.childSessionId, { update, event, metadata: parsed.metadata });
  }
  return true;
}

function applyToolSnapshot(app: AcpConversationAdapter, update: AcpToolEvent, existing?: ToolBlock): ToolBlock {
  finishStreamingBlock(app, "content");
  finishStreamingBlock(app, "thinking");

  const toolCallId = update.toolCallId || existing?.toolCallId || "";
  const inferredTitleCommand =
    typeof update.title === "string" && looksLikeShellCommand(update.title) ? { command: update.title } : undefined;
  const rawInput = update.rawInput ?? existing?.rawInput ?? inferredTitleCommand;
  const toolKind = update.kind ?? existing?.toolKind;
  const toolName = toolNameFromUpdate(update, rawInput, existing?.toolName ?? "tool");
  const rawOutput = update.rawOutput ?? existing?.rawOutput;
  const mappedStatus = acpStatusToToolStatus(statusValue(update.status));
  const formattedArgs = formatToolArgs(rawInput, app.state.cwd);
  const formattedOutput = formatToolOutput(rawOutput, app.state.cwd);
  const parsedToolContent = extractToolContent(update.content);
  const contentDiff = firstDiffFromToolContent(parsedToolContent);
  const isResultEvent = mappedStatus === "success" || mappedStatus === "error";
  const shouldApplyContent = Array.isArray(update.content) && (isResultEvent || contentDiff !== undefined);
  const toolContent = shouldApplyContent ? parsedToolContent : undefined;
  const contentText = isResultEvent ? textFromToolContent(toolContent) : "";

  const snapshot: Partial<ToolBlock> = {
    toolName,
    toolKind,
    display: formattedArgs || existing?.display || "",
    summary: undefined,
    details: contentText || formattedOutput || existing?.details,
    rawInput,
    rawOutput,
    status: mappedStatus,
    content: shouldApplyContent ? toolContent : existing?.content,
    diff: shouldApplyContent ? contentDiff : existing?.diff,
    fileChanges: tryExtractFileChanges(toolName, rawOutput),
    subagent: subagentStateFromInvokingToolResult(existing?.subagent, mappedStatus),
  };

  if (existing) {
    app.updateBlock(existing.id, snapshot);
    const updated = findToolBlock(app, existing.toolCallId) ?? { ...existing, ...snapshot };
    drainPendingSubagentUpdates(app, updated);
    return findToolBlock(app, existing.toolCallId) ?? updated;
  }

  const block: ToolBlock = {
    type: "tool",
    id: nextBlockId(),
    toolCallId,
    toolName,
    toolKind,
    display: snapshot.display ?? "",
    rawInput,
    rawOutput,
    status: mappedStatus,
    details: snapshot.details,
    content: snapshot.content,
    diff: snapshot.diff,
    fileChanges: snapshot.fileChanges,
  };
  app.addBlock(block);
  drainPendingSubagentUpdates(app, block);
  return findToolBlock(app, toolCallId) ?? block;
}

function finishTurn(app: AcpConversationAdapter): void {
  finishStreamingBlock(app, "thinking");
  finishStreamingBlock(app, "content");
  app.setState("statusText", "");
  app.setState("running", false);
  app.setState("spinnerActive", false);
  app.setState("spinnerLabel", "");
  app.setCurrentBlockId(null);
  app.setState("lastAcpActivityKind", null);
  app.setState("lastAcpActivityLabel", "");
  app.setState("lastAcpActivityAt", null);
}

function mergeUsage(app: AcpConversationAdapter, usage: Usage, context?: { size?: number; used?: number }) {
  app.setState("totalUsage", (prev: Usage) => ({
    input_tokens: prev.input_tokens + usage.input_tokens,
    output_tokens: prev.output_tokens + usage.output_tokens,
    cache_read_tokens: prev.cache_read_tokens + usage.cache_read_tokens,
    cache_write_tokens: prev.cache_write_tokens + usage.cache_write_tokens,
  }));
  app.setState("lastUsage", usage);
  if (context?.size !== undefined) {
    app.setState("contextWindow", context.size);
  }
  if (context?.used !== undefined) {
    app.setState("contextTokens", context.used);
  }
}

export function applyAcpSessionUpdate(
  update: unknown,
  app: AcpConversationAdapter,
  envelope?: AcpMetadataEnvelope,
): void {
  const relayUpdate = relayAcpSessionUpdate(update);
  const event = acpThreadEventFromSessionUpdate(update);
  if (applyAltaSubagentUpdate(update, event, app, envelope)) return;
  if (!relayUpdate || !event) return;

  const activity = activityFromAcpSessionUpdate(relayUpdate);
  if (activity) {
    const existingTool =
      activity.kind === "tool" && activity.label === ""
        ? findToolBlock(app, String(relayUpdate.toolCallId ?? ""))
        : undefined;
    const label = existingTool?.toolName ?? activity.label;
    app.setState("lastAcpActivityKind", activity.kind);
    app.setState("lastAcpActivityLabel", label);
    app.setState("lastAcpActivityAt", app.state.elapsedSeconds ?? 0);
    if (!app.state.running && !app.state.spinnerActive) {
      app.setState("lastAcpActivitySequence", (sequence: number) => sequence + 1);
    }
    app.onActivity?.({ kind: activity.kind, label });
  }

  switch (event.type) {
    case "userMessage": {
      const isSystemReminder = event.content ? isSystemReminderContent(event.content) : false;
      const text = event.content ? textFromAcpThreadContent(event.content, "message") : undefined;
      const currentId = app.state.currentBlockId;
      const hasActiveUserMessage = !!currentId && app.state.blocks.findLast((b) => b.id === currentId)?.type === "user";
      if (
        event.content &&
        typeof text === "string" &&
        text.length > 0 &&
        (hasActiveUserMessage || isSystemReminder || text.trim())
      ) {
        finishStreamingBlock(app, "content");
        finishStreamingBlock(app, "thinking");
        const id = ensureUserMessageBlock(app);
        const contentItem = messageContentItemFromThreadContent(event.content);
        if (isSystemReminder) appendContentItem(app, id, contentItem);
        else appendTextContentItem(app, id, text, contentItem);
        if (!isSystemReminder) removeDuplicateLocalSlashSkillEcho(app, id);
      }
      break;
    }

    case "agentMessage": {
      const segments = textSegmentsFromThreadContent(event.content, "content").filter(
        (segment) => segment.text.length > 0,
      );
      if (segments.length === 0) break;
      finishUserMessageBlock(app);
      for (const segment of segments) {
        if (segment.type === "thinking") {
          finishStreamingBlock(app, "content");
          const id = ensureStreamingBlock(app, "thinking");
          appendTextContentItem(app, id, segment.text, segment.contentItem);
          continue;
        }
        finishStreamingBlock(app, "thinking");
        const id = ensureStreamingBlock(app, "content");
        appendTextContentItem(app, id, segment.text, segment.contentItem);
      }
      break;
    }

    case "agentThought": {
      const text = event.content ? textFromAcpThreadContent(event.content, "message") : undefined;
      if (!event.content || typeof text !== "string" || text.length === 0) break;
      finishUserMessageBlock(app);
      finishStreamingBlock(app, "content");
      const id = ensureStreamingBlock(app, "thinking");
      appendTextContentItem(app, id, text, messageContentItemFromThreadContent(event.content));
      break;
    }

    case "toolCall": {
      finishUserMessageBlock(app);
      const block = applyToolSnapshot(app, event, findToolBlock(app, event.toolCallId));
      app.setState("statusText", `${block.toolName}...`);
      if (block.status === "success" || block.status === "error") {
        app.setState("toolCallCount", (n: number) => n + 1);
        app.setState("statusText", "");
      }
      break;
    }

    case "availableCommands":
      break;

    case "configOption":
      break;

    case "currentMode": {
      if (typeof event.currentModeId === "string") {
        app.setState("modeId", event.currentModeId);
      }
      break;
    }

    case "sessionInfo": {
      if (typeof event.title === "string") {
        app.setState("statusText", event.title);
      }
      break;
    }

    case "usage": {
      const usage = usageFromAcp(event.usage) ?? usageFromAcp(relayUpdate);
      const context = {
        size: event.size,
        used: event.used,
      };
      if (usage) {
        mergeUsage(app, usage, context);
      } else {
        if (context.size !== undefined) app.setState("contextWindow", context.size);
        if (context.used !== undefined) app.setState("contextTokens", context.used);
      }
      break;
    }

    case "plan":
    case "planUpdate":
    case "planRemoved":
    default:
      break;
  }
}

export function finalizeAcpPrompt(
  app: AcpConversationAdapter,
  response: RelayAcpPromptResponse | null | undefined,
): void;
export function finalizeAcpPrompt(app: AcpConversationAdapter, response: unknown): void;
export function finalizeAcpPrompt(app: AcpConversationAdapter, response: unknown): void {
  finishUserMessageBlock(app);
  finishStreamingBlock(app, "thinking");
  finishStreamingBlock(app, "content");

  const responseData = isRecord(response) ? response : {};
  const meta = isRecord(responseData._meta) ? responseData._meta : {};
  const usage = usageFromAcp(responseData);
  const contextWindowTokens = meta.contextWindowTokens;
  if (usage) {
    mergeUsage(app, usage, {
      size: typeof contextWindowTokens === "number" ? contextWindowTokens : undefined,
    });
  }

  finishTurn(app);
}
