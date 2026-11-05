import type { Renderable, ScrollBoxRenderable } from "@opentui/core";
import type { ChatBlock, UserBlock, UserSkillInvocationEcho } from "../state";
import { userBlockSkillInvocation } from "./user-message";
import {
  estimateTranscriptBlockRows,
  type TranscriptPage,
  type TranscriptPageIndex,
  type TranscriptPageRevisionChange,
} from "./transcript-page-index";
import type { TranscriptGeometryIndex } from "./transcript-window";

const STICKY_PROMPT_PADDING_ROWS = 2;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;

/** Prefix used to tag user block renderables so they can be located in the scroll tree. */
export const USER_BLOCK_ID_PREFIX = "user-block:";

/** Prefix used to locate keyboard-navigable transcript blocks. */
export const TRANSCRIPT_NAV_BLOCK_ID_PREFIX = "transcript-nav-block:";

export interface StickyPromptResult {
  /** The user block to display in the sticky header, or null when none qualifies. */
  block: UserBlock | null;
  /** The next user block pushing into the sticky header area. */
  incomingBlock: UserBlock | null;
  /** Number of rows the incoming block overlaps into the sticky area. */
  positionInStickyArea: number;
}

export const EMPTY_STICKY_PROMPT_RESULT: StickyPromptResult = {
  block: null,
  incomingBlock: null,
  positionInStickyArea: 0,
};

// The recursive fallback walks the whole transcript tree, and the sticky prompt recomputes on every
// scroll or transcript change, so reuse the last match while it is still mounted under this content.
// Weak on both sides: entries go away with their block, and a destroyed renderable is never retained.
const userBlockRenderables = new WeakMap<UserBlock, WeakRef<Renderable>>();

function isMountedUnder(renderable: Renderable, content: Renderable): boolean {
  let parent = renderable.isDestroyed ? null : renderable.parent;
  while (parent && parent !== content) parent = parent.parent;
  return parent === content;
}

function findUserBlockRenderable(block: UserBlock, scrollBox: ScrollBoxRenderable): Renderable | undefined {
  const renderableId = `${USER_BLOCK_ID_PREFIX}${block.id}`;
  const content = scrollBox.content;
  const cached = userBlockRenderables.get(block)?.deref();
  if (cached?.id === renderableId && isMountedUnder(cached, content)) return cached;
  const found = content.getRenderable(renderableId) ?? content.findDescendantById(renderableId);
  if (found) userBlockRenderables.set(block, new WeakRef(found));
  else userBlockRenderables.delete(block);
  return found;
}

/** Cached sticky-eligible user block and its transcript-relative top offset. */
export interface StickyUserPosition {
  readonly block: UserBlock;
  readonly top: number;
}

interface StickyPageCacheEntry {
  readonly key: string;
  readonly users: readonly StickyUserPosition[];
}

export class TranscriptStickyIndex {
  readonly #cache = new Map<string, StickyPageCacheEntry>();
  #userPageIndices: number[] = [];
  #userPagePositionByIndex = new Map<number, number>();
  #pageIndex: TranscriptPageIndex | null = null;
  #revision = -1;

  /**
   * Finds the sticky user prompt using incrementally cached page-local user positions.
   *
   * @param blockForId - Resolves canonical blocks by identifier.
   * @param pages - Current ordered transcript pages.
   * @param pageIndex - Page index providing incremental revision changes.
   * @param geometry - Geometry index used to translate scroll offsets to pages.
   * @param scrollTop - Current transcript-relative scroll position.
   * @param maxLines - Maximum rows available to the sticky prompt header.
   * @returns The active sticky prompt and incoming overlap transition.
   */
  find(
    blockForId: (blockId: string) => ChatBlock | undefined,
    pages: readonly TranscriptPage[],
    pageIndex: TranscriptPageIndex,
    geometry: TranscriptGeometryIndex,
    scrollTop: number,
    maxLines: number,
  ): StickyPromptResult {
    if (maxLines <= 0 || scrollTop <= 0 || pages.length === 0) return EMPTY_STICKY_PROMPT_RESULT;
    if (this.#pageIndex !== pageIndex) {
      this.#pageIndex = pageIndex;
      this.#cache.clear();
      this.#userPageIndices = [];
      this.#userPagePositionByIndex.clear();
      this.#revision = -1;
    }
    const change = pageIndex.revisionChangeSince(this.#revision);
    this.#sync(blockForId, pages, geometry, change);
    const currentPageIndex = geometry.pageAtOffset(scrollTop)?.index ?? 0;
    let userPagePosition = this.#lastUserPageAtOrBefore(currentPageIndex);
    let candidate: StickyUserPosition | null = null;
    let candidatePageIndex = -1;
    while (userPagePosition >= 0 && !candidate) {
      const pageIndex = this.#userPageIndices[userPagePosition];
      const pageId = geometry.pageIdAt(pageIndex);
      const pageGeometry = pageId ? geometry.page(pageId) : undefined;
      const users = pageId ? (this.#cache.get(pageId)?.users ?? []) : [];
      if (pageGeometry) {
        const localOffset = scrollTop - pageGeometry.start;
        for (let userIndex = users.length - 1; userIndex >= 0; userIndex -= 1) {
          if (pageIndex < currentPageIndex || users[userIndex].top <= localOffset) {
            candidate = users[userIndex];
            candidatePageIndex = pageIndex;
            break;
          }
        }
      }
      userPagePosition -= 1;
    }
    if (!candidate) return EMPTY_STICKY_PROMPT_RESULT;

    const candidatePageId = geometry.pageIdAt(candidatePageIndex);
    const candidateUsers = candidatePageId ? (this.#cache.get(candidatePageId)?.users ?? []) : [];
    const candidateIndex = candidateUsers.indexOf(candidate);
    let incoming: StickyUserPosition | null = null;
    if (candidateIndex >= 0 && candidateIndex + 1 < candidateUsers.length) {
      const pageGeometry = candidatePageId ? geometry.page(candidatePageId) : undefined;
      if (pageGeometry)
        incoming = {
          ...candidateUsers[candidateIndex + 1],
          top: pageGeometry.start + candidateUsers[candidateIndex + 1].top,
        };
    } else {
      const nextPosition = this.#firstUserPageAfter(candidatePageIndex);
      const nextPageIndex = nextPosition < this.#userPageIndices.length ? this.#userPageIndices[nextPosition] : -1;
      const nextPageId = nextPageIndex >= 0 ? geometry.pageIdAt(nextPageIndex) : undefined;
      const nextPageGeometry = nextPageId ? geometry.page(nextPageId) : undefined;
      const next = nextPageId ? this.#cache.get(nextPageId)?.users[0] : undefined;
      if (next && nextPageGeometry) incoming = { ...next, top: nextPageGeometry.start + next.top };
    }

    const stickyBottom = scrollTop + maxLines + STICKY_PROMPT_PADDING_ROWS;
    if (incoming && incoming.top <= stickyBottom) {
      return {
        block: candidate.block,
        incomingBlock: incoming.block,
        positionInStickyArea: stickyBottom - incoming.top,
      };
    }
    return { block: candidate.block, incomingBlock: null, positionInStickyArea: 0 };
  }

  /**
   * Synchronizes cached user positions from structural or page-local index revisions.
   *
   * @param blockForId - Resolves canonical blocks by identifier.
   * @param pages - Current ordered transcript pages.
   * @param geometry - Geometry index used to resolve changed page positions.
   * @param change - Page-index revision summary since the previous synchronization.
   * @returns Nothing; page caches and revision state are updated in place.
   */
  #sync(
    blockForId: (blockId: string) => ChatBlock | undefined,
    pages: readonly TranscriptPage[],
    geometry: TranscriptGeometryIndex,
    change: TranscriptPageRevisionChange,
  ): void {
    if (this.#revision < 0 || change.structural) {
      this.#cache.clear();
      this.#userPageIndices = [];
      for (let index = 0; index < pages.length; index += 1) this.#updatePage(blockForId, pages[index], index);
      this.#rebuildUserPagePositions();
      this.#revision = change.revision;
      return;
    }
    let membershipChanged = false;
    for (const pageId of change.pageIds) {
      const index = geometry.pageIndex(pageId);
      if (index < 0) continue;
      membershipChanged = this.#updatePage(blockForId, pages[index], index) || membershipChanged;
    }
    if (membershipChanged) this.#rebuildUserPagePositions();
    this.#revision = change.revision;
  }

  /**
   * Rebuilds one page's sticky-user cache when its layout identity has changed.
   *
   * @param blockForId - Resolves canonical blocks by identifier.
   * @param page - Page whose user positions should be cached.
   * @param pageIndex - Current zero-based position of the page.
   * @returns `true` when the set of pages containing sticky users changed.
   */
  #updatePage(
    blockForId: (blockId: string) => ChatBlock | undefined,
    page: TranscriptPage,
    pageIndex: number,
  ): boolean {
    const key = [
      page.layoutRevision,
      page.estimatedRows,
      page.estimatedHeight ?? "",
      page.measurement?.transcriptGeneration ?? "",
      page.measurement?.measurementGeneration ?? "",
      page.measurement?.layoutEpoch ?? "",
      page.measurement?.height ?? "",
    ].join(":");
    let cached = this.#cache.get(page.id);
    if (!cached || cached.key !== key) {
      const users: StickyUserPosition[] = [];
      let estimatedOffset = 0;
      for (const blockId of page.blockIds) {
        const block = blockForId(blockId);
        if (!block) continue;
        if (isStickyEligibleUserBlock(block)) {
          const measuredOffset =
            page.measurement?.userBlockOffsets[block.id] ?? page.estimatedUserBlockOffsets?.[block.id];
          users.push({ block, top: measuredOffset ?? estimatedOffset });
        }
        estimatedOffset += estimateTranscriptBlockRows(block);
      }
      cached = { key, users };
      this.#cache.set(page.id, cached);
    }
    const existingPosition = this.#userPagePositionByIndex.get(pageIndex) ?? -1;
    if (cached.users.length > 0 && existingPosition < 0) {
      const insertion = this.#firstUserPageAfter(pageIndex - 1);
      this.#userPageIndices.splice(insertion, 0, pageIndex);
      return true;
    }
    if (cached.users.length === 0 && existingPosition >= 0) {
      this.#userPageIndices.splice(existingPosition, 1);
      return true;
    }
    return false;
  }

  /**
   * Rebuilds the reverse lookup from page index to its sorted user-page position.
   *
   * @returns Nothing; the reverse lookup map is replaced in place.
   */
  #rebuildUserPagePositions(): void {
    this.#userPagePositionByIndex = new Map(this.#userPageIndices.map((pageIndex, position) => [pageIndex, position]));
  }

  /**
   * Binary-searches for the final cached user page at or before a page index.
   *
   * @param pageIndex - Page index used as the inclusive upper bound.
   * @returns The position within the sorted user-page list, or `-1` when none qualifies.
   */
  #lastUserPageAtOrBefore(pageIndex: number): number {
    let low = 0;
    let high = this.#userPageIndices.length - 1;
    let result = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (this.#userPageIndices[middle] <= pageIndex) {
        result = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return result;
  }

  /**
   * Binary-searches for the first cached user page strictly after a page index.
   *
   * @param pageIndex - Page index used as the exclusive lower bound.
   * @returns The insertion position within the sorted user-page list.
   */
  #firstUserPageAfter(pageIndex: number): number {
    let low = 0;
    let high = this.#userPageIndices.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.#userPageIndices[middle] <= pageIndex) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}

/**
 * Builds transcript-relative sticky-user positions from page membership and available geometry.
 *
 * @param blocks - Canonical transcript blocks.
 * @param pages - Ordered transcript pages containing the blocks.
 * @returns Sticky-eligible user blocks with transcript-relative top offsets.
 */
export function buildStickyUserPositions(
  blocks: readonly ChatBlock[],
  pages: readonly TranscriptPage[],
): readonly StickyUserPosition[] {
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const userPositions: StickyUserPosition[] = [];
  let pageTop = 0;

  for (const page of pages) {
    let estimatedOffset = 0;
    for (const blockId of page.blockIds) {
      const block = blocksById.get(blockId);
      if (!block) continue;
      if (isStickyEligibleUserBlock(block)) {
        const measuredOffset =
          page.measurement?.userBlockOffsets[block.id] ?? page.estimatedUserBlockOffsets?.[block.id];
        userPositions.push({ block, top: pageTop + (measuredOffset ?? estimatedOffset) });
      }
      estimatedOffset += estimateTranscriptBlockRows(block);
    }
    pageTop += page.measurement?.height ?? page.estimatedHeight ?? Math.max(1, page.estimatedRows);
  }
  return userPositions;
}

/**
 * Resolves the active sticky prompt from sorted transcript-relative user positions.
 *
 * @param userPositions - Sticky-eligible users sorted by top offset.
 * @param scrollTop - Current transcript-relative scroll position.
 * @param maxLines - Maximum rows available to the sticky prompt header.
 * @returns The active sticky prompt and incoming overlap transition.
 */
export function findStickyUserBlockFromPositions(
  userPositions: readonly StickyUserPosition[],
  scrollTop: number,
  maxLines: number,
): StickyPromptResult {
  if (maxLines <= 0 || scrollTop <= 0 || userPositions.length === 0) return EMPTY_STICKY_PROMPT_RESULT;
  let low = 0;
  let high = userPositions.length - 1;
  let candidateIndex = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (userPositions[middle].top <= scrollTop) {
      candidateIndex = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (candidateIndex < 0) return EMPTY_STICKY_PROMPT_RESULT;

  const candidate = userPositions[candidateIndex];
  const incoming = userPositions[candidateIndex + 1];
  const stickyBottom = scrollTop + maxLines + STICKY_PROMPT_PADDING_ROWS;
  if (incoming && incoming.top <= stickyBottom) {
    return {
      block: candidate.block,
      incomingBlock: incoming.block,
      positionInStickyArea: stickyBottom - incoming.top,
    };
  }
  return { block: candidate.block, incomingBlock: null, positionInStickyArea: 0 };
}

/**
 * Builds page-based user positions and resolves the sticky prompt in one call.
 *
 * @param blocks - Canonical transcript blocks.
 * @param pages - Ordered transcript pages containing the blocks.
 * @param scrollTop - Current transcript-relative scroll position.
 * @param maxLines - Maximum rows available to the sticky prompt header.
 * @returns The active sticky prompt and incoming overlap transition.
 */
export function findStickyUserBlockFromTranscriptPages(
  blocks: readonly ChatBlock[],
  pages: readonly TranscriptPage[],
  scrollTop: number,
  maxLines: number,
): StickyPromptResult {
  return findStickyUserBlockFromPositions(buildStickyUserPositions(blocks, pages), scrollTop, maxLines);
}

/**
 * Finds the sticky user prompt from mounted renderables and computes the next prompt's overlap.
 *
 * @param blocks - Canonical transcript blocks in render order.
 * @param scrollBox - Mounted transcript scroll container used for screen-space positions.
 * @param maxLines - Maximum rows available to the sticky prompt header.
 * @returns The active sticky prompt and incoming overlap transition.
 */
export function findStickyUserBlock(
  blocks: readonly ChatBlock[],
  scrollBox: ScrollBoxRenderable,
  maxLines: number,
): StickyPromptResult {
  if (maxLines <= 0) return EMPTY_STICKY_PROMPT_RESULT;

  const maxScroll = Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height);
  if (maxScroll <= 0) return EMPTY_STICKY_PROMPT_RESULT;

  const scrollBoxTop = scrollBox.y;
  const stickyBottomY = scrollBoxTop + maxLines + STICKY_PROMPT_PADDING_ROWS;

  let candidate: UserBlock | null = null;
  let candidateIndex = -1;

  // The active sticky prompt is usually near the bottom of the transcript, so
  // scan backward to find the latest qualifying user block first.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!isStickyEligibleUserBlock(block)) continue;

    const renderable = findUserBlockRenderable(block, scrollBox) ?? null;
    if (!renderable) continue;

    const blockTopY = renderable.y;

    // A block qualifies once its top has reached the viewport top. Tall blocks
    // that extend below stickyBottomY are still eligible: the header clips to
    // maxLines, so rendered block height does not affect candidacy.
    if (blockTopY <= scrollBoxTop) {
      candidate = block;
      candidateIndex = i;
      break;
    }
  }

  if (!candidate) return EMPTY_STICKY_PROMPT_RESULT;

  // Only the next rendered user block can push the current sticky prompt out.
  for (let i = candidateIndex + 1; i < blocks.length; i++) {
    const block = blocks[i];
    if (!isStickyEligibleUserBlock(block)) continue;

    const renderable = findUserBlockRenderable(block, scrollBox) ?? null;
    if (!renderable) continue;

    const blockTopY = renderable.y;
    if (blockTopY <= stickyBottomY) {
      return {
        block: candidate,
        incomingBlock: block,
        positionInStickyArea: stickyBottomY - blockTopY,
      };
    }

    break;
  }

  return { block: candidate, incomingBlock: null, positionInStickyArea: 0 };
}

function isStickyEligibleUserBlock(block: ChatBlock): block is UserBlock {
  return block.type === "user" && block.delivery !== "current-turn-guidance";
}

/**
 * Build the lines to display in the sticky header for a given user block.
 * Returns up to `maxLines` lines. The last line is truncated with an
 * ellipsis when there is more content that does not fit.
 */
export function formatStickyPromptLines(block: UserBlock, maxLines: number, maxWidth: number): string[] {
  if (maxLines <= 0 || maxWidth <= 0) return [];

  const { lines, hasMore } = firstPromptLines(promptTextForBlock(block), maxLines);
  return lines.map((line, i) => {
    const needsEllipsis = i === lines.length - 1 && hasMore;
    if (needsEllipsis) return truncateLine(line ? `${line}...` : "...", maxWidth);
    return truncateLine(line, maxWidth);
  });
}

function promptTextForBlock(block: UserBlock): string {
  const skill = userBlockSkillInvocation(block);
  if (!skill) return block.content;
  return promptTextForSkill(skill);
}

function promptTextForSkill(skill: UserSkillInvocationEcho): string {
  // Match the user block renderer by showing the skill label before the user's message.
  const prefix = `[skill] ${skill.name}`;
  const userMessage = skill.userMessage?.trim() ?? "";
  return userMessage ? `${prefix} ${userMessage}` : prefix;
}

// Collect only the visible header lines plus one sentinel line for ellipsis.
// This avoids splitting very large prompts on every scroll update.
function firstPromptLines(text: string, maxLines: number): { lines: string[]; hasMore: boolean } {
  const lines: string[] = [];
  const maxCollectedLines = maxLines + 1;
  let lineStart = 0;

  for (let i = 0; i < text.length && lines.length < maxCollectedLines; i++) {
    if (text.charCodeAt(i) !== LINE_FEED) continue;

    const lineEnd = i > lineStart && text.charCodeAt(i - 1) === CARRIAGE_RETURN ? i - 1 : i;
    lines.push(text.slice(lineStart, lineEnd));
    lineStart = i + 1;
  }

  if (lines.length < maxCollectedLines) {
    lines.push(text.slice(lineStart));
  }

  const hasMore = lines.length > maxLines;
  return {
    lines: hasMore ? lines.slice(0, maxLines) : lines,
    hasMore,
  };
}

function truncateLine(line: string, maxWidth: number): string {
  if (line.length <= maxWidth) return line;
  if (maxWidth <= 3) return ".".repeat(maxWidth);
  return `${line.slice(0, maxWidth - 3)}...`;
}
