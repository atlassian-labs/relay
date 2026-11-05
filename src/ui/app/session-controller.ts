/**
 * ACP session resume / load orchestration.
 *
 * Owns the resume picker, "most recent" resume, history loading, and update
 * replay. Extracted from app-root as a factory: the thread bookkeeping maps and
 * a couple of root helpers are injected, while the load-generation counter is
 * private to this module (it is only ever consulted here).
 */

import { batch } from "solid-js";
import { existsSync } from "../../platform/fs";
import { type SlashCommand, SelectionMode } from "../autocomplete";
import { nextBlockId, useApp } from "../state";
import type { AcpClient } from "../../acp/client";
import { loadOrResumeAcpSessionHistory, replayAcpSessionUpdates } from "../../application/acp-orchestration";
import { getAgentPreferredModel, getAgentPreferredThinkingLevel } from "../../config";
import {
  addWelcomeBlocks,
  type ApplySessionCapabilitiesOptions,
  type SessionCapabilitiesResult,
} from "../context/session";
import { applyPreferredModelForNewSession, applyPreferredThinkingLevelForNewSession } from "./acp-client-controller";
import { sessionLoadStatus } from "./session-load-status";
import { mergeSessionCapabilities } from "./runtime-store";
import { emitPluginEvent } from "./plugin-runtime";
import { syncCurrentThreadSession, syncCurrentThreadStatus, updateThread } from "./thread-metadata";
import type { AgentBehaviorProfile } from "../../acp/agent-profile";
import type { RelaySessionUpdate } from "../../acp/sdk";
import { restoredLiveSessionMessageBlocks } from "../../core/live-sessions";
import { additionalDirectoriesForThread } from "../../core/threads";
import {
  hierarchicalSessionSelectionItems,
  isInternalSessionTitle,
  RESUME_PICKER_LAYOUT,
  resumableSessions,
} from "./session-list";
import { nativeChildSessionRelations } from "./resume-session-relations";

type App = ReturnType<typeof useApp>;
type LoadedHistory = Awaited<ReturnType<AcpClient["loadSessionHistory"]>>;

const RESUME_PICKER_LOADING_ITEMS = [{ value: null, label: "Loading sessions…", description: "" }];

function startSessionLoadStatus(app: App, sessionId: string, sessionTitle?: string): void {
  app.setState("spinnerLabel", sessionLoadStatus(sessionId, sessionTitle));
  app.setState("spinnerActive", true);
}

function clearSessionLoadStatus(app: App): void {
  app.setState("spinnerLabel", "");
  if (!app.state.running) app.setState("spinnerActive", false);
}

export interface SessionControllerDeps {
  threadAgentCommands: Map<string, SlashCommand[]>;
  historyLoadedSessionIdsByThread: Map<string, string>;
  acpClient: () => AcpClient | null;
  activeAgentName: () => string;
  agentBehaviorProfile: () => AgentBehaviorProfile;
  resetSessionUi: (app: App) => void;
  applyThreadSessionCapabilities: (
    app: App,
    threadId: string,
    sessionResult: SessionCapabilitiesResult,
    options?: ApplySessionCapabilitiesOptions,
  ) => void;
  refreshOpenSlashAutocomplete: () => void;
  showSelectionOverlay: (items: any[], mode: SelectionMode, layout?: any, selectedIndex?: number) => void;
  hideSelectionOverlay: () => void;
  threadUiAdapter: (app: App, threadId: string) => any;
  setAllowGlobalPromptHistoryContinuation: (value: boolean) => void;
  onThreadCwdChange: (cwd: string) => void;
}

export interface SessionController {
  openResumePicker: (app: App, client: AcpClient) => Promise<void>;
  resumeMostRecentSession: (app: App, client: AcpClient, agentName: string) => Promise<void>;
  loadSessionHistory: (
    client: AcpClient,
    threadId: string,
    sessionId: string,
    cwd: string,
    additionalDirectories?: readonly string[],
    onHistoryReady?: (updates: readonly RelaySessionUpdate[]) => void,
  ) => Promise<LoadedHistory>;
  /** `finalize` defaults to closing open blocks when `updates` is non-empty; early history passes `false`. */
  replayLoadedSessionUpdates: (
    app: App,
    threadId: string,
    updates: readonly RelaySessionUpdate[],
    finalize?: boolean,
  ) => void;
  loadSession: (
    sessionId: string,
    app: App,
    client: AcpClient,
    agentName: string,
    sessionTitle?: string,
    sessionCwd?: string,
  ) => Promise<void>;
}

export function createSessionController(deps: SessionControllerDeps): SessionController {
  const {
    threadAgentCommands,
    historyLoadedSessionIdsByThread,
    acpClient,
    activeAgentName,
    agentBehaviorProfile,
    resetSessionUi,
    applyThreadSessionCapabilities,
    refreshOpenSlashAutocomplete,
    showSelectionOverlay,
    hideSelectionOverlay,
    threadUiAdapter,
    setAllowGlobalPromptHistoryContinuation,
    onThreadCwdChange,
  } = deps;

  // Generation counter so a stale resume cannot clobber a newer one.
  let sessionLoadRunId = 0;

  async function openResumePicker(app: App, client: AcpClient): Promise<void> {
    showSelectionOverlay(RESUME_PICKER_LOADING_ITEMS, SelectionMode.SESSION_LOADING, RESUME_PICKER_LAYOUT);

    try {
      const sessions = await client.listSessions();
      const resumable = resumableSessions(sessions, agentBehaviorProfile().sessionListPolicy);
      const mostRecentSessionId = resumable[0]?.sessionId;
      const items = hierarchicalSessionSelectionItems(
        resumable,
        client.sessionId,
        nativeChildSessionRelations(app.state.threads),
      );

      if (items.length === 0) {
        hideSelectionOverlay();
        app.addBlock({
          type: "info",
          id: nextBlockId(),
          content: "No ACP sessions available to resume.",
          variant: "warning",
        });
        return;
      }

      const selectedIndex = items.findIndex((item) => item.value.sessionId === mostRecentSessionId);
      showSelectionOverlay(items, SelectionMode.SESSION, RESUME_PICKER_LAYOUT, Math.max(0, selectedIndex));
    } catch (err) {
      hideSelectionOverlay();
      app.addBlock({
        type: "info",
        id: nextBlockId(),
        content: `Failed to list sessions: ${err}`,
        variant: "error",
      });
    }
  }

  async function resumeMostRecentSession(app: App, client: AcpClient, agentName: string): Promise<void> {
    startSessionLoadStatus(app, "most recent");
    try {
      const sessions = await client.listSessions();
      const mostRecent = resumableSessions(sessions, agentBehaviorProfile().sessionListPolicy)[0];
      if (!mostRecent) {
        clearSessionLoadStatus(app);
        app.addBlock({
          type: "info",
          id: nextBlockId(),
          content: "No ACP sessions available to resume.",
          variant: "warning",
        });
        return;
      }
      await loadSession(mostRecent.sessionId, app, client, agentName, mostRecent.title, mostRecent.cwd);
    } catch (err) {
      clearSessionLoadStatus(app);
      app.addBlock({
        type: "info",
        id: nextBlockId(),
        content: `Failed to resume most recent session: ${err}`,
        variant: "error",
      });
    }
  }

  async function loadSessionHistory(
    client: AcpClient,
    threadId: string,
    sessionId: string,
    cwd: string,
    additionalDirectories?: readonly string[],
    onHistoryReady?: (updates: readonly RelaySessionUpdate[]) => void,
  ): Promise<LoadedHistory> {
    return loadOrResumeAcpSessionHistory(client, sessionId, cwd, additionalDirectories, {
      onLoadedSessionId: (loadedSessionId) => historyLoadedSessionIdsByThread.set(threadId, loadedSessionId),
      onHistoryReady,
    });
  }

  function replayLoadedSessionUpdates(
    app: App,
    threadId: string,
    updates: readonly RelaySessionUpdate[],
    finalize?: boolean,
  ): void {
    const adapter = threadId === app.state.activeThreadId ? app : threadUiAdapter(app, threadId);
    // Unbatched, every update re-runs transcript-wide effects and a large history freezes input.
    batch(() =>
      replayAcpSessionUpdates(updates, adapter, {
        finalize,
        onAvailableCommands: (latestCommands) => {
          threadAgentCommands.set(threadId, latestCommands);
          if (threadId === app.state.activeThreadId) {
            app.setState("availableCommands", latestCommands);
            refreshOpenSlashAutocomplete();
          }
        },
      }),
    );
  }

  async function loadSession(
    sessionId: string,
    app: App,
    client: AcpClient,
    agentName: string,
    sessionTitle?: string,
    sessionCwd?: string,
  ): Promise<void> {
    const loadRunId = ++sessionLoadRunId;
    const threadId = app.state.activeThreadId;
    if (!threadId) return;
    const activeThread = app.state.threads.find((thread) => thread.id === threadId && !thread.archived);
    const cwd = sessionCwd ?? activeThread?.cwd ?? app.state.cwd;
    if (sessionCwd !== undefined && !existsSync(sessionCwd)) {
      app.addBlock({
        type: "info",
        id: nextBlockId(),
        content: `Cannot load session: workspace no longer exists: ${sessionCwd}`,
        variant: "error",
      });
      return;
    }
    startSessionLoadStatus(app, sessionId, sessionTitle);
    // Paint stored history as soon as it has streamed in; the agent may take seconds more to answer the load.
    let renderedUpdateCount = 0;
    const addResumedMarker = (id: string) =>
      app.addBlock({ type: "info", id: nextBlockId(), content: `Resumed ACP session: ${id}`, variant: "info" });
    try {
      const directoryThread =
        activeThread === undefined
          ? undefined
          : activeThread.cwd === cwd
            ? activeThread
            : { ...activeThread, cwd, worktreePath: undefined };
      const directoryThreads = directoryThread
        ? app.state.threads.map((thread) => (thread.id === threadId ? directoryThread : thread))
        : app.state.threads;
      const additionalDirectories = directoryThread
        ? additionalDirectoriesForThread(directoryThread, directoryThreads)
        : [];
      const preferredModel = getAgentPreferredModel(agentName);
      const preferredThinkingLevel = getAgentPreferredThinkingLevel(agentName);
      const { result: sessionResult, updates } = await loadSessionHistory(
        client,
        threadId,
        sessionId,
        cwd,
        additionalDirectories,
        (earlyUpdates) => {
          if (loadRunId !== sessionLoadRunId || client !== acpClient() || app.state.activeThreadId !== threadId) return;
          batch(() => {
            resetSessionUi(app);
            addWelcomeBlocks(app.addBlock, cwd);
            addResumedMarker(sessionId);
            replayLoadedSessionUpdates(app, threadId, earlyUpdates, false);
            startSessionLoadStatus(app, sessionId, sessionTitle);
          });
          renderedUpdateCount = earlyUpdates.length;
        },
      );
      if (loadRunId !== sessionLoadRunId || client !== acpClient()) {
        if (loadRunId === sessionLoadRunId) clearSessionLoadStatus(app);
        return;
      }
      const loadedSessionId = sessionResult.sessionId ?? sessionId;

      // Keep the destructive resume transition atomic. Without this batch,
      // OpenTUI can paint after resetSessionUi clears the old blocks but before
      // ACP history replay repopulates them, which looks like a full-window flash.
      batch(() => {
        threadAgentCommands.set(threadId, []);
        if (activeThread !== undefined && activeThread.cwd !== cwd) {
          app.setState("cwd", cwd);
          app.setState("worktreePath", null);
          app.setState("worktreeBranch", null);
          updateThread(app, threadId, {
            cwd,
            workspaceKind: "local",
            worktreePath: undefined,
            worktreeBranch: undefined,
            updatedAt: new Date().toISOString(),
          });
          onThreadCwdChange(cwd);
        }
        if (renderedUpdateCount === 0) {
          resetSessionUi(app);
          addWelcomeBlocks(app.addBlock, cwd);
        }
        clearSessionLoadStatus(app);
        setAllowGlobalPromptHistoryContinuation(false);
        syncCurrentThreadSession(app, loadedSessionId);
        const cleanSessionTitle = sessionTitle?.trim();
        if (cleanSessionTitle && !isInternalSessionTitle(cleanSessionTitle, agentBehaviorProfile().sessionListPolicy)) {
          updateThread(app, threadId, { title: cleanSessionTitle });
        }
        syncCurrentThreadStatus(app, "paused");
        applyThreadSessionCapabilities(app, threadId, sessionResult, { replace: true });
        if (renderedUpdateCount === 0) addResumedMarker(loadedSessionId);
        replayLoadedSessionUpdates(app, threadId, updates.slice(renderedUpdateCount), updates.length > 0);
        if (activeThread) {
          for (const block of restoredLiveSessionMessageBlocks(activeThread, loadedSessionId, app.state.blocks)) {
            app.addBlock(block);
          }
        }
        emitPluginEvent({ type: "session:load", sessionId, cwd: app.state.cwd, threadId });
      });

      // Applying configured preferences can make extra ACP round trips.
      // Keep them after history replay so /resume never sits on a blank transition frame.
      if (loadRunId !== sessionLoadRunId || client !== acpClient()) return;
      let latestSessionResult: SessionCapabilitiesResult & { sessionId?: string } = sessionResult;
      const preferredModelResult = await applyPreferredModelForNewSession(
        app,
        client,
        agentName,
        latestSessionResult,
        preferredModel,
        loadedSessionId,
      );
      if (preferredModelResult) {
        applyThreadSessionCapabilities(app, threadId, preferredModelResult);
        latestSessionResult = {
          ...mergeSessionCapabilities(latestSessionResult, preferredModelResult),
          sessionId: latestSessionResult.sessionId,
        };
      }
      const preferredThinkingResult = await applyPreferredThinkingLevelForNewSession(
        app,
        client,
        agentName,
        latestSessionResult,
        preferredThinkingLevel,
        loadedSessionId,
      );
      if (preferredThinkingResult) applyThreadSessionCapabilities(app, threadId, preferredThinkingResult);
    } catch (e) {
      if (loadRunId !== sessionLoadRunId || client !== acpClient()) {
        if (loadRunId === sessionLoadRunId) clearSessionLoadStatus(app);
        return;
      }
      batch(() => {
        // Drop any early-rendered history: it can't be continued without a loaded session.
        resetSessionUi(app);
        addWelcomeBlocks(app.addBlock, app.state.cwd);
        clearSessionLoadStatus(app);
        app.addBlock({
          type: "info",
          id: nextBlockId(),
          content: `Failed to load session: ${e}`,
          variant: "error",
        });
      });
    }
  }

  return { openResumePicker, resumeMostRecentSession, loadSessionHistory, replayLoadedSessionUpdates, loadSession };
}
