import { createSignal } from "solid-js";
import type { ChatBlock } from "../state";
import { isSingleLineResult } from "./format";

export const TRANSCRIPT_PAGE_SOFT_BLOCK_LIMIT = 32;
export const TRANSCRIPT_PAGE_SOFT_ROW_LIMIT = 96;
export const TRANSCRIPT_PAGE_HARD_BLOCK_LIMIT = 64;
export const TRANSCRIPT_PAGE_HARD_ROW_LIMIT = 192;
export const TRANSCRIPT_TALL_BLOCK_ROW_THRESHOLD = 96;
export const TRANSCRIPT_ESTIMATED_ROW_WIDTH = 80;
export const TRANSCRIPT_COLLAPSED_PAYLOAD_ROW_LIMIT = 20;
export const TRANSCRIPT_COLLAPSED_USER_ROW_LIMIT = 10;

export interface TranscriptLayoutProjection {
  readonly width: number;
  readonly detailsExpanded: boolean;
  readonly showThinking: boolean;
  readonly thinkingPreviewLines: number;
  readonly toolPreviewLines: number;
  readonly succinctToolResults: boolean;
  readonly toolCallGroupsKey?: string;
  readonly toolCallGroupRoles?: Readonly<Record<string, "collapsed-header" | "collapsed-hidden" | "expanded-header">>;
}

export type TranscriptPagePinReason = "streaming" | "interaction" | "selection" | "navigation";

export interface TranscriptPageMeasurement {
  readonly transcriptGeneration: number;
  readonly measurementGeneration: number;
  readonly layoutEpoch: number;
  readonly width: number;
  readonly height: number;
  readonly userBlockOffsets: Readonly<Record<string, number>>;
  readonly blockOffsets?: Readonly<Record<string, number>>;
}

export interface TranscriptPage {
  readonly id: string;
  readonly anchorBlockId: string;
  readonly blockIds: readonly string[];
  readonly estimatedRows: number;
  readonly layoutRevision: number;
  readonly dynamic: boolean;
  readonly finalized: boolean;
  readonly reopened: boolean;
  readonly pinReasons: readonly TranscriptPagePinReason[];
  readonly measurement?: TranscriptPageMeasurement;
  readonly estimatedHeight?: number;
  readonly estimatedUserBlockOffsets?: Readonly<Record<string, number>>;
}

export interface TranscriptPageRevisionChange {
  readonly revision: number;
  readonly structural: boolean;
  readonly pageIds: readonly string[];
}

export interface TranscriptPageIndexOptions {
  readonly createPageId?: () => string;
  readonly softBlockLimit?: number;
  readonly softRowLimit?: number;
  readonly hardBlockLimit?: number;
  readonly hardRowLimit?: number;
  readonly tallBlockRowThreshold?: number;
  readonly estimatedRowWidth?: number;
}

interface ResolvedTranscriptPageIndexOptions {
  readonly createPageId: () => string;
  readonly softBlockLimit: number;
  readonly softRowLimit: number;
  readonly hardBlockLimit: number;
  readonly hardRowLimit: number;
  readonly tallBlockRowThreshold: number;
  readonly estimatedRowWidth: number;
}

let transcriptPageIdCounter = 0;

/**
 * Allocates a process-local identifier for a newly created transcript page.
 *
 * @returns The next monotonically increasing transcript page identifier.
 */
function nextTranscriptPageId(): string {
  transcriptPageIdCounter += 1;
  return `transcript-page-${transcriptPageIdCounter}`;
}

/**
 * Creates the default renderer projection used before the windowed layout supplies live settings.
 *
 * @param width - Estimated terminal width available to transcript content.
 * @returns A normalized collapsed-layout projection for row estimation.
 */
function defaultLayoutProjection(width = TRANSCRIPT_ESTIMATED_ROW_WIDTH): TranscriptLayoutProjection {
  return {
    width: Math.max(1, width),
    detailsExpanded: false,
    showThinking: true,
    thinkingPreviewLines: 1,
    toolPreviewLines: 5,
    succinctToolResults: true,
    toolCallGroupsKey: "",
    toolCallGroupRoles: {},
  };
}

interface TranscriptTextMetrics {
  readonly wrappedRows: number;
  readonly trailingColumns: number;
}

/**
 * Extends cached text metrics without rescanning content that was already measured.
 *
 * @param previous - Metrics for the text before the append.
 * @param appendedText - New text fragment to incorporate.
 * @param estimatedRowWidth - Estimated terminal columns available per rendered row.
 * @returns Updated wrapped-row and trailing-column metrics for the combined text.
 */
function appendTextMetrics(
  previous: TranscriptTextMetrics,
  appendedText: string,
  estimatedRowWidth: number,
): TranscriptTextMetrics {
  if (!appendedText) return previous;
  const rowWidth = Math.max(1, estimatedRowWidth);
  let wrappedRows = previous.wrappedRows;
  let trailingColumns = previous.trailingColumns;
  for (let index = 0; index < appendedText.length; index += 1) {
    if (wrappedRows === 0) wrappedRows = 1;
    if (appendedText.charCodeAt(index) === 10) {
      wrappedRows += 1;
      trailingColumns = 0;
      continue;
    }
    trailingColumns += 1;
    if (trailingColumns > rowWidth) {
      wrappedRows += 1;
      trailingColumns = 1;
    }
  }
  return { wrappedRows, trailingColumns };
}

/**
 * Calculates wrapped-row metrics for a complete text value.
 *
 * @param text - Text to measure, or `undefined` for empty content.
 * @param estimatedRowWidth - Estimated terminal columns available per rendered row.
 * @returns Wrapped-row and trailing-column metrics for the text.
 */
function textMetrics(text: string | undefined, estimatedRowWidth: number): TranscriptTextMetrics {
  return appendTextMetrics({ wrappedRows: 0, trailingColumns: 0 }, text ?? "", estimatedRowWidth);
}

/**
 * Converts cached text metrics into a usable estimated row count.
 *
 * @param metrics - Wrapped-row metrics to convert.
 * @returns The estimated number of rendered rows occupied by the text.
 */
function estimatedTextRows(metrics: TranscriptTextMetrics): number {
  return metrics.wrappedRows;
}

/**
 * Estimates wrapped rows for text after applying an optional visible-line cap.
 *
 * @param text - Text whose visible height should be estimated.
 * @param projection - Active renderer layout settings.
 * @param maxLines - Maximum logical lines rendered before an overflow indicator, when capped.
 * @returns The projected rendered row count for the visible text.
 */
function projectedTextRows(
  text: string | undefined,
  projection: TranscriptLayoutProjection,
  maxLines?: number,
): number {
  if (!text || maxLines === 0) return 0;
  if (maxLines === undefined) return estimatedTextRows(textMetrics(text, projection.width));
  const lines = text.split("\n");
  const visible = lines.slice(0, Math.max(0, maxLines));
  const visibleRows = estimatedTextRows(textMetrics(visible.join("\n"), projection.width));
  return visibleRows + (lines.length > visible.length ? 1 : 0);
}

/**
 * Estimates rows for an unknown payload by serializing non-string values when possible.
 *
 * @param value - Text or structured value whose display size should be estimated.
 * @param projection - Active renderer layout settings used for width and visibility.
 * @param maxLines - Maximum logical lines rendered before an overflow indicator, when capped.
 * @returns The estimated rendered row count for the visible value.
 */
function unknownTextRows(value: unknown, projection: TranscriptLayoutProjection, maxLines?: number): number {
  if (typeof value === "string") return projectedTextRows(value, projection, maxLines);
  if (value === null || value === undefined) return 0;
  try {
    return projectedTextRows(JSON.stringify(value, null, 2), projection, maxLines);
  } catch {
    return 1;
  }
}

/**
 * Estimates the rendered height of a transcript block using its type-specific presentation.
 *
 * @param block - Transcript block to estimate.
 * @param estimatedRowWidth - Fallback terminal width used when the projection has no positive width.
 * @param layoutProjection - Renderer visibility and expansion settings used for the estimate.
 * @returns The estimated number of visible rows occupied by the block.
 */
export function estimateTranscriptBlockRows(
  block: ChatBlock,
  estimatedRowWidth = TRANSCRIPT_ESTIMATED_ROW_WIDTH,
  layoutProjection: TranscriptLayoutProjection = defaultLayoutProjection(estimatedRowWidth),
): number {
  const projection = { ...layoutProjection, width: Math.max(1, layoutProjection.width || estimatedRowWidth) };
  const groupRole = projection.toolCallGroupRoles?.[block.id];
  if (groupRole === "collapsed-hidden") return 0;
  if (groupRole === "collapsed-header") return 1;

  const collapsed = !projection.detailsExpanded;
  const rows = (() => {
    switch (block.type) {
      case "content":
        return Math.max(1, projectedTextRows(block.content, projection) + 1);
      case "thinking": {
        if (!projection.showThinking) return 0;
        if (!block.finalized) return 2;
        const previewLines =
          collapsed && projection.thinkingPreviewLines > 0 ? projection.thinkingPreviewLines : undefined;
        return Math.max(1, projectedTextRows(block.content, projection, previewLines) + 1);
      }
      case "user":
        return Math.max(
          3,
          projectedTextRows(block.content, projection, collapsed ? TRANSCRIPT_COLLAPSED_USER_ROW_LIMIT : undefined) + 2,
        );
      case "tool": {
        const previewLines = collapsed ? Math.max(0, projection.toolPreviewLines) : undefined;
        // Collapsed renderers draw no body for a one-line result, so a long single line costs nothing.
        const bodyRows = (value: unknown) =>
          collapsed && typeof value === "string" && isSingleLineResult(value)
            ? 0
            : unknownTextRows(value, projection, previewLines);
        // Renderers show details when present and only fall back to rawOutput.
        const resultRows = block.details
          ? bodyRows(block.details)
          : projection.succinctToolResults && collapsed
            ? Math.min(1, bodyRows(block.rawOutput))
            : bodyRows(block.rawOutput);
        // Off hides the result; reserve the "enter to expand" row a selected tool shows.
        const hintRows = previewLines === 0 && (block.details || block.rawOutput) ? 1 : 0;
        return Math.max(1 + hintRows, 1 + resultRows + (block.diff ? 3 : 0));
      }
      case "user-bash":
        return Math.max(
          3,
          projectedTextRows(block.command, projection) +
            projectedTextRows(
              block.output,
              projection,
              collapsed ? TRANSCRIPT_COLLAPSED_PAYLOAD_ROW_LIMIT : undefined,
            ) +
            2,
        );
      case "elicitation":
        return Math.max(1, block.fields.length + 2);
      case "info":
      case "plugin":
        return Math.max(1, projectedTextRows(block.content, projection) + 1);
    }
  })();
  return rows + (groupRole === "expanded-header" ? 1 : 0);
}

/**
 * Determines whether a block can be treated as settled for page finalization.
 *
 * @param block - Transcript block whose lifecycle state should be evaluated.
 * @param currentBlockId - Identifier of the block currently receiving streamed content.
 * @returns `true` when the block is no longer expected to change during the current turn.
 */
export function isTranscriptBlockStable(block: ChatBlock, currentBlockId: string | null): boolean {
  switch (block.type) {
    case "content":
    case "thinking":
      return block.finalized;
    case "user":
      return block.id !== currentBlockId;
    case "tool":
      return block.status === "success" || block.status === "error";
    case "user-bash":
      return block.status === "done" || block.status === "error";
    case "elicitation":
      return block.status === "accepted" || block.status === "declined" || block.status === "cancelled";
    case "info":
      return block.variant !== "spinner";
    case "plugin":
      return true;
  }
}

/**
 * Detects block changes that can alter rendered geometry while ignoring callback identity changes.
 *
 * @param previous - Block value before the update.
 * @param next - Block value after the update.
 * @returns `true` when the update may change page layout.
 */
function layoutRelevantUpdate(previous: ChatBlock, next: ChatBlock): boolean {
  if (previous.type !== next.type) return true;
  const ignoredKeys = new Set(["resolveApproval", "respond"]);
  const previousRecord = previous as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(previousRecord), ...Object.keys(nextRecord)]);
  for (const key of keys) {
    if (ignoredKeys.has(key)) continue;
    if (!Object.is(previousRecord[key], nextRecord[key])) return true;
  }
  return false;
}

/**
 * Determines whether a block starts a user turn suitable for a soft page boundary.
 *
 * @param block - Transcript block being considered as the next page member.
 * @returns `true` for user prompts other than current-turn guidance.
 */
function isUserTurnBoundary(block: ChatBlock): boolean {
  return block.type === "user" && block.delivery !== "current-turn-guidance";
}

export class TranscriptPageIndex {
  readonly #options: ResolvedTranscriptPageIndexOptions;
  readonly #revision: () => number;
  readonly #setRevision: (update: (revision: number) => number) => number;
  #pages: TranscriptPage[] = [];
  #pageIdByBlockId = new Map<string, string>();
  #pageIndexById = new Map<string, number>();
  #stabilityByBlockId = new Map<string, boolean>();
  #blockById = new Map<string, ChatBlock>();
  #estimatedRowsByBlockId = new Map<string, number>();
  #contentMetricsByBlockId = new Map<string, TranscriptTextMetrics>();
  #lastChange: TranscriptPageRevisionChange = { revision: 0, structural: true, pageIds: [] };
  #changeLog: TranscriptPageRevisionChange[] = [];
  #generation = 1;
  #currentBlockId: string | null = null;
  #layoutProjection: TranscriptLayoutProjection;

  /**
   * Builds a page index for an existing canonical transcript.
   *
   * @param blocks - Canonical blocks in transcript order.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @param options - Optional page sizing, width, and identifier configuration.
   * @returns An initialized transcript page index.
   */
  constructor(
    blocks: readonly ChatBlock[] = [],
    currentBlockId: string | null = null,
    options: TranscriptPageIndexOptions = {},
  ) {
    this.#options = {
      createPageId: options.createPageId ?? nextTranscriptPageId,
      softBlockLimit: options.softBlockLimit ?? TRANSCRIPT_PAGE_SOFT_BLOCK_LIMIT,
      softRowLimit: options.softRowLimit ?? TRANSCRIPT_PAGE_SOFT_ROW_LIMIT,
      hardBlockLimit: options.hardBlockLimit ?? TRANSCRIPT_PAGE_HARD_BLOCK_LIMIT,
      hardRowLimit: options.hardRowLimit ?? TRANSCRIPT_PAGE_HARD_ROW_LIMIT,
      tallBlockRowThreshold: options.tallBlockRowThreshold ?? TRANSCRIPT_TALL_BLOCK_ROW_THRESHOLD,
      estimatedRowWidth: options.estimatedRowWidth ?? TRANSCRIPT_ESTIMATED_ROW_WIDTH,
    };
    this.#layoutProjection = defaultLayoutProjection(this.#options.estimatedRowWidth);
    const [revision, setRevision] = createSignal(0);
    this.#revision = revision;
    this.#setRevision = setRevision;
    this.#rebuild(blocks, currentBlockId);
  }

  get generation(): number {
    return this.#generation;
  }

  get revision(): number {
    return this.#revision();
  }

  /**
   * Describes the most recent page-index revision for incremental consumers.
   *
   * @returns The current revision and the pages or structure changed by its latest update.
   */
  revisionChange(): TranscriptPageRevisionChange {
    this.#revision();
    return this.#lastChange;
  }

  /**
   * Aggregates page-index changes that occurred after a previously observed revision.
   *
   * @param revision - Last revision processed by the caller.
   * @returns A structural invalidation or the unique page IDs changed since that revision.
   */
  revisionChangeSince(revision: number): TranscriptPageRevisionChange {
    const currentRevision = this.#revision();
    if (revision >= currentRevision) return { revision: currentRevision, structural: false, pageIds: [] };
    const firstLoggedRevision = this.#changeLog[0]?.revision ?? currentRevision;
    if (revision < firstLoggedRevision - 1) return { revision: currentRevision, structural: true, pageIds: [] };
    const changes = this.#changeLog.filter((change) => change.revision > revision);
    if (changes.some((change) => change.structural)) {
      return { revision: currentRevision, structural: true, pageIds: [] };
    }
    return {
      revision: currentRevision,
      structural: false,
      pageIds: [...new Set(changes.flatMap((change) => change.pageIds))],
    };
  }

  pageById(pageId: string): TranscriptPage | undefined {
    this.#revision();
    const pageIndex = this.#pageIndexById.get(pageId);
    return pageIndex === undefined ? undefined : this.#pages[pageIndex];
  }

  pageIndexForId(pageId: string): number {
    this.#revision();
    return this.#pageIndexById.get(pageId) ?? -1;
  }

  pages(): readonly TranscriptPage[] {
    this.#revision();
    return this.#pages;
  }

  pageForBlock(blockId: string): TranscriptPage | undefined {
    this.#revision();
    const pageId = this.#pageIdByBlockId.get(blockId);
    const pageIndex = pageId ? this.#pageIndexById.get(pageId) : undefined;
    return pageIndex === undefined ? undefined : this.#pages[pageIndex];
  }

  pageIndexForBlock(blockId: string): number {
    this.#revision();
    const pageId = this.#pageIdByBlockId.get(blockId);
    return pageId ? (this.#pageIndexById.get(pageId) ?? -1) : -1;
  }

  /**
   * Appends a canonical block to the tail page or starts a new page when limits require it.
   *
   * @param block - New block being appended.
   * @param _blocks - Canonical transcript after the append; reserved for mutation API symmetry.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @param expectedGeneration - Transcript generation captured before the mutation.
   * @returns `true` when the generation matched and the append was indexed.
   */
  append(
    block: ChatBlock,
    _blocks: readonly ChatBlock[],
    currentBlockId: string | null,
    expectedGeneration: number,
  ): boolean {
    if (!this.#accepts(expectedGeneration)) return false;
    const previousPageCount = this.#pages.length;
    this.#appendInternal(block);
    this.#stabilityByBlockId.set(block.id, isTranscriptBlockStable(block, currentBlockId));
    this.#blockById.set(block.id, block);
    this.#estimatedRowsByBlockId.set(block.id, this.#estimateBlockRows(block));
    if ("content" in block && typeof block.content === "string") {
      this.#contentMetricsByBlockId.set(block.id, textMetrics(block.content, this.#layoutProjection.width));
    }
    const tailIndex = this.#pages.length - 1;
    const tail = this.#pages[tailIndex];
    if (tail) {
      this.#pageIndexById.set(tail.id, tailIndex);
      this.#pageIdByBlockId.set(block.id, tail.id);
    }
    if (this.#pages.length > previousPageCount && tailIndex > 0) this.#refreshPageFinalization(tailIndex - 1);
    if (tail) this.#touch(this.#pages.length === previousPageCount ? [tail.id] : undefined);
    return true;
  }

  /**
   * Inserts a block into the appropriate page and normalizes resulting overflow.
   *
   * @param index - Zero-based position of the inserted block in canonical state.
   * @param block - Block being inserted.
   * @param blocks - Canonical transcript after insertion.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @param expectedGeneration - Transcript generation captured before the mutation.
   * @returns `true` when the generation matched and the insertion was indexed.
   */
  insert(
    index: number,
    block: ChatBlock,
    blocks: readonly ChatBlock[],
    currentBlockId: string | null,
    expectedGeneration: number,
  ): boolean {
    if (!this.#accepts(expectedGeneration)) return false;
    const blockById = new Map(blocks.map((block) => [block.id, block]));
    const successorId = blocks[index + 1]?.id;
    const predecessorId = blocks[index - 1]?.id;
    const pageIndex = successorId ? this.pageIndexForBlock(successorId) : this.pageIndexForBlock(predecessorId ?? "");
    if (pageIndex < 0) {
      this.#appendInternal(block);
    } else {
      const page = this.#pages[pageIndex];
      const successorIndex = successorId ? page.blockIds.indexOf(successorId) : -1;
      const insertionIndex = successorIndex >= 0 ? successorIndex : page.blockIds.length;
      const blockIds = [...page.blockIds.slice(0, insertionIndex), block.id, ...page.blockIds.slice(insertionIndex)];
      const estimatedRows = page.estimatedRows + this.#estimateBlockRows(block);
      this.#pages[pageIndex] = {
        ...page,
        blockIds,
        estimatedRows,
        layoutRevision: page.layoutRevision + 1,
        reopened: true,
        ...this.#invalidatedMeasurementForRows(page, estimatedRows),
      };
      this.#normalizePages(blockById);
    }
    this.#refresh(blocks, currentBlockId, blockById);
    return true;
  }

  /**
   * Removes a block, promotes a surviving page anchor when needed, and refreshes page metadata.
   *
   * @param blockId - Identifier of the block being removed.
   * @param blocks - Canonical transcript after removal.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @param expectedGeneration - Transcript generation captured before the mutation.
   * @returns `true` when the generation matched and the indexed block was removed.
   */
  remove(
    blockId: string,
    blocks: readonly ChatBlock[],
    currentBlockId: string | null,
    expectedGeneration: number,
  ): boolean {
    if (!this.#accepts(expectedGeneration)) return false;
    const pageIndex = this.pageIndexForBlock(blockId);
    if (pageIndex < 0) return false;
    const blockById = new Map(blocks.map((block) => [block.id, block]));
    const page = this.#pages[pageIndex];
    this.#estimatedRowsByBlockId.delete(blockId);
    this.#contentMetricsByBlockId.delete(blockId);
    const blockIds = page.blockIds.filter((id) => id !== blockId);
    if (blockIds.length === 0) {
      this.#pages.splice(pageIndex, 1);
    } else {
      const estimatedRows = blockIds.reduce((total, id) => {
        const block = blockById.get(id);
        return total + (block ? this.#estimateBlockRows(block) : 1);
      }, 0);
      this.#pages[pageIndex] = {
        ...page,
        anchorBlockId: page.anchorBlockId === blockId ? blockIds[0] : page.anchorBlockId,
        blockIds,
        estimatedRows,
        layoutRevision: page.layoutRevision + 1,
        reopened: true,
        ...this.#invalidatedMeasurementForRows(page, estimatedRows),
      };
    }
    this.#refresh(blocks, currentBlockId, blockById);
    return true;
  }

  /**
   * Applies a general block update and recalculates affected page estimates and stability.
   *
   * @param blockId - Identifier of the block being updated.
   * @param previous - Block value before the update.
   * @param next - Block value after the update.
   * @param blocks - Canonical transcript containing the updated block.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @param expectedGeneration - Transcript generation captured before the mutation.
   * @returns `true` when the generation matched and the block update was indexed.
   */
  update(
    blockId: string,
    previous: ChatBlock,
    next: ChatBlock,
    blocks: readonly ChatBlock[],
    currentBlockId: string | null,
    expectedGeneration: number,
  ): boolean {
    if (!this.#accepts(expectedGeneration)) return false;
    const previousRows = this.#estimatedRowsByBlockId.get(blockId) ?? this.#estimateBlockRows(previous);
    const nextRows = this.#estimateBlockRows(next);
    this.#blockById.set(blockId, next);
    if ("content" in next && typeof next.content === "string") {
      this.#contentMetricsByBlockId.set(blockId, textMetrics(next.content, this.#layoutProjection.width));
    }
    return this.#updateWithEstimatedRows(blockId, previous, next, previousRows, nextRows, blocks, currentBlockId);
  }

  /**
   * Applies a streaming append, using incremental metrics for content blocks and full estimation for other types.
   *
   * @param blockId - Identifier of the content-bearing block being extended.
   * @param previous - Block value before the append.
   * @param next - Block value after the append.
   * @param appendedText - Text fragment added by this mutation.
   * @param blocks - Canonical transcript containing the updated block.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @param expectedGeneration - Transcript generation captured before the mutation.
   * @returns `true` when the generation matched and the append was indexed.
   */
  appendText(
    blockId: string,
    previous: ChatBlock,
    next: ChatBlock,
    appendedText: string,
    blocks: readonly ChatBlock[],
    currentBlockId: string | null,
    expectedGeneration: number,
  ): boolean {
    if (!this.#accepts(expectedGeneration)) return false;
    if (!("content" in previous) || typeof previous.content !== "string" || !("content" in next)) {
      return this.update(blockId, previous, next, blocks, currentBlockId, expectedGeneration);
    }
    const previousRows = this.#estimatedRowsByBlockId.get(blockId) ?? this.#estimateBlockRows(previous);
    const previousMetrics =
      this.#contentMetricsByBlockId.get(blockId) ?? textMetrics(previous.content, this.#layoutProjection.width);
    const nextMetrics = appendTextMetrics(previousMetrics, appendedText, this.#layoutProjection.width);
    const nextRows =
      next.type === "content" ? Math.max(1, estimatedTextRows(nextMetrics) + 1) : this.#estimateBlockRows(next);
    this.#blockById.set(blockId, next);
    this.#contentMetricsByBlockId.set(blockId, nextMetrics);
    return this.#updateWithEstimatedRows(blockId, previous, next, previousRows, nextRows, blocks, currentBlockId);
  }

  /**
   * Rebuilds all pages for a replacement canonical transcript and advances the generation.
   *
   * @param blocks - Replacement canonical blocks in transcript order.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @returns The new transcript generation.
   */
  replaceTranscript(blocks: readonly ChatBlock[], currentBlockId: string | null): number {
    this.#generation += 1;
    this.#rebuild(blocks, currentBlockId);
    return this.#generation;
  }

  /**
   * Recomputes page stability after the identity of the streaming block changes.
   *
   * @param blocks - Current canonical transcript.
   * @param currentBlockId - New streaming block identifier, or `null` when no block is active.
   * @returns Nothing; page finalization state is refreshed in place.
   */
  setCurrentBlockId(blocks: readonly ChatBlock[], currentBlockId: string | null): void {
    if (this.#currentBlockId === currentBlockId) return;
    const previousBlockId = this.#currentBlockId;
    this.#currentBlockId = currentBlockId;
    const affectedPageIds = new Set<string>();
    for (const blockId of [previousBlockId, currentBlockId]) {
      if (!blockId) continue;
      const block = this.#blockById.get(blockId) ?? blocks.find((candidate) => candidate.id === blockId);
      if (block) this.#stabilityByBlockId.set(blockId, isTranscriptBlockStable(block, currentBlockId));
      const pageId = this.#pageIdByBlockId.get(blockId);
      if (pageId) affectedPageIds.add(pageId);
    }
    const changedPageIds: string[] = [];
    for (const pageId of affectedPageIds) {
      const pageIndex = this.#pageIndexById.get(pageId);
      if (pageIndex === undefined) continue;
      const previousPage = this.#pages[pageIndex];
      this.#refreshPageFinalization(pageIndex);
      const nextPage = this.#pages[pageIndex];
      if (previousPage.dynamic !== nextPage.dynamic || previousPage.finalized !== nextPage.finalized) {
        changedPageIds.push(pageId);
      }
    }
    if (changedPageIds.length > 0) this.#touch(changedPageIds);
  }

  /**
   * Applies renderer layout settings and rebuilds page estimates when visible heights change.
   *
   * @param projection - Current width, expansion, thinking, and tool-result presentation settings.
   * @param blocks - Canonical transcript used to recalculate block estimates.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @returns `true` when projected row estimates changed and page geometry was invalidated.
   */
  applyLayoutProjection(
    projection: TranscriptLayoutProjection,
    blocks: readonly ChatBlock[],
    currentBlockId: string | null,
  ): boolean {
    const nextProjection: TranscriptLayoutProjection = {
      width: Math.max(1, projection.width),
      detailsExpanded: projection.detailsExpanded,
      showThinking: projection.showThinking,
      thinkingPreviewLines: Math.max(0, projection.thinkingPreviewLines),
      toolPreviewLines: Math.max(0, projection.toolPreviewLines),
      succinctToolResults: projection.succinctToolResults,
      toolCallGroupsKey: projection.toolCallGroupsKey ?? "",
      toolCallGroupRoles: projection.toolCallGroupRoles ?? {},
    };
    if (
      this.#layoutProjection.width === nextProjection.width &&
      this.#layoutProjection.detailsExpanded === nextProjection.detailsExpanded &&
      this.#layoutProjection.showThinking === nextProjection.showThinking &&
      this.#layoutProjection.thinkingPreviewLines === nextProjection.thinkingPreviewLines &&
      this.#layoutProjection.toolPreviewLines === nextProjection.toolPreviewLines &&
      this.#layoutProjection.succinctToolResults === nextProjection.succinctToolResults &&
      this.#layoutProjection.toolCallGroupsKey === nextProjection.toolCallGroupsKey
    ) {
      return false;
    }
    this.#layoutProjection = nextProjection;
    const nextEstimatedRowsByBlockId = new Map(blocks.map((block) => [block.id, this.#estimateBlockRows(block)]));
    const estimatesChanged = blocks.some(
      (block) => this.#estimatedRowsByBlockId.get(block.id) !== nextEstimatedRowsByBlockId.get(block.id),
    );
    this.#estimatedRowsByBlockId = nextEstimatedRowsByBlockId;
    this.#contentMetricsByBlockId = new Map(
      blocks.flatMap((block) =>
        "content" in block && typeof block.content === "string"
          ? [[block.id, textMetrics(block.content, this.#layoutProjection.width)] as const]
          : [],
      ),
    );
    if (!estimatesChanged) return false;
    this.#pages = this.#pages.map((page) => {
      const estimatedRows = page.blockIds.reduce(
        (rows, blockId) => rows + (nextEstimatedRowsByBlockId.get(blockId) ?? 1),
        0,
      );
      return {
        ...page,
        estimatedRows,
        layoutRevision: page.layoutRevision + 1,
        reopened: true,
        ...this.#invalidatedMeasurementForRows(page, estimatedRows),
      };
    });
    const blockById = new Map(blocks.map((block) => [block.id, block]));
    this.#normalizePages(blockById);
    this.#refresh(blocks, currentBlockId, blockById);
    return true;
  }

  /**
   * Pins a page for an interaction that requires it to remain dynamic and addressable.
   *
   * @param pageId - Identifier of the page to pin.
   * @param reason - Interaction category requiring the pin.
   * @returns `true` when the page exists and is pinned after the call.
   */
  pinPage(pageId: string, reason: TranscriptPagePinReason): boolean {
    const pageIndex = this.#pageIndexById.get(pageId) ?? -1;
    if (pageIndex < 0) return false;
    const page = this.#pages[pageIndex];
    if (page.pinReasons.includes(reason)) return true;
    this.#pages[pageIndex] = {
      ...page,
      pinReasons: [...page.pinReasons, reason],
      finalized: false,
      dynamic: true,
    };
    this.#touch([page.id]);
    return true;
  }

  /**
   * Removes one interaction pin from a page and normalizes deferred page structure.
   *
   * @param pageId - Identifier of the page to unpin.
   * @param reason - Pin category to remove.
   * @param blocks - Current canonical transcript used for normalization.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @returns `true` when the requested pin was removed.
   */
  unpinPage(
    pageId: string,
    reason: TranscriptPagePinReason,
    blocks: readonly ChatBlock[],
    currentBlockId: string | null,
  ): boolean {
    return this.unpinPages([pageId], reason, blocks, currentBlockId) > 0;
  }

  /**
   * Removes the same interaction pin from multiple pages in one normalization pass.
   *
   * @param pageIds - Page identifiers whose pins should be removed.
   * @param reason - Pin category to remove.
   * @param blocks - Current canonical transcript used for normalization.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @returns The number of pages from which the pin was removed.
   */
  unpinPages(
    pageIds: Iterable<string>,
    reason: TranscriptPagePinReason,
    blocks: readonly ChatBlock[],
    currentBlockId: string | null,
  ): number {
    const requested = new Set(pageIds);
    let changed = 0;
    this.#pages = this.#pages.map((page) => {
      if (!requested.has(page.id) || !page.pinReasons.includes(reason)) return page;
      changed += 1;
      return { ...page, pinReasons: page.pinReasons.filter((pin) => pin !== reason) };
    });
    if (changed === 0) return 0;
    const blockById = new Map(blocks.map((block) => [block.id, block]));
    this.#normalizePages(blockById);
    this.#refresh(blocks, currentBlockId, blockById);
    return changed;
  }

  /**
   * Commits measured page geometry when its transcript generation and layout revision remain current.
   *
   * @param pageId - Identifier of the measured page.
   * @param measurement - Geometry and generation metadata captured by the renderer.
   * @param expectedLayoutRevision - Page layout revision observed when measurement began.
   * @returns `true` when the measurement was current and committed.
   */
  setMeasurement(pageId: string, measurement: TranscriptPageMeasurement, expectedLayoutRevision: number): boolean {
    const pageIndex = this.#pageIndexById.get(pageId) ?? -1;
    if (pageIndex < 0) return false;
    const page = this.#pages[pageIndex];
    if (measurement.transcriptGeneration !== this.#generation || page.layoutRevision !== expectedLayoutRevision) {
      return false;
    }
    this.#pages[pageIndex] = {
      ...page,
      measurement,
      estimatedHeight: undefined,
      estimatedUserBlockOffsets: undefined,
      reopened: false,
    };
    this.#refreshPageFinalization(pageIndex);
    this.#touch([pageId]);
    return true;
  }

  /**
   * Preserves measured heights as estimates while invalidating their exact-layout status.
   *
   * @returns Nothing; existing measurements are converted in place and revisions are published.
   */
  demoteMeasurementsToEstimates(): void {
    let changed = false;
    this.#pages = this.#pages.map((page) => {
      if (!page.measurement) return page;
      changed = true;
      return {
        ...page,
        measurement: undefined,
        estimatedHeight: page.measurement.height,
        estimatedUserBlockOffsets: page.measurement.userBlockOffsets,
      };
    });
    if (changed) this.#touch();
  }

  /**
   * Removes exact and estimated geometry from every page after a complete layout invalidation.
   *
   * @returns Nothing; page geometry is cleared in place and revisions are published.
   */
  clearMeasurements(): void {
    let changed = false;
    this.#pages = this.#pages.map((page) => {
      if (!page.measurement && page.estimatedHeight === undefined && page.estimatedUserBlockOffsets === undefined) {
        return page;
      }
      changed = true;
      return {
        ...page,
        measurement: undefined,
        estimatedHeight: undefined,
        estimatedUserBlockOffsets: undefined,
      };
    });
    if (changed) this.#touch();
  }

  /**
   * Estimates one block using the currently active renderer projection.
   *
   * @param block - Transcript block to estimate.
   * @returns The projected rendered row count for the block.
   */
  #estimateBlockRows(block: ChatBlock): number {
    return estimateTranscriptBlockRows(block, this.#layoutProjection.width, this.#layoutProjection);
  }

  #accepts(expectedGeneration: number): boolean {
    return expectedGeneration === this.#generation;
  }

  /**
   * Publishes an incremental or structural page-index revision to reactive consumers.
   *
   * @param pageIds - Changed page identifiers, or `undefined` for a structural invalidation.
   * @returns Nothing; the revision signal and bounded change log are updated.
   */
  #touch(pageIds?: Iterable<string>): void {
    const revision = this.#revision() + 1;
    this.#lastChange = {
      revision,
      structural: pageIds === undefined,
      pageIds: pageIds === undefined ? [] : [...new Set(pageIds)],
    };
    this.#changeLog.push(this.#lastChange);
    if (this.#changeLog.length > 256) this.#changeLog.splice(0, this.#changeLog.length - 256);
    this.#setRevision(() => revision);
  }

  /**
   * Invalidates exact geometry while preserving a prior measured height as a temporary estimate.
   *
   * @param page - Page whose measurement is no longer exact.
   * @returns Replacement geometry fields for the invalidated page.
   */
  #invalidatedMeasurement(
    page: TranscriptPage,
  ): Pick<TranscriptPage, "measurement" | "estimatedHeight" | "estimatedUserBlockOffsets"> {
    return {
      measurement: undefined,
      estimatedHeight: page.measurement?.height ?? page.estimatedHeight,
      estimatedUserBlockOffsets: undefined,
    };
  }

  /**
   * Scales a previous page height estimate to reflect a changed estimated row count.
   *
   * @param page - Page whose estimated row count changed.
   * @param estimatedRows - New estimated row count for the page.
   * @returns Replacement geometry fields with a proportionally adjusted estimated height.
   */
  #invalidatedMeasurementForRows(
    page: TranscriptPage,
    estimatedRows: number,
  ): Pick<TranscriptPage, "measurement" | "estimatedHeight" | "estimatedUserBlockOffsets"> {
    const sourceHeight = page.measurement?.height ?? page.estimatedHeight;
    const rowRatio = estimatedRows / Math.max(1, page.estimatedRows);
    return {
      measurement: undefined,
      estimatedHeight: sourceHeight === undefined ? undefined : Math.max(1, Math.round(sourceHeight * rowRatio)),
      estimatedUserBlockOffsets: undefined,
    };
  }

  /**
   * Creates an unfinalized page anchored to a single block.
   *
   * @param block - Initial block and identity anchor for the page.
   * @returns A new dynamic transcript page with an estimated height.
   */
  #newPage(block: ChatBlock): TranscriptPage {
    return {
      id: this.#options.createPageId(),
      anchorBlockId: block.id,
      blockIds: [block.id],
      estimatedRows: this.#estimateBlockRows(block),
      layoutRevision: 0,
      dynamic: true,
      finalized: false,
      reopened: false,
      pinReasons: [],
    };
  }

  /**
   * Appends a block during rebuilds or live mutations without publishing a revision.
   *
   * @param block - Block to place in the tail page or a new page.
   * @returns Nothing; the internal page array is updated in place.
   */
  #appendInternal(block: ChatBlock): void {
    const estimatedRows = this.#estimateBlockRows(block);
    const tail = this.#pages.at(-1);
    if (!tail) {
      this.#pages.push(this.#newPage(block));
      return;
    }
    const tailIsDedicatedTall = tail.blockIds.length === 1 && tail.estimatedRows >= this.#options.tallBlockRowThreshold;
    const blockIsTall = estimatedRows >= this.#options.tallBlockRowThreshold;
    const exceedsHardLimit =
      tail.blockIds.length + 1 > this.#options.hardBlockLimit ||
      tail.estimatedRows + estimatedRows > this.#options.hardRowLimit;
    const crossedSoftLimit =
      tail.blockIds.length >= this.#options.softBlockLimit || tail.estimatedRows >= this.#options.softRowLimit;
    if (tailIsDedicatedTall || blockIsTall || exceedsHardLimit || (crossedSoftLimit && isUserTurnBoundary(block))) {
      this.#pages.push(this.#newPage(block));
      return;
    }
    this.#pages[this.#pages.length - 1] = {
      ...tail,
      blockIds: [...tail.blockIds, block.id],
      estimatedRows: tail.estimatedRows + estimatedRows,
      layoutRevision: tail.layoutRevision + 1,
      ...this.#invalidatedMeasurement(tail),
    };
  }

  /**
   * Repartitions a complete canonical transcript and refreshes all derived lookup state.
   *
   * @param blocks - Canonical blocks to partition into pages.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @returns Nothing; page and lookup state are replaced in place.
   */
  #rebuild(blocks: readonly ChatBlock[], currentBlockId: string | null): void {
    this.#pages = [];
    for (const block of blocks) this.#appendInternal(block);
    this.#refresh(blocks, currentBlockId);
  }

  /**
   * Isolates tall blocks and recursively splits pages that exceed hard limits.
   *
   * @param blocks - Canonical transcript used to estimate and locate page members.
   * @returns Nothing; the page array is normalized in place.
   */
  #normalizePages(blockById: ReadonlyMap<string, ChatBlock>, startIndex = 0, endIndex = this.#pages.length): void {
    for (let pageIndex = startIndex; pageIndex < endIndex; pageIndex += 1) {
      const page = this.#pages[pageIndex];
      if (page.pinReasons.includes("selection")) continue;
      const pageCount = this.#pages.length;
      const tallBlockId =
        page.blockIds.length > 1
          ? page.blockIds.find((blockId) => {
              const block = blockById.get(blockId);
              return block ? this.#estimateBlockRows(block) >= this.#options.tallBlockRowThreshold : false;
            })
          : undefined;
      if (tallBlockId) {
        this.#isolateTallBlock(pageIndex, tallBlockId, blockById);
        endIndex += this.#pages.length - pageCount;
        pageIndex -= 1;
        continue;
      }
      this.#splitPageIfNeeded(pageIndex, blockById);
      endIndex += this.#pages.length - pageCount;
    }
  }

  /**
   * Splits a tall block into a dedicated page while preserving identity on the anchor segment.
   *
   * @param pageIndex - Index of the page containing the tall block.
   * @param blockId - Identifier of the block that must be isolated.
   * @param blocks - Canonical transcript used to rebuild segment estimates.
   * @returns Nothing; the original page is replaced by one or more segments.
   */
  #isolateTallBlock(pageIndex: number, blockId: string, blockById: ReadonlyMap<string, ChatBlock>): void {
    const page = this.#pages[pageIndex];
    if (!page || page.blockIds.length === 1) return;
    const blockIndex = page.blockIds.indexOf(blockId);
    if (blockIndex < 0) return;
    const segments = [page.blockIds.slice(0, blockIndex), [blockId], page.blockIds.slice(blockIndex + 1)].filter(
      (blockIds) => blockIds.length > 0,
    );
    const identitySegmentIndex = Math.max(
      0,
      segments.findIndex((blockIds) => blockIds.includes(page.anchorBlockId)),
    );
    const replacement = segments.flatMap((blockIds, segmentIndex): TranscriptPage[] => {
      const firstBlock = blockById.get(blockIds[0]);
      if (!firstBlock) return [];
      const estimatedRows = blockIds.reduce((total, id) => {
        const segmentBlock = blockById.get(id);
        return total + (segmentBlock ? this.#estimateBlockRows(segmentBlock) : 1);
      }, 0);
      if (segmentIndex === identitySegmentIndex) {
        return [
          {
            ...page,
            blockIds,
            estimatedRows,
            layoutRevision: page.layoutRevision + 1,
            reopened: true,
            ...this.#invalidatedMeasurementForRows(page, estimatedRows),
          },
        ];
      }
      return [
        {
          ...this.#newPage(firstBlock),
          blockIds,
          estimatedRows,
          layoutRevision: page.layoutRevision + 1,
          reopened: true,
          ...this.#invalidatedMeasurementForRows(page, estimatedRows),
        },
      ];
    });
    this.#pages.splice(pageIndex, 1, ...replacement);
  }

  /**
   * Chooses a balanced boundary and recursively splits a page that exceeds hard limits.
   *
   * @param pageIndex - Index of the page to inspect.
   * @param blocks - Canonical transcript used for row estimation.
   * @param blockById - Optional prebuilt lookup for canonical blocks.
   * @returns Nothing; oversized pages are replaced by normalized segments.
   */
  #splitPageIfNeeded(pageIndex: number, blockById: ReadonlyMap<string, ChatBlock>): void {
    const page = this.#pages[pageIndex];
    if (!page || page.blockIds.length <= 1 || page.pinReasons.includes("selection")) return;
    const rowCounts = page.blockIds.map((blockId) => {
      const block = blockById.get(blockId);
      return block ? this.#estimateBlockRows(block) : 1;
    });
    const estimatedRows = rowCounts.reduce((total, rows) => total + rows, 0);
    if (page.blockIds.length <= this.#options.hardBlockLimit && estimatedRows <= this.#options.hardRowLimit) return;

    const totalRows = estimatedRows;
    let prefixRows = 0;
    const midpoint = page.blockIds.length / 2;
    const boundaries = page.blockIds.slice(1).map((blockId, offset) => {
      const index = offset + 1;
      prefixRows += rowCounts[offset];
      const suffixRows = totalRows - prefixRows;
      const prefixBlockOverflow = Math.max(0, index - this.#options.hardBlockLimit);
      const suffixBlockOverflow = Math.max(0, page.blockIds.length - index - this.#options.hardBlockLimit);
      const prefixRowOverflow = Math.max(0, prefixRows - this.#options.hardRowLimit);
      const suffixRowOverflow = Math.max(0, suffixRows - this.#options.hardRowLimit);
      const overflow =
        prefixRowOverflow +
        suffixRowOverflow +
        (prefixBlockOverflow + suffixBlockOverflow) * this.#options.hardRowLimit;
      const block = blockById.get(blockId);
      return {
        index,
        overflow,
        userPenalty: block && isUserTurnBoundary(block) ? 0 : 1,
        midpointDistance: Math.abs(index - midpoint),
      };
    });
    boundaries.sort(
      (left, right) =>
        left.overflow - right.overflow ||
        left.userPenalty - right.userPenalty ||
        left.midpointDistance - right.midpointDistance,
    );
    const splitIndex = boundaries[0]?.index;
    if (!splitIndex) return;

    const prefixIds = page.blockIds.slice(0, splitIndex);
    const suffixIds = page.blockIds.slice(splitIndex);
    const prefixEstimatedRows = rowCounts.slice(0, splitIndex).reduce((total, rows) => total + rows, 0);
    const suffixEstimatedRows = rowCounts.slice(splitIndex).reduce((total, rows) => total + rows, 0);
    const prefixBlock = blockById.get(prefixIds[0]);
    const suffixBlock = blockById.get(suffixIds[0]);
    if (!prefixBlock || !suffixBlock) return;
    const anchorInPrefix = prefixIds.includes(page.anchorBlockId);
    const prefix: TranscriptPage = {
      ...(anchorInPrefix ? page : this.#newPage(prefixBlock)),
      blockIds: prefixIds,
      estimatedRows: prefixEstimatedRows,
      layoutRevision: page.layoutRevision + 1,
      reopened: true,
      ...this.#invalidatedMeasurementForRows(page, prefixEstimatedRows),
    };
    const suffix: TranscriptPage = {
      ...(anchorInPrefix ? this.#newPage(suffixBlock) : page),
      blockIds: suffixIds,
      estimatedRows: suffixEstimatedRows,
      layoutRevision: page.layoutRevision + 1,
      reopened: true,
      ...this.#invalidatedMeasurementForRows(page, suffixEstimatedRows),
    };
    this.#pages.splice(pageIndex, 1, prefix, suffix);
    this.#splitPageIfNeeded(pageIndex, blockById);
    this.#splitPageIfNeeded(pageIndex + 1, blockById);
  }

  /**
   * Recomputes whether one page can be finalized from block stability, position, and pins.
   *
   * @param pageIndex - Index of the page whose finalization state should be refreshed.
   * @returns Nothing; the page entry is updated in place.
   */
  #refreshPageFinalization(pageIndex: number): void {
    const page = this.#pages[pageIndex];
    if (!page) return;
    const stable = page.blockIds.every((blockId) => this.#stabilityByBlockId.get(blockId) === true);
    const isTail = pageIndex === this.#pages.length - 1;
    const pinned = page.pinReasons.length > 0;
    const finalized = stable && !isTail && !pinned && !page.reopened;
    this.#pages[pageIndex] = { ...page, dynamic: !finalized, finalized };
  }

  /**
   * Rebuilds page and block lookup maps after structural page changes.
   *
   * @returns Nothing; all lookup maps are replaced in place.
   */
  #rebuildLookups(): void {
    this.#pageIdByBlockId = new Map();
    this.#pageIndexById = new Map();
    this.#reindexPages(0, this.#pages.length, this.#pages.length);
  }

  /** Re-registers page indexes from `start` to `indexEnd`, and block membership from `start` to `membershipEnd`. */
  #reindexPages(start: number, indexEnd: number, membershipEnd: number): void {
    for (let index = start; index < indexEnd; index += 1) {
      const page = this.#pages[index];
      this.#pageIndexById.set(page.id, index);
      if (index < membershipEnd) for (const id of page.blockIds) this.#pageIdByBlockId.set(id, page.id);
    }
  }

  /**
   * Applies a block update using precomputed row estimates and normalizes the affected page if needed.
   *
   * @param blockId - Identifier of the block being updated.
   * @param previous - Block value before the update.
   * @param next - Block value after the update.
   * @param previousRows - Cached row estimate for the previous block value.
   * @param nextRows - Row estimate for the next block value.
   * @param blocks - Canonical transcript containing the updated block.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @returns `true` when the block was present and its page metadata was updated.
   */
  #updateWithEstimatedRows(
    blockId: string,
    previous: ChatBlock,
    next: ChatBlock,
    previousRows: number,
    nextRows: number,
    blocks: readonly ChatBlock[],
    currentBlockId: string | null,
  ): boolean {
    const pageIndex = this.pageIndexForBlock(blockId);
    if (pageIndex < 0) return false;
    const pageBeforeUpdate = this.#pages[pageIndex];
    if (layoutRelevantUpdate(previous, next)) {
      const page = this.#pages[pageIndex];
      this.#pages[pageIndex] = {
        ...page,
        layoutRevision: page.layoutRevision + 1,
        reopened: true,
        ...this.#invalidatedMeasurement(page),
      };
    }
    this.#estimatedRowsByBlockId.set(blockId, nextRows);
    this.#refreshUpdatedPage(pageIndex, next, previousRows, nextRows, currentBlockId);
    const updatedPage = this.#pages[pageIndex];
    const requiresNormalization =
      updatedPage &&
      updatedPage.blockIds.length > 1 &&
      (nextRows >= this.#options.tallBlockRowThreshold ||
        updatedPage.blockIds.length > this.#options.hardBlockLimit ||
        updatedPage.estimatedRows > this.#options.hardRowLimit);
    if (requiresNormalization) {
      // Only this page changed, so normalize it alone; a full #refresh re-estimates every block (O(n) per update).
      const pageCount = this.#pages.length;
      this.#normalizePages(this.#blockById, pageIndex, pageIndex + 1);
      const endIndex = pageIndex + 1 + this.#pages.length - pageCount;
      for (let index = pageIndex; index < endIndex; index += 1) this.#refreshPageFinalization(index);
      const reindexEnd = this.#pages.length === pageCount ? endIndex : this.#pages.length;
      this.#reindexPages(pageIndex, reindexEnd, endIndex);
      this.#touch();
    } else {
      const pageAfterUpdate = this.#pages[pageIndex];
      if (
        pageBeforeUpdate.layoutRevision !== pageAfterUpdate.layoutRevision ||
        pageBeforeUpdate.estimatedRows !== pageAfterUpdate.estimatedRows ||
        pageBeforeUpdate.dynamic !== pageAfterUpdate.dynamic ||
        pageBeforeUpdate.finalized !== pageAfterUpdate.finalized ||
        pageBeforeUpdate.reopened !== pageAfterUpdate.reopened ||
        pageBeforeUpdate.measurement !== pageAfterUpdate.measurement
      ) {
        this.#touch([pageAfterUpdate.id]);
      }
    }
    return true;
  }

  /**
   * Updates one page's estimated rows, block stability, and finalization after a block mutation.
   *
   * @param pageIndex - Index of the page containing the updated block.
   * @param next - Block value after the mutation.
   * @param previousRows - Previous estimated rows contributed by the block.
   * @param nextRows - New estimated rows contributed by the block.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @returns Nothing; the page and stability cache are updated in place.
   */
  #refreshUpdatedPage(
    pageIndex: number,
    next: ChatBlock,
    previousRows: number,
    nextRows: number,
    currentBlockId: string | null,
  ): void {
    const page = this.#pages[pageIndex];
    if (!page) return;
    this.#stabilityByBlockId.set(next.id, isTranscriptBlockStable(next, currentBlockId));
    const estimatedRows = Math.max(0, page.estimatedRows - previousRows + nextRows);
    const stable = page.blockIds.every((blockId) => this.#stabilityByBlockId.get(blockId) === true);
    const isTail = pageIndex === this.#pages.length - 1;
    const pinned = page.pinReasons.length > 0;
    const finalized = stable && !isTail && !pinned && !page.reopened;
    this.#pages[pageIndex] = {
      ...page,
      estimatedRows,
      dynamic: !finalized,
      finalized,
    };
  }

  /**
   * Recomputes page estimates, block metrics, stability, finalization, and lookup maps from canonical state.
   *
   * @param blocks - Current canonical transcript.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @param blockById - Optional prebuilt id lookup for `blocks`.
   * @returns Nothing; all derived page-index state is refreshed in place.
   */
  #refresh(
    blocks: readonly ChatBlock[],
    currentBlockId: string | null,
    blockById: Map<string, ChatBlock> = new Map(blocks.map((block) => [block.id, block])),
  ): void {
    this.#currentBlockId = currentBlockId;
    this.#blockById = blockById;
    this.#stabilityByBlockId = new Map(
      blocks.map((block) => [block.id, isTranscriptBlockStable(block, currentBlockId)]),
    );
    this.#estimatedRowsByBlockId = new Map(blocks.map((block) => [block.id, this.#estimateBlockRows(block)]));
    this.#contentMetricsByBlockId = new Map(
      blocks.flatMap((block) =>
        "content" in block && typeof block.content === "string"
          ? [[block.id, textMetrics(block.content, this.#layoutProjection.width)] as const]
          : [],
      ),
    );
    const lastPageIndex = this.#pages.length - 1;
    this.#pages = this.#pages.map((page, pageIndex) => {
      const pageBlocks = page.blockIds
        .map((blockId) => blockById.get(blockId))
        .filter((block): block is ChatBlock => Boolean(block));
      const estimatedRows = pageBlocks.reduce((rows, block) => rows + this.#estimateBlockRows(block), 0);
      const stable =
        pageBlocks.length === page.blockIds.length &&
        page.blockIds.every((blockId) => this.#stabilityByBlockId.get(blockId) === true);
      const isTail = pageIndex === lastPageIndex;
      const pinned = page.pinReasons.length > 0;
      const finalized = stable && !isTail && !pinned && !page.reopened;
      return {
        ...page,
        estimatedRows,
        dynamic: !finalized,
        finalized,
      };
    });
    this.#rebuildLookups();
    this.#touch();
  }
}
