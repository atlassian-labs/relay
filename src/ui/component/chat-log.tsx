import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import type { CliRenderer, MouseEvent, Renderable, ScrollBoxRenderable, Selection } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { useApp, type ToolBlock } from "../state";
import { PluginWelcomeScreen } from "./plugin-welcome-screen";
import { WelcomeScreen } from "./welcome-screen";
import { StickyPromptHeader } from "./sticky-prompt-header";
import type { VersionUpdateInfo } from "../../platform/version-check";
import type { RelayWidgetEntry } from "../../plugins/slots";
import { preserveStickyScrollBoundaryAfterMouseScrollWithEscapeRecovery } from "../app/scroll-escape-recovery";
import {
  EMPTY_STICKY_PROMPT_RESULT,
  findStickyUserBlock,
  TranscriptStickyIndex,
  TRANSCRIPT_NAV_BLOCK_ID_PREFIX,
  USER_BLOCK_ID_PREFIX,
} from "../util/sticky-prompt";
import type { StickyPromptResult } from "../util/sticky-prompt";
import { getConfig, subscribeConfig } from "../../config";
import { store } from "../app/runtime-store";
import type { TranscriptPage } from "../util/transcript-page-index";
import type { TranscriptRendererMode } from "../util/transcript-renderer-mode";
import type { TranscriptSelectionCoordinator, TranscriptSelectionCopy } from "../util/transcript-selection";
import { transcriptPageHeight, TranscriptGeometryIndex } from "../util/transcript-window";
import type { TranscriptScrollAnchor, TranscriptViewState } from "../util/transcript-view-state";
import { isTranscriptBlockStable } from "../util/transcript-page-index";
import {
  buildToolCallGroupProjection,
  toolCallGroupLayoutKey,
  toolCallGroupLayoutRoles,
  type ToolCallGroup,
} from "../util/tool-call-groups";
import { ToolCallGroupHeader } from "./tool-call-group";

export const TRANSCRIPT_PAGE_ID_PREFIX = "transcript-page:";
export const TRANSCRIPT_BLOCK_ID_PREFIX = "transcript-block:";
export const TRANSCRIPT_SPACER_ID_PREFIX = "transcript-spacer:";
const TRANSCRIPT_OVERSCAN_PAGES = 2;
const MAX_BACKGROUND_DYNAMIC_PAGES = 2;
const MAX_SELECTION_PIN_PAGES = 16;

/**
 * Narrows an unknown renderer value to the selection APIs used by windowed transcripts.
 *
 * @param value - Renderer candidate supplied by props or OpenTUI context.
 * @returns A compatible CLI renderer, or `null` when the required selection APIs are absent.
 */
function cliRenderer(value: unknown): CliRenderer | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CliRenderer>;
  return typeof candidate.getSelection === "function" &&
    typeof candidate.updateSelection === "function" &&
    typeof candidate.clearSelection === "function" &&
    typeof candidate.requestSelectionUpdate === "function"
    ? (value as CliRenderer)
    : null;
}

/**
 * Walks a renderable's ancestors to find the enclosing transcript page identifier.
 *
 * @param renderable - Renderable selected or touched by the user.
 * @returns The enclosing page identifier, or `null` when the renderable is outside a page.
 */
function pageIdFromRenderable(renderable: Renderable | null | undefined): string | null {
  let current = renderable ?? null;
  while (current) {
    if (current.id.startsWith(TRANSCRIPT_PAGE_ID_PREFIX)) return current.id.slice(TRANSCRIPT_PAGE_ID_PREFIX.length);
    current = current.parent;
  }
  return null;
}

/**
 * Walks a renderable's ancestors to find the enclosing transcript block identifier.
 *
 * @param renderable - Renderable selected or touched by the user.
 * @returns The enclosing block identifier, or `null` when the renderable is outside a block.
 */
function blockIdFromRenderable(renderable: Renderable | null | undefined): string | null {
  let current = renderable ?? null;
  while (current) {
    if (current.id?.startsWith(TRANSCRIPT_BLOCK_ID_PREFIX)) {
      return current.id.slice(TRANSCRIPT_BLOCK_ID_PREFIX.length);
    }
    current = current.parent;
  }
  return null;
}

/**
 * Captures a page-relative and, when measured, block-relative anchor for a scroll position.
 *
 * @param geometry - Current transcript geometry index.
 * @param scrollTop - Transcript-relative scroll position to preserve.
 * @param indexedPage - Indexed page containing the scroll position, when available.
 * @returns A restorable scroll anchor, or `null` when no page covers the position.
 */
function anchorForScroll(
  geometry: TranscriptGeometryIndex,
  scrollTop: number,
  indexedPage: TranscriptPage | undefined,
): TranscriptScrollAnchor | null {
  const page = geometry.pageAtOffset(scrollTop);
  if (!page) return null;
  const offset = Math.max(0, scrollTop - page.start);
  const blockOffsets = indexedPage?.measurement?.blockOffsets;
  if (!blockOffsets) return { pageId: page.pageId, offset };
  let blockId: string | undefined;
  let blockStart = 0;
  for (const candidateId of indexedPage.blockIds) {
    const candidateStart = blockOffsets[candidateId];
    if (candidateStart === undefined || candidateStart > offset) break;
    blockId = candidateId;
    blockStart = candidateStart;
  }
  return blockId
    ? { pageId: page.pageId, offset, blockId, blockOffset: offset - blockStart }
    : { pageId: page.pageId, offset };
}

/**
 * Resolves a stored page or block anchor to the current transcript scroll position.
 *
 * @param geometry - Current transcript geometry index.
 * @param anchor - Previously captured page-relative or block-relative anchor.
 * @param indexedPage - Current page containing the anchored block, when available.
 * @returns The clamped transcript scroll position, or `null` when the page no longer exists.
 */
function scrollForAnchor(
  geometry: TranscriptGeometryIndex,
  anchor: TranscriptScrollAnchor,
  indexedPage: TranscriptPage | undefined,
): number | null {
  const page = geometry.page(indexedPage?.id ?? anchor.pageId);
  if (!page) return null;
  const blockStart = anchor.blockId ? indexedPage?.measurement?.blockOffsets?.[anchor.blockId] : undefined;
  const requestedOffset =
    blockStart !== undefined && anchor.blockOffset !== undefined ? blockStart + anchor.blockOffset : anchor.offset;
  const maxOffset = Math.max(0, page.height - 1);
  return page.start + Math.min(Math.max(0, requestedOffset), maxOffset);
}

/**
 * Compares renderer selections by their anchor and focus coordinates.
 *
 * @param left - First selection attempt.
 * @param right - Second selection attempt.
 * @returns `true` when both selections describe the same coordinate range.
 */
function isSameSelectionAttempt(left: Selection, right: Selection): boolean {
  return (
    left.anchor.x === right.anchor.x &&
    left.anchor.y === right.anchor.y &&
    left.focus.x === right.focus.x &&
    left.focus.y === right.focus.y
  );
}

export function ChatLog(props: {
  welcomeDismissed: () => boolean;
  renderBlock: (block: any, prevBlock?: any) => any;
  versionUpdate?: () => VersionUpdateInfo | null;
  welcomeWidgets?: () => readonly RelayWidgetEntry[];
  welcomeAddonWidgets?: () => readonly RelayWidgetEntry[];
  onConnectionErrorModalOpenChange?: (open: boolean) => void;
  onScrollBoxRef?: (scrollBox: ScrollBoxRenderable | null) => void;
  availableWidth?: () => number;
  rendererMode?: TranscriptRendererMode;
  renderer?: unknown;
  layoutRevision?: () => string | number;
  onSelectionCoordinatorChange?: (coordinator: TranscriptSelectionCoordinator | null) => void;
  onTranscriptSelect?: () => void;
  selectionPinPageLimit?: number;
}) {
  const app = useApp();
  const contextRenderer = useRenderer();
  const mode = (): TranscriptRendererMode =>
    props.rendererMode ?? (app.transcriptPagingEnabled ? "windowed" : "legacy");
  const renderer = cliRenderer(props.renderer ?? contextRenderer);

  const isWelcomeOnly = () => {
    if (props.welcomeDismissed()) return false;
    const blocks = app.state.blocks;
    return blocks.every((block) => block.type === "info");
  };

  const [scrollBoxRef, setScrollBoxRefSignal] = createSignal<ScrollBoxRenderable | null>(null);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(1);
  const [viewportWidth, setViewportWidth] = createSignal(1);
  const [viewportReady, setViewportReady] = createSignal(false);
  const [stickyMaxLines, setStickyMaxLines] = createSignal(getConfig().ui.sticky_prompt_header_lines);
  const [toolCallGroupsConfig, setToolCallGroupsConfig] = createSignal(getConfig().ui.tool_call_groups);
  const initialLayoutConfig = getConfig().ui;
  const [layoutConfigKey, setLayoutConfigKey] = createSignal(
    `${initialLayoutConfig.show_thinking}:${initialLayoutConfig.thinking_preview_lines}:${initialLayoutConfig.tool_result_preview_lines}:${initialLayoutConfig.succinct_tool_results}`,
  );

  /**
   * Builds the renderer-owned layout identity used to invalidate transcript measurements.
   *
   * @param width - Current transcript viewport width.
   * @returns A stable key covering width, expansion, workspace, config, and caller layout revisions.
   */
  const layoutKeyForWidth = (width: number) =>
    `${width}:${app.state.cwd}:${layoutConfigKey()}:${toolCallGroupLayoutKey(
      toolCallGroups(),
      app.state.expandedToolCallGroups,
    )}:${props.layoutRevision?.() ?? ""}`;

  const setScrollBoxRef = (scrollBox: ScrollBoxRenderable) => {
    setScrollBoxRefSignal(scrollBox);
    props.onScrollBoxRef?.(scrollBox);
  };
  const handleScrollBoxMouseScroll = (event: MouseEvent) => {
    preserveStickyScrollBoundaryAfterMouseScrollWithEscapeRecovery(scrollBoxRef(), event);
  };

  const activeView = (): TranscriptViewState | null => {
    if (mode() !== "windowed") return null;
    return store.threadTranscriptViews.get(app.state.activeThreadId) ?? null;
  };
  const pages = (): readonly TranscriptPage[] => activeView()?.pageIndex.pages() ?? [];
  const geometry = new TranscriptGeometryIndex();
  /**
   * Synchronizes incremental page changes into the geometry index for the active transcript owner.
   *
   * @returns The synchronized page-index revision, or `-1` when no active transcript view exists.
   */
  const geometryRevision = createMemo(() => {
    const view = activeView();
    if (!view) return -1;
    const indexedPages = view.pageIndex.pages();
    const change = view.pageIndex.revisionChangeSince(geometry.revision);
    geometry.sync(indexedPages, change, `${app.state.activeThreadId}:${view.transcriptGeneration}`);
    return change.revision;
  });
  const pageById = (pageId: string) => activeView()?.pageIndex.pageById(pageId);
  const toolCallGroups = createMemo(() => buildToolCallGroupProjection(app.state.blocks, toolCallGroupsConfig()));
  const groupExpanded = (group: ToolCallGroup) => app.state.expandedToolCallGroups[group.id] === true;
  const canonicalBlockIdForTranscriptRow = (rowId: string): string =>
    toolCallGroups().byId.get(rowId)?.firstBlockId ?? rowId;
  const renderProjectedBlock = (blockId: string) => {
    const entry = app.blockEntry(blockId);
    if (!entry) return null;
    const previous = entry.index > 0 ? app.state.blocks[entry.index - 1] : undefined;
    const renderNormalBlock = () => props.renderBlock(entry.block, previous);
    return (
      <Show when={toolCallGroups().byMemberBlockId.get(blockId)} fallback={renderNormalBlock()}>
        {(currentGroup) => (
          <Show
            when={currentGroup().firstBlockId === blockId && entry.block.type === "tool"}
            fallback={<Show when={groupExpanded(currentGroup())}>{renderNormalBlock()}</Show>}
          >
            <>
              <ToolCallGroupHeader
                group={currentGroup()}
                firstBlock={entry.block as ToolBlock}
                prevBlock={previous}
                expanded={() => groupExpanded(currentGroup())}
                onSelect={props.onTranscriptSelect}
              />
              <Show when={groupExpanded(currentGroup())}>{renderNormalBlock()}</Show>
            </>
          </Show>
        )}
      </Show>
    );
  };
  const pageForAnchor = (anchor: TranscriptScrollAnchor) =>
    anchor.blockId ? activeView()?.pageIndex.pageForBlock(anchor.blockId) : pageById(anchor.pageId);
  const anchorAtScroll = (value: number) => {
    const geometryPage = geometry.pageAtOffset(value);
    return anchorForScroll(geometry, value, geometryPage ? pageById(geometryPage.pageId) : undefined);
  };
  const scrollToAnchor = (anchor: TranscriptScrollAnchor) => scrollForAnchor(geometry, anchor, pageForAnchor(anchor));
  const stickyIndex = new TranscriptStickyIndex();
  /**
   * Renders an indexed block with its canonical predecessor for spacing and grouping behavior.
   *
   * @param blockId - Identifier of the canonical block to render.
   * @returns The rendered block node, or `null` when the block no longer exists.
   */
  const renderIndexedBlock = (blockId: string) => renderProjectedBlock(blockId);

  /**
   * Resolves the stored page window or calculates an initial tail-following window from geometry.
   *
   * @returns The active visible page range, or `null` when geometry is unavailable.
   */
  const calculatedWindow = createMemo(() => {
    const view = activeView();
    geometryRevision();
    if (!view || geometry.pageCount === 0) return null;
    const existing = view.window();
    if (existing) return existing;
    return geometry.calculateWindow({
      scrollTop: Math.max(0, geometry.totalHeight - viewportHeight()),
      viewportHeight: viewportHeight(),
      overscanPages: TRANSCRIPT_OVERSCAN_PAGES,
    });
  });
  const selectionPins = new Set<string>();
  let pendingNavigation: {
    threadId: string;
    transcriptGeneration: number;
    pageId: string;
    blockId: string;
    targetId: string;
    retainPin: boolean;
    scrolled: boolean;
  } | null = null;
  let navigationPin: { threadId: string; pageId: string } | null = null;
  const backgroundDynamicPageIds = new Set<string>();
  let mountedRevision = -1;
  let mountedView: TranscriptViewState | null = null;
  /**
   * Selects the bounded set of pages retained for visibility, pins, tail updates, and nearby dynamic work.
   *
   * @returns Page identifiers that should render as live components for the current frame.
   */
  const mountedPageIds = createMemo<ReadonlySet<string>>(() => {
    const view = activeView();
    geometryRevision();
    if (!view) return new Set<string>();
    if (mountedView !== view) {
      mountedView = view;
      mountedRevision = -1;
      backgroundDynamicPageIds.clear();
    }
    const indexedPages = view.pageIndex.pages();
    const change = view.pageIndex.revisionChangeSince(mountedRevision);
    mountedRevision = change.revision;
    const tailPageId = geometry.pageIdAt(geometry.pageCount - 1);
    if (change.structural) {
      backgroundDynamicPageIds.clear();
      for (let index = indexedPages.length - 1; index >= 0; index -= 1) {
        const page = indexedPages[index];
        if (page.id !== tailPageId && page.dynamic) backgroundDynamicPageIds.add(page.id);
        if (backgroundDynamicPageIds.size >= MAX_BACKGROUND_DYNAMIC_PAGES) break;
      }
    } else {
      for (const pageId of change.pageIds) {
        const page = view.pageIndex.pageById(pageId);
        if (page && page.id !== tailPageId && page.dynamic && (page.reopened || page.pinReasons.length > 0)) {
          backgroundDynamicPageIds.add(pageId);
        } else {
          backgroundDynamicPageIds.delete(pageId);
        }
      }
    }

    const mounted = new Set<string>();
    const window = calculatedWindow();
    const startIndex = window ? geometry.pageIndex(window.startPageId) : -1;
    const endIndex = window ? geometry.pageIndex(window.endPageId) : -1;
    if (startIndex >= 0 && endIndex >= startIndex) {
      for (let index = startIndex; index <= endIndex; index += 1) {
        const pageId = geometry.pageIdAt(index);
        if (pageId) mounted.add(pageId);
      }
    }
    if (tailPageId) mounted.add(tailPageId);
    for (const pageId of selectionPins) mounted.add(pageId);
    if (pendingNavigation) mounted.add(pendingNavigation.pageId);

    const windowStart = startIndex >= 0 ? startIndex : Math.max(0, geometry.pageCount - 1);
    const windowEnd = endIndex >= windowStart ? endIndex : windowStart;
    const selectedBackground = [...backgroundDynamicPageIds]
      .filter((pageId) => !mounted.has(pageId))
      .map((pageId) => ({ pageId, index: geometry.pageIndex(pageId) }))
      .filter(({ index }) => index >= 0)
      .sort((left, right) => {
        const leftDistance = left.index < windowStart ? windowStart - left.index : Math.max(0, left.index - windowEnd);
        const rightDistance =
          right.index < windowStart ? windowStart - right.index : Math.max(0, right.index - windowEnd);
        return leftDistance - rightDistance || left.index - right.index;
      })
      .slice(0, MAX_BACKGROUND_DYNAMIC_PAGES);
    backgroundDynamicPageIds.clear();
    for (const { pageId } of selectedBackground) {
      backgroundDynamicPageIds.add(pageId);
      mounted.add(pageId);
    }
    return mounted;
  });
  const renderSegments = createMemo(() => {
    geometryRevision();
    return geometry.renderSegments(mountedPageIds());
  });
  const renderSegmentKeys = createMemo(() => renderSegments().map((segment) => segment.key));
  const renderSegment = (key: string) => renderSegments().find((segment) => segment.key === key);
  const renderSegmentPageId = (key: string) => {
    const segment = renderSegment(key);
    return segment?.type === "page" ? segment.pageId : null;
  };
  const renderSegmentSpacerHeight = (key: string) => {
    const segment = renderSegment(key);
    return segment?.type === "spacer" ? segment.height : 1;
  };

  let pendingAnchorRestore: TranscriptScrollAnchor | null = null;
  let anchorRevisionView: TranscriptViewState | null = null;
  let anchorRevision = -1;
  let activationPending = mode() === "windowed";
  let pendingActivationAnchor: TranscriptScrollAnchor | null = activeView()?.scrollAnchor() ?? null;
  let activeThreadId = app.state.activeThreadId;
  let selectionThreadId: string | null = null;
  let selectionGeneration: number | null = null;
  const pendingSelectionRefreshPages = new Set<string>();
  let selectionRefreshPending = false;
  let selectionOverflowed = false;
  let pendingSelectionCompletion: {
    threadId: string;
    transcriptGeneration: number;
    pageIndexRevision: number;
    blockIds: readonly string[];
    selection: Selection;
    copy: TranscriptSelectionCopy;
  } | null = null;
  let completedSelection: Selection | null = null;
  let selectionWasPresent = false;
  let lastTrackedFrameKey = "";
  let disposed = false;

  /**
   * Releases all selection pins and clears deferred selection state.
   *
   * @returns Nothing; page pins and selection bookkeeping are cleared in place.
   */
  const releaseSelectionPins = () => {
    const threadId = selectionThreadId;
    const view = threadId ? store.threadTranscriptViews.get(threadId) : undefined;
    if (view && threadId) {
      const blocks =
        threadId === app.state.activeThreadId ? app.state.blocks : (store.threadBlocks.get(threadId) ?? []);
      const currentBlockId =
        threadId === app.state.activeThreadId
          ? app.state.currentBlockId
          : (store.threadCurrentBlockIds.get(threadId) ?? null);
      view.pageIndex.unpinPages(selectionPins, "selection", blocks, currentBlockId);
    }
    selectionPins.clear();
    pendingSelectionRefreshPages.clear();
    selectionRefreshPending = false;
    pendingSelectionCompletion = null;
    selectionThreadId = null;
    selectionGeneration = null;
    selectionOverflowed = false;
    selectionWasPresent = false;
  };

  /**
   * Releases the page pinned for sticky-prompt navigation.
   *
   * @param threadId - Thread whose canonical state should be used while unpinning.
   * @returns Nothing; the navigation pin and pending navigation state are cleared.
   */
  const releaseNavigationPin = (threadId = app.state.activeThreadId) => {
    const pin = navigationPin ?? (pendingNavigation ? { threadId, pageId: pendingNavigation.pageId } : null);
    if (!pin) return;
    const view = store.threadTranscriptViews.get(pin.threadId);
    const blocks =
      pin.threadId === app.state.activeThreadId ? app.state.blocks : (store.threadBlocks.get(pin.threadId) ?? []);
    const currentBlockId =
      pin.threadId === app.state.activeThreadId
        ? app.state.currentBlockId
        : (store.threadCurrentBlockIds.get(pin.threadId) ?? null);
    view?.pageIndex.unpinPage(pin.pageId, "navigation", blocks, currentBlockId);
    navigationPin = null;
    pendingNavigation = null;
  };

  /**
   * Moves a pending navigation pin when page normalization relocates its target block.
   *
   * @param view - Active transcript view containing the current page membership.
   * @returns Nothing; pending navigation is updated or cancelled in place.
   */
  const reconcilePendingNavigation = (view: TranscriptViewState): void => {
    const navigation = pendingNavigation;
    if (!navigation) return;
    if (
      navigation.threadId !== app.state.activeThreadId ||
      navigation.transcriptGeneration !== view.transcriptGeneration
    ) {
      releaseNavigationPin(navigation.threadId);
      return;
    }
    const currentPage = view.pageIndex.pageForBlock(navigation.blockId);
    if (!currentPage) {
      releaseNavigationPin(navigation.threadId);
      return;
    }
    if (currentPage.id === navigation.pageId) return;
    view.pageIndex.unpinPage(navigation.pageId, "navigation", app.state.blocks, app.state.currentBlockId);
    view.pageIndex.pinPage(currentPage.id, "navigation");
    navigationPin = { threadId: navigation.threadId, pageId: currentPage.id };
    pendingNavigation = { ...navigation, pageId: currentPage.id, scrolled: false };
  };

  /**
   * Pins one page for selection and records whether the renderer must refresh it first.
   *
   * @param view - Active transcript view owning the page.
   * @param pageId - Identifier of the page to pin.
   * @param wasMounted - Whether the page was already rendered before pinning.
   * @returns Nothing; pin and refresh bookkeeping are updated in place.
   */
  const pinSelectionPage = (view: TranscriptViewState, pageId: string, wasMounted: boolean) => {
    if (selectionPins.has(pageId)) return;
    if (!view.pageIndex.pinPage(pageId, "selection")) return;
    selectionPins.add(pageId);
    if (!wasMounted) pendingSelectionRefreshPages.add(pageId);
  };

  /**
   * Resolves a screen-space row to a mounted or geometrically inferred transcript page.
   *
   * @param scrollBox - Transcript scroll container.
   * @param y - Screen-space row to resolve.
   * @returns The page identifier at the row, or `null` when the row is outside the viewport.
   */
  const pageAtScreenY = (scrollBox: ScrollBoxRenderable, y: number): string | null => {
    const viewportTop = scrollBox.viewport.y;
    const viewportBottom = viewportTop + scrollBox.viewport.height;
    if (y < viewportTop || y >= viewportBottom) return null;
    for (const pageId of mountedPageIds()) {
      const renderable = scrollBox.content.findDescendantById(`${TRANSCRIPT_PAGE_ID_PREFIX}${pageId}`);
      if (renderable && y >= renderable.y && y < renderable.y + renderable.height) return pageId;
    }
    geometryRevision();
    if (geometry.pageCount === 0) return null;
    const contentY = Math.max(0, scrollBox.scrollTop + (y - scrollBox.y));
    return geometry.pageAtOffset(contentY)?.pageId ?? null;
  };

  /**
   * Captures a precise block-relative anchor from the mounted content at the viewport top.
   *
   * @param scrollBox - Transcript scroll container containing mounted page renderables.
   * @returns A page or block anchor, or `null` when no mounted page crosses the viewport top.
   */
  const anchorFromMountedPage = (scrollBox: ScrollBoxRenderable): TranscriptScrollAnchor | null => {
    const viewportTop = scrollBox.viewport.y;
    for (const pageId of mountedPageIds()) {
      const renderable = scrollBox.content.findDescendantById(`${TRANSCRIPT_PAGE_ID_PREFIX}${pageId}`);
      if (!renderable || viewportTop < renderable.y || viewportTop >= renderable.y + renderable.height) continue;
      const page = pageById(pageId);
      if (page) {
        for (const blockId of page.blockIds) {
          const blockRenderable = renderable.findDescendantById(`${TRANSCRIPT_BLOCK_ID_PREFIX}${blockId}`);
          if (
            blockRenderable &&
            viewportTop >= blockRenderable.y &&
            viewportTop < blockRenderable.y + blockRenderable.height
          ) {
            return {
              pageId,
              offset: viewportTop - renderable.y,
              blockId,
              blockOffset: viewportTop - blockRenderable.y,
            };
          }
        }
      }
      return { pageId, offset: viewportTop - renderable.y };
    }
    return null;
  };

  /**
   * Reconciles page pins for the current selection range while enforcing the configured page cap.
   *
   * @param selection - Current renderer selection.
   * @param scrollBox - Transcript scroll container used to infer page boundaries.
   * @param view - Active transcript view owning the pages.
   * @returns Nothing; selection pins and overflow state are updated in place.
   */
  const pinSelectionRange = (selection: Selection, scrollBox: ScrollBoxRenderable, view: TranscriptViewState): void => {
    const mountedBeforePin = mountedPageIds();
    const selectedPageIds = new Set<string>();
    for (const renderable of [...selection.selectedRenderables, ...selection.touchedRenderables]) {
      const pageId = pageIdFromRenderable(renderable);
      if (pageId) selectedPageIds.add(pageId);
    }
    const anchorPage = pageAtScreenY(scrollBox, selection.anchor.y);
    const focusPage = pageAtScreenY(scrollBox, selection.focus.y);
    if (anchorPage) selectedPageIds.add(anchorPage);
    if (focusPage) selectedPageIds.add(focusPage);

    geometryRevision();
    const selectedIndexes = [...selectedPageIds]
      .map((pageId) => geometry.pageIndex(pageId))
      .filter((index) => index >= 0);
    if (selectedIndexes.length === 0) return;
    let start = Math.min(...selectedIndexes);
    let end = Math.max(...selectedIndexes);
    const viewportTop = scrollBox.viewport.y;
    const viewportBottom = viewportTop + scrollBox.viewport.height;
    if (selection.isDragging && selection.focus.y <= viewportTop + 1) start = Math.max(0, start - 1);
    if (selection.isDragging && selection.focus.y >= viewportBottom - 1) {
      end = Math.min(geometry.pageCount - 1, end + 1);
    }
    const nextPinnedPageIds = new Set<string>();
    for (let index = start; index <= end; index += 1) {
      const pageId = geometry.pageIdAt(index);
      if (pageId) nextPinnedPageIds.add(pageId);
    }
    if (nextPinnedPageIds.size > (props.selectionPinPageLimit ?? MAX_SELECTION_PIN_PAGES)) {
      selectionOverflowed = true;
      return;
    }
    selectionOverflowed = false;
    const releasedPageIds = [...selectionPins].filter((pageId) => !nextPinnedPageIds.has(pageId));
    if (releasedPageIds.length > 0) {
      view.pageIndex.unpinPages(releasedPageIds, "selection", app.state.blocks, app.state.currentBlockId);
      for (const pageId of releasedPageIds) {
        selectionPins.delete(pageId);
        pendingSelectionRefreshPages.delete(pageId);
      }
    }
    for (let index = start; index <= end; index += 1) {
      const pageId = geometry.pageIdAt(index);
      if (pageId) pinSelectionPage(view, pageId, mountedBeforePin.has(pageId));
    }
  };

  /**
   * Samples renderer selection state, refreshes newly mounted pages, and completes deferred copies.
   *
   * @param scrollBox - Transcript scroll container used for page and renderable lookup.
   * @param view - Active transcript view owning selection-pinned pages.
   * @returns Nothing; selection state and deferred copy work are advanced in place.
   */
  const sampleSelection = (scrollBox: ScrollBoxRenderable, view: TranscriptViewState) => {
    if (!renderer || disposed) return;
    const selectionIsStale =
      selectionThreadId !== null &&
      (selectionThreadId !== app.state.activeThreadId ||
        selectionGeneration !== view.transcriptGeneration ||
        [...selectionPins].some((pageId) => !view.pageIndex.pageById(pageId)) ||
        pendingSelectionCompletion?.blockIds.some((blockId) => !view.pageIndex.pageForBlock(blockId)) === true ||
        (pendingSelectionCompletion !== null &&
          view.pageIndex.revisionChangeSince(pendingSelectionCompletion.pageIndexRevision).structural));
    if (selectionIsStale) {
      renderer.clearSelection();
      completedSelection = null;
      releaseSelectionPins();
    }
    const selection = renderer.getSelection();
    if (!selection) {
      completedSelection = null;
      if (selectionWasPresent && !pendingSelectionCompletion) releaseSelectionPins();
      return;
    }
    if (pendingSelectionCompletion && !isSameSelectionAttempt(selection, pendingSelectionCompletion.selection)) {
      releaseSelectionPins();
      completedSelection = null;
      selectionWasPresent = true;
      selectionThreadId = app.state.activeThreadId;
      selectionGeneration = view.transcriptGeneration;
    }
    if (selection === completedSelection) return;
    completedSelection = null;
    selectionWasPresent = true;
    selectionThreadId = app.state.activeThreadId;
    selectionGeneration = view.transcriptGeneration;
    pinSelectionRange(selection, scrollBox, view);

    if (pendingSelectionRefreshPages.size > 0) {
      const ready = [...pendingSelectionRefreshPages].every((pageId) =>
        Boolean(scrollBox.content.findDescendantById(`${TRANSCRIPT_PAGE_ID_PREFIX}${pageId}`)),
      );
      if (ready) {
        const focusPageId = pageAtScreenY(scrollBox, selection.focus.y);
        const focusRenderable = focusPageId
          ? scrollBox.content.findDescendantById(`${TRANSCRIPT_PAGE_ID_PREFIX}${focusPageId}`)
          : undefined;
        renderer.updateSelection(focusRenderable, selection.focus.x, selection.focus.y, {
          finishDragging: pendingSelectionCompletion !== null,
        });
        renderer.requestSelectionUpdate();
        if (selectionRefreshPending) {
          pendingSelectionRefreshPages.clear();
          selectionRefreshPending = false;
        } else {
          selectionRefreshPending = true;
        }
      }
    }
    if (pendingSelectionRefreshPages.size === 0 && pendingSelectionCompletion) {
      const completion = pendingSelectionCompletion;
      const currentSelection = renderer.getSelection();
      pendingSelectionCompletion = null;
      if (
        completion.threadId !== app.state.activeThreadId ||
        completion.transcriptGeneration !== view.transcriptGeneration ||
        !currentSelection ||
        !isSameSelectionAttempt(currentSelection, completion.selection)
      ) {
        releaseSelectionPins();
        return;
      }
      completedSelection = currentSelection;
      completion.copy(currentSelection);
      releaseSelectionPins();
    }
  };

  const selectionCoordinator: TranscriptSelectionCoordinator = {
    /**
     * Defers selection completion until all selected transcript pages are mounted and refreshed.
     *
     * @param selection - Current renderer selection to complete.
     * @param copy - Callback invoked when the stabilized selection is ready to copy.
     * @returns The selection completion disposition.
     */
    completeSelection(selection, copy) {
      const scrollBox = scrollBoxRef();
      const view = activeView();
      if (mode() !== "windowed" || !scrollBox || !view) return "not-handled";
      selectionThreadId = app.state.activeThreadId;
      selectionGeneration = view.transcriptGeneration;
      selectionWasPresent = true;
      pinSelectionRange(selection, scrollBox, view);
      if (selectionOverflowed) {
        renderer?.clearSelection();
        releaseSelectionPins();
        return "too-large";
      }
      if (selectionPins.size === 0) return "not-handled";
      const blockIds = [
        ...new Set(
          [...selection.selectedRenderables, ...selection.touchedRenderables]
            .map((renderable) => blockIdFromRenderable(renderable))
            .filter((blockId): blockId is string => blockId !== null),
        ),
      ];
      pendingSelectionCompletion = {
        threadId: app.state.activeThreadId,
        transcriptGeneration: view.transcriptGeneration,
        pageIndexRevision: view.pageIndex.revision,
        blockIds,
        selection,
        copy,
      };
      for (const pageId of selectionPins) pendingSelectionRefreshPages.add(pageId);
      selectionRefreshPending = false;
      return "deferred";
    },
    /**
     * Cancels measurement and interaction work before a thread leaves the active view.
     *
     * @param threadId - Identifier of the thread being deactivated.
     * @returns Nothing; transient renderer state is cleared in place.
     */
    beforeThreadDeactivate(threadId) {
      store.threadTranscriptViews.get(threadId)?.cancelMeasurementWork();
      completedSelection = null;
      releaseNavigationPin(threadId);
      releaseSelectionPins();
      renderer?.clearSelection();
    },
    /**
     * Records the stored anchor that should be restored after a thread becomes active.
     *
     * @param threadId - Identifier of the thread being activated.
     * @returns Nothing; activation state is prepared for the next frame.
     */
    afterThreadActivate(threadId) {
      activationPending = true;
      pendingActivationAnchor = store.threadTranscriptViews.get(threadId)?.scrollAnchor() ?? null;
      activeThreadId = threadId;
    },
    /**
     * Releases selection, navigation, and renderer state owned by the coordinator.
     *
     * @returns Nothing; transient resources are cleared in place.
     */
    dispose() {
      completedSelection = null;
      releaseNavigationPin();
      releaseSelectionPins();
      renderer?.clearSelection();
    },
  };

  if (mode() === "windowed") props.onSelectionCoordinatorChange?.(selectionCoordinator);

  /**
   * Measures stable mounted pages and schedules anchor restoration when their heights change.
   *
   * @param scrollBox - Transcript scroll container containing mounted page renderables.
   * @param view - Active transcript view receiving committed measurements.
   * @param wasAtBottom - Whether the viewport was following the transcript tail before measurement.
   * @returns Nothing; current measurements and pending anchor restoration are updated in place.
   */
  const measureMountedPages = (scrollBox: ScrollBoxRenderable, view: TranscriptViewState, wasAtBottom: boolean) => {
    const width = Math.max(1, scrollBox.viewport.width);
    const candidates = [...mountedPageIds()]
      .flatMap((pageId) => pageById(pageId) ?? [])
      .filter((page) => {
        const containsUnstableBlock = page.blockIds.some((blockId) => {
          const block = app.blockEntry(blockId)?.block;
          return block ? !isTranscriptBlockStable(block, app.state.currentBlockId) : false;
        });
        if (containsUnstableBlock) return false;
        const measurement = page.measurement;
        return (
          !measurement ||
          measurement.transcriptGeneration !== view.transcriptGeneration ||
          measurement.measurementGeneration !== view.measurementGeneration ||
          measurement.layoutEpoch !== view.layoutEpoch ||
          measurement.width !== width ||
          page.reopened
        );
      });
    if (candidates.length === 0) return;
    const anchor = wasAtBottom ? null : (anchorFromMountedPage(scrollBox) ?? anchorAtScroll(scrollBox.scrollTop));
    const measurementToken = view.measurementToken();
    let changed = false;
    for (const page of candidates) {
      const renderable = scrollBox.content.findDescendantById(`${TRANSCRIPT_PAGE_ID_PREFIX}${page.id}`);
      if (!renderable || renderable.height <= 0) continue;
      const userBlockOffsets: Record<string, number> = {};
      const blockOffsets: Record<string, number> = {};
      for (const blockId of page.blockIds) {
        const blockRenderable = renderable.findDescendantById(`${TRANSCRIPT_BLOCK_ID_PREFIX}${blockId}`);
        if (blockRenderable) blockOffsets[blockId] = Math.max(0, blockRenderable.y - renderable.y);
        const block = app.blockEntry(blockId)?.block;
        if (block?.type !== "user") continue;
        const userRenderable = renderable.findDescendantById(`${USER_BLOCK_ID_PREFIX}${blockId}`);
        if (userRenderable) userBlockOffsets[blockId] = Math.max(0, userRenderable.y - renderable.y);
      }
      const previousHeight = transcriptPageHeight(page);
      const committed = view.commitPageMeasurement(
        page.id,
        { width, height: renderable.height, userBlockOffsets, blockOffsets },
        measurementToken,
        page.layoutRevision,
      );
      if (committed && previousHeight !== renderable.height) changed = true;
    }
    if (changed && anchor && !pendingAnchorRestore) pendingAnchorRestore = anchor;
  };

  /**
   * Restores pending anchors, captures the current anchor, and synchronizes the visible page window.
   *
   * @param scrollBox - Transcript scroll container whose position and viewport define the window.
   * @param view - Active transcript view storing window and anchor state.
   * @param wasAtBottom - Whether tail-following should be preserved.
   * @returns Nothing; scroll, anchor, and window state are synchronized in place.
   */
  const syncWindow = (scrollBox: ScrollBoxRenderable, view: TranscriptViewState, wasAtBottom: boolean) => {
    geometryRevision();
    let preserveBottom = wasAtBottom;
    if (activationPending) {
      activationPending = false;
      const activationAnchor = pendingActivationAnchor;
      pendingActivationAnchor = null;
      if (activationAnchor) {
        const restored = scrollToAnchor(activationAnchor);
        if (restored !== null) {
          scrollBox.scrollTop = restored;
          preserveBottom = false;
        }
      } else {
        scrollBox.scrollTop = Math.max(0, geometry.totalHeight - scrollBox.viewport.height);
        preserveBottom = true;
      }
    }
    if (pendingAnchorRestore && !preserveBottom) {
      const restored = scrollToAnchor(pendingAnchorRestore);
      pendingAnchorRestore = null;
      if (restored !== null) scrollBox.scrollTop = restored;
    }
    let anchor = preserveBottom ? null : anchorAtScroll(scrollBox.scrollTop);
    const storedAnchor = view.scrollAnchor();
    if (anchor && !anchor.blockId && storedAnchor?.blockId) {
      const storedBlockPage = view.pageIndex.pageForBlock(storedAnchor.blockId);
      if (storedBlockPage?.id === anchor.pageId)
        anchor = { ...storedAnchor, pageId: anchor.pageId, offset: anchor.offset };
    }
    if (anchor) view.setScrollAnchor(anchor);
    else if (preserveBottom) view.setScrollAnchor(null);
    const nextWindow = geometry.calculateWindow({
      scrollTop: scrollBox.scrollTop,
      viewportHeight: scrollBox.viewport.height,
      overscanPages: TRANSCRIPT_OVERSCAN_PAGES,
    });
    const currentWindow = view.window();
    if (currentWindow?.startPageId !== nextWindow?.startPageId || currentWindow?.endPageId !== nextWindow?.endPageId) {
      if (anchor) pendingAnchorRestore = anchor;
      view.setWindow(nextWindow);
    }
  };

  /**
   * Advances windowed transcript measurement, layout, navigation, selection, and scroll state for one frame.
   *
   * @returns Nothing; renderer and transcript view state are synchronized in place.
   */
  const trackFrame = () => {
    const scrollBox = scrollBoxRef();
    if (!scrollBox) return;
    if (scrollTop() !== scrollBox.scrollTop) setScrollTop(scrollBox.scrollTop);
    if (viewportHeight() !== scrollBox.viewport.height) setViewportHeight(scrollBox.viewport.height);
    if (viewportWidth() !== scrollBox.viewport.width) setViewportWidth(scrollBox.viewport.width);
    if (mode() !== "windowed") return;
    const view = activeView();
    if (!view) return;
    const uiConfig = getConfig().ui;
    if (
      view.applyLayoutProjection(
        {
          width: scrollBox.viewport.width,
          detailsExpanded: false,
          showThinking: uiConfig.show_thinking,
          thinkingPreviewLines: uiConfig.thinking_preview_lines,
          toolPreviewLines: uiConfig.tool_result_preview_lines,
          succinctToolResults: uiConfig.succinct_tool_results,
          toolCallGroupsKey: toolCallGroupLayoutKey(toolCallGroups(), app.state.expandedToolCallGroups),
          toolCallGroupRoles: toolCallGroupLayoutRoles(toolCallGroups(), app.state.expandedToolCallGroups),
        },
        app.state.blocks,
        app.state.currentBlockId,
      )
    ) {
      pendingAnchorRestore ??= view.scrollAnchor();
      lastTrackedFrameKey = "";
      return;
    }
    if (!viewportReady()) {
      view.ensureLayoutKey(layoutKeyForWidth(scrollBox.viewport.width));
      setViewportReady(true);
    }
    if (activeThreadId !== app.state.activeThreadId) {
      releaseNavigationPin(activeThreadId);
      activeThreadId = app.state.activeThreadId;
      releaseSelectionPins();
      activationPending = true;
      pendingActivationAnchor = view.scrollAnchor();
    }
    reconcilePendingNavigation(view);
    const selectionActive =
      Boolean(renderer?.getSelection()) || selectionWasPresent || pendingSelectionCompletion !== null;
    const frameKey = `${activeThreadId}:${scrollBox.scrollTop}:${scrollBox.viewport.width}:${scrollBox.viewport.height}:${view.pageIndex.revision}:${view.layoutEpoch}:${view.measurementGeneration}`;
    if (
      frameKey === lastTrackedFrameKey &&
      !selectionActive &&
      !activationPending &&
      !pendingAnchorRestore &&
      !pendingNavigation
    ) {
      return;
    }
    lastTrackedFrameKey = frameKey;
    const maxScroll = Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height);
    const wasAtBottom = scrollBox.scrollTop >= maxScroll - 1;
    if (anchorRevisionView !== view) {
      anchorRevisionView = view;
      anchorRevision = view.pageIndex.revision;
    } else if (anchorRevision !== view.pageIndex.revision) {
      const change = view.pageIndex.revisionChangeSince(anchorRevision);
      anchorRevision = change.revision;
      const storedAnchor = view.scrollAnchor();
      if (change.structural && !wasAtBottom && storedAnchor && !pendingAnchorRestore) {
        pendingAnchorRestore = storedAnchor;
      }
    }
    measureMountedPages(scrollBox, view, wasAtBottom);
    syncWindow(scrollBox, view, wasAtBottom);
    if (pendingNavigation?.scrolled) {
      releaseNavigationPin();
    } else if (pendingNavigation) {
      const target = scrollBox.content.findDescendantById(pendingNavigation.targetId);
      if (target) {
        const scrollToTarget = () => {
          const currentTargetId = pendingNavigation?.targetId ?? target.id;
          if (!scrollBox.content.findDescendantById(currentTargetId)) return;
          scrollBox.scrollChildIntoView(currentTargetId);
          // The page pin changes the virtual layout revision. Record the post-scroll
          // anchor so the next revision preserves this viewport instead of restoring
          // the pre-navigation anchor (often the transcript top).
          pendingAnchorRestore = null;
          const navigationAnchor = anchorFromMountedPage(scrollBox) ?? anchorAtScroll(scrollBox.scrollTop);
          if (navigationAnchor) view.setScrollAnchor(navigationAnchor);
        };
        scrollToTarget();
        requestAnimationFrame(scrollToTarget);
        // Keep the navigation pin while selection moves within this page. Releasing it
        // after every block can trigger a structural reflow that restores the viewport
        // anchor to the top of the transcript.
        const navigation = pendingNavigation;
        if (navigation.retainPin) {
          pendingNavigation = null;
        } else {
          // Let the window recalculate once with the target mounted before releasing
          // the temporary sticky-prompt pin.
          pendingNavigation = { ...navigation, scrolled: true };
        }
      }
    }
    sampleSelection(scrollBox, view);
  };

  const stickyResult = createMemo<StickyPromptResult>(() => {
    const maxLines = stickyMaxLines();
    if (maxLines <= 0) return EMPTY_STICKY_PROMPT_RESULT;
    if (mode() === "windowed") {
      const view = activeView();
      if (!view) return EMPTY_STICKY_PROMPT_RESULT;
      geometryRevision();
      return stickyIndex.find(
        (blockId) => app.blockEntry(blockId)?.block,
        pages(),
        view.pageIndex,
        geometry,
        scrollTop(),
        maxLines,
      );
    }
    const currentScrollBox = scrollBoxRef();
    if (!currentScrollBox) return EMPTY_STICKY_PROMPT_RESULT;
    void scrollTop();
    return findStickyUserBlock(app.state.blocks, currentScrollBox, maxLines);
  });

  const scrollToStickyBlock = () => {
    const block = stickyResult().block;
    const scrollBox = scrollBoxRef();
    if (!block || !scrollBox) return;
    if (mode() === "windowed") {
      const view = activeView();
      const page = view?.pageIndex.pageForBlock(block.id);
      if (view && page && !mountedPageIds().has(page.id)) {
        view.pageIndex.pinPage(page.id, "navigation");
        navigationPin = { threadId: app.state.activeThreadId, pageId: page.id };
        pendingNavigation = {
          threadId: app.state.activeThreadId,
          transcriptGeneration: view.transcriptGeneration,
          pageId: page.id,
          blockId: block.id,
          targetId: `${USER_BLOCK_ID_PREFIX}${block.id}`,
          retainPin: false,
          scrolled: false,
        };
        return;
      }
    }
    scrollBox.scrollChildIntoView(`${USER_BLOCK_ID_PREFIX}${block.id}`);
  };

  createEffect(() => {
    const blockId = app.state.transcriptSelectedBlockId;
    if (!blockId) {
      untrack(() => releaseNavigationPin());
      return;
    }
    const scrollBox = scrollBoxRef();
    if (!scrollBox) return;
    untrack(() => {
      const targetId = `${TRANSCRIPT_NAV_BLOCK_ID_PREFIX}${blockId}`;
      if (mode() === "windowed") {
        const view = activeView();
        const page = view?.pageIndex.pageForBlock(canonicalBlockIdForTranscriptRow(blockId));
        if (view && page) {
          const reuseNavigationPin =
            navigationPin?.threadId === app.state.activeThreadId && navigationPin.pageId === page.id;
          if (!reuseNavigationPin) releaseNavigationPin();
          if (!reuseNavigationPin && !mountedPageIds().has(page.id)) {
            view.pageIndex.pinPage(page.id, "navigation");
            navigationPin = { threadId: app.state.activeThreadId, pageId: page.id };
          }
          pendingNavigation = {
            threadId: app.state.activeThreadId,
            transcriptGeneration: view.transcriptGeneration,
            pageId: page.id,
            blockId,
            targetId,
            retainPin: true,
            scrolled: false,
          };
          return;
        }
      }
      if (scrollBox.content.findDescendantById(targetId)) scrollBox.scrollChildIntoView(targetId);
    });
  });

  const unsubscribeConfig = subscribeConfig((change) => {
    setStickyMaxLines(change.config.ui.sticky_prompt_header_lines);
    setToolCallGroupsConfig(change.config.ui.tool_call_groups);
    const ui = change.config.ui;
    setLayoutConfigKey(
      `${ui.show_thinking}:${ui.thinking_preview_lines}:${ui.tool_result_preview_lines}:${ui.succinct_tool_results}`,
    );
  });

  createEffect(() => {
    if (mode() !== "windowed") return;
    const view = activeView();
    if (!view || !viewportReady()) return;
    if (view.ensureLayoutKey(layoutKeyForWidth(viewportWidth()))) pendingAnchorRestore = view.scrollAnchor();
  });

  createEffect(() => {
    if (isWelcomeOnly()) {
      setScrollBoxRefSignal(null);
      props.onScrollBoxRef?.(null);
    }
  });

  onCleanup(() => {
    disposed = true;
    selectionCoordinator.dispose();
    props.onSelectionCoordinatorChange?.(null);
    setScrollBoxRefSignal(null);
    props.onScrollBoxRef?.(null);
    unsubscribeConfig();
  });

  return (
    <Show
      when={!isWelcomeOnly()}
      fallback={
        <Show
          when={(props.welcomeWidgets?.() ?? []).length > 0}
          fallback={
            <WelcomeScreen
              versionUpdate={props.versionUpdate}
              welcomeAddonWidgets={() => props.welcomeAddonWidgets?.() ?? []}
              onConnectionErrorModalOpenChange={props.onConnectionErrorModalOpenChange}
            />
          }
        >
          <PluginWelcomeScreen widgets={() => props.welcomeWidgets?.() ?? []} />
        </Show>
      }
    >
      <box position="relative" flexGrow={1} flexShrink={1} minHeight={0}>
        <scrollbox
          ref={setScrollBoxRef}
          width="100%"
          height="100%"
          stickyScroll
          stickyStart="bottom"
          scrollbarOptions={{ visible: false }}
          onMouseScroll={handleScrollBoxMouseScroll}
          renderAfter={trackFrame}
        >
          <Show
            when={mode() === "windowed" && activeView()}
            fallback={<For each={app.state.blocks}>{(block) => renderProjectedBlock(block.id)}</For>}
          >
            <For each={renderSegmentKeys()}>
              {(segmentKey) => {
                const segment = () => renderSegment(segmentKey);
                return (
                  <Show when={segment()}>
                    {(currentSegment) => (
                      <Show
                        when={renderSegmentPageId(segmentKey)}
                        fallback={
                          <box
                            id={`${TRANSCRIPT_SPACER_ID_PREFIX}${currentSegment().key}`}
                            width="100%"
                            height={renderSegmentSpacerHeight(segmentKey)}
                            flexShrink={0}
                          />
                        }
                      >
                        {(pageId) => (
                          <Show when={pageById(pageId())}>
                            {(currentPage) => (
                              <box
                                id={`${TRANSCRIPT_PAGE_ID_PREFIX}${pageId()}`}
                                width="100%"
                                flexDirection="column"
                                flexShrink={0}
                              >
                                <For each={currentPage().blockIds}>
                                  {(blockId) => (
                                    <box
                                      id={`${TRANSCRIPT_BLOCK_ID_PREFIX}${blockId}`}
                                      width="100%"
                                      flexDirection="column"
                                      flexShrink={0}
                                    >
                                      {renderIndexedBlock(blockId)}
                                    </box>
                                  )}
                                </For>
                              </box>
                            )}
                          </Show>
                        )}
                      </Show>
                    )}
                  </Show>
                );
              }}
            </For>
          </Show>
        </scrollbox>
        <StickyPromptHeader
          stickyResult={stickyResult}
          maxLines={stickyMaxLines}
          availableWidth={props.availableWidth ?? (() => 80)}
          onJumpToBlock={scrollToStickyBlock}
        />
      </box>
    </Show>
  );
}
