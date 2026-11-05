/**
 * Thread lifecycle + per-thread ACP wiring.
 *
 * Owns the thread UI adapter, ACP client callbacks, and thread create/select/archive
 * lifecycle. Shared state lives in the runtime store. Cross-controller entrypoints
 * are injected and late-bound because those controllers are constructed
 * after this one. The externally-used functions are returned and destructured in
 * app-root so existing call sites keep working unchanged.
 */

import { batch } from "solid-js";
import {
  type ChatBlock,
  type ElicitationBlock,
  type QueuedPrompt,
  type SessionModeOption,
  type ToolBlock,
  type UserSkillInvocationEcho,
  nextBlockId,
  useApp,
} from "../state";
import type { SlashCommand } from "../autocomplete";
import {
  AcpClient,
  type AcpClientCallbacks,
  type AcpClientOptions,
  type AcpElicitationRequest,
  type AcpElicitationResponse,
  type AcpProcessExitEvent,
  type AcpSessionResult,
  type AcpToolApprovalRequest,
} from "../../acp/client";
import {
  ApprovalResponse,
  isApprovalOptionAllow,
  isApprovalSelectionAllow,
  type ApprovalSelection,
} from "../../core/events";
import { restoredLiveSessionMessageBlocks } from "../../core/live-sessions";
import type { PromptInput } from "../../core/prompt-submission";
import {
  additionalDirectoriesForThread,
  archiveRelayWorktree,
  createRelaySessionId,
  createRelayWorktree,
  relaySessionNameFromId,
  threadRelaySessionName,
  listGitWorktrees,
  type ThreadInfo,
  type ThreadRelationKind,
} from "../../core/threads";
import { type NotificationContext, notify } from "../../notify";
import { normalizeAgentLifecycleEvent, type RelayAcpActivityKind } from "../../plugins";
import { applyAcpSessionUpdate, findLastToolBlock } from "../../application/acp-mapping";
import type { RelaySessionUpdate } from "../../acp/sdk";
import { parseAltaSubagentMetadata } from "../../acp/subagents";
import {
  acpClientOptionsForAgent,
  addUnexpectedAcpProcessExitBlock,
  resolveAcpLaunchAgent,
  resolveAgentBehaviorProfileForLaunchAgent,
} from "../../application/acp-orchestration";
import { getConfig, setConfigValue } from "../../config";
import { getConfigSettingByAcpOptionId } from "../../config/schema";
import { mergeSessionCapabilities, store } from "./runtime-store";
import { writeCachedAgentCommands } from "./agent-command-cache";
import { emitPluginEvent, getPluginRunner, hasPluginBlockEventListeners, withPluginMcpServers } from "./plugin-runtime";
import { pluginEventsFromBlockTransition, snapshotPluginBlocks, type PluginEventContext } from "./plugin-events";
import { persistThreads, syncCurrentThreadSession, syncCurrentThreadStatus, updateThread } from "./thread-metadata";
import {
  acpAuthRequiredBlockContent,
  applyAcpClientCapabilities,
  applyPreferredModelForNewSession,
  applyPreferredThinkingLevelForNewSession,
  connectAcpClientWithTimeout,
  markAcpAuthRequired,
} from "./acp-client-controller";
import { stopStartupTips } from "./status-indicators";
import {
  agentSlashSkillInvocationEcho as buildAgentSlashSkillInvocationEcho,
  shouldPreferNativeSlashCommand as shouldPreferNativeSlashCommandForState,
  slashCommandName,
} from "./slash-commands";
import {
  isPromptDispatchReserved,
  releaseCurrentPromptDispatch,
  releasePromptDispatch,
  reservePromptDispatch,
  type PromptDispatchReservation,
} from "./prompt-dispatch";
import {
  addWelcomeBlocks,
  applySessionCapabilities,
  applySessionConfigOptionUpdate,
  resetSessionState,
  sessionCapabilitiesWithConfigOptionUpdate,
  type ApplySessionCapabilitiesOptions,
  type SessionCapabilitiesResult,
} from "../context/session";
import { fieldsFromElicitationSchema } from "../util/elicitation-schema";
import { elicitationNotificationSummary } from "../util/elicitation-notification";
import { compactPreviewText, isRunningPreviewBlock, previewFromBlocks } from "../util/thread-preview";
import {
  queuedPromptToInput,
  queuedPromptToText,
  restoreEditingQueuedPrompt as restoreEditingQueuedPromptState,
} from "../util/prompt-queue";
import { sessionLoadStatus } from "./session-load-status";
import { stopTurnTimer } from "./turn-timer";
import type { PromptSubmissionOptions } from "./submit-controller";
import type { ThreadQueueStore } from "./thread-queue";
import { withLiveSessionEnv } from "./live-session-runtime";
import { TranscriptViewState } from "../util/transcript-view-state";

type App = ReturnType<typeof useApp>;
type LoadedHistory = Awaited<ReturnType<AcpClient["loadSessionHistory"]>>;
type ThreadSessionStart = { client: AcpClient; result?: AcpSessionResult };

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function sessionCommand(value: unknown): SlashCommand | null {
  const entry = recordValue(value);
  if (!entry || typeof entry.name !== "string" || !entry.name) return null;
  return {
    name: entry.name,
    description: typeof entry.description === "string" ? entry.description : "",
    origin: "agent",
    kind: "unknown",
    invocation: { syntax: "slash", composable: false },
    ...(Object.prototype.hasOwnProperty.call(entry, "input") ? { input: entry.input } : {}),
    ...(recordValue(entry.meta ?? entry._meta) ? { meta: (entry.meta ?? entry._meta) as Record<string, unknown> } : {}),
  };
}

function sessionCommands(value: unknown): SlashCommand[] | null {
  return Array.isArray(value) ? value.flatMap((entry) => sessionCommand(entry) ?? []) : null;
}

function hasAgentYoloo(commands: readonly SlashCommand[]): boolean {
  return commands.some((command) => command.name.toLowerCase() === "yoloo");
}

export interface CreateThreadOptions {
  readonly snapshotCurrent?: boolean;
  readonly cwd?: string;
  readonly select?: boolean;
  readonly parentThreadId?: string;
  readonly relationKind?: ThreadRelationKind;
  readonly relationGoal?: string;
  readonly title?: string;
  readonly relaySessionName?: string;
  readonly childTaskType?: string;
  readonly agentName?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
}

export interface ThreadControllerDeps {
  threadQueue: ThreadQueueStore;
  queueFocusIndex?: () => number | null;
  setQueueFocusIndex: (value: number | null) => void;
  clearQueueInteraction: () => void;
  editingQueueItem: () => QueuedPrompt | null;
  restoreEditingQueuedPromptForSnapshot?: (app: App) => boolean;
  setWelcomeDismissed: (value: boolean) => void;
  refreshOpenSlashAutocomplete: () => void;
  refreshSlashAutocompleteForCommandUpdate?: () => void;
  gitWatcherSetCwd: (cwd: string) => void;
  abortAndClearUserBash: () => void;
  beforeThreadDeactivate?: (threadId: string) => void;
  afterThreadActivate?: (threadId: string) => void;
  // Late-bound: provided by controllers constructed after this one.
  loadSessionHistory: (
    client: AcpClient,
    threadId: string,
    sessionId: string,
    cwd: string,
    additionalDirectories?: readonly string[],
    onHistoryReady?: (updates: readonly RelaySessionUpdate[]) => void,
  ) => Promise<LoadedHistory>;
  replayLoadedSessionUpdates: (
    app: App,
    threadId: string,
    updates: readonly RelaySessionUpdate[],
    finalize?: boolean,
  ) => void;
  submitPromptToAgent: (
    input: PromptInput,
    app: App,
    queuePlacement?: "in-place" | "end",
    options?: PromptSubmissionOptions,
  ) => Promise<void>;
}

export function createThreadController(deps: ThreadControllerDeps) {
  const clientStartByThread = new Map<string, Promise<ThreadSessionStart>>();
  const blockIndicesByThread = new Map<string, Map<string, number>>();
  /** Indices of running blocks per inactive transcript array, so the preview doesn't rescan it on every chunk. */
  const runningIndicesByBlocks = new WeakMap<readonly ChatBlock[], { indices: Set<number>; last: number }>();
  const sessionStartByThread = new Map<string, Promise<ThreadSessionStart>>();

  const {
    threadQueue,
    queueFocusIndex = () => null,
    setQueueFocusIndex,
    clearQueueInteraction,
    editingQueueItem,
    restoreEditingQueuedPromptForSnapshot: restoreEditingQueuedPromptForSnapshotWithDraft,
    setWelcomeDismissed,
    refreshOpenSlashAutocomplete,
    refreshSlashAutocompleteForCommandUpdate,
    gitWatcherSetCwd,
    abortAndClearUserBash,
    beforeThreadDeactivate,
    afterThreadActivate,
    loadSessionHistory,
    replayLoadedSessionUpdates,
    submitPromptToAgent,
  } = deps;

  function agentNameForThread(thread: ThreadInfo): string {
    return thread.agentName?.trim() || store.activeAgentName || "agent";
  }

  function agentBehaviorProfileForThread(thread: ThreadInfo) {
    const agentName = agentNameForThread(thread);
    if (agentName === store.activeAgentName) return store.activeAgentBehaviorProfile;
    return resolveAgentBehaviorProfileForLaunchAgent(resolveAcpLaunchAgent(agentName));
  }

  function agentBehaviorProfileForThreadId(app: App, threadId: string) {
    const thread = app.state.threads.find((candidate) => candidate.id === threadId);
    return thread ? agentBehaviorProfileForThread(thread) : store.activeAgentBehaviorProfile;
  }

  function baseClientOptionsForThread(thread: ThreadInfo): AcpClientOptions {
    const agentName = agentNameForThread(thread);
    if (agentName === store.activeAgentName) {
      if (!store.activeAcpLaunchOptions) throw new Error("No ACP agent configured"); // effect-shape-allow: thread startup requires initialized ACP launch options.
      return {
        ...store.activeAcpLaunchOptions,
        cwd: thread.cwd,
        agentBehaviorProfile: store.activeAgentBehaviorProfile,
        agentName,
      };
    }
    const agent = resolveAcpLaunchAgent(agentName);
    if (!agent) throw new Error(`No agent runner configured for ${agentName}`); // effect-shape-allow: child startup reports an unavailable configured agent.
    return acpClientOptionsForAgent(agent, thread.cwd, agentBehaviorProfileForThread(thread));
  }

  function resetSessionUi(app: App): void {
    stopTurnTimer();
    stopStartupTips(app, false);
    resetSessionState(app);
    abortAndClearUserBash();
  }

  function pluginEventContext(app: App, threadId: string, raw?: unknown): PluginEventContext | null {
    const thread = app.state.threads.find((item) => item.id === threadId);
    if (!thread) return null;
    return {
      threadId,
      sessionId: threadClient(threadId)?.sessionId ?? thread.sessionId ?? null,
      cwd: thread.cwd,
      ...(raw !== undefined ? { raw } : {}),
    };
  }

  function emitPluginBlockTransitionEvents(
    before: ReturnType<typeof snapshotPluginBlocks> | null,
    app: App,
    threadId: string,
    raw?: unknown,
  ): void {
    if (!before) return;
    const ctx = pluginEventContext(app, threadId, raw);
    if (!ctx) return;
    const after = snapshotPluginBlocks(threadUiAdapter(app, threadId).state.blocks);
    for (const event of pluginEventsFromBlockTransition(before, after, ctx)) emitPluginEvent(event);
  }

  function emitThreadChange(
    app: App,
    thread: ThreadInfo,
    action: "created" | "selected" | "archived" | "updated",
    previousThreadId?: string | null,
  ): void {
    emitPluginEvent({
      type: "thread:change",
      action,
      threadId: thread.id,
      sessionId: threadClient(thread.id)?.sessionId ?? thread.sessionId ?? null,
      cwd: thread.cwd,
      ...(previousThreadId !== undefined ? { previousThreadId } : {}),
    });
  }

  /**
   * Rebuilds the block ID lookup for an inactive thread after a structural transcript change.
   *
   * @param threadId - Thread whose cached block indexes should be replaced.
   * @param blocks - Canonical blocks in their current transcript order.
   * @returns The replacement block ID-to-index map stored for the thread.
   */
  function rebuildInactiveBlockIndices(threadId: string, blocks: readonly ChatBlock[]): Map<string, number> {
    const indices = new Map(blocks.map((block, index) => [block.id, index]));
    blockIndicesByThread.set(threadId, indices);
    return indices;
  }

  /**
   * Resolves a block's current index for an inactive thread and repairs stale cached indexes.
   *
   * @param threadId - Thread whose block index cache should be queried.
   * @param blocks - Canonical blocks used to validate or rebuild the cache.
   * @param blockId - Block identifier to locate.
   * @returns The block's current zero-based index, or `-1` when absent.
   */
  function inactiveBlockIndex(threadId: string, blocks: readonly ChatBlock[], blockId: string): number {
    let indices = blockIndicesByThread.get(threadId);
    if (!indices || indices.size !== blocks.length) indices = rebuildInactiveBlockIndices(threadId, blocks);
    const cachedIndex = indices.get(blockId) ?? -1;
    if (cachedIndex >= 0 && blocks[cachedIndex]?.id === blockId) return cachedIndex;
    return rebuildInactiveBlockIndices(threadId, blocks).get(blockId) ?? -1;
  }

  /**
   * Resolves or creates an inactive thread's derived transcript view when paging is enabled.
   *
   * @param app - Application state adapter that controls the paging rollout.
   * @param threadId - Thread whose transcript view should be resolved.
   * @param blocks - Canonical blocks used when creating a new view.
   * @param currentBlockId - Block currently receiving streamed content, or `null` when no block is active.
   * @returns The thread's transcript view, or `null` when paging is disabled.
   */
  function ensureThreadTranscriptView(
    app: App,
    threadId: string,
    blocks: readonly ChatBlock[],
    currentBlockId: string | null,
  ): TranscriptViewState | null {
    if (!app.transcriptPagingEnabled) return null;
    let view = store.threadTranscriptViews.get(threadId);
    if (!view) {
      view = new TranscriptViewState(blocks, currentBlockId);
      store.threadTranscriptViews.set(threadId, view);
    }
    return view;
  }

  /**
   * Publishes a completed inactive-thread transcript mutation and refreshes its preview.
   *
   * @param threadId - Thread receiving the updated transcript.
   * @param blocks - Replacement canonical block array for the thread.
   * @param changedIndex - The one index changed in place (append or update); omit when positions may have shifted.
   * @returns Nothing; the thread store and preview are updated in place.
   */
  function writeInactiveThreadBlocks(threadId: string, blocks: ChatBlock[], changedIndex?: number): void {
    store.threadBlocks.set(threadId, blocks);
    let running = runningIndicesByBlocks.get(blocks);
    if (!running || changedIndex === undefined) {
      running = { indices: new Set(), last: -1 };
      for (let index = 0; index < blocks.length; index++) {
        if (!isRunningPreviewBlock(blocks[index])) continue;
        running.indices.add(index);
        running.last = index;
      }
      runningIndicesByBlocks.set(blocks, running);
    } else if (isRunningPreviewBlock(blocks[changedIndex])) {
      running.indices.add(changedIndex);
      running.last = Math.max(running.last, changedIndex);
    } else if (running.indices.delete(changedIndex) && changedIndex === running.last) {
      // Only when the latest running block finishes; the set holds just the running blocks.
      running.last = -1;
      for (const index of running.indices) running.last = Math.max(running.last, index);
    }
    updateThreadPreview(threadId, blocks, running.last);
  }

  /**
   * Commits an inactive structural mutation only if the matching page-index update is accepted.
   *
   * @param threadId - Thread receiving the replacement transcript.
   * @param view - Optional derived transcript view synchronized with the mutation.
   * @param expectedGeneration - Page-index generation captured before the mutation, or `null` without paging.
   * @param blocks - Replacement canonical block array.
   * @param updateIndex - Callback that applies the equivalent structural change to the current view.
   * @param appendedIndex - Index of a block pushed in place, or omitted when positions may have shifted.
   * @returns `true` when both canonical and derived state were committed; otherwise `false`.
   */
  function commitInactiveThreadBlocks(
    threadId: string,
    view: TranscriptViewState | null,
    expectedGeneration: number | null,
    blocks: ChatBlock[],
    updateIndex: (currentView: TranscriptViewState) => boolean,
    appendedIndex?: number,
  ): boolean {
    return batch(() => {
      if (
        view &&
        (expectedGeneration === null || view.transcriptGeneration !== expectedGeneration || !updateIndex(view))
      ) {
        return false;
      }
      writeInactiveThreadBlocks(threadId, blocks, appendedIndex);
      return true;
    });
  }

  /**
   * Commits an indexed inactive block update after the corresponding page-index update succeeds.
   *
   * @param threadId - Thread containing the block being updated.
   * @param view - Optional derived transcript view synchronized with the mutation.
   * @param expectedGeneration - Page-index generation captured before the mutation, or `null` without paging.
   * @param blocks - Canonical array, updated in place at `blockIndex` once the page index accepts the change.
   * @param blockIndex - Zero-based position at which to store the updated block.
   * @param next - Replacement block value.
   * @param updateIndex - Callback that applies the equivalent update to the current view.
   * @returns `true` when both canonical and derived state were committed; otherwise `false`.
   */
  function commitInactiveThreadBlockUpdate(
    threadId: string,
    view: TranscriptViewState | null,
    expectedGeneration: number | null,
    blocks: ChatBlock[],
    blockIndex: number,
    next: ChatBlock,
    updateIndex: (currentView: TranscriptViewState) => boolean,
  ): boolean {
    return batch(() => {
      if (
        view &&
        (expectedGeneration === null || view.transcriptGeneration !== expectedGeneration || !updateIndex(view))
      ) {
        return false;
      }
      blocks[blockIndex] = next;
      writeInactiveThreadBlocks(threadId, blocks, blockIndex);
      return true;
    });
  }

  /**
   * Puts back a thread's transcript from before early history was shown, after its session load failed.
   *
   * @param app - App state that owns the thread.
   * @param threadId - Thread whose load failed.
   * @param blocks - Blocks captured before the first early history batch.
   * @returns Nothing; the partial history and its open block are dropped.
   */
  function restoreBlocksBeforeHistory(app: App, threadId: string, blocks: ChatBlock[]): void {
    const adapter = threadUiAdapter(app, threadId);
    batch(() => {
      adapter.setCurrentBlockId(null);
      adapter.replaceBlocks(blocks);
    });
  }

  function threadUiAdapter(app: App, threadId: string) {
    return {
      state: {
        get blocks() {
          return threadId === app.state.activeThreadId ? app.state.blocks : (store.threadBlocks.get(threadId) ?? []);
        },
        get currentBlockId() {
          return threadId === app.state.activeThreadId
            ? app.state.currentBlockId
            : (store.threadCurrentBlockIds.get(threadId) ?? null);
        },
        get cwd() {
          return app.state.threads.find((thread) => thread.id === threadId)?.cwd;
        },
      },
      findToolBlock: (toolCallId: string) =>
        threadId === app.state.activeThreadId
          ? app.findToolBlock(toolCallId)
          : findLastToolBlock(store.threadBlocks.get(threadId) ?? [], toolCallId),
      addBlock: (block: ChatBlock, index?: number) => {
        if (threadId === app.state.activeThreadId) {
          if (index === undefined) app.appendBlock(block);
          else app.insertBlock(index, block);
          return;
        }
        const currentBlocks = store.threadBlocks.get(threadId) ?? [];
        const currentBlockId = store.threadCurrentBlockIds.get(threadId) ?? null;
        const view = ensureThreadTranscriptView(app, threadId, currentBlocks, currentBlockId);
        const generation = view?.transcriptGeneration ?? null;
        // Appends push in place (O(1)); mid-transcript inserts are rare and still copy.
        const previousLength = currentBlocks.length;
        const blocks = index === undefined ? currentBlocks : currentBlocks.toSpliced(index, 0, block);
        if (index === undefined) blocks.push(block);
        const indices = blockIndicesByThread.get(threadId);
        const indicesCurrent = index === undefined && indices?.size === previousLength;
        let committed = false;
        try {
          committed = commitInactiveThreadBlocks(
            threadId,
            view,
            generation,
            blocks,
            (currentView) => {
              const currentGeneration = currentView.transcriptGeneration;
              return index === undefined
                ? currentView.appendBlock(block, blocks, currentBlockId, currentGeneration)
                : currentView.insertBlock(index, block, blocks, currentBlockId, currentGeneration);
            },
            index === undefined ? previousLength : undefined,
          );
        } finally {
          // Undo the in-place push if the view rejected or threw.
          if (!committed && index === undefined) blocks.pop();
        }
        if (committed) {
          if (indicesCurrent && indices) indices.set(block.id, previousLength);
          else rebuildInactiveBlockIndices(threadId, blocks);
        }
      },
      updateBlock: (id: string, updates: Partial<ChatBlock>) => {
        if (threadId === app.state.activeThreadId) {
          app.updateBlock(id, updates);
          return;
        }
        const currentBlocks = store.threadBlocks.get(threadId) ?? [];
        const blockIndex = inactiveBlockIndex(threadId, currentBlocks, id);
        const previous = currentBlocks[blockIndex];
        if (blockIndex < 0 || !previous) return;
        const blocks = currentBlocks;
        const next = { ...previous, ...updates } as ChatBlock;
        const currentBlockId = store.threadCurrentBlockIds.get(threadId) ?? null;
        const view = ensureThreadTranscriptView(app, threadId, currentBlocks, currentBlockId);
        const generation = view?.transcriptGeneration ?? null;
        commitInactiveThreadBlockUpdate(threadId, view, generation, blocks, blockIndex, next, (currentView) =>
          currentView.updateBlock(id, previous, next, blocks, currentBlockId, currentView.transcriptGeneration),
        );
      },
      appendToBlock: (id: string, text: string) => {
        if (threadId === app.state.activeThreadId) {
          app.appendToBlock(id, text);
          return;
        }
        const currentBlocks = store.threadBlocks.get(threadId) ?? [];
        const blockIndex = inactiveBlockIndex(threadId, currentBlocks, id);
        const previous = currentBlocks[blockIndex];
        if (blockIndex < 0 || !previous || !("content" in previous) || typeof previous.content !== "string") return;
        const blocks = currentBlocks;
        const next = { ...previous, content: previous.content + text } as ChatBlock;
        const currentBlockId = store.threadCurrentBlockIds.get(threadId) ?? null;
        const view = ensureThreadTranscriptView(app, threadId, currentBlocks, currentBlockId);
        const generation = view?.transcriptGeneration ?? null;
        commitInactiveThreadBlockUpdate(threadId, view, generation, blocks, blockIndex, next, (currentView) =>
          currentView.appendText(id, previous, next, text, blocks, currentBlockId, currentView.transcriptGeneration),
        );
      },
      /**
       * Removes a block through the active adapter or the inactive thread's synchronized transcript stores.
       *
       * @param id - Identifier of the block to remove.
       * @returns Nothing; canonical and optional derived transcript state are updated together.
       */
      removeBlock: (id: string) => {
        if (threadId === app.state.activeThreadId) {
          app.removeBlock(id);
          return;
        }
        const currentBlocks = store.threadBlocks.get(threadId) ?? [];
        if (!currentBlocks.some((block) => block.id === id)) return;
        const blocks = currentBlocks.filter((block) => block.id !== id);
        const currentBlockId = store.threadCurrentBlockIds.get(threadId) ?? null;
        const view = ensureThreadTranscriptView(app, threadId, currentBlocks, currentBlockId);
        const generation = view?.transcriptGeneration ?? null;
        if (
          commitInactiveThreadBlocks(threadId, view, generation, blocks, (currentView) =>
            currentView.removeBlock(id, blocks, currentBlockId, currentView.transcriptGeneration),
          )
        ) {
          rebuildInactiveBlockIndices(threadId, blocks);
        }
      },
      /**
       * Replaces an active or inactive thread's complete canonical and derived transcript state.
       *
       * @param blocks - Replacement blocks in canonical transcript order.
       * @returns Nothing; canonical and optional derived transcript state are replaced together.
       */
      replaceBlocks: (blocks: ChatBlock[]) => {
        if (threadId === app.state.activeThreadId) {
          app.replaceBlocks(blocks);
          return;
        }
        const currentBlockId = store.threadCurrentBlockIds.get(threadId) ?? null;
        const view = ensureThreadTranscriptView(app, threadId, store.threadBlocks.get(threadId) ?? [], currentBlockId);
        const generation = view?.transcriptGeneration ?? null;
        batch(() => {
          if (view && view.transcriptGeneration !== generation) return;
          view?.replaceTranscript(blocks, currentBlockId);
          writeInactiveThreadBlocks(threadId, blocks);
          rebuildInactiveBlockIndices(threadId, blocks);
        });
      },
      /**
       * Updates an active or inactive thread's streaming block identifier and page stability.
       *
       * @param value - Active streaming block identifier, or `null` when no block is active.
       * @returns Nothing; canonical and optional derived thread state are synchronized in place.
       */
      setCurrentBlockId: (value: string | null) => {
        if (threadId === app.state.activeThreadId) app.setCurrentBlockId(value);
        else {
          store.threadCurrentBlockIds.set(threadId, value);
          ensureThreadTranscriptView(app, threadId, store.threadBlocks.get(threadId) ?? [], value)?.setCurrentBlockId(
            store.threadBlocks.get(threadId) ?? [],
            value,
          );
        }
      },
      onActivity: (activity: { kind: RelayAcpActivityKind; label: string }) => {
        emitPluginEvent({ type: "agent:activity", kind: activity.kind, label: activity.label });
      },
      setState: (...args: unknown[]) => {
        const [key, value] = args;
        if (key === "currentBlockId") {
          if (threadId === app.state.activeThreadId) app.setCurrentBlockId(value as string | null);
          else {
            store.threadCurrentBlockIds.set(threadId, value as string | null);
            ensureThreadTranscriptView(
              app,
              threadId,
              store.threadBlocks.get(threadId) ?? [],
              value as string | null,
            )?.setCurrentBlockId(store.threadBlocks.get(threadId) ?? [], value as string | null);
          }
          return;
        }
        if (key === "running") {
          updateThread(app, threadId, { status: value ? "running" : "paused" });
          if (threadId === app.state.activeThreadId) app.setState("running", value as boolean);
          return;
        }
        if (key === "spinnerActive") {
          if (threadId === app.state.activeThreadId) app.setState("spinnerActive", value as boolean);
          return;
        }
        if (threadId === app.state.activeThreadId) {
          (app.setState as (...stateArgs: unknown[]) => void)(...args);
        }
      },
    };
  }

  function finalizeThreadAfterUnexpectedProcessExit(
    app: App,
    threadId: string,
    event: AcpProcessExitEvent,
    sourceClient: AcpClient | null,
  ): void {
    if (event.expected || event.connected === false) return;
    if (sourceClient && threadClient(threadId) !== sourceClient) return;
    const thread = app.state.threads.find((item) => item.id === threadId && !item.archived);
    if (!thread) return;

    const adapter = threadUiAdapter(app, threadId);
    const message = addUnexpectedAcpProcessExitBlock(adapter, event);
    releaseCurrentPromptDispatch(threadId);
    store.threadPromptRunIds.delete(threadId);
    store.suppressedThreadPromptRunIds.delete(threadId);
    if (!sourceClient || store.threadClients.get(threadId) === sourceClient) store.threadClients.delete(threadId);
    if (!sourceClient || store.acpClient === sourceClient) store.acpClient = null;

    if (threadId === app.state.activeThreadId) app.setState("connecting", false);
    adapter.setState("running", false);
    adapter.setState("spinnerActive", false);
    adapter.setState("spinnerLabel", "");
    if (threadId === app.state.activeThreadId) {
      applyAcpClientCapabilities(app, null);
      stopTurnTimer();
      app.setState("lastAcpActivityKind", null);
      app.setState("lastAcpActivityLabel", "");
      app.setState("lastAcpActivityAt", null);
    } else {
      notify("error", threadNotificationContext(app, threadId, { summary: message }));
    }
    updateThread(app, threadId, { status: "paused", updatedAt: new Date().toISOString() });
  }

  function emitPermissionRequestEvent(app: App, threadId: string, request: AcpToolApprovalRequest): void {
    const ctx = pluginEventContext(app, threadId, request);
    emitPluginEvent({
      type: "permission:request",
      toolName: request.toolName,
      toolCallId: request.toolCallId,
      preview: request.preview,
      options: request.options,
      ...(ctx ? { threadId: ctx.threadId, sessionId: ctx.sessionId, cwd: ctx.cwd } : {}),
    });
  }

  function respondToPermissionRequest(
    app: App,
    threadId: string,
    request: AcpToolApprovalRequest,
    selection: ApprovalSelection,
  ): void {
    const ctx = pluginEventContext(app, threadId, request);
    emitPluginEvent({
      type: "permission:resolved",
      toolName: request.toolName,
      toolCallId: request.toolCallId,
      outcome: isApprovalSelectionAllow(selection) ? "approved" : "denied",
      ...(ctx ? { threadId: ctx.threadId, sessionId: ctx.sessionId, cwd: ctx.cwd } : {}),
    });
    request.respond(selection);
  }

  function renderPermissionRequest(
    app: App,
    threadId: string,
    adapter: ReturnType<typeof threadUiAdapter>,
    request: AcpToolApprovalRequest,
  ): void {
    notify("permission", permissionNotificationContext(app, threadId, request));
    const beforeBlocks = hasPluginBlockEventListeners() ? snapshotPluginBlocks(adapter.state.blocks) : null;
    // Append, don't flip the existing tool block to "approval": findPendingApprovalBlock only notices new blocks.
    adapter.addBlock({
      type: "tool",
      id: nextBlockId(),
      toolCallId: request.toolCallId || nextBlockId(),
      toolName: request.toolName,
      display: request.preview ?? "",
      status: "approval",
      approvalPreview: request.preview,
      approvalOptions: request.options,
      resolveApproval: (selection) => respondToPermissionRequest(app, threadId, request, selection),
    });
    emitPluginBlockTransitionEvents(beforeBlocks, app, threadId, request);
  }

  function permissionSelectionForPluginDecision(
    request: AcpToolApprovalRequest,
    decision: NonNullable<
      Awaited<ReturnType<NonNullable<ReturnType<typeof getPluginRunner>>["handlePermissionRequest"]>>
    >,
  ): ApprovalSelection | null {
    const result = decision.result;
    if (result.action === "deny") return ApprovalResponse.DENY;
    if (result.action === "approve" && !result.optionId) {
      return request.options.find((option) => isApprovalOptionAllow(option)) ?? ApprovalResponse.APPROVE;
    }
    const optionId = result.optionId;
    const option = request.options.find((item) => item.optionId === optionId);
    if (option) return option;
    getPluginRunner()?.recordError(
      decision.plugin,
      `Permission hook selected unknown option "${optionId}" for ${request.toolName}`,
    );
    return null;
  }

  function relayYoloPermissionSelection(request: AcpToolApprovalRequest): ApprovalSelection | null {
    return (
      request.options.find((option) => option.kind === "allow_once") ??
      request.options.find((option) => option.kind === "allow_always") ??
      null
    );
  }

  function addPermissionPolicyBlock(
    adapter: ReturnType<typeof threadUiAdapter>,
    request: AcpToolApprovalRequest,
    decision: NonNullable<
      Awaited<ReturnType<NonNullable<ReturnType<typeof getPluginRunner>>["handlePermissionRequest"]>>
    >,
    selection: ApprovalSelection,
  ): void {
    const allowed = isApprovalSelectionAllow(selection);
    const reason = decision.result.action === "deny" && decision.result.reason ? `: ${decision.result.reason}` : "";
    adapter.addBlock({
      type: "info",
      id: nextBlockId(),
      content: `Plugin ${decision.plugin.name} ${allowed ? "approved" : "denied"} permission for ${request.toolName}${reason}`,
      variant: allowed ? "info" : "warning",
    });
  }

  async function handlePermissionRequest(
    app: App,
    threadId: string,
    adapter: ReturnType<typeof threadUiAdapter>,
    request: AcpToolApprovalRequest,
    isCurrentCallbackClient: () => boolean,
  ): Promise<void> {
    if (!isCurrentCallbackClient()) return;
    emitPermissionRequestEvent(app, threadId, request);
    const ctx = pluginEventContext(app, threadId, request);
    const decision = ctx
      ? await (getPluginRunner()?.handlePermissionRequest({
          threadId: ctx.threadId,
          sessionId: ctx.sessionId,
          cwd: ctx.cwd,
          toolName: request.toolName,
          toolCallId: request.toolCallId,
          preview: request.preview,
          options: request.options,
          raw: request,
        }) ?? Promise.resolve(null))
      : null;
    if (!isCurrentCallbackClient()) return;
    if (decision) {
      const selection = permissionSelectionForPluginDecision(request, decision);
      if (selection) {
        respondToPermissionRequest(app, threadId, request, selection);
        addPermissionPolicyBlock(adapter, request, decision, selection);
        return;
      }
    }
    if (store.threadYoloEnabled.has(threadId)) {
      const selection = relayYoloPermissionSelection(request);
      if (selection) {
        respondToPermissionRequest(app, threadId, request, selection);
        return;
      }
    }
    renderPermissionRequest(app, threadId, adapter, request);
  }

  function emitElicitationRequestEvent(app: App, threadId: string, request: AcpElicitationRequest): void {
    const ctx = pluginEventContext(app, threadId, request);
    emitPluginEvent({
      type: "elicitation:request",
      message: request.message,
      mode: request.mode,
      schema: request.requestedSchema,
      url: request.url,
      elicitationId: request.elicitationId,
      toolCallId: request.toolCallId,
      ...(ctx ? { threadId: ctx.threadId, sessionId: ctx.sessionId, cwd: ctx.cwd } : {}),
    });
  }

  function findElicitationParentToolBlockId(
    adapter: ReturnType<typeof threadUiAdapter>,
    request: AcpElicitationRequest,
  ): string | undefined {
    const blocks = adapter.state.blocks;
    const scopedToolCallId = typeof request.toolCallId === "string" ? request.toolCallId : undefined;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (block.type !== "tool") continue;
      const toolBlock = block as ToolBlock;
      if (scopedToolCallId && toolBlock.toolCallId === scopedToolCallId) return block.id;
      if (!scopedToolCallId && toolBlock.toolName === "ask_user_questions") return block.id;
    }
    return undefined;
  }

  function applyElicitationAnswers(
    adapter: ReturnType<typeof threadUiAdapter>,
    request: AcpElicitationRequest,
    fields: ReturnType<typeof fieldsFromElicitationSchema>,
    parentToolBlockId: string | undefined,
    response: AcpElicitationResponse,
  ): void {
    if (response.action !== "accept" || !parentToolBlockId) return;
    const MAX_VAL_LEN = 40;
    const truncate = (value: string) => (value.length > MAX_VAL_LEN ? `${value.slice(0, MAX_VAL_LEN)}…` : value);
    const elicitationAnswers = Object.entries(response.content).map(([key, value]) => {
      const field = fields.find((item) => item.key === key);
      const label = field?.description ?? (fields.length === 1 ? request.message : field?.title) ?? key;
      const answer = Array.isArray(value) ? value.join(", ") : String(value);
      return { label, value: truncate(answer) };
    });
    adapter.updateBlock(parentToolBlockId, { elicitationAnswers } as Partial<ChatBlock>);
  }

  function respondToElicitationRequest(
    app: App,
    threadId: string,
    adapter: ReturnType<typeof threadUiAdapter>,
    request: AcpElicitationRequest,
    fields: ReturnType<typeof fieldsFromElicitationSchema>,
    parentToolBlockId: string | undefined,
    response: AcpElicitationResponse,
  ): void {
    applyElicitationAnswers(adapter, request, fields, parentToolBlockId, response);
    const ctx = pluginEventContext(app, threadId, request);
    emitPluginEvent({
      type: "elicitation:resolved",
      elicitationId: request.elicitationId,
      toolCallId: request.toolCallId,
      outcome: response.action === "accept" ? "accepted" : response.action === "decline" ? "declined" : "cancelled",
      ...(ctx ? { threadId: ctx.threadId, sessionId: ctx.sessionId, cwd: ctx.cwd } : {}),
    });
    request.respond(response);
  }

  function addElicitationPolicyBlock(
    adapter: ReturnType<typeof threadUiAdapter>,
    request: AcpElicitationRequest,
    pluginName: string,
    response: AcpElicitationResponse,
  ): void {
    const action = response.action === "accept" ? "answered" : response.action;
    adapter.addBlock({
      type: "info",
      id: nextBlockId(),
      content: `Plugin ${pluginName} ${action} elicitation: ${request.message}`,
      variant: response.action === "accept" ? "info" : "warning",
    });
  }

  function renderElicitationRequest(
    app: App,
    threadId: string,
    adapter: ReturnType<typeof threadUiAdapter>,
    request: AcpElicitationRequest,
    fields: ReturnType<typeof fieldsFromElicitationSchema>,
    parentToolBlockId: string | undefined,
  ): void {
    if (threadId === app.state.activeThreadId) setWelcomeDismissed(true);
    notify(
      "elicitation",
      threadNotificationContext(app, threadId, {
        summary: elicitationNotificationSummary({
          mode: request.mode,
          message: request.message,
          fields,
        }),
        toolName: "question",
      }),
    );
    if (request.mode !== "form") {
      respondToElicitationRequest(app, threadId, adapter, request, fields, parentToolBlockId, { action: "cancel" });
      adapter.addBlock({
        type: "info",
        id: nextBlockId(),
        content: "URL elicitation is not supported in this terminal yet.",
        variant: "warning",
      });
      return;
    }
    // Must be appended as pending: findPendingElicitationBlock only notices new blocks.
    const block: ElicitationBlock = {
      type: "elicitation",
      id: nextBlockId(),
      mode: request.mode,
      message: request.message,
      schema: request.requestedSchema,
      url: request.url,
      elicitationId: request.elicitationId,
      status: "pending",
      fields,
      currentFieldIndex: 0,
      answers: {},
      allowCustomEnumInput:
        agentBehaviorProfileForThreadId(app, threadId).elicitationPolicy?.allowCustomEnumInput === true,
      respond: (response) =>
        respondToElicitationRequest(app, threadId, adapter, request, fields, parentToolBlockId, response),
    };
    adapter.addBlock(block);
  }

  async function handleElicitationRequest(
    app: App,
    threadId: string,
    adapter: ReturnType<typeof threadUiAdapter>,
    request: AcpElicitationRequest,
    isCurrentCallbackClient: () => boolean,
  ): Promise<void> {
    if (!isCurrentCallbackClient()) return;
    const fields = request.mode === "form" ? fieldsFromElicitationSchema(request.requestedSchema) : [];
    const parentToolBlockId = findElicitationParentToolBlockId(adapter, request);
    emitElicitationRequestEvent(app, threadId, request);
    const ctx = pluginEventContext(app, threadId, request);
    const decision = ctx
      ? await (getPluginRunner()?.handleElicitationRequest({
          threadId: ctx.threadId,
          sessionId: ctx.sessionId,
          cwd: ctx.cwd,
          mode: request.mode,
          message: request.message,
          schema: request.requestedSchema,
          url: request.url,
          elicitationId: request.elicitationId,
          toolCallId: request.toolCallId,
          fields,
          raw: request,
        }) ?? Promise.resolve(null))
      : null;
    if (!isCurrentCallbackClient()) return;
    if (decision) {
      respondToElicitationRequest(app, threadId, adapter, request, fields, parentToolBlockId, decision.result.response);
      addElicitationPolicyBlock(adapter, request, decision.plugin.name, decision.result.response);
      return;
    }
    renderElicitationRequest(app, threadId, adapter, request, fields, parentToolBlockId);
  }

  function createThreadCallbacks(app: App, threadId: string, clientRef?: () => AcpClient | null): AcpClientCallbacks {
    const adapter = threadUiAdapter(app, threadId);
    const callbackClient = () => clientRef?.() ?? null;
    const isCurrentCallbackClient = () => {
      const sourceClient = callbackClient();
      return !sourceClient || threadClient(threadId) === sourceClient;
    };
    return {
      onProcessExit: (event) => {
        emitPluginEvent({ type: "agent:process:exit", threadId, ...event });
        finalizeThreadAfterUnexpectedProcessExit(app, threadId, event, callbackClient());
      },
      onSessionUpdate: (update, envelope) => {
        // Reject callbacks from stale clients.
        if (!isCurrentCallbackClient()) {
          return;
        }

        // Plugins observe every accepted update, even if transcript mutation is later suppressed.
        emitPluginEvent({ type: "session:update", update });

        const lifecycle = normalizeAgentLifecycleEvent(update, agentBehaviorProfileForThreadId(app, threadId));
        if (lifecycle) {
          emitPluginEvent(lifecycle);
        }

        const isConfigOptionUpdate = update.sessionUpdate === "config_option_update";
        const subagentAttribution = isConfigOptionUpdate ? parseAltaSubagentMetadata(update, envelope) : null;
        // Only updates with no subagent attribution may change the parent session config.
        // Invalid attribution is rejected conservatively so malformed child updates cannot affect the parent.
        const shouldApplyConfigToParentSession = isConfigOptionUpdate && subagentAttribution?.kind === "absent";
        const isCurrentSessionHistoryLoaded =
          store.historyLoadedSessionIdsByThread.get(threadId) === (threadClient(threadId)?.sessionId ?? null);

        // Until the next prompt clears the marker, loaded-session config notifications may update cached parent
        // capabilities or nested subagent state, but not active config controls or transcript block-transition events.
        if (isConfigOptionUpdate && isCurrentSessionHistoryLoaded) {
          if (shouldApplyConfigToParentSession) {
            cacheThreadConfigOptionUpdate(threadId, update);
          }

          applyAcpSessionUpdate(update, adapter, envelope);
          return;
        }

        // Raw plugin events remain observable, but suppressed prompt runs must not mutate the normal transcript.
        if (store.suppressedThreadPromptRunIds.has(threadId)) {
          return;
        }

        const beforeBlocks = hasPluginBlockEventListeners() ? snapshotPluginBlocks(adapter.state.blocks) : null;
        applyAcpSessionUpdate(update, adapter, envelope);
        emitPluginBlockTransitionEvents(beforeBlocks, app, threadId, update);

        if (!shouldApplyConfigToParentSession) {
          return;
        }

        cacheThreadConfigOptionUpdate(threadId, update);

        if (threadId === app.state.activeThreadId) {
          handleAcpConfigOptionUpdate(update, app);
        }
      },
      onPermissionRequest: (request) => {
        void handlePermissionRequest(app, threadId, adapter, request, isCurrentCallbackClient);
      },
      onElicitationRequest: (request) => {
        void handleElicitationRequest(app, threadId, adapter, request, isCurrentCallbackClient);
      },
      onAvailableCommands: (commands) => {
        if (!isCurrentCallbackClient()) return;
        store.cachedAgentCommands = commands;
        writeCachedAgentCommands(store.activeAgentCommandCacheKey, commands);
        store.threadAgentCommands.set(threadId, commands);
        store.threadSessionCapabilities.set(
          threadId,
          mergeSessionCapabilities(store.threadSessionCapabilities.get(threadId), { availableCommands: commands }),
        );
        store.threadAgentCommandsKnown.add(threadId);
        if (hasAgentYoloo(commands) && !store.threadYoloLaunchEnabled.has(threadId)) {
          store.threadYoloEnabled.delete(threadId);
        }
        if (threadId !== app.state.activeThreadId) return;
        app.setState("availableCommands", commands);
        (refreshSlashAutocompleteForCommandUpdate ?? refreshOpenSlashAutocomplete)();
      },
    };
  }

  function threadClient(threadId: string): AcpClient | null {
    return store.threadClients.get(threadId) ?? null;
  }

  function resetThreadSessionCapabilities(app: App, threadId: string): void {
    store.threadSessionCapabilities.delete(threadId);
    store.threadAgentCommands.set(threadId, []);
    store.threadAgentCommandsKnown.delete(threadId);
    if (threadId === app.state.activeThreadId) app.setState("availableCommands", []);
  }

  function startThreadSessionLoadStatus(app: App, thread: ThreadInfo): void {
    if (!thread.sessionId || thread.id !== app.state.activeThreadId) return;
    app.setState("spinnerLabel", sessionLoadStatus(thread.sessionId, thread.title));
    app.setState("spinnerActive", true);
  }

  function clearThreadSessionLoadStatus(app: App, threadId: string): void {
    if (threadId !== app.state.activeThreadId) return;
    app.setState("spinnerLabel", "");
    if (!app.state.running) app.setState("spinnerActive", false);
  }

  async function createSessionForThread(app: App, thread: ThreadInfo, client: AcpClient): Promise<AcpSessionResult> {
    let result: AcpSessionResult;
    try {
      resetThreadSessionCapabilities(app, thread.id);
      result = await client.newSession(thread.cwd, additionalDirectoriesForThread(thread, app.state.threads));
    } catch (error) {
      if (thread.id === app.state.activeThreadId) markAcpAuthRequired(app, error);
      throw error; // effect-shape-allow: UI session startup keeps existing async error propagation.
    }
    emitPluginEvent({ type: "session:new", sessionId: result.sessionId ?? null, cwd: thread.cwd, threadId: thread.id });
    store.historyLoadedSessionIdsByThread.delete(thread.id);
    if (thread.id === app.state.activeThreadId) store.allowGlobalPromptHistoryContinuation = true;
    const updateAppState = thread.id === app.state.activeThreadId;
    applyThreadSessionCapabilities(app, thread.id, result, { replace: true });
    let latestSessionResult: SessionCapabilitiesResult & { sessionId?: string } = result;
    const preferredModelResult = await applyPreferredModelForNewSession(
      app,
      client,
      agentNameForThread(thread),
      result,
      undefined,
      undefined,
      {
        updateAppState,
      },
    );
    if (preferredModelResult) {
      applyThreadSessionCapabilities(app, thread.id, preferredModelResult);
      latestSessionResult = {
        ...mergeSessionCapabilities(latestSessionResult, preferredModelResult),
        sessionId: latestSessionResult.sessionId,
      };
    }
    const preferredThinkingResult = await applyPreferredThinkingLevelForNewSession(
      app,
      client,
      agentNameForThread(thread),
      latestSessionResult,
      undefined,
      undefined,
      {
        updateAppState,
      },
    );
    if (preferredThinkingResult) applyThreadSessionCapabilities(app, thread.id, preferredThinkingResult);
    const currentThread = app.state.threads.find((item) => item.id === thread.id && !item.archived);
    if (currentThread && !currentThread.sessionId) {
      updateThread(app, thread.id, { sessionId: result.sessionId ?? null, status: "paused" });
    }
    return result;
  }

  function threadNotificationContext(
    app: App,
    threadId: string,
    overrides: NotificationContext = {},
  ): NotificationContext {
    const thread = app.state.threads.find((item) => item.id === threadId);
    return {
      sessionId: threadClient(threadId)?.sessionId ?? thread?.sessionId ?? null,
      cwd: thread?.cwd ?? app.state.cwd,
      ...overrides,
    };
  }

  function permissionNotificationContext(
    app: App,
    threadId: string,
    request: AcpToolApprovalRequest,
  ): NotificationContext {
    const preview = request.preview?.trim() ?? "";
    return threadNotificationContext(app, threadId, {
      summary: preview ? `Permission requested: ${compactPreviewText(preview, 160, false)}` : undefined,
      toolName: request.toolName,
      toolInput: preview ? { preview } : undefined,
    });
  }

  function agentSlashSkillInvocationEcho(command: string, app: App, threadId: string): UserSkillInvocationEcho | null {
    const commandName = slashCommandName(command);
    if (shouldPreferNativeSlashCommandForState(commandName, app.state)) return null;
    const commands =
      threadId === app.state.activeThreadId
        ? app.state.availableCommands
        : (store.threadAgentCommands.get(threadId) ?? []);
    return buildAgentSlashSkillInvocationEcho(command, commands);
  }

  function applyThreadSessionCapabilities(
    app: App,
    threadId: string,
    sessionResult: SessionCapabilitiesResult,
    options: ApplySessionCapabilitiesOptions = {},
  ): void {
    const resultWithCommands =
      options.replace && sessionResult.availableCommands === undefined
        ? { ...sessionResult, availableCommands: store.threadAgentCommands.get(threadId) ?? [] }
        : sessionResult;
    const capabilities = options.replace
      ? resultWithCommands
      : mergeSessionCapabilities(store.threadSessionCapabilities.get(threadId), resultWithCommands);
    store.threadSessionCapabilities.set(threadId, capabilities);
    const commands = sessionCommands(capabilities.availableCommands);
    if (sessionResult.availableCommands !== undefined) store.threadAgentCommandsKnown.add(threadId);
    if (commands) {
      store.threadAgentCommands.set(threadId, commands);
      if (hasAgentYoloo(commands) && !store.threadYoloLaunchEnabled.has(threadId)) {
        store.threadYoloEnabled.delete(threadId);
      }
    } else if (options.replace) store.threadAgentCommands.set(threadId, []);
    if (threadId !== app.state.activeThreadId) return;
    applySessionCapabilities(app, capabilities, options);
    store.threadAgentCommands.set(threadId, app.state.availableCommands);
  }

  function cacheThreadConfigOptionUpdate(threadId: string, update: unknown): void {
    const next = sessionCapabilitiesWithConfigOptionUpdate(store.threadSessionCapabilities.get(threadId), update);
    if (next) store.threadSessionCapabilities.set(threadId, next);
  }

  function handleAcpConfigOptionUpdate(update: unknown, app: App): void {
    if (!update || typeof update !== "object") return;
    const data = update as {
      configOptions?: unknown;
      optionId?: unknown;
      id?: unknown;
      value?: unknown;
      option?: { value?: unknown };
    };
    if (applySessionConfigOptionUpdate(app, update)) return;
    const optionId =
      typeof data.optionId === "string" ? data.optionId : typeof data.id === "string" ? data.id : undefined;
    if (!optionId) return;
    const value = data.value ?? data.option?.value;
    const setting = getConfigSettingByAcpOptionId(optionId);
    if (!setting) return;
    try {
      setConfigValue(setting.key, value as boolean | number | string);
      app.addBlock({
        type: "info",
        id: nextBlockId(),
        content: `Updated setting: ${setting.title}`,
        variant: "info",
      });
    } catch {}
  }

  async function ensureThreadClient(app: App, thread: ThreadInfo): Promise<ThreadSessionStart> {
    const inFlight = clientStartByThread.get(thread.id);
    if (inFlight) return await inFlight;
    const existing = threadClient(thread.id);
    if (existing) return { client: existing };
    if (!store.activeAcpLaunchOptions) throw new Error("No ACP agent configured"); // effect-shape-allow: UI event bridge requires initialized ACP launch options.
    let clientRef: AcpClient | null = null;
    const callbacks = createThreadCallbacks(app, thread.id, () => clientRef);
    const opts = withLiveSessionEnv(
      withPluginMcpServers(baseClientOptionsForThread(thread)),
      thread,
      app.state.threads,
    );
    const client = store.activeAcpClientFactory?.(callbacks, opts) ?? new AcpClient(callbacks, opts);
    clientRef = client;
    store.threadClients.set(thread.id, client);
    const start = (async (): Promise<ThreadSessionStart> => {
      startThreadSessionLoadStatus(app, thread);
      const agentName = agentNameForThread(thread);
      if ((opts.transport ?? "stdio") === "stdio") {
        emitPluginEvent({ type: "agent:process:start", command: opts.command ?? "", args: opts.args ?? [] });
      }
      emitPluginEvent({ type: "agent:connect:start", agentName });
      try {
        await connectAcpClientWithTimeout(client, agentName);
        if (thread.id === app.state.activeThreadId) applyAcpClientCapabilities(app, client);
        emitPluginEvent({ type: "agent:connect:ready", agentName, capabilities: null });
      } catch (error) {
        store.threadClients.delete(thread.id);
        if (thread.sessionId) clearThreadSessionLoadStatus(app, thread.id);
        emitPluginEvent({ type: "agent:connect:error", agentName, error: String(error) });
        throw error; // effect-shape-allow: UI event bridge preserves existing async control flow.
      }
      if (thread.sessionId) {
        let blocksBeforeHistory: ChatBlock[] | undefined;
        try {
          resetThreadSessionCapabilities(app, thread.id);
          let renderedUpdateCount = 0;
          const { result, updates } = await loadSessionHistory(
            client,
            thread.id,
            thread.sessionId,
            thread.cwd,
            additionalDirectoriesForThread(thread, app.state.threads),
            (earlyUpdates) => {
              if (store.threadClients.get(thread.id) !== client) return;
              blocksBeforeHistory ??= threadUiAdapter(app, thread.id).state.blocks.slice();
              replayLoadedSessionUpdates(app, thread.id, earlyUpdates, false);
              renderedUpdateCount = earlyUpdates.length;
            },
          );
          const loadedSessionId = result.sessionId ?? thread.sessionId;
          updateThread(app, thread.id, { sessionId: loadedSessionId, status: "paused" });
          applyThreadSessionCapabilities(app, thread.id, result, { replace: true });
          replayLoadedSessionUpdates(app, thread.id, updates.slice(renderedUpdateCount), updates.length > 0);
          const refreshedThread = app.state.threads.find((candidate) => candidate.id === thread.id) ?? thread;
          const adapter = threadUiAdapter(app, thread.id);
          for (const block of restoredLiveSessionMessageBlocks(
            refreshedThread,
            loadedSessionId,
            adapter.state.blocks,
          )) {
            adapter.addBlock(block);
          }
          emitPluginEvent({
            type: "session:load",
            sessionId: result.sessionId ?? thread.sessionId,
            cwd: thread.cwd,
            threadId: thread.id,
          });
          drainReadyPromptQueue(app, thread.id);
          return { client, result };
        } catch (error) {
          if (blocksBeforeHistory && store.threadClients.get(thread.id) === client) {
            restoreBlocksBeforeHistory(app, thread.id, blocksBeforeHistory);
          }
          throw error; // effect-shape-allow: UI event bridge preserves existing async control flow.
        } finally {
          clearThreadSessionLoadStatus(app, thread.id);
        }
      }
      updateThread(app, thread.id, { status: "paused" });
      return { client };
    })();
    clientStartByThread.set(thread.id, start);
    try {
      return await start;
    } finally {
      clientStartByThread.delete(thread.id);
    }
  }

  async function createThreadFromExistingWorktree(app: App, worktreePath: string): Promise<void> {
    if (!store.activeAcpLaunchOptions) throw new Error("No ACP agent configured"); // effect-shape-allow: UI event bridge requires initialized ACP launch options.
    const found = listGitWorktrees(store.rootCwd || app.state.cwd).find((worktree) => worktree.path === worktreePath);
    const id = `thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    const relaySessionId = createRelaySessionId();
    const thread: ThreadInfo = {
      id,
      relaySessionId,
      relaySessionName: relaySessionNameFromId(relaySessionId, app.state.threads.map(threadRelaySessionName)),
      title: found?.branch ? `Worktree: ${found.branch}` : "Existing worktree",
      sessionId: null,
      cwd: worktreePath,
      workspaceKind: "worktree",
      worktreePath,
      worktreeBranch: found?.branch ?? undefined,
      status: "connecting",
      archived: false,
      managedWorktree: false,
      createdAt: now,
      updatedAt: now,
    };
    app.setState("threads", (threads: ThreadInfo[]) => [...threads, thread]);
    emitThreadChange(app, thread, "created");
    persistThreads(app);
    await selectThread(app, id);
    app.addBlock({
      type: "info",
      id: nextBlockId(),
      content: `Existing worktree thread: ${worktreePath}`,
      variant: "info",
    });
  }

  async function createThread(app: App, inWorktree: boolean, options: CreateThreadOptions = {}): Promise<ThreadInfo> {
    if (!store.activeAcpLaunchOptions) throw new Error("No ACP agent configured"); // effect-shape-allow: UI event bridge requires initialized ACP launch options.
    const id = `thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const worktree = inWorktree
      ? createRelayWorktree(store.rootCwd || app.state.cwd, id, getConfig().ui.thread_worktree_location)
      : null;
    const cwd = worktree?.path ?? options.cwd ?? store.rootCwd ?? app.state.cwd;
    const relaySessionId = createRelaySessionId();
    const thread: ThreadInfo = {
      id,
      relaySessionId,
      relaySessionName:
        options.relaySessionName ??
        relaySessionNameFromId(relaySessionId, app.state.threads.map(threadRelaySessionName)),
      title: options.title ?? "New thread",
      sessionId: null,
      ...(options.parentThreadId ? { parentThreadId: options.parentThreadId } : {}),
      ...(options.relationKind ? { relationKind: options.relationKind } : {}),
      ...(options.relationGoal ? { relationGoal: options.relationGoal } : {}),
      ...(options.childTaskType ? { childTaskType: options.childTaskType } : {}),
      agentName: options.agentName?.trim() || store.activeAgentName,
      ...(options.modelId ? { modelId: options.modelId } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      ...(options.parentThreadId ? { relationCreatedAt: new Date().toISOString(), childTaskStatus: "starting" } : {}),
      cwd,
      workspaceKind: inWorktree ? "worktree" : "local",
      worktreePath: worktree?.path,
      worktreeBranch: worktree?.branch,
      status: options.select === false ? "paused" : "connecting",
      archived: false,
      managedWorktree: inWorktree,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const previousThreadId = app.state.activeThreadId || null;
    if (options.select !== false && previousThreadId) beforeThreadDeactivate?.(previousThreadId);
    if (options.snapshotCurrent !== false) snapshotActiveThreadUiState(app);
    app.setState("threads", (threads: ThreadInfo[]) => [...threads, thread]);
    emitThreadChange(app, thread, "created");
    store.threadPendingQueues.set(id, []);
    store.threadAgentCommands.set(id, []);
    persistThreads(app);
    if (options.select === false) {
      const adapter = threadUiAdapter(app, id);
      addWelcomeBlocks((block) => adapter.addBlock(block), cwd);
      adapter.addBlock({
        type: "info",
        id: nextBlockId(),
        content: options.parentThreadId
          ? `Child session: ${options.relaySessionName ?? options.title ?? "child"}`
          : inWorktree
            ? "New worktree thread"
            : "New thread",
        variant: "info",
      });
      return thread;
    }
    app.setActiveThreadState(thread, [], []);
    afterThreadActivate?.(thread.id);
    emitThreadChange(app, thread, "selected", previousThreadId);
    resetSessionUi(app);
    gitWatcherSetCwd(cwd);
    let clientRef: AcpClient | null = null;
    const callbacks = createThreadCallbacks(app, id, () => clientRef);
    const opts = withLiveSessionEnv(
      withPluginMcpServers(baseClientOptionsForThread(thread)),
      thread,
      app.state.threads,
    );
    const client = store.activeAcpClientFactory?.(callbacks, opts) ?? new AcpClient(callbacks, opts);
    clientRef = client;
    store.threadClients.set(id, client);
    store.acpClient = client;
    const agentName = agentNameForThread(thread);
    if ((opts.transport ?? "stdio") === "stdio") {
      emitPluginEvent({ type: "agent:process:start", command: opts.command ?? "", args: opts.args ?? [] });
    }
    emitPluginEvent({ type: "agent:connect:start", agentName });
    try {
      await connectAcpClientWithTimeout(client, agentName);
      applyAcpClientCapabilities(app, client);
      emitPluginEvent({ type: "agent:connect:ready", agentName, capabilities: null });
    } catch (error) {
      emitPluginEvent({ type: "agent:connect:error", agentName, error: String(error) });
      throw error; // effect-shape-allow: UI event bridge preserves existing async control flow.
    }
    syncCurrentThreadStatus(app, "paused");
    addWelcomeBlocks(app.addBlock, cwd);
    app.addBlock({
      type: "info",
      id: nextBlockId(),
      content: inWorktree ? "New worktree thread" : "New thread",
      variant: "info",
    });
    if (!drainReadyPromptQueue(app, id)) warmThreadSessionCapabilities(app, id);
    return thread;
  }

  async function forkThread(app: App): Promise<void> {
    const sourceThread = app.state.threads.find((item) => item.id === app.state.activeThreadId && !item.archived);
    if (!sourceThread) throw new Error("No active thread to fork"); // effect-shape-allow: UI slash command reports missing active thread.
    const { client } = await ensureThreadSession(app, sourceThread);
    if (!client.sessionId) throw new Error("No active ACP session to fork"); // effect-shape-allow: UI slash command reports missing session.
    if (!client.supportsSessionFork()) throw new Error("ACP agent did not advertise session/fork"); // effect-shape-allow: UI slash command reports unsupported capability.

    const result = await client.forkSession(
      sourceThread.cwd,
      undefined,
      additionalDirectoriesForThread(sourceThread, app.state.threads),
    );
    if (!result.sessionId) throw new Error("ACP session/fork response missing sessionId"); // effect-shape-allow: UI slash command validates ACP response.

    const id = `thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    const title =
      sourceThread.title && sourceThread.title !== "New thread" ? `Fork: ${sourceThread.title}` : "Forked thread";
    const relaySessionId = createRelaySessionId();
    const thread: ThreadInfo = {
      id,
      relaySessionId,
      relaySessionName: relaySessionNameFromId(relaySessionId, app.state.threads.map(threadRelaySessionName)),
      title,
      sessionId: result.sessionId,
      agentName: sourceThread.agentName ?? store.activeAgentName,
      cwd: sourceThread.cwd,
      workspaceKind: sourceThread.workspaceKind,
      worktreePath: sourceThread.worktreePath,
      worktreeBranch: sourceThread.worktreeBranch,
      status: "connecting",
      archived: false,
      managedWorktree: false,
      titleQuality: "fallback",
      createdAt: now,
      updatedAt: now,
    };

    snapshotActiveThreadUiState(app);
    app.setState("threads", (threads: ThreadInfo[]) => [...threads, thread]);
    emitThreadChange(app, thread, "created");
    store.threadPendingQueues.set(id, []);
    store.threadAgentCommands.set(id, result.availableCommands ?? []);
    store.threadSessionCapabilities.set(id, result);
    persistThreads(app);
    await selectThread(app, id, { snapshotCurrent: false });
    app.addBlock({
      type: "info",
      id: nextBlockId(),
      content: `Forked session: ${result.sessionId}`,
      variant: "info",
    });
  }

  function getThreadPendingQueue(app: App, threadId: string): QueuedPrompt[] {
    return threadQueue.get(app, threadId);
  }

  function sessionReferencedByOtherVisibleThread(app: App, threadId: string, sessionId: string): boolean {
    return app.state.threads.some(
      (thread) => thread.id !== threadId && !thread.archived && thread.sessionId === sessionId,
    );
  }

  async function closeThreadSessionIfUnreferenced(
    app: App,
    threadId: string,
    thread: ThreadInfo,
    client: AcpClient | null,
  ): Promise<void> {
    const sessionId = thread.sessionId ?? client?.sessionId ?? null;
    if (!sessionId || !client?.supportsSessionClose?.()) return;
    if (sessionReferencedByOtherVisibleThread(app, threadId, sessionId)) return;
    await client.closeSession(sessionId).catch(() => undefined);
  }

  function setThreadPendingQueue(app: App, threadId: string, queue: QueuedPrompt[]): void {
    threadQueue.set(app, threadId, queue);
  }

  function queueDrainSubmissionOptions(
    threadId: string,
    options: PromptSubmissionOptions = {},
    promptDispatchReservation?: PromptDispatchReservation,
  ): PromptSubmissionOptions {
    const drainOptions: PromptSubmissionOptions = {
      source: "queue",
      targetThreadId: threadId,
      ...(promptDispatchReservation ? { promptDispatchReservation } : {}),
    };
    if (options.drainQueueIncludePendingBashContext !== undefined) {
      drainOptions.includePendingBashContext = options.drainQueueIncludePendingBashContext;
      drainOptions.drainQueueIncludePendingBashContext = options.drainQueueIncludePendingBashContext;
    }
    return drainOptions;
  }

  function drainReadyPromptQueue(app: App, threadId: string, options?: PromptSubmissionOptions): boolean {
    const thread = app.state.threads.find((item) => item.id === threadId && !item.archived);
    if (!thread || thread.status !== "paused") return false;
    if (threadId === app.state.activeThreadId && (app.state.connecting || app.state.running)) return false;
    if (isPromptDispatchReserved(threadId)) return false;
    if (threadId === app.state.activeThreadId && (editingQueueItem() || queueFocusIndex() !== null)) return false;
    const queue = getThreadPendingQueue(app, threadId);
    const next = queue[0];
    if (!next) return false;
    if (!thread.sessionId) {
      const dispatchReservation = reservePromptDispatch(threadId);
      if (!dispatchReservation) return false;
      void ensureThreadSession(app, thread)
        .then(() => {
          const readyQueue = getThreadPendingQueue(app, threadId);
          const readyNext = readyQueue[0];
          if (!readyNext) {
            releasePromptDispatch(threadId, dispatchReservation);
            return;
          }
          setThreadPendingQueue(app, threadId, readyQueue.slice(1));
          setQueueFocusIndex(null);
          void submitPromptToAgent(
            queuedPromptToInput(readyNext),
            app,
            "in-place",
            queueDrainSubmissionOptions(threadId, options, dispatchReservation),
          );
        })
        .catch((err) => {
          releasePromptDispatch(threadId, dispatchReservation);
          const authRequired = markAcpAuthRequired(app, err);
          app.addBlock({
            type: "info",
            id: nextBlockId(),
            content: authRequired
              ? acpAuthRequiredBlockContent(err)
              : `ACP session startup failed: ${err instanceof Error ? err.message : String(err)}`,
            variant: authRequired ? "warning" : "error",
          });
        });
      return true;
    }
    setThreadPendingQueue(app, threadId, queue.slice(1));
    setQueueFocusIndex(null);
    void submitPromptToAgent(
      queuedPromptToInput(next),
      app,
      "in-place",
      queueDrainSubmissionOptions(threadId, options),
    );
    return true;
  }

  function restoreEditingQueuedPromptForSnapshot(app: App): void {
    if (restoreEditingQueuedPromptForSnapshotWithDraft?.(app)) return;
    const result = restoreEditingQueuedPromptState(app.state.pendingQueue, editingQueueItem());
    if (!result.restored) return;
    app.setState("pendingQueue", result.queue);
    clearQueueInteraction();
  }

  function updateThreadPreview(threadId: string, blocks: ChatBlock[], lastRunningIndex?: number): void {
    const preview = previewFromBlocks(blocks, lastRunningIndex);
    if (preview) store.threadPreviews.set(threadId, preview);
  }

  function snapshotActiveThreadUiState(app: App): void {
    if (!app.state.activeThreadId) return;
    restoreEditingQueuedPromptForSnapshot(app);
    const blocks = [...app.state.blocks];
    store.threadBlocks.set(app.state.activeThreadId, blocks);
    rebuildInactiveBlockIndices(app.state.activeThreadId, blocks);
    store.threadCurrentBlockIds.set(app.state.activeThreadId, app.state.currentBlockId);
    threadQueue.set(app, app.state.activeThreadId, app.state.pendingQueue);
    setQueueFocusIndex(null);
    updateThreadPreview(app.state.activeThreadId, app.state.blocks);
  }

  async function selectThread(app: App, threadId: string, options: { snapshotCurrent?: boolean } = {}): Promise<void> {
    if (threadId === app.state.activeThreadId) return;
    const thread = app.state.threads.find((item) => item.id === threadId && !item.archived);
    if (!thread) return;
    const previousThreadId = app.state.activeThreadId || null;
    if (previousThreadId) beforeThreadDeactivate?.(previousThreadId);
    if (options.snapshotCurrent !== false) snapshotActiveThreadUiState(app);
    app.setActiveThreadState(thread, store.threadBlocks.get(thread.id) ?? [], getThreadPendingQueue(app, thread.id));
    app.setState("providerName", agentNameForThread(thread));
    emitThreadChange(app, thread, "selected", previousThreadId);
    app.setCurrentBlockId(store.threadCurrentBlockIds.get(thread.id) ?? null);
    afterThreadActivate?.(thread.id);
    app.setState("availableCommands", store.threadAgentCommands.get(thread.id) ?? []);
    applyAcpClientCapabilities(app, threadClient(thread.id));
    const cachedCapabilities = store.threadSessionCapabilities.get(thread.id);
    if (cachedCapabilities) applyThreadSessionCapabilities(app, thread.id, cachedCapabilities, { replace: true });
    refreshOpenSlashAutocomplete();
    persistThreads(app);
    gitWatcherSetCwd(thread.cwd);
    const { client, result } = await ensureThreadClient(app, thread);
    store.acpClient = client;
    applyAcpClientCapabilities(app, client);
    if (result) applyThreadSessionCapabilities(app, thread.id, result, { replace: true });
    if (!drainReadyPromptQueue(app, thread.id) && !thread.sessionId) warmThreadSessionCapabilities(app, thread.id);
  }

  async function archiveThread(app: App, threadId: string): Promise<void> {
    const thread = app.state.threads.find((item) => item.id === threadId);
    if (!thread) return;
    const client = threadClient(threadId);
    if (thread.status === "running" || thread.status === "connecting") {
      await client?.cancel(thread.sessionId ?? undefined);
    }
    await closeThreadSessionIfUnreferenced(app, threadId, thread, client);
    await client?.disposeAsync();
    store.threadClients.delete(threadId);
    store.threadAgentCommands.delete(threadId);
    store.threadAgentCommandsKnown.delete(threadId);
    store.threadSessionCapabilities.delete(threadId);
    store.threadYoloEnabled.delete(threadId);
    store.threadYoloLaunchEnabled.delete(threadId);
    store.threadPromptRunIds.delete(threadId);
    store.suppressedThreadPromptRunIds.delete(threadId);
    if (store.acpClient === client) store.acpClient = null;
    if (thread.workspaceKind === "worktree" && thread.worktreePath && thread.managedWorktree !== false) {
      archiveRelayWorktree(thread.worktreePath, store.rootCwd || app.state.cwd);
    }
    updateThread(app, threadId, { archived: true });
    emitThreadChange(app, { ...thread, archived: true }, "archived");
    store.threadBlocks.delete(threadId);
    blockIndicesByThread.delete(threadId);
    store.threadTranscriptViews.delete(threadId);
    store.threadPendingQueues.delete(threadId);
    if (threadId !== app.state.activeThreadId) return;
    const next = app.state.threads.find((item) => item.id !== threadId && !item.archived);
    if (next) {
      await selectThread(app, next.id, { snapshotCurrent: false });
      return;
    }
    await createThread(app, false, { snapshotCurrent: false });
  }

  async function ensureThreadSession(app: App, thread: ThreadInfo): Promise<ThreadSessionStart> {
    const latestThread = app.state.threads.find((item) => item.id === thread.id && !item.archived) ?? thread;
    const existingStart = sessionStartByThread.get(latestThread.id);
    if (existingStart) return await existingStart;
    if (latestThread.sessionId) return await ensureThreadClient(app, latestThread);

    const start = (async () => {
      const ensured = await ensureThreadClient(app, latestThread);
      const refreshedThread = app.state.threads.find((item) => item.id === latestThread.id && !item.archived);
      if (!refreshedThread) return ensured;
      if (refreshedThread.sessionId) return ensured;
      const result = await createSessionForThread(app, refreshedThread, ensured.client);
      return { client: ensured.client, result };
    })();
    sessionStartByThread.set(latestThread.id, start);
    try {
      return await start;
    } finally {
      sessionStartByThread.delete(latestThread.id);
    }
  }

  function warmThreadSessionCapabilities(app: App, threadId: string): boolean {
    const thread = app.state.threads.find((item) => item.id === threadId && !item.archived);
    if (!thread || thread.sessionId || thread.status === "connecting" || thread.status === "running") return false;
    void ensureThreadSession(app, thread).catch((err) => {
      const currentThread = app.state.threads.find((item) => item.id === threadId && !item.archived);
      if (!currentThread || currentThread.sessionId) return;
      const authRequired = markAcpAuthRequired(app, err);
      threadUiAdapter(app, threadId).addBlock({
        type: "info",
        id: nextBlockId(),
        content: authRequired
          ? acpAuthRequiredBlockContent(err)
          : `ACP session capabilities failed: ${err instanceof Error ? err.message : String(err)}`,
        variant: "warning",
      });
    });
    return true;
  }

  async function setSessionModeFromKeyboard(
    nextMode: SessionModeOption,
    app: App,
    setModeId: (modeId: string) => void,
  ): Promise<void> {
    try {
      await store.acpClient?.setSessionMode(nextMode.id);
      setModeId(nextMode.id);
      emitPluginEvent({ type: "mode:change", modeId: nextMode.id });
      app.addBlock({
        type: "info",
        id: nextBlockId(),
        content: `Mode: ${nextMode.id}`,
        variant: "info",
      });
    } catch (err) {
      app.addBlock({
        type: "info",
        id: nextBlockId(),
        content: `Failed to set mode: ${err}`,
        variant: "error",
      });
    }
  }

  return {
    resetSessionUi,
    threadUiAdapter,
    restoreBlocksBeforeHistory,
    createThreadCallbacks,
    threadClient,
    ensureThreadSession,
    warmThreadSessionCapabilities,
    threadNotificationContext,
    agentSlashSkillInvocationEcho,
    applyThreadSessionCapabilities,
    createThreadFromExistingWorktree,
    createThread,
    forkThread,
    getThreadPendingQueue,
    drainReadyPromptQueue,
    selectThread,
    archiveThread,
    setSessionModeFromKeyboard,
  };
}
