import { describe, expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { findStickyUserBlock, formatStickyPromptLines, USER_BLOCK_ID_PREFIX } from "../../../src/ui/util/sticky-prompt";
import type { ChatBlock, UserBlock } from "../../../src/ui/state";

function makeUserBlock(id: string, content: string, delivery?: UserBlock["delivery"]): UserBlock {
  return { type: "user", id, content, ...(delivery ? { delivery } : {}) };
}

function makeContentBlock(id: string, content = ""): ChatBlock {
  return { type: "content", id, content, finalized: true };
}

function makeToolBlock(id: string): ChatBlock {
  return {
    type: "tool",
    id,
    toolCallId: id,
    toolName: "test",
    display: "test",
    status: "success",
  };
}

interface MockChild {
  _id: string;
  id: string;
  y: number;
  height: number;
  getChildren: () => MockChild[];
  getRenderable?: (id: string) => MockChild | undefined;
  findDescendantById?: (id: string) => MockChild | undefined;
}

function makeChild(id: string, y: number, height = 3): MockChild {
  return { _id: id, id, y, height, getChildren: () => [] };
}

function createScrollBox(options: {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  viewportY?: number;
  children: { id: string; contentY: number; height?: number }[];
  nestChildren?: boolean;
  onGetRenderable?: (id: string) => void;
  onFindDescendant?: (id: string) => void;
}): ScrollBoxRenderable {
  const vpY = options.viewportY ?? 0;
  const contentScreenY = vpY - options.scrollTop;
  const mockChildren: MockChild[] = options.children.map(({ id, contentY, height }) =>
    makeChild(id, contentScreenY + contentY, height ?? 3),
  );

  const directChildren = options.nestChildren
    ? [{ ...makeChild("wrapper", contentScreenY), getChildren: () => mockChildren }]
    : mockChildren;
  const findDescendantById = (children: MockChild[], id: string): MockChild | undefined => {
    for (const child of children) {
      if (child.id === id) return child;
      const descendant = findDescendantById(child.getChildren(), id);
      if (descendant) return descendant;
    }
    return undefined;
  };
  const content = {
    _id: "content",
    id: "content",
    y: contentScreenY,
    height: options.scrollHeight,
    getChildren: () => directChildren,
    getRenderable: (id: string): MockChild | undefined => {
      options.onGetRenderable?.(id);
      return directChildren.find((child) => child.id === id);
    },
    findDescendantById: (id: string): MockChild | undefined => {
      options.onFindDescendant?.(id);
      return findDescendantById(directChildren, id);
    },
  };

  const box = {
    scrollTop: options.scrollTop,
    scrollHeight: options.scrollHeight,
    y: vpY,
    viewport: { height: options.viewportHeight, y: vpY },
    content,
  };
  Object.setPrototypeOf(box, ScrollBoxRenderable.prototype);
  return box as unknown as ScrollBoxRenderable;
}

function userChild(blockId: string, contentY: number, height?: number) {
  return { id: `${USER_BLOCK_ID_PREFIX}${blockId}`, contentY, height };
}

function contentChild(id: string, contentY: number, height?: number) {
  return { id, contentY, height };
}

const USER_BLOCK_HEIGHT = 5;

describe("findStickyUserBlock", () => {
  test("returns null when scrollbox content fits in viewport", () => {
    const blocks: ChatBlock[] = [makeUserBlock("u1", "Hello"), makeContentBlock("c1")];
    const scrollBox = createScrollBox({
      scrollTop: 0,
      scrollHeight: 10,
      viewportHeight: 10,
      children: [userChild("u1", 0, USER_BLOCK_HEIGHT), contentChild("c1", 5)],
    });

    expect(findStickyUserBlock(blocks, scrollBox, 0).block).toBeNull();
  });

  test("returns null when no user block has reached the viewport top", () => {
    const blocks: ChatBlock[] = [makeUserBlock("u1", "Hello"), makeContentBlock("c1")];
    // scrollTop=0, block at contentY=5 -> blockTopY=5 > scrollBoxTop=0
    const scrollBox = createScrollBox({
      scrollTop: 0,
      scrollHeight: 100,
      viewportHeight: 10,
      children: [userChild("u1", 5, USER_BLOCK_HEIGHT), contentChild("c1", 10)],
    });

    expect(findStickyUserBlock(blocks, scrollBox, 2).block).toBeNull();
  });

  test("returns a tall user block that extends below the sticky area", () => {
    const user = makeUserBlock("u1", "Hello\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6");
    const blocks: ChatBlock[] = [user, makeContentBlock("c1")];
    // Block is 11 rows tall, stickyBottomY is 5 (maxLines=3 + 2 padding).
    // Should still be a candidate because blockTopY <= scrollBoxTop.
    const scrollBox = createScrollBox({
      scrollTop: 0,
      scrollHeight: 100,
      viewportHeight: 10,
      children: [userChild("u1", 0, 11), contentChild("c1", 11)],
    });

    const result = findStickyUserBlock(blocks, scrollBox, 3);
    expect(result.block).toBe(user);
    expect(result.incomingBlock).toBeNull();
  });

  test("returns user block once it has fully scrolled out of view", () => {
    const user = makeUserBlock("u1", "Hello");
    const blocks: ChatBlock[] = [user, makeContentBlock("c1"), makeToolBlock("t1")];
    const scrollBox = createScrollBox({
      scrollTop: 6,
      scrollHeight: 100,
      viewportHeight: 10,
      children: [userChild("u1", 0, USER_BLOCK_HEIGHT), contentChild("c1", 5), contentChild("t1", 20)],
    });

    const result = findStickyUserBlock(blocks, scrollBox, 6);
    expect(result.block).toBe(user);
    expect(result.incomingBlock).toBeNull();
    expect(result.positionInStickyArea).toBe(0);
  });

  test("returns the latest user block that has fully scrolled past the top", () => {
    const user1 = makeUserBlock("u1", "First");
    const user2 = makeUserBlock("u2", "Second");
    const blocks: ChatBlock[] = [user1, makeContentBlock("c1"), user2, makeContentBlock("c2")];
    const scrollBox = createScrollBox({
      scrollTop: 30,
      scrollHeight: 100,
      viewportHeight: 10,
      children: [
        userChild("u1", 0, USER_BLOCK_HEIGHT),
        contentChild("c1", 5),
        userChild("u2", 20, USER_BLOCK_HEIGHT),
        contentChild("c2", 25),
      ],
    });

    expect(findStickyUserBlock(blocks, scrollBox, 30).block).toBe(user2);
  });

  test("skips current-turn-guidance user blocks", () => {
    const guidance = makeUserBlock("u1", "guidance", "current-turn-guidance");
    const blocks: ChatBlock[] = [guidance, makeContentBlock("c1")];
    const scrollBox = createScrollBox({
      scrollTop: 10,
      scrollHeight: 100,
      viewportHeight: 10,
      children: [userChild("u1", 0, USER_BLOCK_HEIGHT), contentChild("c1", 5)],
    });

    expect(findStickyUserBlock(blocks, scrollBox, 10).block).toBeNull();
  });

  test("returns null when blocks array is empty", () => {
    const scrollBox = createScrollBox({
      scrollTop: 5,
      scrollHeight: 100,
      viewportHeight: 10,
      children: [],
    });

    expect(findStickyUserBlock([], scrollBox, 5).block).toBeNull();
  });

  test("works when non-user blocks are not rendered (index mismatch)", () => {
    const user1 = makeUserBlock("u1", "First");
    const user2 = makeUserBlock("u2", "Second");
    const blocks: ChatBlock[] = [
      user1,
      { type: "thinking", id: "th1", content: "", finalized: true } as ChatBlock,
      makeContentBlock("c1"),
      user2,
      makeContentBlock("c2"),
    ];
    const scrollBox = createScrollBox({
      scrollTop: 20,
      scrollHeight: 100,
      viewportHeight: 10,
      children: [
        userChild("u1", 0, USER_BLOCK_HEIGHT),
        contentChild("c1", 5),
        userChild("u2", 12, USER_BLOCK_HEIGHT),
        contentChild("c2", 17),
      ],
    });

    expect(findStickyUserBlock(blocks, scrollBox, 20).block).toBe(user2);
  });

  test("skips user blocks whose renderable is not found", () => {
    const user1 = makeUserBlock("u1", "First");
    const user2 = makeUserBlock("u2", "Second");
    const blocks: ChatBlock[] = [user1, makeContentBlock("c1"), user2, makeContentBlock("c2")];
    const scrollBox = createScrollBox({
      scrollTop: 10,
      scrollHeight: 100,
      viewportHeight: 10,
      children: [userChild("u1", 0, USER_BLOCK_HEIGHT), contentChild("c1", 5), contentChild("c2", 25)],
    });

    expect(findStickyUserBlock(blocks, scrollBox, 10).block).toBe(user1);
  });

  test("uses the direct child index before recursive traversal", () => {
    const user = makeUserBlock("u1", "Hello");
    const blocks: ChatBlock[] = [user, makeContentBlock("c1")];
    let directLookups = 0;
    let recursiveLookups = 0;
    const scrollBox = createScrollBox({
      scrollTop: 6,
      scrollHeight: 100,
      viewportHeight: 10,
      children: [userChild("u1", 0, USER_BLOCK_HEIGHT), contentChild("c1", 5)],
      onGetRenderable: () => {
        directLookups += 1;
      },
      onFindDescendant: () => {
        recursiveLookups += 1;
      },
    });

    expect(findStickyUserBlock(blocks, scrollBox, 3).block).toBe(user);
    expect(directLookups).toBeGreaterThan(0);
    expect(recursiveLookups).toBe(0);
  });

  test("falls back to recursive traversal when the direct child index misses", () => {
    const user = makeUserBlock("u1", "Hello");
    const blocks: ChatBlock[] = [user, makeContentBlock("c1")];
    let directLookups = 0;
    let recursiveLookups = 0;
    const scrollBox = createScrollBox({
      scrollTop: 6,
      scrollHeight: 100,
      viewportHeight: 10,
      children: [userChild("u1", 0, USER_BLOCK_HEIGHT), contentChild("c1", 5)],
      nestChildren: true,
      onGetRenderable: () => {
        directLookups += 1;
      },
      onFindDescendant: () => {
        recursiveLookups += 1;
      },
    });

    expect(findStickyUserBlock(blocks, scrollBox, 3).block).toBe(user);
    expect(directLookups).toBeGreaterThan(0);
    expect(recursiveLookups).toBeGreaterThan(0);
  });

  test("accounts for viewport y offset on screen", () => {
    const user = makeUserBlock("u1", "Hello");
    const blocks: ChatBlock[] = [user, makeContentBlock("c1")];
    const scrollBox = createScrollBox({
      scrollTop: 6,
      scrollHeight: 100,
      viewportHeight: 10,
      viewportY: 5,
      children: [userChild("u1", 0, USER_BLOCK_HEIGHT), contentChild("c1", 5)],
    });

    expect(findStickyUserBlock(blocks, scrollBox, 6).block).toBe(user);
  });

  test("shows sticky header at sticky-scroll bottom when user block is out of view", () => {
    const user = makeUserBlock("u1", "Hello");
    const blocks: ChatBlock[] = [user, makeContentBlock("c1")];
    const scrollBox = createScrollBox({
      scrollTop: 90,
      scrollHeight: 100,
      viewportHeight: 10,
      children: [userChild("u1", 0, USER_BLOCK_HEIGHT), contentChild("c1", 5)],
    });

    expect(findStickyUserBlock(blocks, scrollBox, 90).block).toBe(user);
  });

  test("is stable when sticky header height changes viewport position", () => {
    const user = makeUserBlock("u1", "Hello");
    const blocks: ChatBlock[] = [user, makeContentBlock("c1")];

    const box1 = createScrollBox({
      scrollTop: 6,
      scrollHeight: 100,
      viewportHeight: 10,
      viewportY: 0,
      children: [userChild("u1", 0, USER_BLOCK_HEIGHT), contentChild("c1", 5)],
    });
    const box2 = createScrollBox({
      scrollTop: 6,
      scrollHeight: 100,
      viewportHeight: 7,
      viewportY: 3,
      children: [userChild("u1", 0, USER_BLOCK_HEIGHT), contentChild("c1", 5)],
    });

    expect(findStickyUserBlock(blocks, box1, 6).block).toBe(user);
    expect(findStickyUserBlock(blocks, box2, 6).block).toBe(user);
  });

  test("does not set incoming when the next user block is below the sticky area", () => {
    const user1 = makeUserBlock("u1", "First");
    const user2 = makeUserBlock("u2", "Second");
    const blocks: ChatBlock[] = [user1, makeContentBlock("c1"), user2, makeContentBlock("c2")];
    const scrollBox = createScrollBox({
      scrollTop: 10,
      scrollHeight: 100,
      viewportHeight: 20,
      children: [
        userChild("u1", 0, USER_BLOCK_HEIGHT),
        contentChild("c1", 5),
        userChild("u2", 20, USER_BLOCK_HEIGHT),
        contentChild("c2", 25),
      ],
    });

    const result = findStickyUserBlock(blocks, scrollBox, 3);
    expect(result.block).toBe(user1);
    expect(result.incomingBlock).toBeNull();
    expect(result.positionInStickyArea).toBe(0);
  });

  test("sets positionInStickyArea to the number of overlapping sticky rows", () => {
    const user1 = makeUserBlock("u1", "First");
    const user2 = makeUserBlock("u2", "Second");
    const blocks: ChatBlock[] = [user1, makeContentBlock("c1"), user2, makeContentBlock("c2")];
    const scrollBox = createScrollBox({
      scrollTop: 16,
      scrollHeight: 100,
      viewportHeight: 10,
      children: [
        userChild("u1", 0, USER_BLOCK_HEIGHT),
        contentChild("c1", 5),
        userChild("u2", 20, USER_BLOCK_HEIGHT),
        contentChild("c2", 28),
      ],
    });

    const result = findStickyUserBlock(blocks, scrollBox, 3);
    expect(result.block).toBe(user1);
    expect(result.incomingBlock).toBe(user2);
    expect(result.positionInStickyArea).toBe(1);
  });

  test("increases positionInStickyArea as the incoming block moves up", () => {
    const user1 = makeUserBlock("u1", "First");
    const user2 = makeUserBlock("u2", "Second");
    const blocks: ChatBlock[] = [user1, makeContentBlock("c1"), user2, makeContentBlock("c2")];
    const scrollBox = createScrollBox({
      scrollTop: 18,
      scrollHeight: 100,
      viewportHeight: 10,
      children: [
        userChild("u1", 0, USER_BLOCK_HEIGHT),
        contentChild("c1", 5),
        userChild("u2", 20, USER_BLOCK_HEIGHT),
        contentChild("c2", 28),
      ],
    });

    const result = findStickyUserBlock(blocks, scrollBox, 3);
    expect(result.block).toBe(user1);
    expect(result.incomingBlock).toBe(user2);
    expect(result.positionInStickyArea).toBe(3);
  });

  test("keeps a tall incoming block as incoming while its top is above the sticky area bottom", () => {
    const user1 = makeUserBlock("u1", "First");
    const user2 = makeUserBlock("u2", "Second");
    const blocks: ChatBlock[] = [user1, makeContentBlock("c1"), user2, makeContentBlock("c2")];
    // u2 at contentY=20, scrollTop=19 -> u2.blockTopY=1 > scrollBoxTop=0, so not a candidate.
    // u2.blockTopY=1 < stickyBottomY=5, so it is the incoming block.
    const scrollBox = createScrollBox({
      scrollTop: 19,
      scrollHeight: 100,
      viewportHeight: 10,
      children: [
        userChild("u1", 0, USER_BLOCK_HEIGHT),
        contentChild("c1", 5),
        userChild("u2", 20, 8),
        contentChild("c2", 28),
      ],
    });

    const result = findStickyUserBlock(blocks, scrollBox, 3);
    expect(result.block).toBe(user1);
    expect(result.incomingBlock).toBe(user2);
    expect(result.positionInStickyArea).toBe(4);
  });

  test("resets when incoming block becomes the candidate", () => {
    const user1 = makeUserBlock("u1", "First");
    const user2 = makeUserBlock("u2", "Second");
    const blocks: ChatBlock[] = [user1, makeContentBlock("c1"), user2, makeContentBlock("c2")];
    const scrollBox = createScrollBox({
      scrollTop: 20,
      scrollHeight: 100,
      viewportHeight: 10,
      children: [
        userChild("u1", 0, USER_BLOCK_HEIGHT),
        contentChild("c1", 5),
        userChild("u2", 20, USER_BLOCK_HEIGHT),
        contentChild("c2", 25),
      ],
    });

    const result = findStickyUserBlock(blocks, scrollBox, 3);
    expect(result.block).toBe(user2);
    expect(result.incomingBlock).toBeNull();
    expect(result.positionInStickyArea).toBe(0);
  });
});

describe("formatStickyPromptLines", () => {
  test("returns a single line for short single-line message", () => {
    const block = makeUserBlock("u1", "Hello world");
    expect(formatStickyPromptLines(block, 3, 80)).toEqual(["Hello world"]);
  });

  test("returns up to maxLines for multi-line content", () => {
    const block = makeUserBlock("u1", "Line 1\nLine 2\nLine 3\nLine 4\nLine 5");
    expect(formatStickyPromptLines(block, 3, 80)).toEqual(["Line 1", "Line 2", "Line 3..."]);
  });

  test("does not add ellipsis when content fits exactly in maxLines", () => {
    const block = makeUserBlock("u1", "Line 1\nLine 2\nLine 3");
    expect(formatStickyPromptLines(block, 3, 80)).toEqual(["Line 1", "Line 2", "Line 3"]);
  });

  test("truncates long lines by width", () => {
    const block = makeUserBlock("u1", "This is a very long line that should be truncated by width");
    expect(formatStickyPromptLines(block, 1, 20)).toEqual(["This is a very lo..."]);
  });

  test("handles maxLines=1 with multi-line content", () => {
    const block = makeUserBlock("u1", "First line\nSecond line");
    expect(formatStickyPromptLines(block, 1, 80)).toEqual(["First line..."]);
  });

  test("returns empty array when maxLines is 0", () => {
    const block = makeUserBlock("u1", "Hello");
    expect(formatStickyPromptLines(block, 0, 80)).toEqual([]);
  });

  test("returns empty array when maxWidth is 0", () => {
    const block = makeUserBlock("u1", "Hello");
    expect(formatStickyPromptLines(block, 3, 0)).toEqual([]);
  });

  test("handles CRLF line endings", () => {
    const block = makeUserBlock("u1", "Line 1\r\nLine 2\r\nLine 3");
    expect(formatStickyPromptLines(block, 3, 80)).toEqual(["Line 1", "Line 2", "Line 3"]);
  });

  test("formats skill invocation with name only", () => {
    const block: UserBlock = {
      type: "user",
      id: "u1",
      content: "/my-skill",
      origin: "acp",
      skillInvocation: { name: "my-skill" },
    };
    expect(formatStickyPromptLines(block, 3, 80)).toEqual(["[skill] my-skill"]);
  });

  test("formats skill invocation with multi-line user message", () => {
    const block: UserBlock = {
      type: "user",
      id: "u1",
      content: "/my-skill do\nthis\nthing\nand more",
      origin: "acp",
      skillInvocation: { name: "my-skill", userMessage: "do\nthis\nthing\nand more" },
    };
    expect(formatStickyPromptLines(block, 3, 80)).toEqual(["[skill] my-skill do", "this", "thing..."]);
  });

  test("truncates long skill invocation text", () => {
    const block: UserBlock = {
      type: "user",
      id: "u1",
      content: "/my-skill do something very long that exceeds the width",
      origin: "acp",
      skillInvocation: { name: "my-skill", userMessage: "do something very long that exceeds the width" },
    };
    expect(formatStickyPromptLines(block, 1, 30)).toEqual(["[skill] my-skill do somethi..."]);
  });
});
