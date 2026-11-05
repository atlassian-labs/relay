import { parseLiveSessionMessage } from "../../core/live-sessions";
import type { ChatBlock } from "../state";
import { userBashPreview } from "./user-bash-block";
import { formatUserBlockPreview } from "./user-message";

export function compactPreviewText(value: string, maxLength = 1000, preserveNewlines = true): string {
  const normalized = preserveNewlines
    ? value
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => line.replace(/[\t ]+/g, " ").trimEnd())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    : value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1).trimEnd()}…` : normalized;
}

export function lastAssistantResponseText(blocks: readonly ChatBlock[]): string {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block.type === "content") {
      const content = block.content.trim();
      if (content) return content;
    }
  }
  return "";
}

function compactToolTarget(display: string): string {
  const line = display
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return "";
  return line.replace(/^(path|file|file_path|filename|command|cmd):\s*/i, "");
}

/** Whether a block is still running, so it should win the thread preview over later content. */
export function isRunningPreviewBlock(block: ChatBlock): boolean {
  if (block.type === "tool")
    return block.status === "running" || block.status === "pending" || block.status === "approval";
  return block.type === "user-bash" && block.status === "running";
}

/**
 * Builds the sidebar preview for a thread.
 *
 * @param lastRunningIndex - Index of the last running block, or -1. Callers that track it skip a full scan.
 */
export function previewFromBlocks(
  blocks: readonly ChatBlock[],
  lastRunningIndex = blocks.findLastIndex(isRunningPreviewBlock),
): string {
  const running = blocks[lastRunningIndex];
  if (running?.type === "tool") {
    const target = compactToolTarget(running.summary || running.display || running.details || "");
    return compactPreviewText([running.toolName, target].filter(Boolean).join(" "), 1000, false);
  }
  if (running?.type === "user-bash") {
    return compactPreviewText(userBashPreview(running.command, running.excludeFromContext), 1000, false);
  }

  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block.type === "content" || block.type === "user" || block.type === "info") {
      const content = "content" in block ? String(block.content ?? "") : "";
      const sessionMessage = block.type === "user" ? parseLiveSessionMessage(content) : null;
      if (sessionMessage) {
        const label = `[${sessionMessage.relation}: ${sessionMessage.name}]`;
        const isTurnUpdate = block.type === "user" && block.delivery === "current-turn-guidance";
        const prefix = isTurnUpdate ? `[turn update] ${label}` : label;
        const preview = sessionMessage.text.trim() ? `${prefix} — ${sessionMessage.text}` : prefix;
        return compactPreviewText(preview, 1000, false);
      }
      if (block.type === "user" && block.delivery === "current-turn-guidance") {
        const turnUpdatePreview = content.trim() ? `[turn update] — ${content}` : "[turn update]";
        return compactPreviewText(turnUpdatePreview, 1000, false);
      }
      const skillPreview = block.type === "user" ? formatUserBlockPreview(block) : null;
      if (skillPreview) return compactPreviewText(skillPreview, 1000, false);
      if (content.trim()) return compactPreviewText(content);
    }
    if (block.type === "tool") {
      const target = compactToolTarget(block.summary || block.display || block.details || "");
      return compactPreviewText([block.toolName, target].filter(Boolean).join(" "), 1000, false);
    }
    if (block.type === "user-bash") {
      return compactPreviewText(userBashPreview(block.command, block.excludeFromContext), 1000, false);
    }
  }
  return "";
}
