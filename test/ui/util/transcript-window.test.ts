import { describe, expect, test } from "bun:test";
import type { TranscriptPage } from "../../../src/ui/util/transcript-page-index";
import {
  buildTranscriptGeometry,
  buildTranscriptRenderSegments,
  calculateTranscriptWindow,
  mountedTranscriptPageIds,
  TranscriptGeometryIndex,
} from "../../../src/ui/util/transcript-window";

function page(id: string, height: number, options: Partial<TranscriptPage> = {}): TranscriptPage {
  return {
    id,
    anchorBlockId: `block-${id}`,
    blockIds: [`block-${id}`],
    estimatedRows: height,
    layoutRevision: 0,
    dynamic: false,
    finalized: true,
    reopened: false,
    pinReasons: [],
    ...options,
  };
}

describe("transcript window", () => {
  test("builds cumulative geometry from exact and estimated heights", () => {
    const pages = [
      page("a", 10),
      page("b", 20, {
        measurement: {
          transcriptGeneration: 1,
          measurementGeneration: 1,
          layoutEpoch: 0,
          width: 80,
          height: 12,
          userBlockOffsets: {},
        },
      }),
      page("c", 5),
    ];

    expect(buildTranscriptGeometry(pages)).toEqual([
      { pageId: "a", index: 0, start: 0, end: 10, height: 10, exact: false },
      { pageId: "b", index: 1, start: 10, end: 22, height: 12, exact: true },
      { pageId: "c", index: 2, start: 22, end: 27, height: 5, exact: false },
    ]);
  });

  test("updates cumulative geometry from bounded page-change sets", () => {
    const pages = [page("a", 10), page("b", 20), page("c", 5)];
    const index = new TranscriptGeometryIndex();
    index.sync(pages, { revision: 1, structural: true, pageIds: [] });

    expect(index.pageAtOffset(21)).toMatchObject({ pageId: "b", start: 10, end: 30 });
    const updatedPages = [
      pages[0],
      page("b", 20, {
        measurement: {
          transcriptGeneration: 1,
          measurementGeneration: 1,
          layoutEpoch: 0,
          width: 80,
          height: 30,
          userBlockOffsets: {},
        },
      }),
      pages[2],
    ];
    index.sync(updatedPages, { revision: 2, structural: false, pageIds: ["b"] });

    expect(index.page("c")).toMatchObject({ start: 40, end: 45 });
    expect(index.calculateWindow({ scrollTop: 39, viewportHeight: 2, overscanPages: 0 })).toEqual({
      startPageId: "b",
      endPageId: "c",
    });
    expect(index.renderSegments(new Set(["b"]))).toEqual([
      { type: "spacer", key: "spacer:a:a", height: 10, startPageId: "a", endPageId: "a" },
      { type: "page", key: "page:b", pageId: "b" },
      { type: "spacer", key: "spacer:c:c", height: 5, startPageId: "c", endPageId: "c" },
    ]);
  });

  test("selects viewport pages with page-count overscan", () => {
    const geometry = buildTranscriptGeometry(Array.from({ length: 10 }, (_, index) => page(String(index), 10)));

    expect(calculateTranscriptWindow(geometry, { scrollTop: 35, viewportHeight: 20, overscanPages: 1 })).toEqual({
      startPageId: "2",
      endPageId: "6",
    });
  });

  test("starts at the tail when no scroll position is available", () => {
    const geometry = buildTranscriptGeometry(Array.from({ length: 10 }, (_, index) => page(String(index), 10)));

    expect(calculateTranscriptWindow(geometry, { scrollTop: null, viewportHeight: 20, overscanPages: 1 })).toEqual({
      startPageId: "7",
      endPageId: "9",
    });
  });

  test("aggregates contiguous off-window pages into bounded spacer runs", () => {
    const pages = Array.from({ length: 100 }, (_, index) => page(String(index), 10));
    const mounted = new Set(["10", "11", "12", "90"]);

    const segments = buildTranscriptRenderSegments(pages, mounted);

    expect(segments).toEqual([
      { type: "spacer", key: "spacer:0:9", height: 100, startPageId: "0", endPageId: "9" },
      { type: "page", key: "page:10", pageId: "10" },
      { type: "page", key: "page:11", pageId: "11" },
      { type: "page", key: "page:12", pageId: "12" },
      { type: "spacer", key: "spacer:13:89", height: 770, startPageId: "13", endPageId: "89" },
      { type: "page", key: "page:90", pageId: "90" },
      { type: "spacer", key: "spacer:91:99", height: 90, startPageId: "91", endPageId: "99" },
    ]);
    expect(segments).toHaveLength(7);
  });

  test("bounds background dynamic pages while retaining the window, pins, and tail", () => {
    const pages = Array.from({ length: 100 }, (_, index) =>
      page(String(index), 10, { dynamic: true, finalized: false }),
    );
    pages[90] = page("90", 10, { pinReasons: ["navigation"], finalized: false, dynamic: true });
    const geometry = buildTranscriptGeometry(pages);
    const window = calculateTranscriptWindow(geometry, { scrollTop: 450, viewportHeight: 20, overscanPages: 1 });
    const mounted = mountedTranscriptPageIds(pages, window);

    expect(mounted).toEqual(new Set(["43", "44", "45", "46", "47", "48", "90", "99"]));
    expect(mounted.size).toBeLessThan(10);
  });

  test("mounts the window plus dynamic and pinned pages without depending on total history", () => {
    const pages = Array.from({ length: 100 }, (_, index) =>
      page(String(index), 10, index === 3 ? { dynamic: true, finalized: false } : {}),
    );
    pages[90] = page("90", 10, { pinReasons: ["navigation"], finalized: false, dynamic: true });
    const geometry = buildTranscriptGeometry(pages);
    const window = calculateTranscriptWindow(geometry, { scrollTop: 450, viewportHeight: 20, overscanPages: 1 });
    const mounted = mountedTranscriptPageIds(pages, window);

    expect(mounted).toEqual(new Set(["3", "44", "45", "46", "47", "90", "99"]));
    expect(mounted.size).toBeLessThan(10);
  });
});
