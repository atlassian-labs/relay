import { describe, expect, test } from "bun:test";
import type { ChatBlock } from "../../../src/ui/state";
import {
  TranscriptPageIndex,
  estimateTranscriptBlockRows,
  isTranscriptBlockStable,
  type TranscriptPageIndexOptions,
} from "../../../src/ui/util/transcript-page-index";

function content(id: string, lines = 1, finalized = true): ChatBlock {
  return {
    type: "content",
    id,
    content: Array.from({ length: lines }, (_, index) => `${id}-${index}`).join("\n"),
    finalized,
  };
}

function user(id: string): ChatBlock {
  return { type: "user", id, content: id };
}

function options(overrides: Partial<TranscriptPageIndexOptions> = {}): TranscriptPageIndexOptions {
  let page = 0;
  return {
    createPageId: () => `page-${++page}`,
    softBlockLimit: 2,
    hardBlockLimit: 4,
    softRowLimit: 100,
    hardRowLimit: 200,
    tallBlockRowThreshold: 50,
    ...overrides,
  };
}

function blockIds(index: TranscriptPageIndex): string[][] {
  return index.pages().map((page) => [...page.blockIds]);
}

/**
 * Asserts that page membership, lookups, ordering, and anchors match canonical blocks.
 *
 * @param index - Transcript page index under test.
 * @param blocks - Canonical blocks expected to be represented exactly once and in order.
 * @returns Nothing; the helper records test assertions or throws on failure.
 */
function expectConsistent(index: TranscriptPageIndex, blocks: readonly ChatBlock[]): void {
  const indexedIds = index.pages().flatMap((page) => page.blockIds);
  expect(indexedIds).toEqual(blocks.map((block) => block.id));
  expect(new Set(indexedIds).size).toBe(indexedIds.length);
  for (const [blockIndex, block] of blocks.entries()) {
    expect(index.pageForBlock(block.id)?.blockIds).toContain(block.id);
    expect(index.pageIndexForBlock(block.id)).toBe(index.pages().findIndex((page) => page.blockIds.includes(block.id)));
    expect(indexedIds[blockIndex]).toBe(block.id);
  }
}

describe("TranscriptPageIndex", () => {
  test("rolls the tail at soft user boundaries and hard limits while preserving page identity", () => {
    const blocks = [user("u1"), content("c1")];
    const index = new TranscriptPageIndex(blocks, null, options());
    const firstPageId = index.pages()[0].id;

    blocks.push(content("c2"));
    expect(index.append(blocks.at(-1)!, blocks, null, index.generation)).toBe(true);
    expect(blockIds(index)).toEqual([["u1", "c1", "c2"]]);

    blocks.push(user("u2"));
    index.append(blocks.at(-1)!, blocks, null, index.generation);
    expect(blockIds(index)).toEqual([["u1", "c1", "c2"], ["u2"]]);
    expect(index.pages()[0].id).toBe(firstPageId);

    blocks.push(content("c3"), content("c4"), content("c5"), content("c6"));
    for (const block of blocks.slice(-4))
      index.append(block, blocks.slice(0, blocks.indexOf(block) + 1), null, index.generation);
    expect(blockIds(index)).toEqual([["u1", "c1", "c2"], ["u2", "c3", "c4", "c5"], ["c6"]]);
  });

  test("gives appended and inserted tall blocks dedicated stable pages", () => {
    const blocks = [user("u1"), content("tall", 50), content("c1")];
    const index = new TranscriptPageIndex(blocks, null, options());

    expect(blockIds(index)).toEqual([["u1"], ["tall"], ["c1"]]);
    expect(index.pageForBlock("tall")?.estimatedRows).toBeGreaterThanOrEqual(50);

    const insertedTall = content("inserted-tall", 50);
    blocks.splice(2, 0, insertedTall);
    expect(index.insert(2, insertedTall, blocks, null, index.generation)).toBe(true);
    expect(index.pageForBlock("inserted-tall")?.blockIds).toEqual(["inserted-tall"]);
    expectConsistent(index, blocks);
  });

  test("isolates a tall insertion in the middle of a page with correct identity and row accounting", () => {
    const blocks = [user("u1"), content("c1"), content("c2"), content("c3")];
    const index = new TranscriptPageIndex(
      blocks,
      null,
      options({ softBlockLimit: 10, hardBlockLimit: 10, softRowLimit: 200, hardRowLimit: 400 }),
    );
    const originalPage = index.pages()[0];
    const originalPageId = originalPage.id;
    expect(
      index.setMeasurement(
        originalPage.id,
        {
          transcriptGeneration: index.generation,
          measurementGeneration: 1,
          layoutEpoch: 1,
          width: 80,
          height: originalPage.estimatedRows * 2,
          userBlockOffsets: { u1: 1 },
        },
        originalPage.layoutRevision,
      ),
    ).toBe(true);
    const tall = content("middle-tall", 50);
    blocks.splice(2, 0, tall);

    expect(index.insert(2, tall, blocks, null, index.generation)).toBe(true);

    expect(blockIds(index)).toEqual([["u1", "c1"], ["middle-tall"], ["c2", "c3"]]);
    expect(index.pages()[0].id).toBe(originalPageId);
    expect(index.pages()[2].id).not.toBe(originalPageId);
    expect(index.pages().reduce((height, page) => height + (page.estimatedHeight ?? 0), 0)).toBe(
      index.pages().reduce((rows, page) => rows + page.estimatedRows * 2, 0),
    );
    expect(index.pages().every((page) => page.estimatedUserBlockOffsets === undefined)).toBe(true);
    for (const page of index.pages()) {
      expect(page.estimatedRows).toBe(
        page.blockIds.reduce(
          (rows, blockId) => rows + estimateTranscriptBlockRows(blocks.find((block) => block.id === blockId)!),
          0,
        ),
      );
    }
    expectConsistent(index, blocks);
  });

  test("preserves a dedicated tall page ID when inserting a short block before its anchor", () => {
    const blocks = [content("tall", 50), content("after")];
    const index = new TranscriptPageIndex(blocks, null, options());
    const tallPageId = index.pageForBlock("tall")!.id;
    const inserted = content("before");
    blocks.splice(0, 0, inserted);

    expect(index.insert(0, inserted, blocks, null, index.generation)).toBe(true);

    expect(index.pageForBlock("tall")?.id).toBe(tallPageId);
    expect(index.pageForBlock("tall")?.blockIds).toEqual(["tall"]);
    expect(index.pageForBlock("before")?.id).not.toBe(tallPageId);
    expectConsistent(index, blocks);
  });

  test("isolates a block that grows across the tall threshold during an update", () => {
    const blocks = [user("u1"), content("stream", 1, false)];
    const index = new TranscriptPageIndex(
      blocks,
      "stream",
      options({
        softBlockLimit: 10,
        hardBlockLimit: 10,
        softRowLimit: 20,
        hardRowLimit: 40,
        tallBlockRowThreshold: 20,
      }),
    );
    const previous = blocks[1];
    const next = content("stream", 25, true);
    blocks[1] = next;

    expect(index.update("stream", previous, next, blocks, null, index.generation)).toBe(true);

    expect(index.pageForBlock("stream")?.blockIds).toEqual(["stream"]);
    expect(index.pageForBlock("u1")?.blockIds).toEqual(["u1"]);
    expectConsistent(index, blocks);
  });

  test("keeps later page indexes exact when a middle page splits on a tall update", () => {
    const blocks = [
      user("u1"),
      content("a"),
      content("grow", 1, false),
      content("b"),
      content("c"),
      content("d"),
      content("e"),
    ];
    const index = new TranscriptPageIndex(
      blocks,
      "grow",
      options({ softBlockLimit: 4, hardBlockLimit: 4, softRowLimit: 20, hardRowLimit: 40, tallBlockRowThreshold: 20 }),
    );
    const pagesBefore = index.pages().length;
    const previous = blocks[2];
    const next = content("grow", 25, true);
    blocks[2] = next;

    expect(index.update("grow", previous, next, blocks, null, index.generation)).toBe(true);

    expect(index.pages().length).toBeGreaterThan(pagesBefore);
    expect(index.pageForBlock("grow")?.blockIds).toEqual(["grow"]);
    expectConsistent(index, blocks);
    for (const [position, page] of index.pages().entries())
      expect(index.pageIndexForBlock(page.blockIds[0])).toBe(position);
  });

  test("normalizes only the updated page when a block grows tall", () => {
    let reads = 0;
    const earlier = Array.from({ length: 200 }, (_, i) => {
      const block = content(`c${i}`);
      const text = block.type === "content" ? block.content : "";
      return Object.defineProperty(block, "content", {
        get: () => (reads++, text),
        enumerable: true,
      });
    });
    const blocks: ChatBlock[] = [...earlier, user("u1"), content("stream", 1, false)];
    const index = new TranscriptPageIndex(
      blocks,
      "stream",
      options({
        softBlockLimit: 10,
        hardBlockLimit: 10,
        softRowLimit: 20,
        hardRowLimit: 40,
        tallBlockRowThreshold: 20,
      }),
    );
    const previous = blocks.at(-1)!;
    const next = content("stream", 25, true);
    blocks[blocks.length - 1] = next;
    reads = 0;

    expect(index.update("stream", previous, next, blocks, null, index.generation)).toBe(true);

    expect(reads).toBe(0);
    expect(index.pageForBlock("stream")?.blockIds).toEqual(["stream"]);
    expectConsistent(index, blocks);
  });

  test("starts a new page before an append would exceed the hard row limit", () => {
    const blocks = [content("a", 6)];
    const index = new TranscriptPageIndex(
      blocks,
      null,
      options({ softBlockLimit: 10, hardBlockLimit: 10, softRowLimit: 8, hardRowLimit: 10 }),
    );
    const next = content("b", 6);
    blocks.push(next);

    expect(index.append(next, blocks, null, index.generation)).toBe(true);
    expect(blockIds(index)).toEqual([["a"], ["b"]]);
  });

  test("insert joins the successor page and splits without remounting the prefix page", () => {
    const blocks = [user("u1"), content("c1"), user("u2"), content("c2")];
    const index = new TranscriptPageIndex(blocks, null, options({ softBlockLimit: 1, hardBlockLimit: 3 }));
    const successorPage = index.pageForBlock("u2")!;
    const inserted = content("inserted");
    blocks.splice(2, 0, inserted);

    index.insert(2, inserted, blocks, null, index.generation);

    expect(index.pageForBlock("inserted")?.id).toBe(successorPage.id);
    expect(index.pages().flatMap((page) => page.blockIds)).toEqual(blocks.map((block) => block.id));
    expect(new Set(index.pages().flatMap((page) => page.blockIds)).size).toBe(blocks.length);
  });

  test("preserves the anchored page identity when an insertion splits before the anchor", () => {
    const blocks = [user("u2"), content("c2"), content("c3")];
    const index = new TranscriptPageIndex(
      blocks,
      null,
      options({ softBlockLimit: 10, hardBlockLimit: 3, softRowLimit: 100, hardRowLimit: 200 }),
    );
    const originalPageId = index.pages()[0].id;
    const inserted: ChatBlock = { type: "info", id: "i1", content: "note", variant: "info" };
    blocks.splice(0, 0, inserted);

    expect(index.insert(0, inserted, blocks, null, index.generation)).toBe(true);

    expect(index.pageForBlock("u2")?.id).toBe(originalPageId);
    expect(index.pageForBlock("i1")?.id).not.toBe(originalPageId);
    expect(index.pages().every((page) => page.blockIds.includes(page.anchorBlockId))).toBe(true);
    expectConsistent(index, blocks);
  });

  test("estimates wrapping independently for each logical line", () => {
    const block: ChatBlock = {
      type: "content",
      id: "wrapped",
      content: "abcdefghijk\nx\nabcdefghijk\nx",
      finalized: true,
    };

    expect(estimateTranscriptBlockRows(block, 10)).toBe(7);
  });

  test("estimates wrapped long lines and isolates them as tall blocks", () => {
    const longLine: ChatBlock = { type: "content", id: "long", content: "x".repeat(400), finalized: true };
    const blocks = [user("u1"), longLine, content("c1")];
    const index = new TranscriptPageIndex(
      blocks,
      null,
      options({ estimatedRowWidth: 10, tallBlockRowThreshold: 20, hardRowLimit: 40 }),
    );

    expect(estimateTranscriptBlockRows(longLine, 10)).toBeGreaterThanOrEqual(40);
    expect(index.pageForBlock("long")?.blockIds).toEqual(["long"]);
    expectConsistent(index, blocks);
  });

  test("caps estimates for payloads that render collapsed by default", () => {
    const longOutput = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
    const finalizedThinking: ChatBlock = {
      type: "thinking",
      id: "thinking",
      content: longOutput,
      finalized: true,
    };
    const streamingThinking: ChatBlock = { ...finalizedThinking, id: "streaming-thinking", finalized: false };
    const tool: ChatBlock = {
      type: "tool",
      id: "tool",
      toolCallId: "tool-call",
      toolName: "test",
      display: "test",
      details: longOutput,
      rawOutput: longOutput,
      status: "success",
    };
    const userBash: ChatBlock = {
      type: "user-bash",
      id: "bash",
      command: "echo test",
      output: longOutput,
      exitCode: 0,
      status: "done",
      excludeFromContext: false,
    };

    expect(estimateTranscriptBlockRows(finalizedThinking)).toBeLessThanOrEqual(13);
    expect(estimateTranscriptBlockRows(streamingThinking)).toBe(2);
    expect(estimateTranscriptBlockRows(tool)).toBeLessThanOrEqual(40);
    expect(estimateTranscriptBlockRows(userBash)).toBeLessThanOrEqual(24);

    const collapsedProjection = {
      width: 80,
      detailsExpanded: false,
      showThinking: true,
      thinkingPreviewLines: 3,
      toolPreviewLines: 5,
      succinctToolResults: true,
    };
    const expandedProjection = { ...collapsedProjection, detailsExpanded: true };
    const rowsAt = (toolPreviewLines: number) =>
      estimateTranscriptBlockRows(tool, 80, { ...collapsedProjection, toolPreviewLines });
    // Off is the header plus the "enter to expand" row; 1 previews one line plus the hidden-lines hint.
    expect(rowsAt(0)).toBe(2);
    expect(rowsAt(1)).toBe(3);
    // Renderers draw no collapsed body for a single long line, so it must not reserve wrapped rows.
    const singleLine = "x".repeat(20_000);
    const singleLineTool: ChatBlock = { ...tool, id: "single", details: singleLine, rawOutput: singleLine };
    expect(estimateTranscriptBlockRows(singleLineTool, 80, collapsedProjection)).toBe(1);
    expect(estimateTranscriptBlockRows(finalizedThinking, 80, expandedProjection)).toBeGreaterThan(
      estimateTranscriptBlockRows(finalizedThinking, 80, collapsedProjection),
    );
    expect(estimateTranscriptBlockRows(tool, 80, expandedProjection)).toBeGreaterThan(
      estimateTranscriptBlockRows(tool, 80, collapsedProjection),
    );
    expect(estimateTranscriptBlockRows(userBash, 80, expandedProjection)).toBeGreaterThan(
      estimateTranscriptBlockRows(userBash, 80, collapsedProjection),
    );
    expect(estimateTranscriptBlockRows(finalizedThinking, 80, { ...collapsedProjection, showThinking: false })).toBe(0);
  });

  test("selection pinning defers over-limit splitting and tall-block isolation", () => {
    const blocks = [user("u1"), content("c1"), content("c2")];
    const index = new TranscriptPageIndex(blocks, null, options({ softBlockLimit: 10, hardBlockLimit: 3 }));
    const pageId = index.pages()[0].id;
    index.pinPage(pageId, "selection");
    const inserted = content("inserted-tall", 50);
    blocks.splice(1, 0, inserted);

    index.insert(1, inserted, blocks, null, index.generation);
    expect(index.pages()).toHaveLength(1);
    expect(index.pages()[0].pinReasons).toContain("selection");

    index.unpinPage(pageId, "selection", blocks, null);
    expect(index.pageForBlock("inserted-tall")?.blockIds).toEqual(["inserted-tall"]);
    expect(index.pages().every((page) => !page.pinReasons.includes("selection"))).toBe(true);
    expectConsistent(index, blocks);
  });

  test("releases multiple selection pins with one reconciliation pass", () => {
    const blocks = [user("u1"), content("c1"), user("u2"), content("c2"), user("u3")];
    const index = new TranscriptPageIndex(blocks, null, options({ softBlockLimit: 1, hardBlockLimit: 3 }));
    const pageIds = index.pages().map((page) => page.id);
    for (const pageId of pageIds) index.pinPage(pageId, "selection");
    const revision = index.revision;

    expect(index.unpinPages(pageIds, "selection", blocks, null)).toBe(pageIds.length);

    expect(index.revision).toBe(revision + 1);
    expect(index.pages().every((page) => !page.pinReasons.includes("selection"))).toBe(true);
    expectConsistent(index, blocks);
  });

  test("normalizes both sides of an inserted row-limit split", () => {
    const blocks = [content("a"), user("u1"), content("b", 12), content("c", 7)];
    const index = new TranscriptPageIndex(
      blocks,
      null,
      options({ softBlockLimit: 20, hardBlockLimit: 20, softRowLimit: 25, hardRowLimit: 30 }),
    );
    const inserted = content("d", 9);
    blocks.splice(2, 0, inserted);

    expect(index.insert(2, inserted, blocks, null, index.generation)).toBe(true);
    expect(index.pages().every((page) => page.estimatedRows <= 30 || page.blockIds.length === 1)).toBe(true);
    expectConsistent(index, blocks);
  });

  test("remove keeps neighboring page identities and deletes only empty pages", () => {
    const blocks = [content("a", 50), content("b", 50), content("c", 50)];
    const index = new TranscriptPageIndex(blocks, null, options());
    const ids = index.pages().map((page) => page.id);

    blocks.splice(1, 1);
    index.remove("b", blocks, null, index.generation);

    expect(blockIds(index)).toEqual([["a"], ["c"]]);
    expect(index.pages().map((page) => page.id)).toEqual([ids[0], ids[2]]);
  });

  test("promotes a remaining block when the page anchor is removed", () => {
    const blocks = [user("u1"), content("c1"), content("c2")];
    const index = new TranscriptPageIndex(
      blocks,
      null,
      options({ softBlockLimit: 10, hardBlockLimit: 10, softRowLimit: 100, hardRowLimit: 200 }),
    );
    const pageId = index.pages()[0].id;
    blocks.splice(0, 1);

    expect(index.remove("u1", blocks, null, index.generation)).toBe(true);

    expect(index.pages()[0]).toMatchObject({ id: pageId, anchorBlockId: "c1", blockIds: ["c1", "c2"] });
    expect(index.pages().every((page) => page.blockIds.includes(page.anchorBlockId))).toBe(true);
    expectConsistent(index, blocks);
  });

  test("updates preserve membership and invalidate only the affected page", () => {
    const blocks = [content("a", 50), content("b", 50), content("c", 50)];
    const index = new TranscriptPageIndex(blocks, null, options());
    const revisions = index.pages().map((page) => page.layoutRevision);
    const previous = blocks[1];
    blocks[1] = { ...previous, content: "updated" } as ChatBlock;

    index.update("b", previous, blocks[1], blocks, null, index.generation);

    expect(index.pages().map((page) => page.layoutRevision)).toEqual([revisions[0], revisions[1] + 1, revisions[2]]);
    expect(index.pageForBlock("b")?.id).toBe(index.pages()[1].id);
  });

  test("keeps incremental streaming estimates equivalent to a full wrapped-row estimate", () => {
    const blocks = [content("stream", 1, false)];
    const index = new TranscriptPageIndex(blocks, "stream", options({ estimatedRowWidth: 10 }));

    for (let chunk = 0; chunk < 100; chunk += 1) {
      const previous = blocks[0];
      if (previous.type !== "content") throw new Error("expected content block");
      const appendedText = chunk % 10 === 0 ? "abcdefghij\n" : "abcdefghij";
      const next = { ...previous, content: previous.content + appendedText } as ChatBlock;
      blocks[0] = next;
      expect(index.appendText("stream", previous, next, appendedText, blocks, "stream", index.generation)).toBe(true);
    }

    expect(index.pageForBlock("stream")?.estimatedRows).toBe(estimateTranscriptBlockRows(blocks[0], 10));
    expectConsistent(index, blocks);
  });

  test("publishes every layout revision even when a streaming append stays on the same estimated row", () => {
    const blocks = [{ type: "content", id: "stream", content: "", finalized: false } as ChatBlock];
    const index = new TranscriptPageIndex(blocks, "stream", options({ estimatedRowWidth: 80 }));
    const pageId = index.pages()[0].id;
    const initialRevision = index.revision;

    for (const appendedText of ["a", "b"]) {
      const previous = blocks[0];
      if (previous.type !== "content") throw new Error("expected content block");
      const next = { ...previous, content: previous.content + appendedText } as ChatBlock;
      blocks[0] = next;
      expect(index.appendText("stream", previous, next, appendedText, blocks, "stream", index.generation)).toBe(true);
    }

    expect(index.revision).toBe(initialRevision + 2);
    expect(index.revisionChange()).toEqual({ revision: index.revision, structural: false, pageIds: [pageId] });
  });

  test("aggregates bounded page changes for independent geometry consumers", () => {
    const initial = [user("u1"), content("c1", 1, true), user("u2"), content("c2", 1, true)];
    const index = new TranscriptPageIndex(initial, null, options({ softBlockLimit: 1 }));
    const indexedPages = index.pages();
    expect(indexedPages).toHaveLength(2);
    const sinceRevision = index.revision;

    for (const page of indexedPages) {
      expect(
        index.setMeasurement(
          page.id,
          {
            transcriptGeneration: index.generation,
            measurementGeneration: 0,
            layoutEpoch: 0,
            width: 80,
            height: page.estimatedRows + 1,
            userBlockOffsets: {},
          },
          page.layoutRevision,
        ),
      ).toBe(true);
    }

    expect(index.revisionChangeSince(sinceRevision)).toEqual({
      revision: index.revision,
      structural: false,
      pageIds: indexedPages.map((page) => page.id),
    });
  });

  test("replacement rebuilds with a new generation and rejects stale operations", () => {
    const blocks = [user("u1"), content("c1")];
    const index = new TranscriptPageIndex(blocks, null, options());
    const staleGeneration = index.generation;
    const replacement = [user("u2"), content("c2")];

    index.replaceTranscript(replacement, null);
    expect(index.generation).toBe(staleGeneration + 1);
    expect(blockIds(index)).toEqual([["u2", "c2"]]);

    const appended = content("stale");
    expect(index.append(appended, [...replacement, appended], null, staleGeneration)).toBe(false);
    expect(index.pageForBlock("stale")).toBeUndefined();
  });

  test("keeps every mutation shape consistent and rejects all stale structural operations", () => {
    const blocks = [user("u1"), content("c1"), user("u2"), content("c2")];
    const index = new TranscriptPageIndex(blocks, null, options({ softBlockLimit: 1, hardBlockLimit: 3 }));
    const firstPageId = index.pages()[0].id;

    const boundaryInsert = content("before-u2");
    blocks.splice(2, 0, boundaryInsert);
    expect(index.insert(2, boundaryInsert, blocks, null, index.generation)).toBe(true);
    expect(index.pages()[0].id).toBe(firstPageId);
    expectConsistent(index, blocks);

    const endInsert = content("at-end");
    blocks.push(endInsert);
    expect(index.insert(blocks.length - 1, endInsert, blocks, null, index.generation)).toBe(true);
    expectConsistent(index, blocks);

    const removed = blocks.splice(1, 1)[0];
    expect(index.remove(removed.id, blocks, null, index.generation)).toBe(true);
    expectConsistent(index, blocks);

    const staleGeneration = index.generation;
    const reordered = [...blocks].reverse();
    index.replaceTranscript(reordered, null);
    expectConsistent(index, reordered);

    const staleInsert = content("stale-insert");
    expect(index.insert(0, staleInsert, [staleInsert, ...reordered], null, staleGeneration)).toBe(false);
    expect(index.remove(reordered[0].id, reordered.slice(1), null, staleGeneration)).toBe(false);
    expect(
      index.update(
        reordered[0].id,
        reordered[0],
        { ...reordered[0], id: reordered[0].id } as ChatBlock,
        reordered,
        null,
        staleGeneration,
      ),
    ).toBe(false);
    expectConsistent(index, reordered);
  });

  test("finalizes only stable non-tail unpinned pages", () => {
    const blocks = [user("u1"), content("c1"), user("u2"), content("c2")];
    const index = new TranscriptPageIndex(blocks, null, options({ softBlockLimit: 1 }));
    const first = index.pages()[0];

    expect(first.finalized).toBe(true);
    expect(index.pages().at(-1)?.finalized).toBe(false);

    index.pinPage(first.id, "navigation");
    expect(index.pages()[0].finalized).toBe(false);
    index.unpinPage(first.id, "navigation", blocks, null);
    expect(index.pages()[0].finalized).toBe(true);
  });
});

describe("isTranscriptBlockStable", () => {
  const cases: Array<[string, ChatBlock, string | null, boolean]> = [
    ["final content", content("content", 1, true), null, true],
    ["streaming content", content("content", 1, false), null, false],
    ["final thinking", { type: "thinking", id: "thinking", content: "x", finalized: true }, null, true],
    ["streaming thinking", { type: "thinking", id: "thinking", content: "x", finalized: false }, null, false],
    ["settled user", user("user"), null, true],
    ["current user", user("user"), "user", false],
    [
      "pending tool",
      { type: "tool", id: "tool", toolCallId: "t", toolName: "x", display: "", status: "pending" },
      null,
      false,
    ],
    [
      "running tool",
      { type: "tool", id: "tool", toolCallId: "t", toolName: "x", display: "", status: "running" },
      null,
      false,
    ],
    [
      "approval tool",
      { type: "tool", id: "tool", toolCallId: "t", toolName: "x", display: "", status: "approval" },
      null,
      false,
    ],
    [
      "successful tool",
      { type: "tool", id: "tool", toolCallId: "t", toolName: "x", display: "", status: "success" },
      null,
      true,
    ],
    [
      "failed tool",
      { type: "tool", id: "tool", toolCallId: "t", toolName: "x", display: "", status: "error" },
      null,
      true,
    ],
    [
      "running bash",
      {
        type: "user-bash",
        id: "bash",
        command: "x",
        output: "",
        exitCode: undefined,
        status: "running",
        excludeFromContext: false,
      },
      null,
      false,
    ],
    [
      "done bash",
      {
        type: "user-bash",
        id: "bash",
        command: "x",
        output: "",
        exitCode: 0,
        status: "done",
        excludeFromContext: false,
      },
      null,
      true,
    ],
    [
      "failed bash",
      {
        type: "user-bash",
        id: "bash",
        command: "x",
        output: "",
        exitCode: 1,
        status: "error",
        excludeFromContext: false,
      },
      null,
      true,
    ],
    [
      "pending elicitation",
      {
        type: "elicitation",
        id: "e",
        mode: "form",
        message: "x",
        status: "pending",
        fields: [],
        currentFieldIndex: 0,
        answers: {},
      },
      null,
      false,
    ],
    [
      "accepted elicitation",
      {
        type: "elicitation",
        id: "e",
        mode: "form",
        message: "x",
        status: "accepted",
        fields: [],
        currentFieldIndex: 0,
        answers: {},
      },
      null,
      true,
    ],
    [
      "declined elicitation",
      {
        type: "elicitation",
        id: "e",
        mode: "form",
        message: "x",
        status: "declined",
        fields: [],
        currentFieldIndex: 0,
        answers: {},
      },
      null,
      true,
    ],
    [
      "cancelled elicitation",
      {
        type: "elicitation",
        id: "e",
        mode: "form",
        message: "x",
        status: "cancelled",
        fields: [],
        currentFieldIndex: 0,
        answers: {},
      },
      null,
      true,
    ],
    ["spinner", { type: "info", id: "info", content: "x", variant: "spinner" }, null, false],
    ["info", { type: "info", id: "info", content: "x", variant: "info" }, null, true],
    [
      "plugin",
      { type: "plugin", id: "plugin", pluginId: "p", pluginName: "p", blockType: "x", content: "x" },
      null,
      true,
    ],
  ];

  for (const [name, block, currentBlockId, expected] of cases) {
    test(name, () => expect(isTranscriptBlockStable(block, currentBlockId)).toBe(expected));
  }
});
