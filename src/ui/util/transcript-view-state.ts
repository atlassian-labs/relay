import { createSignal } from "solid-js";
import type { ChatBlock } from "../state";
import {
  TranscriptPageIndex,
  type TranscriptLayoutProjection,
  type TranscriptPageMeasurement,
} from "./transcript-page-index";

export interface TranscriptScrollAnchor {
  readonly pageId: string;
  readonly offset: number;
  readonly blockId?: string;
  readonly blockOffset?: number;
}

export interface TranscriptWindow {
  readonly startPageId: string;
  readonly endPageId: string;
}

export interface TranscriptMeasurementToken {
  readonly transcriptGeneration: number;
  readonly measurementGeneration: number;
  readonly layoutEpoch: number;
}

export type TranscriptPageGeometry = Pick<
  TranscriptPageMeasurement,
  "width" | "height" | "userBlockOffsets" | "blockOffsets"
>;

export class TranscriptViewState {
  readonly pageIndex: TranscriptPageIndex;
  readonly #revision: () => number;
  readonly #setRevision: (update: (revision: number) => number) => number;
  #layoutEpoch = 0;
  #layoutKey: string | null = null;
  #measurementGeneration = 0;
  #window: TranscriptWindow | null = null;
  #scrollAnchor: TranscriptScrollAnchor | null = null;

  /**
   * Creates per-thread transcript view state around a page index.
   *
   * @param blocks - Initial canonical transcript.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @returns An initialized transcript view state instance.
   */
  constructor(blocks: readonly ChatBlock[] = [], currentBlockId: string | null = null) {
    this.pageIndex = new TranscriptPageIndex(blocks, currentBlockId);
    const [revision, setRevision] = createSignal(0);
    this.#revision = revision;
    this.#setRevision = setRevision;
  }

  get transcriptGeneration(): number {
    return this.pageIndex.generation;
  }

  get layoutEpoch(): number {
    this.#revision();
    return this.#layoutEpoch;
  }

  get measurementGeneration(): number {
    this.#revision();
    return this.#measurementGeneration;
  }

  window(): TranscriptWindow | null {
    this.#revision();
    return this.#window;
  }

  scrollAnchor(): TranscriptScrollAnchor | null {
    this.#revision();
    return this.#scrollAnchor;
  }

  /**
   * Captures the generations required to reject stale asynchronous measurements.
   *
   * @returns A token identifying the current transcript, measurement pass, and layout epoch.
   */
  measurementToken(): TranscriptMeasurementToken {
    this.#revision();
    return {
      transcriptGeneration: this.transcriptGeneration,
      measurementGeneration: this.#measurementGeneration,
      layoutEpoch: this.#layoutEpoch,
    };
  }

  /**
   * Appends a block to the page index for this view.
   *
   * @param block - New block being appended.
   * @param blocks - Canonical transcript after the append.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @param expectedGeneration - Transcript generation captured before the mutation.
   * @returns `true` when the generation matched and the append was indexed.
   */
  appendBlock(
    block: ChatBlock,
    blocks: readonly ChatBlock[],
    currentBlockId: string | null,
    expectedGeneration: number,
  ): boolean {
    return this.pageIndex.append(block, blocks, currentBlockId, expectedGeneration);
  }

  /**
   * Inserts a block and reconciles stored page references after structural normalization.
   *
   * @param index - Zero-based canonical position of the inserted block.
   * @param block - Block being inserted.
   * @param blocks - Canonical transcript after insertion.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @param expectedGeneration - Transcript generation captured before the mutation.
   * @returns `true` when the generation matched and the insertion was indexed.
   */
  insertBlock(
    index: number,
    block: ChatBlock,
    blocks: readonly ChatBlock[],
    currentBlockId: string | null,
    expectedGeneration: number,
  ): boolean {
    const changed = this.pageIndex.insert(index, block, blocks, currentBlockId, expectedGeneration);
    if (changed) this.#reconcilePageReferences();
    return changed;
  }

  /**
   * Applies a general block update and reconciles window and anchor page references.
   *
   * @param blockId - Identifier of the block being updated.
   * @param previous - Block value before the update.
   * @param next - Block value after the update.
   * @param blocks - Canonical transcript containing the updated block.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @param expectedGeneration - Transcript generation captured before the mutation.
   * @returns `true` when the generation matched and the update was indexed.
   */
  updateBlock(
    blockId: string,
    previous: ChatBlock,
    next: ChatBlock,
    blocks: readonly ChatBlock[],
    currentBlockId: string | null,
    expectedGeneration: number,
  ): boolean {
    const changed = this.pageIndex.update(blockId, previous, next, blocks, currentBlockId, expectedGeneration);
    if (changed) this.#reconcilePageReferences();
    return changed;
  }

  /**
   * Applies a streaming append through the page index and reconciles page references after normalization.
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
    const changed = this.pageIndex.appendText(
      blockId,
      previous,
      next,
      appendedText,
      blocks,
      currentBlockId,
      expectedGeneration,
    );
    if (changed) this.#reconcilePageReferences();
    return changed;
  }

  /**
   * Removes a block and clears window or anchor references to pages that no longer exist.
   *
   * @param blockId - Identifier of the block being removed.
   * @param blocks - Canonical transcript after removal.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @param expectedGeneration - Transcript generation captured before the mutation.
   * @returns `true` when the generation matched and the block was removed from the index.
   */
  removeBlock(
    blockId: string,
    blocks: readonly ChatBlock[],
    currentBlockId: string | null,
    expectedGeneration: number,
  ): boolean {
    const changed = this.pageIndex.remove(blockId, blocks, currentBlockId, expectedGeneration);
    if (changed) this.#reconcilePageReferences();
    return changed;
  }

  /**
   * Refreshes page stability after the streaming block identity changes.
   *
   * @param blocks - Current canonical transcript.
   * @param currentBlockId - New streaming block identifier, or `null` when no block is active.
   * @returns Nothing; page stability is updated in place.
   */
  setCurrentBlockId(blocks: readonly ChatBlock[], currentBlockId: string | null): void {
    this.pageIndex.setCurrentBlockId(blocks, currentBlockId);
  }

  /**
   * Replaces the transcript, invalidates measurement work, and clears stored viewport references.
   *
   * @param blocks - Replacement canonical transcript.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @returns Nothing; page, measurement, window, and anchor state are reset in place.
   */
  replaceTranscript(blocks: readonly ChatBlock[], currentBlockId: string | null): void {
    this.pageIndex.replaceTranscript(blocks, currentBlockId);
    this.#measurementGeneration += 1;
    this.#window = null;
    this.#scrollAnchor = null;
    this.#touch();
  }

  /**
   * Applies renderer layout settings and advances the measurement generation when page estimates change.
   *
   * @param projection - Current renderer layout settings.
   * @param blocks - Canonical transcript used to recalculate page estimates.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @returns `true` when the projection changed visible geometry.
   */
  applyLayoutProjection(
    projection: TranscriptLayoutProjection,
    blocks: readonly ChatBlock[],
    currentBlockId: string | null,
  ): boolean {
    const changed = this.pageIndex.applyLayoutProjection(projection, blocks, currentBlockId);
    if (!changed) return false;
    this.#measurementGeneration += 1;
    this.#reconcilePageReferences();
    this.#touch();
    return true;
  }

  /**
   * Advances the layout epoch when a renderer-owned layout identity changes.
   *
   * @param layoutKey - Stable identity for the active layout configuration.
   * @returns `true` when the key changed and a new layout epoch was started.
   */
  ensureLayoutKey(layoutKey: string): boolean {
    if (this.#layoutKey === null) {
      this.#layoutKey = layoutKey;
      return false;
    }
    if (this.#layoutKey === layoutKey) return false;
    this.#layoutKey = layoutKey;
    this.advanceLayoutEpoch();
    return true;
  }

  /**
   * Starts a new layout epoch and demotes exact measurements to temporary estimates.
   *
   * @returns The newly active layout epoch.
   */
  advanceLayoutEpoch(): number {
    this.#layoutEpoch += 1;
    this.#measurementGeneration += 1;
    this.pageIndex.demoteMeasurementsToEstimates();
    this.#touch();
    return this.#layoutEpoch;
  }

  /**
   * Invalidates all in-flight measurement tokens without changing page geometry.
   *
   * @returns Nothing; the measurement generation is advanced in place.
   */
  cancelMeasurementWork(): void {
    this.#measurementGeneration += 1;
    this.#touch();
  }

  /**
   * Starts a new measurement pass and returns the token required to commit its results.
   *
   * @returns A token for the newly active measurement generation.
   */
  beginMeasurementGeneration(): TranscriptMeasurementToken {
    this.#measurementGeneration += 1;
    this.#touch();
    return this.measurementToken();
  }

  /**
   * Commits page geometry only when its transcript, measurement, layout, and page revisions remain current.
   *
   * @param pageId - Identifier of the measured page.
   * @param geometry - Measured width, height, and user-block offsets.
   * @param token - Generation token captured when measurement began.
   * @param expectedLayoutRevision - Page layout revision observed by the renderer.
   * @returns `true` when all guards matched and the measurement was committed.
   */
  commitPageMeasurement(
    pageId: string,
    geometry: TranscriptPageGeometry,
    token: TranscriptMeasurementToken,
    expectedLayoutRevision: number,
  ): boolean {
    if (
      token.transcriptGeneration !== this.transcriptGeneration ||
      token.measurementGeneration !== this.#measurementGeneration ||
      token.layoutEpoch !== this.#layoutEpoch
    ) {
      return false;
    }
    return this.pageIndex.setMeasurement(
      pageId,
      {
        ...geometry,
        transcriptGeneration: token.transcriptGeneration,
        measurementGeneration: token.measurementGeneration,
        layoutEpoch: token.layoutEpoch,
      },
      expectedLayoutRevision,
    );
  }

  /**
   * Stores a visible page window after validating that both boundary pages still exist.
   *
   * @param window - Proposed visible page range, or `null` to clear it.
   * @returns Nothing; the validated window is stored when it differs from the current value.
   */
  setWindow(window: TranscriptWindow | null): void {
    const nextWindow =
      window && this.pageIndex.pageById(window.startPageId) && this.pageIndex.pageById(window.endPageId)
        ? window
        : null;
    if (this.#window?.startPageId === nextWindow?.startPageId && this.#window?.endPageId === nextWindow?.endPageId) {
      return;
    }
    this.#window = nextWindow;
    this.#touch();
  }

  /**
   * Stores a scroll anchor only when its referenced page still exists.
   *
   * @param anchor - Proposed page-relative scroll anchor, or `null` to clear it.
   * @returns Nothing; the validated anchor is stored when it differs from the current value.
   */
  setScrollAnchor(anchor: TranscriptScrollAnchor | null): void {
    const nextAnchor = anchor && this.pageIndex.pageById(anchor.pageId) ? anchor : null;
    if (
      this.#scrollAnchor?.pageId === nextAnchor?.pageId &&
      this.#scrollAnchor?.offset === nextAnchor?.offset &&
      this.#scrollAnchor?.blockId === nextAnchor?.blockId &&
      this.#scrollAnchor?.blockOffset === nextAnchor?.blockOffset
    ) {
      return;
    }
    this.#scrollAnchor = nextAnchor;
    this.#touch();
  }

  /**
   * Clears stored window and anchor references invalidated by incremental page structure changes.
   *
   * @returns Nothing; stale references are removed and reactive consumers are notified.
   */
  #reconcilePageReferences(): void {
    let changed = false;
    if (
      this.#window &&
      (!this.pageIndex.pageById(this.#window.startPageId) || !this.pageIndex.pageById(this.#window.endPageId))
    ) {
      this.#window = null;
      changed = true;
    }
    if (this.#scrollAnchor?.blockId) {
      const currentPage = this.pageIndex.pageForBlock(this.#scrollAnchor.blockId);
      if (!currentPage) {
        this.#scrollAnchor = null;
        changed = true;
      } else if (currentPage.id !== this.#scrollAnchor.pageId) {
        this.#scrollAnchor = { ...this.#scrollAnchor, pageId: currentPage.id };
        changed = true;
      }
    } else if (this.#scrollAnchor && !this.pageIndex.pageById(this.#scrollAnchor.pageId)) {
      this.#scrollAnchor = null;
      changed = true;
    }
    if (changed) this.#touch();
  }

  #touch(): void {
    this.#setRevision((revision) => revision + 1);
  }
}
