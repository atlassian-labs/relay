import { describe, expect, test } from "bun:test";
import type { ChatBlock } from "../../../src/ui/state";
import { conversationTreeItems, nextConversationMessageIndex } from "../../../src/ui/app/conversation-tree";
import { filterListItemsBySubstringInOrder, orderedOverlayIndexAfterFilter } from "../../../src/ui/app/overlay-filter";

const blocks: ChatBlock[] = [
  { type: "user", id: "u1", content: "first" },
  { type: "tool", id: "t1", toolCallId: "tc1", toolName: "read", display: "one", status: "success" },
  { type: "tool", id: "t2", toolCallId: "tc2", toolName: "read", display: "two", status: "success" },
  { type: "content", id: "a1", content: "answer", finalized: true },
  { type: "tool", id: "t3", toolCallId: "tc3", toolName: "bash", display: "test", status: "success" },
  { type: "user", id: "u2", content: "second" },
];

describe("conversation tree", () => {
  test("assigns theme tones by conversation role", () => {
    expect(conversationTreeItems(blocks).map((item) => item.tone)).toEqual([
      "accent",
      "muted",
      "muted",
      "success",
      "muted",
      "accent",
    ]);
  });

  test("keeps tool labels concise instead of exposing searchable payloads", () => {
    const items = conversationTreeItems([
      {
        type: "tool",
        id: "edit",
        toolCallId: "edit-call",
        toolName: "edit",
        display: "path: src/app.ts old_string: Look at this payload",
        rawInput: { path: "src/app.ts", old_string: "Look at this payload" },
        status: "success",
      },
    ]);

    expect(items[0]?.label).toBe("• [edit: src/app.ts]");
  });

  test("selects the visible message instead of hidden tool payload matches", () => {
    const items = conversationTreeItems([
      { type: "user", id: "user", content: "Look at the tree" },
      {
        type: "tool",
        id: "edit",
        toolCallId: "edit-call",
        toolName: "edit",
        display: "path: src/app.ts old_string: Look at the tree",
        rawInput: { path: "src/app.ts", old_string: "Look at the tree" },
        status: "success",
      },
      { type: "content", id: "assistant", content: "Done", finalized: true },
    ]);
    const filtered = filterListItemsBySubstringInOrder(items, "Look at");

    expect(filtered.map((item) => item.label)).toEqual(["• user: Look at the tree"]);
    expect(orderedOverlayIndexAfterFilter(items, filtered, items[2]?.value)).toBe(0);
  });

  test("jumps over tools to adjacent user or assistant messages", () => {
    const items = conversationTreeItems(blocks);

    expect(nextConversationMessageIndex(items, 5, -1)).toBe(3);
    expect(nextConversationMessageIndex(items, 3, -1)).toBe(0);
    expect(nextConversationMessageIndex(items, 0, 1)).toBe(3);
    expect(nextConversationMessageIndex(items, 3, 1)).toBe(5);
    expect(nextConversationMessageIndex(items, 5, 1)).toBe(5);
  });
});
