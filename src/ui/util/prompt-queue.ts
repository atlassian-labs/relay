import { formatSkillInvocationPreview, parseSkillInvocationPrompt } from "../../skills";
import { parseLiveSessionMessage } from "../../core/live-sessions";
import type { PromptImageAttachment, PromptSubmission } from "../../core/prompt-submission";
import type { QueuedPrompt, QueuedSkillPrompt } from "../state";
import { hasOptionModifier, type KeyModifierEvent } from "./key-events";

export type QueuePlacement = "in-place" | "end";
export type QueueNavigationAction = "previous" | "next";
export type QueueMoveAction = "up" | "down";

export interface QueueRemovalResult {
  queue: QueuedPrompt[];
  item: QueuedPrompt | null;
  focusIndex: number | null;
}

export const QUEUE_NAVIGATION_LABEL = "⌥↑/⌥↓";
export const EMPTY_QUEUE_EDIT_MESSAGE =
  "Queued prompt cannot be empty; add text, press ctrl+d to delete, or esc to cancel";

export type QueueNavigationKeyEvent = KeyModifierEvent;

export function queueNavigationAction(evt: QueueNavigationKeyEvent): QueueNavigationAction | null {
  if (!hasOptionModifier(evt)) return null;
  if (evt.name === "up") return "previous";
  if (evt.name === "down") return "next";
  return null;
}

export function queueMoveAction(evt: QueueNavigationKeyEvent & { shift?: boolean }): QueueMoveAction | null {
  const hasQueueModifier = evt.option === true || evt.meta === true;
  if (!hasQueueModifier || evt.shift !== true) return null;
  if (evt.name === "up") return "up";
  if (evt.name === "down") return "down";
  return null;
}

export interface QueuePromptResult {
  queue: QueuedPrompt[];
  editing: QueuedPrompt | null;
  accepted: boolean;
  insertIndex?: number;
  reason?: "full";
}

export function queuedPromptFromText(
  id: string,
  text: string,
  originalIndex?: number,
  images?: readonly PromptImageAttachment[],
): QueuedPrompt {
  const imageList = images && images.length > 0 ? [...images] : undefined;
  const skill = skillPromptFromText(text);
  if (!skill) {
    return {
      id,
      text,
      ...(imageList ? { images: imageList } : {}),
      ...(originalIndex === undefined ? {} : { originalIndex }),
    };
  }

  return {
    id,
    kind: "skill",
    text,
    skill,
    ...(imageList ? { images: imageList } : {}),
    ...(originalIndex === undefined ? {} : { originalIndex }),
  };
}

export function queuedPromptToText(item: QueuedPrompt): string {
  const skill = getQueuedSkillPrompt(item);
  if (skill) {
    const prefix = skill.userMessagePrefix ?? "\n\n";
    return skill.userMessage.trim() ? `${skill.blockText}${prefix}${skill.userMessage}` : skill.blockText;
  }
  return item.text;
}

export function queuedPromptEditText(item: QueuedPrompt): string {
  return getQueuedSkillPrompt(item)?.userMessage ?? item.text;
}

export function queuedPromptToInput(item: QueuedPrompt): string | PromptSubmission {
  const text = queuedPromptToText(item);
  return item.images && item.images.length > 0 ? { text, images: item.images } : text;
}

export function queuedPromptWithEditedText(item: QueuedPrompt, editedText: string): QueuedPrompt {
  const skill = getQueuedSkillPrompt(item);
  if (skill) {
    const nextSkill = { ...skill, userMessage: editedText };
    const nextItem: QueuedPrompt = { ...item, kind: "skill", skill: nextSkill };
    const { originalIndex: _originalIndex, ...cleanItem } = nextItem;
    return { ...cleanItem, text: queuedPromptToText(cleanItem) };
  }
  return queuedPromptFromText(item.id, editedText, undefined, item.images);
}

export function formatQueuedPromptPreview(item: QueuedPrompt): string {
  const skill = getQueuedSkillPrompt(item);
  if (skill) {
    const fallbackUserMessage = skill.userMessage.trim() ? queuedPromptPreview(skill.userMessage).text : "";
    return (
      formatSkillInvocationPreview(item.text) ??
      `[skill] ${skill.name}${fallbackUserMessage ? ` — ${fallbackUserMessage}` : ""}`
    );
  }

  const sessionMessage = parseLiveSessionMessage(item.text);
  if (sessionMessage) {
    const preview = queuedPromptPreview(sessionMessage.text);
    const label = `[${sessionMessage.relation}: ${sessionMessage.name}]`;
    return preview.text ? `${label} — ${preview.text}` : label;
  }

  const preview = queuedPromptPreview(item.text);
  return preview.lineCount > 1 ? `${preview.text} · ${preview.lineCount} lines` : preview.text;
}

export function queuePromptItem(args: {
  queue: QueuedPrompt[];
  text: string;
  images?: readonly PromptImageAttachment[];
  editing?: QueuedPrompt | null;
  placement?: QueuePlacement;
  maxSize: number;
  nextId: () => string;
}): QueuePromptResult {
  const placement = args.placement ?? "in-place";
  const editing = args.editing ?? null;

  if (editing && placement === "in-place") {
    const insertIndex = clampIndex(editing.originalIndex ?? args.queue.length, args.queue.length);
    return {
      queue: insertAt(
        args.queue,
        insertIndex,
        queuedPromptWithEditedText({ ...editing, images: [...(args.images ?? [])] }, args.text),
      ),
      editing: null,
      accepted: true,
      insertIndex,
    };
  }

  if (args.queue.length >= args.maxSize) {
    return {
      queue: args.queue,
      editing,
      accepted: false,
      reason: "full",
    };
  }

  const insertIndex = args.queue.length;
  return {
    queue: [
      ...args.queue,
      editing
        ? queuedPromptWithEditedText({ ...editing, images: [...(args.images ?? [])] }, args.text)
        : queuedPromptFromText(args.nextId(), args.text, undefined, args.images),
    ],
    editing: null,
    accepted: true,
    insertIndex,
  };
}

export function removeQueuedPromptAt(queue: QueuedPrompt[], index: number): QueueRemovalResult {
  if (index < 0 || index >= queue.length) {
    return { queue, item: null, focusIndex: normalizeQueueFocus(queue.length, index) };
  }
  const item = queue[index] ?? null;
  const nextQueue = queue.filter((_, i) => i !== index);
  return { queue: nextQueue, item, focusIndex: normalizeQueueFocus(nextQueue.length, index) };
}

export function cancelQueuedPromptAt(
  queue: QueuedPrompt[],
  index: number,
): { queue: QueuedPrompt[]; focusIndex: number | null } {
  const result = removeQueuedPromptAt(queue, index);
  return { queue: result.queue, focusIndex: result.focusIndex };
}

export function startEditQueuedPrompt(
  queue: QueuedPrompt[],
  index: number,
): { queue: QueuedPrompt[]; editing: QueuedPrompt | null } {
  const item = queue[index];
  if (!item) return { queue, editing: null };
  return {
    queue: queue.filter((_, i) => i !== index),
    editing: { ...item, originalIndex: index },
  };
}

export function restoreEditingQueuedPrompt(
  queue: QueuedPrompt[],
  editing: QueuedPrompt | null,
): { queue: QueuedPrompt[]; editing: null; insertIndex?: number; restored: boolean } {
  if (!editing) return { queue, editing: null, restored: false };
  const insertIndex = clampIndex(editing.originalIndex ?? queue.length, queue.length);
  const { originalIndex: _originalIndex, ...item } = editing;
  return {
    queue: insertAt(queue, insertIndex, item),
    editing: null,
    insertIndex,
    restored: true,
  };
}

export function moveQueueFocusIndex(queueLength: number, current: number | null, delta: number): number | null {
  if (queueLength <= 0) return null;
  if (current === null) return delta < 0 ? queueLength - 1 : 0;
  const next = current + delta;
  if (next < 0 || next >= queueLength) return null;
  return next;
}

export function normalizeQueueFocus(queueLength: number, preferred: number | null): number | null {
  if (queueLength <= 0) return null;
  if (preferred === null) return 0;
  return clampIndex(preferred, queueLength - 1);
}

export function queuedPromptPreview(text: string): { text: string; lineCount: number } {
  const normalized = text
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { text: normalized || text, lineCount: text.split(/\r?\n/).length };
}

function splitQueuedSkillText(
  text: string,
  userMessage: string | undefined,
): { blockText: string; userMessagePrefix?: string } | null {
  if (!userMessage) return { blockText: text };

  const wrappedSuffix = `\n\n${userMessage}`;
  if (text.endsWith(wrappedSuffix)) {
    return { blockText: text.slice(0, -wrappedSuffix.length), userMessagePrefix: "\n\n" };
  }

  const filesystemSuffixWithSpace = `\nARGUMENTS: ${userMessage}`;
  if (text.endsWith(filesystemSuffixWithSpace)) {
    return {
      blockText: text.slice(0, -filesystemSuffixWithSpace.length),
      userMessagePrefix: "\nARGUMENTS: ",
    };
  }

  const filesystemSuffix = `\nARGUMENTS:${userMessage}`;
  if (text.endsWith(filesystemSuffix)) {
    return { blockText: text.slice(0, -filesystemSuffix.length), userMessagePrefix: "\nARGUMENTS:" };
  }

  return null;
}

function skillPromptFromText(text: string): QueuedSkillPrompt | null {
  const skill = parseSkillInvocationPrompt(text);
  if (!skill) return null;
  const split = splitQueuedSkillText(text, skill.userMessage);
  if (!split) return null;
  return {
    name: skill.name,
    location: skill.location,
    content: skill.content,
    blockText: split.blockText,
    ...(split.userMessagePrefix === undefined ? {} : { userMessagePrefix: split.userMessagePrefix }),
    userMessage: skill.userMessage ?? "",
  };
}

function getQueuedSkillPrompt(item: QueuedPrompt): QueuedSkillPrompt | null {
  if (item.skill) return item.skill;
  return skillPromptFromText(item.text);
}

export function moveQueuedPrompt(
  queue: QueuedPrompt[],
  index: number,
  delta: number,
): { queue: QueuedPrompt[]; focusIndex: number | null; moved: boolean } {
  if (index < 0 || index >= queue.length)
    return { queue, focusIndex: normalizeQueueFocus(queue.length, index), moved: false };
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= queue.length) return { queue, focusIndex: index, moved: false };
  const nextQueue = [...queue];
  const [item] = nextQueue.splice(index, 1);
  if (!item) return { queue, focusIndex: normalizeQueueFocus(queue.length, index), moved: false };
  nextQueue.splice(nextIndex, 0, item);
  return { queue: nextQueue, focusIndex: nextIndex, moved: true };
}

function insertAt<T>(items: T[], index: number, item: T): T[] {
  return [...items.slice(0, index), item, ...items.slice(index)];
}

function clampIndex(index: number, max: number): number {
  return Math.max(0, Math.min(index, max));
}

export * as PromptQueue from "./prompt-queue";
