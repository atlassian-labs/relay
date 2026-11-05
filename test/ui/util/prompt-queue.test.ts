import { describe, expect, test } from "bun:test";
import {
  QUEUE_NAVIGATION_LABEL,
  cancelQueuedPromptAt,
  formatQueuedPromptPreview,
  moveQueueFocusIndex,
  moveQueuedPrompt,
  normalizeQueueFocus,
  queueMoveAction,
  queueNavigationAction,
  queuedPromptEditText,
  queuePromptItem,
  queuedPromptPreview,
  queuedPromptToInput,
  queuedPromptToText,
  queuedPromptWithEditedText,
  removeQueuedPromptAt,
  restoreEditingQueuedPrompt,
  startEditQueuedPrompt,
} from "../../../src/ui/util/prompt-queue";
import type { QueuedPrompt } from "../../../src/ui/state";

function queue(...texts: string[]): QueuedPrompt[] {
  return texts.map((text, index) => ({ id: `q${index + 1}`, text }));
}

function skillPrompt(args = ""): string {
  const block = [
    '<skill name="git-publish" location="/Users/asumer/.agents/skills/git-publish/SKILL.md">',
    "References are relative to /Users/asumer/.agents/skills/git-publish.",
    "",
    "Publish current branch.",
    "</skill>",
  ].join("\n");
  return args ? `${block}\n\n${args}` : block;
}

function filesystemSkillPrompt(args = ""): string {
  const block = [
    "---",
    "name: review-solo",
    "description: Review changes",
    "register_cmd: true",
    "---",
    "# Review Solo",
    "",
    "Review the code directly.",
  ].join("\n");
  return args ? `${block}\nARGUMENTS: ${args}` : block;
}

describe("prompt queue editing", () => {
  test("queues a new prompt at the end", () => {
    const result = queuePromptItem({
      queue: queue("first"),
      text: "second",
      maxSize: 5,
      nextId: () => "q2",
    });

    expect(result).toMatchObject({ accepted: true, editing: null, insertIndex: 1 });
    expect(result.queue).toEqual([
      { id: "q1", text: "first" },
      { id: "q2", text: "second" },
    ]);
  });

  test("rejects new prompts when queue is full", () => {
    const existing = queue("one", "two");
    const result = queuePromptItem({
      queue: existing,
      text: "three",
      maxSize: 2,
      nextId: () => "q3",
    });

    expect(result).toMatchObject({ accepted: false, reason: "full" });
    expect(result.queue).toBe(existing);
  });

  test("starts editing by removing the focused prompt and preserving original index", () => {
    const result = startEditQueuedPrompt(queue("one", "two", "three"), 1);

    expect(result.queue).toEqual([
      { id: "q1", text: "one" },
      { id: "q3", text: "three" },
    ]);
    expect(result.editing).toEqual({ id: "q2", text: "two", originalIndex: 1 });
  });

  test("enter while editing updates the original position", () => {
    const editing = { id: "q2", text: "two", originalIndex: 1 };
    const result = queuePromptItem({
      queue: [
        { id: "q1", text: "one" },
        { id: "q3", text: "three" },
      ],
      editing,
      text: "two edited",
      placement: "in-place",
      maxSize: 5,
      nextId: () => "unused",
    });

    expect(result).toMatchObject({ accepted: true, editing: null, insertIndex: 1 });
    expect(result.queue).toEqual([
      { id: "q1", text: "one" },
      { id: "q2", text: "two edited" },
      { id: "q3", text: "three" },
    ]);
  });

  test("queues image sidecars and converts queued prompts back to structured input", () => {
    const image = {
      id: 1,
      marker: "[image #1 photo.png]",
      data: "abc",
      mimeType: "image/png",
      byteLength: 3,
      filename: "photo.png",
    };
    const result = queuePromptItem({
      queue: [],
      text: "see [image #1 photo.png]",
      images: [image],
      maxSize: 5,
      nextId: () => "q1",
    });

    expect(result.queue[0].images).toEqual([image]);
    expect(queuedPromptToInput(result.queue[0])).toEqual({ text: "see [image #1 photo.png]", images: [image] });
  });

  test("editing an argless skill edits only args and preserves skill preview", () => {
    const queued = queuePromptItem({
      queue: [],
      text: skillPrompt(),
      maxSize: 5,
      nextId: () => "q1",
    });

    expect(formatQueuedPromptPreview(queued.queue[0])).toBe("[skill] git-publish");

    const editing = startEditQueuedPrompt(queued.queue, 0);
    expect(queuedPromptEditText(editing.editing!)).toBe("");

    const updated = queuePromptItem({
      queue: editing.queue,
      editing: editing.editing,
      text: "to all branches",
      placement: "in-place",
      maxSize: 5,
      nextId: () => "unused",
    });

    expect(formatQueuedPromptPreview(updated.queue[0])).toBe("[skill] git-publish — to all branches");
    expect(queuedPromptToText(updated.queue[0])).toBe(skillPrompt("to all branches"));
  });

  test("editing a skill with existing multiline args preserves multiline serialization and compact preview", () => {
    const queued = queuePromptItem({
      queue: [],
      text: skillPrompt("main branch"),
      maxSize: 5,
      nextId: () => "q1",
    });
    const editing = startEditQueuedPrompt(queued.queue, 0);

    expect(queuedPromptEditText(editing.editing!)).toBe("main branch");

    const updated = queuePromptItem({
      queue: editing.queue,
      editing: editing.editing,
      text: "release branches\ninclude tags",
      placement: "in-place",
      maxSize: 5,
      nextId: () => "unused",
    });

    expect(formatQueuedPromptPreview(updated.queue[0])).toBe("[skill] git-publish — release branches include tags");
    expect(queuedPromptToText(updated.queue[0])).toBe(skillPrompt("release branches\ninclude tags"));
  });

  test("editing a skill preserves non-blank whitespace-sensitive args exactly", () => {
    const queued = queuePromptItem({
      queue: [],
      text: skillPrompt("main branch"),
      maxSize: 5,
      nextId: () => "q1",
    });
    const editing = startEditQueuedPrompt(queued.queue, 0);
    const whitespaceSensitiveArgs = "  run this\n    --with-indent\n";

    const updated = queuePromptItem({
      queue: editing.queue,
      editing: editing.editing,
      text: whitespaceSensitiveArgs,
      placement: "in-place",
      maxSize: 5,
      nextId: () => "unused",
    });

    expect(formatQueuedPromptPreview(updated.queue[0])).toBe("[skill] git-publish — run this --with-indent");
    expect(queuedPromptEditText(updated.queue[0])).toBe(whitespaceSensitiveArgs);
    expect(queuedPromptToText(updated.queue[0])).toBe(skillPrompt(whitespaceSensitiveArgs));
  });

  test("blanking existing skill args returns to an argless skill prompt", () => {
    const queued = queuePromptItem({
      queue: [],
      text: skillPrompt("main branch"),
      maxSize: 5,
      nextId: () => "q1",
    });
    const editing = startEditQueuedPrompt(queued.queue, 0);

    const updated = queuePromptItem({
      queue: editing.queue,
      editing: editing.editing,
      text: "   \n  ",
      placement: "in-place",
      maxSize: 5,
      nextId: () => "unused",
    });

    expect(formatQueuedPromptPreview(updated.queue[0])).toBe("[skill] git-publish");
    expect(queuedPromptToText(updated.queue[0])).toBe(skillPrompt());
  });

  test("filesystem skill queue items preserve ARGUMENTS serialization", () => {
    const queued = queuePromptItem({
      queue: [],
      text: filesystemSkillPrompt("focus area"),
      maxSize: 5,
      nextId: () => "q1",
    });

    expect(formatQueuedPromptPreview(queued.queue[0])).toBe("[skill] review-solo — focus area");
    expect(queuedPromptEditText(queued.queue[0])).toBe("focus area");
    expect(queuedPromptToText(queued.queue[0])).toBe(filesystemSkillPrompt("focus area"));

    const editing = startEditQueuedPrompt(queued.queue, 0);
    const updated = queuePromptItem({
      queue: editing.queue,
      editing: editing.editing,
      text: "new focus\ninclude tests",
      placement: "in-place",
      maxSize: 5,
      nextId: () => "unused",
    });

    expect(formatQueuedPromptPreview(updated.queue[0])).toBe("[skill] review-solo — new focus include tests");
    expect(queuedPromptToText(updated.queue[0])).toBe(filesystemSkillPrompt("new focus\ninclude tests"));
  });

  test("legacy raw skill queue items still preview and edit as skills", () => {
    const item = { id: "legacy", text: skillPrompt() };

    expect(formatQueuedPromptPreview(item)).toBe("[skill] git-publish");
    expect(queuedPromptEditText(item)).toBe("");
    expect(queuedPromptToText(item)).toBe(skillPrompt());
    const edited = queuedPromptWithEditedText(item, "to all branches");
    expect(formatQueuedPromptPreview(edited)).toBe("[skill] git-publish — to all branches");
    expect(queuedPromptToText(edited)).toBe(skillPrompt("to all branches"));
  });

  test("restoring a skill edit keeps the original structured skill item", () => {
    const queued = queuePromptItem({
      queue: [],
      text: skillPrompt("main branch"),
      maxSize: 5,
      nextId: () => "q1",
    });
    const editing = startEditQueuedPrompt(queued.queue, 0);

    const restored = restoreEditingQueuedPrompt(editing.queue, editing.editing);

    expect(formatQueuedPromptPreview(restored.queue[0])).toBe("[skill] git-publish — main branch");
    expect(queuedPromptToText(restored.queue[0])).toBe(skillPrompt("main branch"));
  });

  test("esc restores an edited prompt to its original index", () => {
    const result = restoreEditingQueuedPrompt(
      [
        { id: "q1", text: "one" },
        { id: "q3", text: "three" },
      ],
      { id: "q2", text: "two", originalIndex: 1 },
    );

    expect(result).toMatchObject({ restored: true, editing: null, insertIndex: 1 });
    expect(result.queue).toEqual([
      { id: "q1", text: "one" },
      { id: "q2", text: "two" },
      { id: "q3", text: "three" },
    ]);
  });

  test("removes focused prompt and returns the removed item", () => {
    const result = removeQueuedPromptAt(queue("one", "two", "three"), 1);

    expect(result.item).toEqual({ id: "q2", text: "two" });
    expect(result.queue.map((item) => item.text)).toEqual(["one", "three"]);
    expect(result.focusIndex).toBe(1);
  });

  test("delete cancels focused prompt and keeps focus on the next item", () => {
    const result = cancelQueuedPromptAt(queue("one", "two", "three"), 1);

    expect(result.queue.map((item) => item.text)).toEqual(["one", "three"]);
    expect(result.focusIndex).toBe(1);
  });

  test("delete last prompt moves focus to previous last item", () => {
    const result = cancelQueuedPromptAt(queue("one", "two"), 1);

    expect(result.queue.map((item) => item.text)).toEqual(["one"]);
    expect(result.focusIndex).toBe(0);
  });

  test("queue focus enters from boundaries and exits past edges", () => {
    expect(moveQueueFocusIndex(3, null, 1)).toBe(0);
    expect(moveQueueFocusIndex(3, null, -1)).toBe(2);
    expect(moveQueueFocusIndex(3, 0, -1)).toBeNull();
    expect(moveQueueFocusIndex(3, 2, 1)).toBeNull();
    expect(moveQueueFocusIndex(3, 1, 1)).toBe(2);
  });

  test("normalizes focus after queue size changes", () => {
    expect(normalizeQueueFocus(0, 2)).toBeNull();
    expect(normalizeQueueFocus(3, null)).toBe(0);
    expect(normalizeQueueFocus(3, 9)).toBe(2);
  });

  test("maps option/meta arrow keys to queue navigation actions", () => {
    expect(QUEUE_NAVIGATION_LABEL).toBe("⌥↑/⌥↓");
    expect(queueNavigationAction({ name: "up", option: true })).toBe("previous");
    expect(queueNavigationAction({ name: "down", option: true })).toBe("next");
    expect(queueNavigationAction({ name: "up", meta: true })).toBe("previous");
    expect(queueNavigationAction({ name: "down", meta: true })).toBe("next");
    expect(queueNavigationAction({ name: "up" })).toBeNull();
    expect(queueNavigationAction({ name: "down" })).toBeNull();
    expect(queueNavigationAction({ name: "left", option: true })).toBeNull();
  });

  test("maps shift option/meta arrow keys to queue move actions", () => {
    expect(queueMoveAction({ name: "up", option: true, shift: true })).toBe("up");
    expect(queueMoveAction({ name: "down", option: true, shift: true })).toBe("down");
    expect(queueMoveAction({ name: "up", meta: true, shift: true })).toBe("up");
    expect(queueMoveAction({ name: "down", meta: true, shift: true })).toBe("down");
    expect(queueMoveAction({ name: "up", option: true })).toBeNull();
    expect(queueMoveAction({ name: "left", option: true, shift: true })).toBeNull();
  });

  test("moves queued prompts and keeps focus on the moved item", () => {
    const movedUp = moveQueuedPrompt(queue("one", "two", "three"), 1, -1);
    expect(movedUp).toMatchObject({ focusIndex: 0, moved: true });
    expect(movedUp.queue.map((item) => item.text)).toEqual(["two", "one", "three"]);

    const movedDown = moveQueuedPrompt(movedUp.queue, 0, 1);
    expect(movedDown).toMatchObject({ focusIndex: 1, moved: true });
    expect(movedDown.queue.map((item) => item.text)).toEqual(["one", "two", "three"]);
  });

  test("does not move queued prompts past boundaries or invalid indexes", () => {
    const existing = queue("one", "two");
    expect(moveQueuedPrompt(existing, 0, -1)).toEqual({ queue: existing, focusIndex: 0, moved: false });
    expect(moveQueuedPrompt(existing, 1, 1)).toEqual({ queue: existing, focusIndex: 1, moved: false });
    expect(moveQueuedPrompt(existing, 9, 1)).toEqual({ queue: existing, focusIndex: 1, moved: false });
  });

  test("formats multiline queue previews with compact line metadata", () => {
    expect(queuedPromptPreview("one line")).toEqual({ text: "one line", lineCount: 1 });
    expect(queuedPromptPreview("one\n  two\nthree")).toEqual({ text: "one two three", lineCount: 3 });
  });
});
