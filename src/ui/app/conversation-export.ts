import * as path from "node:path";
import type { ThreadInfo } from "../../core/threads";
import type { RelayConversationSnapshot, RelayConversationBlock, RelayPluginThreadInfo } from "../../plugins";
import type { ChatBlock } from "../state";
import { snapshotRelayConversation } from "./plugin-conversation";

export const DEFAULT_EXPORT_TOOL_PREVIEW_LIMIT = 8;
const EXPORT_THREAD_TITLE_MAX_LENGTH = 240;

export function relayExportFilePath(cwd: string, date = new Date()): string {
  const timestamp = date.toISOString().replace(/[:.]/gu, "-");
  return path.join(cwd, `relay-export-${timestamp}.md`);
}

export function snapshotThreadConversation(options: {
  readonly thread: ThreadInfo;
  readonly blocks: readonly ChatBlock[];
  readonly sessionId?: string | null;
}): RelayConversationSnapshot {
  return snapshotRelayConversation({
    thread: relayPluginThreadInfo(options.thread),
    blocks: options.blocks,
    sessionId: options.sessionId,
  });
}

export function formatRelayConversationMarkdown(
  snapshot: RelayConversationSnapshot,
  options: { readonly exportedAt?: Date; readonly toolPreviewLimit?: number } = {},
): string {
  const exportedAt = options.exportedAt ?? new Date();
  const toolPreviewLimit = options.toolPreviewLimit ?? DEFAULT_EXPORT_TOOL_PREVIEW_LIMIT;
  const lines = [
    "# Relay Conversation Export",
    "",
    `- Thread: ${truncateOneLine(snapshot.thread.title, EXPORT_THREAD_TITLE_MAX_LENGTH)}`,
    `- Thread ID: \`${snapshot.threadId}\``,
    `- Session ID: ${snapshot.sessionId ? `\`${snapshot.sessionId}\`` : "(none)"}`,
    `- CWD: \`${snapshot.cwd}\``,
    `- Exported: ${exportedAt.toISOString()}`,
    "",
    "---",
    "",
  ];
  const body = conversationBodyLines(snapshot.blocks, toolPreviewLimit);
  if (body.length === 0) {
    lines.push("_No visible conversation content._", "");
  } else {
    lines.push(...body);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function conversationBodyLines(blocks: readonly RelayConversationBlock[], toolPreviewLimit: number): string[] {
  const lines: string[] = [];
  let toolGroup: RelayConversationBlock[] = [];

  function flushTools(): void {
    if (toolGroup.length === 0) return;
    lines.push(...toolGroupLines(toolGroup, toolPreviewLimit), "");
    toolGroup = [];
  }

  for (const block of blocks) {
    if (block.type === "tool") {
      toolGroup.push(block);
      continue;
    }
    if (block.type === "thinking") continue;
    flushTools();
    if (block.type === "user") {
      appendSection(lines, "User", block.content);
      continue;
    }
    if (block.type === "content") {
      appendSection(lines, block.finalized ? "Assistant" : "Assistant (partial)", block.content);
    }
  }
  flushTools();
  return lines;
}

function appendSection(lines: string[], title: string, content: string): void {
  const trimmed = content.trim();
  if (!trimmed) return;
  lines.push(`## ${title}`, "", trimmed, "");
}

function toolGroupLines(blocks: readonly RelayConversationBlock[], previewLimit: number): string[] {
  const tools = blocks.filter(
    (block): block is Extract<RelayConversationBlock, { readonly type: "tool" }> => block.type === "tool",
  );
  const names = tools.map((tool) => tool.toolName || tool.display || "tool");
  const visible = names.slice(0, Math.max(0, previewLimit));
  const remaining = Math.max(0, names.length - visible.length);
  const suffix = remaining > 0 ? `, ... (+${remaining} more)` : "";
  const calls = `${tools.length} call${tools.length === 1 ? "" : "s"}`;
  const lines = [`> Tool activity: ${calls}: ${visible.join(", ")}${suffix}`];
  const files = filesReadBy(tools);
  if (files.length > 0) {
    lines.push(`> Files read: ${files.join(", ")}`);
  }
  return lines;
}

function filesReadBy(tools: readonly Extract<RelayConversationBlock, { readonly type: "tool" }>[]): string[] {
  const counts = new Map<string, { count: number; firstSeen: number }>();
  for (const [index, tool] of tools.entries()) {
    if (!isReadToolName(tool.toolName)) continue;
    for (const filePath of readPathsFromInput(tool.input)) {
      const existing = counts.get(filePath);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(filePath, { count: 1, firstSeen: index });
      }
    }
  }
  return [...counts.entries()]
    .sort(([, left], [, right]) => right.count - left.count || left.firstSeen - right.firstSeen)
    .slice(0, 10)
    .map(([filePath]) => filePath);
}

function isReadToolName(name: string): boolean {
  return name === "read" || name === "read_file" || name === "read_files";
}

function readPathsFromInput(input: unknown): string[] {
  if (input === null || typeof input !== "object") return [];
  const values: string[] = [];
  const record = input as Record<string, unknown>;
  if (typeof record.path === "string") values.push(record.path);
  if (Array.isArray(record.paths)) {
    for (const path of record.paths) {
      if (typeof path === "string") values.push(path);
    }
  }
  return values;
}

function relayPluginThreadInfo(thread: ThreadInfo): RelayPluginThreadInfo {
  return {
    id: thread.id,
    title: thread.title,
    sessionId: thread.sessionId,
    cwd: thread.cwd,
    workspaceKind: thread.workspaceKind,
    status: thread.status,
    archived: thread.archived,
    ...(thread.worktreePath ? { worktreePath: thread.worktreePath } : {}),
    ...(thread.worktreeBranch ? { worktreeBranch: thread.worktreeBranch } : {}),
    ...(thread.createdAt ? { createdAt: thread.createdAt } : {}),
    ...(thread.updatedAt ? { updatedAt: thread.updatedAt } : {}),
  };
}

function truncateOneLine(value: string, maxLength: number): string {
  const text = value.replace(/\s+/gu, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}
