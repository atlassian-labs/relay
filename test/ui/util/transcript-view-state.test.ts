import { describe, expect, test } from "bun:test";
import type { ChatBlock } from "../../../src/ui/state";
import { TranscriptViewState } from "../../../src/ui/util/transcript-view-state";

function user(id: string): ChatBlock {
  return { type: "user", id, content: id };
}

function tallContent(id: string): ChatBlock {
  return {
    type: "content",
    id,
    content: Array.from({ length: 100 }, (_, index) => `${id}-${index}`).join("\n"),
    finalized: true,
  };
}

const GEOMETRY = { width: 80, height: 4, userBlockOffsets: { u1: 0 } } as const;

describe("TranscriptViewState measurements", () => {
  test("accepts only the current transcript, measurement generation, epoch, and page revision", () => {
    const view = new TranscriptViewState([user("u1")], null);
    const page = view.pageIndex.pages()[0];
    const token = view.beginMeasurementGeneration();

    expect(view.commitPageMeasurement(page.id, GEOMETRY, token, page.layoutRevision)).toBe(true);
    expect(view.pageIndex.pages()[0].measurement).toMatchObject(GEOMETRY);

    const newerToken = view.beginMeasurementGeneration();
    expect(view.commitPageMeasurement(page.id, GEOMETRY, token, page.layoutRevision)).toBe(false);
    expect(view.commitPageMeasurement(page.id, GEOMETRY, newerToken, page.layoutRevision)).toBe(true);

    view.advanceLayoutEpoch();
    expect(view.pageIndex.pages()[0]).toMatchObject({
      measurement: undefined,
      estimatedHeight: GEOMETRY.height,
      estimatedUserBlockOffsets: GEOMETRY.userBlockOffsets,
    });
    expect(view.commitPageMeasurement(page.id, GEOMETRY, newerToken, page.layoutRevision)).toBe(false);

    const beforeReplacement = view.beginMeasurementGeneration();
    view.replaceTranscript([user("u2")], null);
    expect(view.commitPageMeasurement(page.id, GEOMETRY, beforeReplacement, page.layoutRevision)).toBe(false);
  });

  test("rejects measurement work cancelled during thread deactivation", () => {
    const view = new TranscriptViewState([user("u1")], null);
    const page = view.pageIndex.pages()[0];
    const token = view.beginMeasurementGeneration();

    view.cancelMeasurementWork();

    expect(view.commitPageMeasurement(page.id, GEOMETRY, token, page.layoutRevision)).toBe(false);
    expect(view.pageIndex.pageById(page.id)?.measurement).toBeUndefined();
  });

  test("reopens a finalized historical page after a stable update until it is remeasured", () => {
    const blocks = [tallContent("a"), tallContent("b"), tallContent("c")];
    const view = new TranscriptViewState(blocks, null);
    const page = view.pageIndex.pageForBlock("b")!;
    expect(page.finalized).toBe(true);

    const previous = blocks[1];
    if (previous.type !== "content") throw new Error("expected content block");
    const next = { ...previous, content: `${previous.content}\nupdated` } as ChatBlock;
    blocks[1] = next;
    expect(view.updateBlock("b", previous, next, blocks, null, view.transcriptGeneration)).toBe(true);

    const reopened = view.pageIndex.pageForBlock("b")!;
    expect(reopened.reopened).toBe(true);
    expect(reopened.dynamic).toBe(true);
    expect(reopened.finalized).toBe(false);

    const token = view.beginMeasurementGeneration();
    expect(view.commitPageMeasurement(reopened.id, GEOMETRY, token, reopened.layoutRevision)).toBe(true);
    expect(view.pageIndex.pageForBlock("b")).toMatchObject({ reopened: false, dynamic: false, finalized: true });
  });

  test("clears window and scroll references when their page is removed", () => {
    const blocks = [tallContent("a"), tallContent("b")];
    const view = new TranscriptViewState(blocks, null);
    const removedPage = view.pageIndex.pageForBlock("a")!;
    view.setWindow({ startPageId: removedPage.id, endPageId: removedPage.id });
    view.setScrollAnchor({ pageId: removedPage.id, offset: 3 });
    blocks.splice(0, 1);

    expect(view.removeBlock("a", blocks, null, view.transcriptGeneration)).toBe(true);

    expect(view.pageIndex.pageById(removedPage.id)).toBeUndefined();
    expect(view.window()).toBeNull();
    expect(view.scrollAnchor()).toBeNull();
  });

  test("invalidates a measured page when a block is appended into it", () => {
    const blocks = [user("u1")];
    const view = new TranscriptViewState(blocks, null);
    const page = view.pageIndex.pages()[0];
    const token = view.beginMeasurementGeneration();
    expect(view.commitPageMeasurement(page.id, GEOMETRY, token, page.layoutRevision)).toBe(true);

    const appended = { type: "content", id: "c1", content: "answer", finalized: true } as const;
    blocks.push(appended);
    expect(view.appendBlock(appended, blocks, null, view.transcriptGeneration)).toBe(true);

    const updatedPage = view.pageIndex.pageForBlock("c1")!;
    expect(updatedPage.id).toBe(page.id);
    expect(updatedPage.layoutRevision).toBe(page.layoutRevision + 1);
    expect(updatedPage).toMatchObject({ measurement: undefined, estimatedHeight: GEOMETRY.height });
    expect(view.commitPageMeasurement(page.id, GEOMETRY, token, page.layoutRevision)).toBe(false);
  });
});
