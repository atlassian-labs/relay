import type { ChatBlock, ToolBlock } from "../state";
import type { ListItem } from "../autocomplete";

export interface ConversationTreeEntry {
  readonly block: ChatBlock;
  readonly role: "user" | "assistant" | "tool";
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArgument(input: Record<string, unknown> | null, ...keys: string[]): string {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) return oneLine(value);
  }
  return "";
}

function conciseToolDisplay(block: ToolBlock): string {
  const input = recordValue(block.rawInput);
  const name = block.toolName.toLowerCase();
  const path = stringArgument(input, "path", "file_path");
  if (name === "read" || name === "write" || name === "edit") return path || oneLine(block.display).slice(0, 120);
  if (name === "bash" || name === "shell") {
    return (stringArgument(input, "command") || oneLine(block.display)).slice(0, 80);
  }
  if (name === "grep") {
    const pattern = stringArgument(input, "pattern");
    return pattern ? `/${pattern}/ in ${path || "."}` : path;
  }
  if (name === "find") {
    const pattern = stringArgument(input, "pattern");
    return pattern ? `${pattern} in ${path || "."}` : path;
  }
  const primary = stringArgument(input, "path", "file_path", "command", "pattern", "url", "query");
  return (primary || oneLine(block.display)).slice(0, 120);
}

function toolLabel(block: ToolBlock): string {
  const name = oneLine(block.toolName) || "tool";
  const display = conciseToolDisplay(block);
  return display ? `[${name}: ${display}]` : `[${name}]`;
}

/** Build the message-only view used by `/tree`.
 *
 * Relay currently receives one active conversation path from ACP. Keeping this
 * conversion separate from the overlay makes it possible to add parent/child
 * paths later without coupling the conversation model to list rendering.
 */
export function nextConversationMessageIndex(
  items: readonly ListItem<unknown>[],
  selectedIndex: number,
  direction: -1 | 1,
): number {
  for (let index = selectedIndex + direction; index >= 0 && index < items.length; index += direction) {
    const value = items[index]?.value;
    if (typeof value !== "object" || value === null || !("role" in value)) continue;
    if (value.role === "user" || value.role === "assistant") return index;
  }
  return selectedIndex;
}

export function conversationTreeItems(blocks: readonly ChatBlock[]): ListItem<ConversationTreeEntry>[] {
  const items: ListItem<ConversationTreeEntry>[] = [];

  for (const block of blocks) {
    if (block.type === "user") {
      items.push({
        value: { block, role: "user" },
        label: `• user: ${oneLine(block.content) || "(no content)"}`,
        description: "",
        tone: "accent",
        tonePrefixLength: "• user: ".length,
      });
      continue;
    }

    if (block.type === "content") {
      const content = oneLine(block.content);
      if (!content) continue;
      items.push({
        value: { block, role: "assistant" },
        label: `• assistant: ${content}`,
        description: "",
        tone: "success",
        tonePrefixLength: "• assistant: ".length,
      });
      continue;
    }

    if (block.type === "tool") {
      items.push({
        value: { block, role: "tool" },
        label: `• ${toolLabel(block)}`,
        description: "",
        tone: "muted",
      });
    }
  }

  return items;
}
