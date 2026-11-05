import type { MessageContentItem } from "../../core/conversation";

const SYSTEM_REMINDER_PREFIX = "system-reminder:";

export type SystemReminderUserContent = {
  readonly userContent: string;
  readonly reminderContent: string;
};

function stripSystemReminderPrefix(content: string): string {
  return content
    .trimStart()
    .replace(/^system-reminder:\s*/, "")
    .trimStart();
}

function splitSystemReminderUserContent(content: string): SystemReminderUserContent | null {
  const match = /(^|\n)system-reminder:\s*/.exec(content);
  if (!match) return null;
  const markerStart = match.index + (match[1] === "\n" ? 1 : 0);
  return {
    userContent: content.slice(0, match.index).trimEnd(),
    reminderContent: stripSystemReminderPrefix(content.slice(markerStart)),
  };
}

function systemReminderContentFromItems(contentItems: readonly MessageContentItem[] | undefined): string {
  return (contentItems ?? [])
    .filter(
      (item): item is Extract<MessageContentItem, { type: "text" }> =>
        item.type === "text" && item.text.trimStart().startsWith(SYSTEM_REMINDER_PREFIX),
    )
    .map((item) => stripSystemReminderPrefix(item.text))
    .join("\n\n")
    .trim();
}

export function systemReminderUserContent(block: {
  readonly content: string;
  readonly contentItems?: readonly MessageContentItem[];
}): SystemReminderUserContent | null {
  const reminderContent = systemReminderContentFromItems(block.contentItems);
  if (reminderContent) return { userContent: block.content.trimEnd(), reminderContent };
  return splitSystemReminderUserContent(block.content);
}
