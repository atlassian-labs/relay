import { describe, expect, test } from "bun:test";
import { buildStickyPromptHeaderLines } from "../../../src/ui/component/sticky-prompt-header";
import { UI_GUTTER_X } from "../../../src/ui/layout";
import type { UserBlock } from "../../../src/ui/state";
import type { StickyPromptResult } from "../../../src/ui/util/sticky-prompt";

function makeUserBlock(id: string, content: string): UserBlock {
  return { type: "user", id, content };
}

function stickyResult(options: {
  block: UserBlock | null;
  incomingBlock?: UserBlock | null;
  positionInStickyArea?: number;
}): StickyPromptResult {
  return {
    block: options.block,
    incomingBlock: options.incomingBlock ?? null,
    positionInStickyArea: options.positionInStickyArea ?? 0,
  };
}

function texts(rows: ReturnType<typeof buildStickyPromptHeaderLines>): string[] {
  return rows.map((row) => row.text);
}

describe("buildStickyPromptHeaderLines", () => {
  test("returns no rows when there is no sticky block", () => {
    expect(
      buildStickyPromptHeaderLines({
        stickyResult: stickyResult({ block: null }),
        maxLines: 3,
        availableWidth: 80,
      }),
    ).toEqual([]);
  });

  test("renders the current block with padding and dimmed text", () => {
    const rows = buildStickyPromptHeaderLines({
      stickyResult: stickyResult({ block: makeUserBlock("u1", "Line 1\nLine 2") }),
      maxLines: 3,
      availableWidth: 80,
    });

    expect(rows).toEqual([{ text: "" }, { text: "Line 1", dim: true }, { text: "Line 2", dim: true }, { text: "" }]);
  });

  test("slices current rows from the front until incoming reaches the top", () => {
    const rows = buildStickyPromptHeaderLines({
      stickyResult: stickyResult({
        block: makeUserBlock("u1", "A\nB\nC"),
        incomingBlock: makeUserBlock("u2", "X\nY\nZ"),
        positionInStickyArea: 2,
      }),
      maxLines: 3,
      availableWidth: 80,
    });

    expect(rows).toEqual([{ text: "B", dim: true }, { text: "C", dim: true }, { text: "" }]);
  });

  test("keeps all current rows when the sticky-height slice is taller than current rows", () => {
    const rows = buildStickyPromptHeaderLines({
      stickyResult: stickyResult({
        block: makeUserBlock("u1", "Only current"),
        incomingBlock: makeUserBlock("u2", "Incoming"),
        positionInStickyArea: 2,
      }),
      maxLines: 5,
      availableWidth: 80,
    });

    expect(rows).toEqual([{ text: "" }, { text: "Only current", dim: true }, { text: "" }]);
  });

  test("renders incoming rows once incoming reaches the sticky top", () => {
    const rows = buildStickyPromptHeaderLines({
      stickyResult: stickyResult({
        block: makeUserBlock("u1", "A\nB\nC"),
        incomingBlock: makeUserBlock("u2", "X\nY"),
        positionInStickyArea: 5,
      }),
      maxLines: 3,
      availableWidth: 80,
    });

    expect(rows).toEqual([{ text: "" }, { text: "X" }, { text: "Y" }, { text: "" }]);
  });

  test("formats lines using the content width after gutter padding", () => {
    const rows = buildStickyPromptHeaderLines({
      stickyResult: stickyResult({ block: makeUserBlock("u1", "123456789") }),
      maxLines: 1,
      availableWidth: UI_GUTTER_X * 2 + 5,
    });

    expect(texts(rows)).toEqual(["", "12...", ""]);
  });
});
