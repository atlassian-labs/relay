import { batch, createSignal } from "solid-js";
import { createStore, produce, type SetStoreFunction, unwrap } from "solid-js/store";
import { createSimpleContext } from "./helper";
import {
  createInitialState,
  type AppState,
  type ChatBlock,
  type QueuedPrompt,
  type ToolBlock,
  type ToolSubagentProgressItem,
  type ToolSubagentState,
} from "../state";
import type { ThreadInfo } from "../../core/threads";
import { store } from "../app/runtime-store";
import { TranscriptViewState } from "../util/transcript-view-state";

export interface AppStateContextValue {
  state: AppState;
  readonly transcriptPagingEnabled: boolean;
  setState: SetStoreFunction<AppState>;
  blockEntry: (id: string) => { readonly block: ChatBlock; readonly index: number } | undefined;
  findToolBlock: (toolCallId: string) => ToolBlock | undefined;
  addBlock: (block: ChatBlock) => void;
  appendBlock: (block: ChatBlock) => void;
  insertBlock: (index: number, block: ChatBlock) => void;
  updateBlock: (id: string, updates: Partial<ChatBlock>) => void;
  appendToBlock: (id: string, text: string) => void;
  removeBlock: (id: string) => void;
  replaceBlocks: (blocks: ChatBlock[]) => void;
  clearBlocks: () => void;
  setCurrentBlockId: (id: string | null) => void;
  setActiveThreadState: (thread: ThreadInfo, blocks: ChatBlock[], pendingQueue?: QueuedPrompt[]) => void;
  cancelController: () => AbortController | null;
  setCancelController: (ctrl: AbortController | null) => void;
}

/**
 * Checks whether a transcript view indexes the same ordered block IDs as canonical state.
 *
 * @param view - Transcript view whose page membership should be inspected.
 * @param blocks - Canonical blocks to compare with the indexed order.
 * @returns `true` when both sources contain the same block IDs in the same order.
 */
function blockIdsMatch(view: TranscriptViewState, blocks: readonly ChatBlock[]): boolean {
  const indexedIds = view.pageIndex.pages().flatMap((page) => page.blockIds);
  return indexedIds.length === blocks.length && indexedIds.every((id, index) => id === blocks[index]?.id);
}

export interface AppStateValueOptions {
  readonly transcriptPagingEnabled?: boolean;
}

function sameSubagentProgressSlot(left: ToolSubagentProgressItem, right: ToolSubagentProgressItem): boolean {
  return left.kind === right.kind && left.toolCallId === right.toolCallId;
}

function subagentParentLayoutChanged(previous: ToolSubagentState | undefined, next: ToolSubagentState): boolean {
  if (!previous) return true;
  if (
    previous.agentName !== next.agentName ||
    previous.background !== next.background ||
    previous.status !== next.status
  ) {
    return true;
  }

  const previousTools = previous.progress.filter((item) => item.kind === "tool");
  const nextTools = next.progress.filter((item) => item.kind === "tool");
  if (
    previousTools.length !== nextTools.length ||
    previousTools.some((item, index) => {
      const nextItem = nextTools[index];
      return item.toolCallId !== nextItem.toolCallId || item.text !== nextItem.text || item.status !== nextItem.status;
    })
  ) {
    return true;
  }

  if (next.status === "running") return false;
  const previousToolCount = previous.blocks?.filter((block) => block.type === "tool").length ?? 0;
  const nextToolCount = next.blocks?.filter((block) => block.type === "tool").length ?? 0;
  return (
    previousToolCount !== nextToolCount ||
    previous.startedAt !== next.startedAt ||
    previous.finishedAt !== next.finishedAt
  );
}

/**
 * Applies bounded progress snapshots without replacing stable progress rows.
 *
 * Message text is not rendered in the parent tool row. Preserving the row and
 * mutating only its text keeps those child deltas from invalidating the parent.
 */
function synchronizeSubagentProgress(
  current: ToolSubagentProgressItem[],
  next: readonly ToolSubagentProgressItem[],
): void {
  const aligned =
    current.length === next.length && current.every((item, index) => sameSubagentProgressSlot(item, next[index]));
  if (!aligned) {
    current.splice(0, current.length, ...next);
    return;
  }
  for (const [index, item] of next.entries()) {
    const existing = current[index];
    const raw = unwrap(item);
    if (unwrap(existing) === raw) continue;
    existing.kind = raw.kind;
    existing.text = raw.text;
    existing.status = raw.status;
    existing.toolCallId = raw.toolCallId;
  }
}

/**
 * Reconciles child conversation blocks by ID while retaining mounted block nodes.
 *
 * Alta snapshots structurally share untouched blocks, so the common streaming
 * path mutates only the active child block instead of replacing the transcript.
 */
function synchronizeSubagentBlocks(current: ChatBlock[], next: readonly ChatBlock[]): void {
  const aligned = current.length === next.length && current.every((block, index) => block.id === next[index]?.id);
  if (aligned) {
    for (const [index, block] of next.entries()) {
      const existing = current[index];
      const raw = unwrap(block);
      if (unwrap(existing) !== raw) Object.assign(existing, raw);
    }
    return;
  }

  const currentById = new Map(current.map((block) => [block.id, block]));
  const ordered = next.map((block) => {
    const existing = currentById.get(block.id);
    const raw = unwrap(block);
    if (!existing) return raw;
    if (unwrap(existing) !== raw) Object.assign(existing, raw);
    return existing;
  });
  current.splice(0, current.length, ...ordered);
}

function synchronizeSubagentState(current: ToolSubagentState, next: ToolSubagentState): void {
  current.invokingToolCallId = next.invokingToolCallId;
  current.childSessionId = next.childSessionId;
  current.parentSessionId = next.parentSessionId;
  current.agentName = next.agentName;
  current.background = next.background;
  current.status = next.status;
  current.startedAt = next.startedAt;
  current.finishedAt = next.finishedAt;
  current.currentBlockId = next.currentBlockId;
  synchronizeSubagentProgress(current.progress, next.progress);

  if (!next.blocks) {
    current.blocks = undefined;
    return;
  }
  if (!current.blocks) current.blocks = [];
  synchronizeSubagentBlocks(current.blocks, next.blocks);
}

function isSubagentOnlyUpdate(
  updates: Partial<ChatBlock>,
): updates is Partial<ToolBlock> & { subagent: ToolSubagentState } {
  const keys = Object.keys(updates);
  return keys.length === 1 && keys[0] === "subagent" && (updates as Partial<ToolBlock>).subagent !== undefined;
}

export function createAppStateValue(cwd: string, options: AppStateValueOptions = {}): AppStateContextValue {
  const transcriptPagingEnabled = options.transcriptPagingEnabled ?? false;
  const [state, setState] = createStore<AppState>(createInitialState(cwd));
  const [cancelController, setCancelController] = createSignal<AbortController | null>(null);
  const blocksById = new Map<string, ChatBlock>();
  const blockIndexById = new Map<string, number>();
  // toolCallId -> id of the last tool block for that call. Maintained by every mutation below.
  const toolBlockIdByCallId = new Map<string, string>();

  /**
   * Rebuilds the canonical block ID and index lookups after transcript structure changes.
   *
   * @param blocks - Blocks in their current canonical transcript order.
   * @returns Nothing; both lookup maps are replaced in place.
   */
  function rebuildBlockLookup(blocks: readonly ChatBlock[]): void {
    blocksById.clear();
    blockIndexById.clear();
    toolBlockIdByCallId.clear();
    for (const [index, block] of blocks.entries()) {
      blocksById.set(block.id, block);
      blockIndexById.set(block.id, index);
      if (block.type === "tool") toolBlockIdByCallId.set(block.toolCallId, block.id);
    }
  }

  function findToolBlock(toolCallId: string): ToolBlock | undefined {
    const id = toolBlockIdByCallId.get(toolCallId);
    const block = id === undefined ? undefined : blockEntry(id)?.block;
    return block?.type === "tool" && block.toolCallId === toolCallId ? block : undefined;
  }

  /**
   * Finds a canonical block and repairs the lookup maps if a cached index no longer matches state.
   *
   * @param id - Block identifier to resolve.
   * @returns The current block and its index, or `undefined` when the block is absent.
   */
  function blockEntry(id: string): { readonly block: ChatBlock; readonly index: number } | undefined {
    let index = blockIndexById.get(id) ?? -1;
    if (index < 0 || state.blocks[index]?.id !== id) {
      rebuildBlockLookup(state.blocks);
      index = blockIndexById.get(id) ?? -1;
    }
    const block = index >= 0 ? state.blocks[index] : undefined;
    return block ? { block, index } : undefined;
  }

  /**
   * Resolves or creates the active thread's derived transcript view when paging is enabled.
   *
   * @returns The active transcript view, or `null` when paging or the active thread is unavailable.
   */
  function activeTranscriptView(): TranscriptViewState | null {
    if (!transcriptPagingEnabled) return null;
    const threadId = state.activeThreadId;
    if (!threadId) return null;
    let view = store.threadTranscriptViews.get(threadId);
    if (!view) {
      view = new TranscriptViewState(state.blocks, state.currentBlockId);
      store.threadTranscriptViews.set(threadId, view);
      rebuildBlockLookup(state.blocks);
    }
    return view;
  }

  /**
   * Appends a block while updating canonical state, lookup maps, and the optional page index together.
   *
   * @param block - Block to append to the canonical transcript.
   * @returns Nothing; all enabled transcript representations are updated atomically.
   */
  function appendBlock(block: ChatBlock) {
    const view = activeTranscriptView();
    const generation = view?.transcriptGeneration;
    const index = state.blocks.length;
    batch(() => {
      // The page index ignores the blocks argument; copying the transcript here made each append O(n).
      if (
        view &&
        generation !== undefined &&
        !view.appendBlock(block, state.blocks, state.currentBlockId, generation)
      ) {
        return;
      }
      // Append in place: replacing the array copied every block through the store proxy.
      setState("blocks", index, block);
      blocksById.set(block.id, block);
      blockIndexById.set(block.id, index);
      if (block.type === "tool") toolBlockIdByCallId.set(block.toolCallId, block.id);
    });
  }

  /**
   * Inserts a block while rebuilding shifted lookups and synchronizing the optional page index.
   *
   * @param index - Zero-based transcript position at which to insert the block.
   * @param block - Block to insert into the canonical transcript.
   * @returns Nothing; all enabled transcript representations are updated atomically.
   */
  function insertBlock(index: number, block: ChatBlock) {
    const view = activeTranscriptView();
    const generation = view?.transcriptGeneration;
    const blocks = [...state.blocks.slice(0, index), block, ...state.blocks.slice(index)];
    batch(() => {
      if (
        view &&
        generation !== undefined &&
        !view.insertBlock(index, block, blocks, state.currentBlockId, generation)
      ) {
        return;
      }
      setState("blocks", blocks);
      rebuildBlockLookup(blocks);
    });
  }

  function updateBlock(id: string, updates: Partial<ChatBlock>) {
    const blockIndex = blockIndexById.get(id) ?? state.blocks.findIndex((block) => block.id === id);
    if (blockIndex < 0) return;
    const previous = blocksById.get(id) ?? state.blocks[blockIndex];
    if (!previous) return;
    const next = { ...previous, ...updates } as ChatBlock;
    const subagentOnly = previous.type === "tool" && isSubagentOnlyUpdate(updates);
    const updatesTranscriptLayout = !subagentOnly || subagentParentLayoutChanged(previous.subagent, updates.subagent);
    const view = activeTranscriptView();
    const generation = view?.transcriptGeneration;
    batch(() => {
      if (
        view &&
        updatesTranscriptLayout &&
        generation !== undefined &&
        !view.updateBlock(id, previous, next, state.blocks, state.currentBlockId, generation)
      ) {
        return;
      }
      if (subagentOnly) {
        setState(
          "blocks",
          blockIndex,
          produce((block) => {
            if (block.type !== "tool") return;
            if (!block.subagent) {
              block.subagent = updates.subagent;
              return;
            }
            synchronizeSubagentState(block.subagent, updates.subagent);
          }),
        );
      } else {
        setState(
          "blocks",
          blockIndex,
          produce((block) => {
            Object.assign(block, updates);
          }),
        );
      }
      blocksById.set(id, next);
      if ("toolCallId" in updates) rebuildBlockLookup(state.blocks);
    });
  }

  function appendToBlock(id: string, text: string) {
    const blockIndex = blockIndexById.get(id) ?? state.blocks.findIndex((candidate) => candidate.id === id);
    if (blockIndex < 0) return;
    const previous = blocksById.get(id) ?? state.blocks[blockIndex];
    if (!previous || !("content" in previous) || typeof previous.content !== "string") return;
    const next = { ...previous, content: previous.content + text } as ChatBlock;
    const view = activeTranscriptView();
    const generation = view?.transcriptGeneration;
    batch(() => {
      if (
        view &&
        generation !== undefined &&
        !view.appendText(id, previous, next, text, state.blocks, state.currentBlockId, generation)
      ) {
        return;
      }
      setState(
        "blocks",
        blockIndex,
        produce((block) => {
          if ("content" in block && typeof block.content === "string") block.content += text;
        }),
      );
      blocksById.set(id, next);
    });
  }

  /**
   * Removes a block from canonical state and the optional page index as one mutation.
   *
   * @param id - Identifier of the block to remove.
   * @returns Nothing; state and derived transcript data are updated together.
   */
  function removeBlock(id: string) {
    const view = activeTranscriptView();
    const generation = view?.transcriptGeneration;
    const blocks = state.blocks.filter((block) => block.id !== id);
    batch(() => {
      if (view && generation !== undefined && !view.removeBlock(id, blocks, state.currentBlockId, generation)) {
        return;
      }
      setState("blocks", blocks);
      if (state.transcriptSelectedBlockId === id) {
        setState("transcriptSelectedRows", id, false);
        setState("transcriptSelectedBlockId", null);
      }
      if (state.transcriptDetailBlockId === id) setState("transcriptDetailBlockId", null);
      rebuildBlockLookup(blocks);
    });
  }

  /**
   * Replaces the complete transcript and rebuilds its lookups and optional page index.
   *
   * @param blocks - Replacement blocks in canonical transcript order.
   * @returns Nothing; canonical and derived transcript state are replaced together.
   */
  function replaceBlocks(blocks: ChatBlock[]) {
    const view = activeTranscriptView();
    batch(() => {
      view?.replaceTranscript(blocks, state.currentBlockId);
      setState("blocks", blocks);
      const blockIds = new Set(blocks.map((block) => block.id));
      if (state.transcriptSelectedBlockId && !blockIds.has(state.transcriptSelectedBlockId)) {
        setState("transcriptSelectedRows", state.transcriptSelectedBlockId, false);
        setState("transcriptSelectedBlockId", null);
      }
      if (state.transcriptDetailBlockId && !blockIds.has(state.transcriptDetailBlockId)) {
        setState("transcriptDetailBlockId", null);
      }
      rebuildBlockLookup(blocks);
    });
  }

  function clearBlocks() {
    replaceBlocks([]);
  }

  /**
   * Updates the active streaming block identifier in canonical state and the optional page index.
   *
   * @param id - Active streaming block identifier, or `null` when no block is active.
   * @returns Nothing; canonical and derived stability state are synchronized in place.
   */
  function setCurrentBlockId(id: string | null) {
    batch(() => {
      setState("currentBlockId", id);
      activeTranscriptView()?.setCurrentBlockId(state.blocks, id);
    });
  }

  function setActiveThreadState(thread: ThreadInfo, blocks: ChatBlock[], pendingQueue: QueuedPrompt[] = []) {
    batch(() => {
      let view = transcriptPagingEnabled ? store.threadTranscriptViews.get(thread.id) : undefined;
      if (transcriptPagingEnabled && !view) {
        view = new TranscriptViewState(blocks, null);
        store.threadTranscriptViews.set(thread.id, view);
      } else if (view && !blockIdsMatch(view, blocks)) {
        view.replaceTranscript(blocks, null);
      }
      setState(
        produce((state) => {
          state.activeThreadId = thread.id;
          state.cwd = thread.cwd;
          state.worktreePath = thread.worktreePath ?? null;
          state.worktreeBranch = thread.worktreeBranch ?? null;
          state.blocks = blocks;
          state.fileChanges = [];
          state.totalUsage = createInitialState(thread.cwd).totalUsage;
          state.lastUsage = null;
          state.contextTokens = null;
          state.turn = 0;
          state.toolCallCount = 0;
          state.generationSeconds = 0;
          state.elapsedSeconds = 0;
          state.latestPromptTitleIntent = null;
          state.statusText = "";
          state.running = thread.status === "running";
          state.spinnerActive = thread.status === "running";
          state.spinnerLabel = "";
          state.currentBlockId = null;
          state.statusHint = null;
          state.transcriptSelectedBlockId = null;
          state.transcriptSelectedRows = {};
          state.transcriptDetailBlockId = null;
          state.expandedToolCallGroups = {};
          state.thinkingLevel = "";
          state.thinkingConfigId = "";
          state.availableThinkingLevels = [];
          state.sessionConfigOptions = [];
          state.pendingQueue = pendingQueue.map((item) => ({
            ...item,
            skill: item.skill ? { ...item.skill } : undefined,
          }));
          state.pendingUserBashResults = [];
          state.userBashMode = false;
          state.userBashRunning = false;
        }),
      );
      rebuildBlockLookup(blocks);
      view?.setCurrentBlockId(blocks, null);
    });
  }

  return {
    state,
    transcriptPagingEnabled,
    setState,
    blockEntry,
    findToolBlock,
    addBlock: appendBlock,
    appendBlock,
    insertBlock,
    updateBlock,
    appendToBlock,
    removeBlock,
    replaceBlocks,
    clearBlocks,
    setCurrentBlockId,
    setActiveThreadState,
    cancelController,
    setCancelController,
  };
}

export const AppStateContext = createSimpleContext<AppStateContextValue>({
  name: "AppState",
  init: () => createAppStateValue(process.cwd()),
});

export const useAppState = AppStateContext.use;
