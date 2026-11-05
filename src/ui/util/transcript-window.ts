import type { TranscriptPage, TranscriptPageRevisionChange } from "./transcript-page-index";
import type { TranscriptWindow } from "./transcript-view-state";

export interface TranscriptPageGeometry {
  readonly pageId: string;
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly height: number;
  readonly exact: boolean;
}

export type TranscriptRenderSegment =
  | { readonly type: "page"; readonly key: string; readonly pageId: string }
  | {
      readonly type: "spacer";
      readonly key: string;
      readonly height: number;
      readonly startPageId: string;
      readonly endPageId: string;
    };

export interface TranscriptWindowOptions {
  readonly scrollTop: number | null;
  readonly viewportHeight: number;
  readonly overscanPages: number;
}

/**
 * Resolves the best available height for a transcript page.
 *
 * @param page - Page whose exact or estimated height should be read.
 * @returns The page height, clamped to at least one row.
 */
export function transcriptPageHeight(page: TranscriptPage): number {
  return Math.max(1, page.measurement?.height ?? page.estimatedHeight ?? page.estimatedRows);
}

export class TranscriptGeometryIndex {
  #pageIds: string[] = [];
  #heights: number[] = [];
  #exact: boolean[] = [];
  #tree: number[] = [0];
  #indexById = new Map<string, number>();
  #revision = -1;
  #ownerKey: string | null = null;

  /**
   * Synchronizes the geometry index from structural or page-local index revisions.
   *
   * @param pages - Current ordered transcript pages.
   * @param change - Page-index revision summary since the previous synchronization.
   * @param ownerKey - Identity of the thread and transcript generation owning the geometry.
   * @returns Nothing; geometry arrays and the Fenwick tree are updated in place.
   */
  sync(pages: readonly TranscriptPage[], change: TranscriptPageRevisionChange, ownerKey = ""): void {
    if (
      this.#revision < 0 ||
      this.#ownerKey !== ownerKey ||
      change.structural ||
      pages.length !== this.#pageIds.length
    ) {
      this.#rebuild(pages, change.revision, ownerKey);
      return;
    }
    for (const pageId of change.pageIds) {
      const index = this.#indexById.get(pageId);
      if (index === undefined) continue;
      const page = pages[index];
      const height = transcriptPageHeight(page);
      const delta = height - this.#heights[index];
      this.#heights[index] = height;
      this.#exact[index] = page.measurement !== undefined;
      if (delta !== 0) this.#add(index, delta);
    }
    this.#revision = change.revision;
  }

  get revision(): number {
    return this.#revision;
  }

  get pageCount(): number {
    return this.#pageIds.length;
  }

  get totalHeight(): number {
    return this.#prefix(this.#pageIds.length);
  }

  pageIdAt(index: number): string | undefined {
    return this.#pageIds[index];
  }

  pageIndex(pageId: string): number {
    return this.#indexById.get(pageId) ?? -1;
  }

  page(pageId: string): TranscriptPageGeometry | undefined {
    const index = this.pageIndex(pageId);
    return index < 0 ? undefined : this.#geometryAt(index);
  }

  /**
   * Locates the page containing a transcript-relative vertical offset using the Fenwick tree.
   *
   * @param offset - Zero-based vertical offset within the complete transcript.
   * @returns Geometry for the containing page, or `undefined` when the transcript is empty.
   */
  pageAtOffset(offset: number): TranscriptPageGeometry | undefined {
    if (this.#pageIds.length === 0) return undefined;
    const target = Math.max(0, Math.min(offset, Math.max(0, this.totalHeight - 1)));
    let index = 0;
    let prefix = 0;
    let bit = 1;
    while (bit * 2 <= this.#pageIds.length) bit *= 2;
    for (; bit > 0; bit = Math.floor(bit / 2)) {
      const next = index + bit;
      if (next <= this.#pageIds.length && prefix + this.#tree[next] <= target) {
        index = next;
        prefix += this.#tree[next];
      }
    }
    return this.#geometryAt(Math.min(index, this.#pageIds.length - 1), prefix);
  }

  /**
   * Calculates the visible page range plus configured overscan.
   *
   * @param options - Scroll position, viewport height, and overscan settings.
   * @returns The mounted page window, or `null` when the transcript is empty.
   */
  calculateWindow(options: TranscriptWindowOptions): TranscriptWindow | null {
    if (this.#pageIds.length === 0) return null;
    const viewportHeight = Math.max(1, options.viewportHeight);
    const scrollTop = Math.max(0, options.scrollTop ?? Math.max(0, this.totalHeight - viewportHeight));
    const viewportEnd = scrollTop + viewportHeight;
    const firstVisible = this.pageAtOffset(scrollTop)?.index ?? this.#pageIds.length - 1;
    let endVisible = firstVisible;
    while (endVisible + 1 < this.#pageIds.length && this.#prefix(endVisible + 1) < viewportEnd) endVisible += 1;
    const overscan = Math.max(0, Math.floor(options.overscanPages));
    const startIndex = Math.max(0, firstVisible - overscan);
    const endIndex = Math.min(this.#pageIds.length - 1, endVisible + overscan);
    return { startPageId: this.#pageIds[startIndex], endPageId: this.#pageIds[endIndex] };
  }

  /**
   * Projects mounted pages and unmounted ranges into renderable page and spacer segments.
   *
   * @param mountedPageIds - Page identifiers that must render as live page components.
   * @returns Ordered render segments covering the complete transcript height.
   */
  renderSegments(mountedPageIds: ReadonlySet<string>): readonly TranscriptRenderSegment[] {
    const mountedIndices = [...mountedPageIds]
      .map((pageId) => this.pageIndex(pageId))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right);
    const segments: TranscriptRenderSegment[] = [];
    let cursor = 0;
    for (const index of mountedIndices) {
      if (index > cursor) segments.push(this.#spacer(cursor, index - 1));
      const pageId = this.#pageIds[index];
      segments.push({ type: "page", key: `page:${pageId}`, pageId });
      cursor = index + 1;
    }
    if (cursor < this.#pageIds.length) segments.push(this.#spacer(cursor, this.#pageIds.length - 1));
    return segments;
  }

  /**
   * Sums page heights for an inclusive index range.
   *
   * @param startIndex - First page index in the range.
   * @param endIndexInclusive - Last page index in the range.
   * @returns The total height of the requested range.
   */
  rangeHeight(startIndex: number, endIndexInclusive: number): number {
    if (endIndexInclusive < startIndex) return 0;
    return this.#prefix(endIndexInclusive + 1) - this.#prefix(startIndex);
  }

  /**
   * Creates one spacer segment representing a contiguous unmounted page range.
   *
   * @param startIndex - First unmounted page index.
   * @param endIndex - Last unmounted page index.
   * @returns A spacer segment with stable boundary IDs and aggregate height.
   */
  #spacer(startIndex: number, endIndex: number): Extract<TranscriptRenderSegment, { type: "spacer" }> {
    const startPageId = this.#pageIds[startIndex];
    const endPageId = this.#pageIds[endIndex];
    return {
      type: "spacer",
      key: `spacer:${startPageId}:${endPageId}`,
      height: this.rangeHeight(startIndex, endIndex),
      startPageId,
      endPageId,
    };
  }

  /**
   * Materializes geometry for one indexed page.
   *
   * @param index - Zero-based page index.
   * @param knownStart - Precomputed page start offset, when already available.
   * @returns Geometry containing page bounds, height, and measurement precision.
   */
  #geometryAt(index: number, knownStart?: number): TranscriptPageGeometry {
    const start = knownStart ?? this.#prefix(index);
    const height = this.#heights[index];
    return {
      pageId: this.#pageIds[index],
      index,
      start,
      end: start + height,
      height,
      exact: this.#exact[index],
    };
  }

  /**
   * Rebuilds all geometry arrays, lookup maps, and Fenwick-tree values.
   *
   * @param pages - Current ordered transcript pages.
   * @param revision - Page-index revision represented by the rebuild.
   * @param ownerKey - Identity of the thread and transcript generation owning the geometry.
   * @returns Nothing; all geometry state is replaced in place.
   */
  #rebuild(pages: readonly TranscriptPage[], revision: number, ownerKey: string): void {
    this.#pageIds = pages.map((page) => page.id);
    this.#heights = pages.map(transcriptPageHeight);
    this.#exact = pages.map((page) => page.measurement !== undefined);
    this.#indexById = new Map(this.#pageIds.map((pageId, index) => [pageId, index]));
    this.#tree = Array(this.#pageIds.length + 1).fill(0);
    for (let index = 0; index < this.#heights.length; index += 1) this.#add(index, this.#heights[index]);
    this.#revision = revision;
    this.#ownerKey = ownerKey;
  }

  /**
   * Applies a page-height delta to the Fenwick tree.
   *
   * @param index - Zero-based page index receiving the delta.
   * @param delta - Signed height change to apply.
   * @returns Nothing; tree nodes are updated in place.
   */
  #add(index: number, delta: number): void {
    for (let treeIndex = index + 1; treeIndex < this.#tree.length; treeIndex += treeIndex & -treeIndex) {
      this.#tree[treeIndex] += delta;
    }
  }

  /**
   * Calculates the cumulative height of pages before a given count.
   *
   * @param count - Number of leading pages to include.
   * @returns The summed height of the requested prefix.
   */
  #prefix(count: number): number {
    let total = 0;
    for (let treeIndex = count; treeIndex > 0; treeIndex -= treeIndex & -treeIndex) total += this.#tree[treeIndex];
    return total;
  }
}

/**
 * Builds linear page geometry for callers that do not retain an incremental index.
 *
 * @param pages - Ordered transcript pages to project.
 * @returns Geometry entries covering the complete transcript in order.
 */
export function buildTranscriptGeometry(pages: readonly TranscriptPage[]): TranscriptPageGeometry[] {
  let start = 0;
  return pages.map((page, index) => {
    const height = transcriptPageHeight(page);
    const geometry = {
      pageId: page.id,
      index,
      start,
      end: start + height,
      height,
      exact: page.measurement !== undefined,
    };
    start += height;
    return geometry;
  });
}

/**
 * Calculates a visible page window from prebuilt linear geometry.
 *
 * @param geometry - Ordered page geometry covering the transcript.
 * @param options - Scroll position, viewport height, and overscan settings.
 * @returns The visible page range with overscan, or `null` for empty geometry.
 */
export function calculateTranscriptWindow(
  geometry: readonly TranscriptPageGeometry[],
  options: TranscriptWindowOptions,
): TranscriptWindow | null {
  if (geometry.length === 0) return null;
  const viewportHeight = Math.max(1, options.viewportHeight);
  const totalHeight = geometry.at(-1)?.end ?? 0;
  const scrollTop = Math.max(0, options.scrollTop ?? Math.max(0, totalHeight - viewportHeight));
  const viewportEnd = scrollTop + viewportHeight;
  const firstVisible = geometry.findIndex((page) => page.end > scrollTop);
  const startVisibleIndex = firstVisible < 0 ? geometry.length - 1 : firstVisible;
  let endVisibleIndex = startVisibleIndex;
  while (endVisibleIndex + 1 < geometry.length && geometry[endVisibleIndex].end < viewportEnd) {
    endVisibleIndex += 1;
  }
  const overscan = Math.max(0, Math.floor(options.overscanPages));
  const startIndex = Math.max(0, startVisibleIndex - overscan);
  const endIndex = Math.min(geometry.length - 1, endVisibleIndex + overscan);
  return {
    startPageId: geometry[startIndex].pageId,
    endPageId: geometry[endIndex].pageId,
  };
}

/**
 * Converts page membership into mounted page segments and aggregate spacers.
 *
 * @param pages - Ordered transcript pages.
 * @param mountedPageIds - Page identifiers that must remain mounted.
 * @returns Ordered render segments preserving the transcript's total height.
 */
export function buildTranscriptRenderSegments(
  pages: readonly TranscriptPage[],
  mountedPageIds: ReadonlySet<string>,
): readonly TranscriptRenderSegment[] {
  const segments: TranscriptRenderSegment[] = [];
  let spacerPages: TranscriptPage[] = [];
  /**
   * Flushes the pending contiguous unmounted pages into one spacer segment.
   *
   * @returns Nothing; the segment list and pending spacer buffer are updated in place.
   */
  const flushSpacer = () => {
    if (spacerPages.length === 0) return;
    const first = spacerPages[0].id;
    const last = spacerPages.at(-1)!.id;
    segments.push({
      type: "spacer",
      key: `spacer:${first}:${last}`,
      height: spacerPages.reduce((height, page) => height + transcriptPageHeight(page), 0),
      startPageId: first,
      endPageId: last,
    });
    spacerPages = [];
  };

  for (const page of pages) {
    if (!mountedPageIds.has(page.id)) {
      spacerPages.push(page);
      continue;
    }
    flushSpacer();
    segments.push({ type: "page", key: `page:${page.id}`, pageId: page.id });
  }
  flushSpacer();
  return segments;
}

const MAX_BACKGROUND_DYNAMIC_PAGES = 2;

/**
 * Selects pages that must stay mounted for visibility, pins, tail updates, or bounded background activity.
 *
 * @param pages - Ordered transcript pages.
 * @param window - Current visible page window, or `null` before window calculation.
 * @returns The set of page identifiers that should render as live components.
 */
export function mountedTranscriptPageIds(
  pages: readonly TranscriptPage[],
  window: TranscriptWindow | null,
): ReadonlySet<string> {
  const mounted = new Set<string>();
  const startIndex = window ? pages.findIndex((page) => page.id === window.startPageId) : -1;
  const endIndex = window ? pages.findIndex((page) => page.id === window.endPageId) : -1;
  if (startIndex >= 0 && endIndex >= startIndex) {
    for (let index = startIndex; index <= endIndex; index += 1) mounted.add(pages[index].id);
  }
  for (const page of pages) {
    if (page.pinReasons.length > 0) mounted.add(page.id);
  }
  const tail = pages.at(-1);
  if (tail) mounted.add(tail.id);

  const windowStart = startIndex >= 0 ? startIndex : Math.max(0, pages.length - 1);
  const windowEnd = endIndex >= windowStart ? endIndex : windowStart;
  const dynamicCandidates = pages
    .map((page, index) => ({ page, index }))
    .filter(({ page }) => page.dynamic && !mounted.has(page.id))
    .sort((left, right) => {
      const leftDistance = left.index < windowStart ? windowStart - left.index : Math.max(0, left.index - windowEnd);
      const rightDistance =
        right.index < windowStart ? windowStart - right.index : Math.max(0, right.index - windowEnd);
      return leftDistance - rightDistance || left.index - right.index;
    })
    .slice(0, MAX_BACKGROUND_DYNAMIC_PAGES);
  for (const { page } of dynamicCandidates) mounted.add(page.id);
  return mounted;
}

/**
 * Finds the start offset of a page in linear geometry.
 *
 * @param geometry - Ordered page geometry.
 * @param pageId - Identifier of the page to locate.
 * @returns The page start offset, or `undefined` when the page is absent.
 */
export function transcriptPageOffset(geometry: readonly TranscriptPageGeometry[], pageId: string): number | undefined {
  return geometry.find((page) => page.pageId === pageId)?.start;
}

/**
 * Finds the first geometry entry extending beyond a transcript-relative offset.
 *
 * @param geometry - Ordered page geometry.
 * @param offset - Vertical offset within the transcript.
 * @returns The containing page, the final page past the end, or `undefined` for empty geometry.
 */
export function transcriptPageAtOffset(
  geometry: readonly TranscriptPageGeometry[],
  offset: number,
): TranscriptPageGeometry | undefined {
  return geometry.find((page) => page.end > offset) ?? geometry.at(-1);
}
