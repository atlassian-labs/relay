/**
 * Prompt submission to the ACP agent + turn interruption.
 *
 * The heart of a turn: `submitPromptToAgent` reserves dispatch, runs plugin
 * `beforeSubmit`, echoes the user block, drives the agent prompt, and resolves
 * completion/error (including draining the queue). `interruptAcpPrompt` cancels
 * an in-flight turn. Reads shared state from the runtime store; thread helpers
 * and the queue entrypoint are injected (they live in app-root / queue-controller).
 */

import {
  type MessageContentItem,
  type QueuedPrompt,
  type UserSkillInvocationEcho,
  nextBlockId,
  useApp,
} from "../state";
import type { AcpClient, AcpSessionResult } from "../../acp/client";
import {
  promptInputText,
  withPromptInputSystemReminders,
  withPromptInputText,
  type PromptInput,
} from "../../core/prompt-submission";
import { childSessionCollaborationReminder } from "../../core/child-session-task-types";
import {
  appendLiveSessionInboxEvent,
  childCompletionDelivery,
  formatChildCompletionEvent,
  LIVE_SESSION_CONTINUATION_PROMPT,
  liveSessionInboxReminder,
  parseLiveSessionMessage,
  pendingLiveSessionInboxEvents,
} from "../../core/live-sessions";
import {
  threadRelaySessionName,
  type ChildTaskStatus,
  type LiveSessionInboxEvent,
  type PersistedLiveSessionMessage,
  type ThreadInfo,
} from "../../core/threads";
import { uuid } from "../../platform/crypto";
import { getChildSessionReminderTemplate, getConfig } from "../../config";
import { finalizeAcpPrompt, type AcpConversationAdapter } from "../../application/acp-mapping";
import { addAcpPromptErrorBlock, runAcpPromptTurn } from "../../application/acp-orchestration";
import { notify, type NotificationContext } from "../../notify";
import { store } from "./runtime-store";
import {
  currentThread,
  syncCurrentThreadStatus,
  syncThreadStatus,
  syncThreadTitle,
  updateThread,
} from "./thread-metadata";
import {
  releaseCurrentPromptDispatch,
  releasePromptDispatch,
  reservePromptDispatch,
  type PromptDispatchReservation,
} from "./prompt-dispatch";
import { setTurnTip, stopStartupTips } from "./status-indicators";
import { emitPluginEvent } from "./plugin-runtime";
import { showToast } from "./toast-controller";
import { finishTurnTimer, startTurnTimer } from "./turn-timer";
import { QUEUE_NAVIGATION_LABEL, type QueuePromptResult } from "../util/prompt-queue";
import { composeUserBashContext as composeUserBashContextFromPending } from "../util/submit";
import { completedPromptTurnDecision } from "../util/prompt-turn";
import { compactPreviewText, lastAssistantResponseText } from "../util/thread-preview";
import { promptTitleIntentFromText } from "../util/user-message";
import { pluginEventsFromBlockTransition, snapshotPluginBlocks, type PluginEventContext } from "./plugin-events";

type App = ReturnType<typeof useApp>;

export type PromptSubmissionOptions = {
  promptDispatchReservation?: PromptDispatchReservation;
  targetThreadId?: string;
  drainQueueOnCompletion?: boolean;
  includePendingBashContext?: boolean;
  drainQueueIncludePendingBashContext?: boolean;
  source?: "user" | "plugin" | "queue";
  suppressLocalEcho?: boolean;
  localEchoSkillInvocation?: UserSkillInvocationEcho;
};

export type AcpInterruptMode = "fire-and-forget" | "await-cancel";

export interface SubmitControllerDeps {
  queuePrompt: (
    input: PromptInput,
    app: App,
    placement?: "in-place" | "end",
    reason?: "queued" | "startup" | "active-turn-input-rejected" | "active-turn-input-error",
  ) => boolean;
  setQueueFocusIndex: (value: number | null) => void;
  isEditingQueuedPrompt: () => boolean;
  drainReadyPromptQueue: (app: App, threadId: string, options?: PromptSubmissionOptions) => boolean;
  admitPromptToThreadQueue: (input: PromptInput, app: App, threadId: string) => QueuePromptResult;
  threadClient: (threadId: string) => AcpClient | null;
  ensureThreadSession: (app: App, thread: ThreadInfo) => Promise<{ client: AcpClient; result?: AcpSessionResult }>;
  threadUiAdapter: (app: App, threadId: string) => AcpConversationAdapter;
  agentSlashSkillInvocationEcho: (text: string, app: App, threadId: string) => UserSkillInvocationEcho | null;
  threadNotificationContext: (app: App, threadId: string, overrides?: NotificationContext) => NotificationContext;
  getThreadPendingQueue: (app: App, threadId: string) => QueuedPrompt[];
}

export interface SubmitController {
  publishChildCompletion: (
    app: App,
    thread: ThreadInfo,
    status: ChildTaskStatus,
    result: string | undefined,
  ) => Promise<void>;
  submitPromptToAgent: (
    input: PromptInput,
    app: App,
    queuePlacement?: "in-place" | "end",
    options?: PromptSubmissionOptions,
  ) => Promise<void>;
  interruptAcpPrompt: (app: App, mode: AcpInterruptMode) => Promise<boolean>;
}

export function createSubmitController(deps: SubmitControllerDeps): SubmitController {
  const {
    queuePrompt,
    setQueueFocusIndex,
    isEditingQueuedPrompt,
    drainReadyPromptQueue,
    admitPromptToThreadQueue,
    threadClient,
    ensureThreadSession,
    threadUiAdapter,
    agentSlashSkillInvocationEcho,
    threadNotificationContext,
    getThreadPendingQueue,
  } = deps;

  async function publishChildCompletion(
    app: App,
    thread: ThreadInfo,
    status: ChildTaskStatus,
    result: string | undefined,
  ): Promise<void> {
    if (!thread.parentThreadId) return;
    const parent = appThread(app, thread.parentThreadId);
    if (!parent) return;
    const event: LiveSessionInboxEvent = {
      id: `re_${uuid().replaceAll("-", "")}`,
      kind: "completion",
      sourceSessionId: thread.relaySessionId ?? thread.id,
      sourceSessionName: threadRelaySessionName(thread),
      content: formatChildCompletionEvent(threadRelaySessionName(thread), status, result),
      createdAt: new Date().toISOString(),
      childTaskStatus: status,
    };
    updateThread(app, parent.id, {
      liveSessionInbox: appendLiveSessionInboxEvent(parent.liveSessionInbox, event),
    });

    const markForContinuation = (): void => {
      const latestParent = appThread(app, parent.id) ?? parent;
      updateThread(app, parent.id, {
        liveSessionInbox: (latestParent.liveSessionInbox ?? []).map((candidate) =>
          candidate.id === event.id ? { ...candidate, requiresContinuation: true } : candidate,
        ),
      });
    };
    const latestParent = appThread(app, parent.id) ?? parent;
    const parentClient = threadClient(parent.id);
    const delivery = childCompletionDelivery({
      parentRunning: latestParent.status === "running",
      parentWaiting: store.liveSessionWaitingThreads.has(parent.id),
      supportsActiveTurnInput: Boolean(parentClient?.supportsActiveTurnInput()),
    });

    if (delivery === "steer" && parentClient) {
      try {
        const steered = await parentClient.sendActiveTurnInput(event.content, latestParent.sessionId ?? undefined);
        if (steered.accepted) {
          const deliveredAt = new Date().toISOString();
          const refreshedParent = appThread(app, parent.id) ?? latestParent;
          const acpSessionId = refreshedParent.sessionId ?? parentClient.sessionId;
          const blockId = `live-${event.id}`;
          const persistedMessage: PersistedLiveSessionMessage | undefined = acpSessionId
            ? {
                id: blockId,
                acpSessionId,
                content: event.content,
                delivery: "current-turn-guidance",
                createdAt: deliveredAt,
              }
            : undefined;
          updateThread(app, parent.id, {
            liveSessionInbox: (refreshedParent.liveSessionInbox ?? []).map((candidate) =>
              candidate.id === event.id ? { ...candidate, deliveredAt, consumedAt: deliveredAt } : candidate,
            ),
            ...(persistedMessage
              ? { liveSessionMessages: [...(refreshedParent.liveSessionMessages ?? []), persistedMessage] }
              : {}),
          });
          deps.threadUiAdapter(app, parent.id).addBlock({
            type: "user",
            id: blockId,
            content: event.content,
            origin: "local",
            delivery: "current-turn-guidance",
          });
          return;
        }
      } catch {
        // The parent may have gone idle while the child was publishing its result.
      }
    }

    const refreshedParent = appThread(app, parent.id) ?? latestParent;
    if (refreshedParent.status === "running" || store.liveSessionWaitingThreads.has(parent.id)) {
      markForContinuation();
      return;
    }
    if (store.liveSessionContinuationThreads.has(parent.id)) return;
    store.liveSessionContinuationThreads.add(parent.id);
    await submitPromptToAgent(LIVE_SESSION_CONTINUATION_PROMPT, app, "end", {
      source: "plugin",
      targetThreadId: parent.id,
      suppressLocalEcho: true,
      drainQueueOnCompletion: true,
    });
    if ((appThread(app, parent.id) ?? parent).status !== "running") {
      store.liveSessionContinuationThreads.delete(parent.id);
    }
  }

  function appThread(app: App, threadId: string): ThreadInfo | undefined {
    return app.state.threads.find((thread) => thread.id === threadId);
  }

  function pluginEventContext(thread: ThreadInfo, client: AcpClient | null, raw?: unknown): PluginEventContext {
    return {
      threadId: thread.id,
      sessionId: client?.sessionId ?? thread.sessionId ?? null,
      cwd: thread.cwd,
      ...(raw !== undefined ? { raw } : {}),
    };
  }

  function emitPluginBlockTransitionEvents(
    before: ReturnType<typeof snapshotPluginBlocks>,
    adapter: AcpConversationAdapter,
    ctx: PluginEventContext,
  ): void {
    const after = snapshotPluginBlocks(adapter.state.blocks);
    for (const event of pluginEventsFromBlockTransition(before, after, ctx)) emitPluginEvent(event);
  }

  function localEchoContentItemsWithSystemReminders(
    text: string,
    systemReminders: readonly string[],
  ): MessageContentItem[] | null {
    const reminderItems = systemReminders
      .map((reminder) => reminder.trim())
      .filter((reminder) => reminder.length > 0)
      .map((reminder): MessageContentItem => ({ type: "text", text: `system-reminder: ${reminder}` }));
    if (reminderItems.length === 0) return null;
    return [...(text.length > 0 ? ([{ type: "text", text }] satisfies MessageContentItem[]) : []), ...reminderItems];
  }

  function markAcpPromptInterrupted(app: App): void {
    if (!app.state.running) return;
    const thread = currentThread(app);
    const client = thread ? threadClient(thread.id) : null;
    const adapter = thread ? threadUiAdapter(app, thread.id) : null;
    const ctx = thread ? pluginEventContext(thread, client) : null;
    const beforeBlocks = adapter ? snapshotPluginBlocks(adapter.state.blocks) : null;
    const shouldEmitTurnEnd = !store.cancelRequested && ctx !== null;
    const currentBlockId = app.state.currentBlockId;
    if (currentBlockId) {
      const currentBlock = app.state.blocks.find((block) => block.id === currentBlockId);
      if (currentBlock?.type === "content" || currentBlock?.type === "thinking") {
        app.updateBlock(currentBlockId, { finalized: true });
      }
    }
    if (!store.cancelRequested) {
      store.cancelRequested = true;
      if (thread) {
        const runId = store.threadPromptRunIds.get(thread.id) ?? 0;
        if (runId > 0) store.suppressedThreadPromptRunIds.set(thread.id, runId);
        store.threadPromptRunIds.set(thread.id, runId + 1);
        releaseCurrentPromptDispatch(thread.id);
        if (thread.parentThreadId) {
          updateThread(app, thread.id, {
            childTaskStatus: "interrupted",
            childTaskFinishedAt: new Date().toISOString(),
          });
          const interruptedChild = appThread(app, thread.id) ?? thread;
          void publishChildCompletion(app, interruptedChild, "interrupted", "Child session was interrupted.");
        }
      }
      const queuedCount = app.state.pendingQueue.length;
      app.addBlock({
        type: "info",
        id: nextBlockId(),
        content:
          queuedCount > 0
            ? `Interrupted; ${queuedCount} queued prompt${queuedCount === 1 ? "" : "s"} preserved. Use ${QUEUE_NAVIGATION_LABEL} to manage queue.`
            : "Interrupted by user",
        variant: "info",
      });
    }
    if (adapter && ctx && beforeBlocks) emitPluginBlockTransitionEvents(beforeBlocks, adapter, ctx);
    if (shouldEmitTurnEnd && ctx) emitPluginEvent({ type: "turn:end", ...ctx, outcome: "cancelled" });
    finishTurnTimer(app);
    syncCurrentThreadStatus(app, "paused");
    app.setState("running", false);
    app.setState("spinnerActive", false);
    app.setState("spinnerLabel", "");
    app.setCurrentBlockId(null);
    app.setState("lastAcpActivityKind", null);
    app.setState("lastAcpActivityLabel", "");
    app.setState("lastAcpActivityAt", null);
  }

  async function interruptAcpPrompt(app: App, mode: AcpInterruptMode): Promise<boolean> {
    const client = store.acpClient;
    if (!client || !app.state.running) return false;
    const cancelSettled = client.cancel();
    if (mode === "await-cancel") {
      try {
        await cancelSettled;
      } catch {
        return false;
      }
      markAcpPromptInterrupted(app);
      return true;
    }
    markAcpPromptInterrupted(app);
    void cancelSettled.catch(() => undefined);
    return true;
  }

  async function submitPromptToAgent(
    input: PromptInput,
    app: App,
    queuePlacement: "in-place" | "end" = "in-place",
    options: PromptSubmissionOptions = {},
  ): Promise<void> {
    const targetThreadId = options.targetThreadId;
    const thread = targetThreadId
      ? app.state.threads.find((item) => item.id === targetThreadId && !item.archived)
      : currentThread(app);
    const appInstanceId = store.activeAppInstanceId;
    let promptInput = input;
    let text = promptInputText(input);
    const queueOrRejectPluginPrompt = (
      placement: "in-place" | "end",
      reason?: "queued" | "startup" | "active-turn-input-rejected" | "active-turn-input-error",
    ): Promise<void> => {
      const result =
        thread && thread.id !== app.state.activeThreadId ? admitPromptToThreadQueue(promptInput, app, thread.id) : null;
      const accepted = result ? result.accepted : queuePrompt(promptInput, app, placement, reason);
      return !accepted && options.source === "plugin"
        ? Promise.reject(new Error("Prompt queue is full"))
        : Promise.resolve();
    };
    if (!thread) {
      if (targetThreadId) {
        if (options.promptDispatchReservation) releasePromptDispatch(targetThreadId, options.promptDispatchReservation);
        return;
      }
      if (store.activeAcpLaunchOptions || app.state.connecting) {
        await queueOrRejectPluginPrompt(queuePlacement, "startup");
        return;
      }
      showToast(
        "No ACP agent configured. Use --agent or set [agents].default in ~/.config/relay/config.toml.",
        "warning",
      );
      return;
    }
    if (app.state.connecting || thread.status === "connecting") {
      await queueOrRejectPluginPrompt(queuePlacement, "startup");
      return;
    }

    const editingActiveThread = isEditingQueuedPrompt() && thread.id === app.state.activeThreadId;
    if (editingActiveThread) {
      await queueOrRejectPluginPrompt(options.source === "plugin" ? "end" : queuePlacement);
      return;
    }
    if (thread.status === "running") {
      await queueOrRejectPluginPrompt(queuePlacement);
      return;
    }

    const dispatchReservation = options.promptDispatchReservation ?? reservePromptDispatch(thread.id);
    if (!dispatchReservation) {
      await queueOrRejectPluginPrompt(queuePlacement);
      return;
    }
    let dispatchReleased = false;
    const releaseDispatch = () => {
      if (dispatchReleased) return;
      dispatchReleased = true;
      releasePromptDispatch(thread.id, dispatchReservation);
    };

    const source = options.source ?? "user";
    let intercepted: { text: string; handled: boolean };
    try {
      intercepted = await (store.pluginRunner?.beforeSubmit(text, source) ?? Promise.resolve({ text, handled: false }));
    } catch (err) {
      releaseDispatch();
      throw err; // effect-shape-allow: preserve existing async prompt interception failure behavior.
    }
    if (intercepted.handled) {
      releaseDispatch();
      drainReadyPromptQueue(app, thread.id, options);
      return;
    }
    text = intercepted.text;
    promptInput = withPromptInputText(promptInput, text);
    const localEchoSkillInvocation =
      options.localEchoSkillInvocation ?? agentSlashSkillInvocationEcho(text, app, thread.id);
    if (thread.id === app.state.activeThreadId) {
      const titleIntent = promptTitleIntentFromText(text, localEchoSkillInvocation);
      app.setState("latestPromptTitleIntent", titleIntent);
    }
    syncThreadTitle(app, thread.id, text, localEchoSkillInvocation);

    stopStartupTips(app);
    setQueueFocusIndex(null);

    const shouldIncludePendingBash =
      thread.id === app.state.activeThreadId && (options.includePendingBashContext ?? source !== "plugin");
    const pendingBash = shouldIncludePendingBash ? app.state.pendingUserBashResults : [];
    const composedText = shouldIncludePendingBash ? composeUserBashContextFromPending(text, pendingBash) : text;
    const composedInput = withPromptInputText(promptInput, composedText);
    if (shouldIncludePendingBash && pendingBash.length > 0) {
      app.setState("pendingUserBashResults", []);
    }

    let promptClient = threadClient(thread.id);
    if (!promptClient || !thread.sessionId) {
      try {
        promptClient = (await ensureThreadSession(app, thread)).client;
      } catch (err) {
        releaseDispatch();
        showToast(`Failed to start ACP session: ${err}`, "error", 6000);
        return;
      }
    }

    if (promptClient) {
      const adapter = threadUiAdapter(app, thread.id);
      let localEchoBlockId: string | null = null;
      if (localEchoSkillInvocation) {
        localEchoBlockId = nextBlockId();
        adapter.addBlock({
          type: "user",
          id: localEchoBlockId,
          content: text,
          origin: "local",
          skillInvocation: localEchoSkillInvocation,
        });
      } else if (options.suppressLocalEcho !== true) {
        localEchoBlockId = nextBlockId();
        adapter.addBlock({ type: "user", id: localEchoBlockId, content: text, origin: "local" });
      }
      syncThreadStatus(app, thread.id, "running", { touch: true });
      if (thread.parentThreadId) {
        updateThread(app, thread.id, {
          childTaskStatus: "running",
          childTaskFinishedAt: undefined,
          latestResultPreview: undefined,
        });
      }
      if (thread.id === app.state.activeThreadId) {
        app.setState("running", true);
        app.setState("spinnerActive", true);
        app.setState("spinnerLabel", "");
        setTurnTip(app);
        app.setCurrentBlockId(null);
        app.setState("generationSeconds", 0);
        app.setState("elapsedSeconds", 0);
        app.setState("lastAcpActivityKind", null);
        app.setState("lastAcpActivityLabel", "");
        app.setState("lastAcpActivityAt", null);
        startTurnTimer(app);
      }

      store.cancelRequested = false;
      store.historyLoadedSessionIdsByThread.delete(thread.id);
      store.suppressedThreadPromptRunIds.delete(thread.id);
      const promptRunId = (store.threadPromptRunIds.get(thread.id) ?? 0) + 1;
      store.threadPromptRunIds.set(thread.id, promptRunId);
      const turnCtx = pluginEventContext(thread, promptClient);
      emitPluginEvent({ type: "turn:start", ...turnCtx, text, source });
      emitPluginEvent({ type: "prompt:submitted", ...turnCtx, text });
      const isPromptCurrent = () => {
        if (appInstanceId !== store.activeAppInstanceId) return false;
        if (threadClient(thread.id) !== promptClient) return false;
        if ((store.threadPromptRunIds.get(thread.id) ?? 0) !== promptRunId) return false;
        return true;
      };

      runAcpPromptTurn({
        prompt: async () => {
          const reminderContext = { ...turnCtx, text, source };
          const pluginSystemReminders = await (store.pluginRunner?.systemReminders(reminderContext) ??
            Promise.resolve([]));
          const liveSessionReminder =
            !thread.parentThreadId && source !== "plugin" && parseLiveSessionMessage(text) === null
              ? childSessionCollaborationReminder({
                  template: getChildSessionReminderTemplate(),
                  prompt: text,
                  taskTypes: getConfig().task_types,
                  currentSessionName: threadRelaySessionName(thread),
                })
              : undefined;
          const inboxEvents = pendingLiveSessionInboxEvents(thread);
          const inboxReminder = liveSessionInboxReminder(inboxEvents);
          const systemReminders = [
            ...pluginSystemReminders,
            ...(liveSessionReminder ? [liveSessionReminder] : []),
            ...(inboxReminder ? [inboxReminder] : []),
          ];
          const localEchoContentItems = localEchoContentItemsWithSystemReminders(text, systemReminders);
          if (localEchoBlockId && !localEchoSkillInvocation && localEchoContentItems) {
            adapter.updateBlock(localEchoBlockId, { contentItems: localEchoContentItems });
          }
          const admittedPrompt = promptClient.prompt(withPromptInputSystemReminders(composedInput, systemReminders));
          if (inboxEvents.length > 0) {
            const deliveredIds = new Set(inboxEvents.map((event) => event.id));
            const deliveredAt = new Date().toISOString();
            const latestThread = appThread(app, thread.id) ?? thread;
            updateThread(app, thread.id, {
              liveSessionInbox: (latestThread.liveSessionInbox ?? []).map((event) =>
                deliveredIds.has(event.id) ? { ...event, deliveredAt, consumedAt: deliveredAt } : event,
              ),
            });
          }
          return admittedPrompt;
        },
        isCurrent: isPromptCurrent,
        onComplete: async (response) => {
          if (thread.id === app.state.activeThreadId) finishTurnTimer(app);
          const completeCtx = pluginEventContext(thread, promptClient);
          const beforeBlocks = snapshotPluginBlocks(adapter.state.blocks);
          finalizeAcpPrompt(adapter, response);
          emitPluginBlockTransitionEvents(beforeBlocks, adapter, pluginEventContext(thread, promptClient, response));
          emitPluginEvent({ type: "prompt:complete", ...completeCtx });
          emitPluginEvent({ type: "turn:end", ...completeCtx, outcome: "complete" });
          const notificationContext = threadNotificationContext(app, thread.id, {
            query: compactPreviewText(text, 200, false),
            response: compactPreviewText(lastAssistantResponseText(adapter.state.blocks), 200, false),
          });
          syncThreadStatus(app, thread.id, "paused");
          if (!thread.parentThreadId) store.liveSessionContinuationThreads.delete(thread.id);
          if (thread.parentThreadId) {
            const interrupted = thread.id === app.state.activeThreadId && store.cancelRequested;
            const childTaskStatus = interrupted ? "interrupted" : "done";
            const childResult = lastAssistantResponseText(adapter.state.blocks);
            updateThread(app, thread.id, {
              childTaskStatus,
              childTaskFinishedAt: new Date().toISOString(),
              latestResultPreview: compactPreviewText(childResult, 240, false),
            });
            const completedChild = appThread(app, thread.id) ?? thread;
            await publishChildCompletion(app, completedChild, childTaskStatus, childResult);
          }
          if (!thread.parentThreadId) {
            const latestThread = appThread(app, thread.id) ?? thread;
            const requiresContinuation = (latestThread.liveSessionInbox ?? []).some(
              (event) => event.requiresContinuation && !event.consumedAt,
            );
            if (requiresContinuation) {
              deps.admitPromptToThreadQueue(LIVE_SESSION_CONTINUATION_PROMPT, app, thread.id);
              options.drainQueueOnCompletion = true;
            }
          }
          releaseDispatch();

          const queue = getThreadPendingQueue(app, thread.id);
          const completionDecision = completedPromptTurnDecision({
            queuedPromptCount:
              queue.length + (thread.id === app.state.activeThreadId && isEditingQueuedPrompt() ? 1 : 0),
            cancelRequested: thread.id === app.state.activeThreadId && store.cancelRequested,
            drainQueueOnCompletion: options.drainQueueOnCompletion,
          });

          if (completionDecision.shouldNotifyCompletion) {
            notify("completion", notificationContext);
          }
          if (completionDecision.shouldDrainQueue) {
            drainReadyPromptQueue(app, thread.id, options);
          }
        },
        onError: async (err, promptError) => {
          if (thread.id === app.state.activeThreadId) {
            finishTurnTimer(app);
            notify(
              "error",
              threadNotificationContext(app, thread.id, {
                query: compactPreviewText(text, 200, false),
                response: compactPreviewText(promptError, 200, false),
              }),
            );
          }
          const errorCtx = pluginEventContext(thread, promptClient);
          const errorTransitionCtx = pluginEventContext(thread, promptClient, err);
          const beforeBlocks = snapshotPluginBlocks(adapter.state.blocks);
          emitPluginEvent({ type: "prompt:error", ...errorCtx, error: promptError });
          addAcpPromptErrorBlock(adapter, String(err));
          emitPluginBlockTransitionEvents(beforeBlocks, adapter, errorTransitionCtx);
          emitPluginEvent({ type: "turn:end", ...errorCtx, outcome: "error", error: promptError });
          syncThreadStatus(app, thread.id, "paused");
          if (!thread.parentThreadId) store.liveSessionContinuationThreads.delete(thread.id);
          if (thread.parentThreadId) {
            updateThread(app, thread.id, {
              childTaskStatus: "failed",
              childTaskFinishedAt: new Date().toISOString(),
              latestResultPreview: compactPreviewText(promptError, 240, false),
            });
            const failedChild = appThread(app, thread.id) ?? thread;
            await publishChildCompletion(app, failedChild, "failed", promptError);
          }
          releaseDispatch();
          adapter.setState("running", false);
          adapter.setState("spinnerActive", false);
          adapter.setState("spinnerLabel", "");
          adapter.setCurrentBlockId(null);
          if (thread.id === app.state.activeThreadId) {
            app.setState("lastAcpActivityKind", null);
            app.setState("lastAcpActivityLabel", "");
            app.setState("lastAcpActivityAt", null);
          }
        },
        onSettled: () => {
          releaseDispatch();
          if ((store.threadPromptRunIds.get(thread.id) ?? 0) === promptRunId) {
            store.threadPromptRunIds.delete(thread.id);
          }
          if (store.suppressedThreadPromptRunIds.get(thread.id) === promptRunId) {
            store.suppressedThreadPromptRunIds.delete(thread.id);
          }
        },
      });
      return;
    }

    releaseDispatch();
    showToast(
      "No ACP agent configured. Use --agent or set [agents].default in ~/.config/relay/config.toml.",
      "warning",
    );
  }

  return { publishChildCompletion, submitPromptToAgent, interruptAcpPrompt };
}
