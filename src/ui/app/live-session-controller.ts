import { randomUUID } from "node:crypto";
import type { AcpClient, AcpSessionResult } from "../../acp/client";
import {
  availableModelIdsFromSessionResult,
  availableThinkingLevelsFromSessionResult,
  currentModelIdFromSessionResult,
  currentThinkingLevelFromSessionResult,
  modelConfigIdFromSessionResult,
  thinkingConfigIdFromSessionResult,
} from "../../acp/session-config";
import {
  appendLiveSessionInboxEvent,
  childSessionHistoryFromValue,
  childSessionHistoryLabel,
  childSessionOpeningPrompt,
  canCancelLiveSession,
  canInspectLiveSession,
  canMessageLiveSession,
  formatLiveSessionMessage,
  inspectedSessionContextTurns,
  isLiveSessionVisibleTo,
  isTerminalChildTaskStatus,
  LIVE_SESSION_CONTINUATION_ACKNOWLEDGEMENT,
  LIVE_SESSION_MESSAGE_MAX_BYTES,
  LIVE_SESSION_PROTOCOL_VERSION,
  LIVE_SESSION_WAIT_DEFAULT_MS,
  LIVE_SESSION_WAIT_MAX_MS,
  LIVE_SESSION_WAIT_MIN_MS,
  liveSessionMessageRelation,
  liveSessionRole,
  MAX_ACTIVE_CHILD_SESSIONS,
  type CreateChildSessionInput,
  type LiveSessionControlRequest,
  type LiveSessionControlResponse,
  type LiveSessionMessageResult,
} from "../../core/live-sessions";
import {
  createRelaySessionId,
  normalizeRelaySessionName,
  relaySessionNameFromId,
  summarizeThreadRequest,
  threadRelaySessionName,
  type LiveSessionInboxEvent,
  type PersistedLiveSessionMessage,
  type ThreadInfo,
} from "../../core/threads";
import type { PromptSubmissionOptions } from "./submit-controller";
import type { ChatBlock, useApp } from "../state";
import { liveSessionInfo } from "./live-session-runtime";
import { mergeSessionCapabilities, store } from "./runtime-store";
import { updateThread } from "./thread-metadata";
import { lastAssistantResponseText } from "../util/thread-preview";

export type LiveSessionApp = ReturnType<typeof useApp>;

export interface LiveSessionControllerDeps {
  readonly app: LiveSessionApp;
  readonly agentName: () => string;
  readonly createThread: (
    app: LiveSessionApp,
    inWorktree: boolean,
    options?: {
      readonly snapshotCurrent?: boolean;
      readonly cwd?: string;
      readonly select?: boolean;
      readonly parentThreadId?: string;
      readonly relationKind?: "child" | "handoff";
      readonly relationGoal?: string;
      readonly title?: string;
      readonly relaySessionName?: string;
      readonly childTaskType?: string;
      readonly agentName?: string;
      readonly modelId?: string;
      readonly thinkingLevel?: string;
    },
  ) => Promise<ThreadInfo>;
  readonly ensureThreadSession: (
    app: LiveSessionApp,
    thread: ThreadInfo,
  ) => Promise<{ readonly client: AcpClient; readonly result?: AcpSessionResult }>;
  readonly submitPromptToAgent: (
    text: string,
    app: LiveSessionApp,
    queuePlacement?: "in-place" | "end",
    options?: PromptSubmissionOptions,
  ) => Promise<void>;
  readonly publishChildCompletion?: (
    app: LiveSessionApp,
    thread: ThreadInfo,
    status: "done" | "failed" | "interrupted",
    result: string | undefined,
  ) => Promise<void>;
  readonly threadClient: (threadId: string) => AcpClient | null;
  readonly queuePromptForThread?: (text: string, threadId: string) => boolean;
  readonly threadUiAdapter: (
    app: LiveSessionApp,
    threadId: string,
  ) => {
    readonly state: { readonly blocks: readonly ChatBlock[] };
    addBlock: (block: {
      type: "user";
      id: string;
      content: string;
      origin: "local";
      delivery: "current-turn-guidance";
    }) => void;
  };
}

export interface LiveSessionController {
  readonly createChildSession: (input: CreateChildSessionInput) => Promise<ThreadInfo>;
  readonly handleRequest: (request: LiveSessionControlRequest) => Promise<LiveSessionControlResponse>;
}

function success(requestId: string, result: unknown): LiveSessionControlResponse {
  return { version: LIVE_SESSION_PROTOCOL_VERSION, requestId, ok: true, result };
}

function failure(requestId: string, code: string, message: string): LiveSessionControlResponse {
  return { version: LIVE_SESSION_PROTOCOL_VERSION, requestId, ok: false, error: { code, message } };
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function createLiveSessionController(deps: LiveSessionControllerDeps): LiveSessionController {
  const { app } = deps;
  const pendingSessionNames = new Set<string>();
  const pendingChildNamesByParent = new Map<string, Set<string>>();
  const reportedTerminalChildrenByParent = new Map<string, Set<string>>();

  function threadBySessionId(sessionId: string): ThreadInfo | undefined {
    return app.state.threads.find(
      (thread) =>
        !thread.archived && (thread.relaySessionId ?? thread.id) === sessionId && deps.threadClient(thread.id) !== null,
    );
  }

  function threadBySessionName(sessionName: string): ThreadInfo | undefined {
    return app.state.threads.find(
      (thread) =>
        !thread.archived && threadRelaySessionName(thread) === sessionName && deps.threadClient(thread.id) !== null,
    );
  }

  function sessionInfo(thread: ThreadInfo) {
    return liveSessionInfo(thread, app.state.threads, deps.agentName());
  }

  function requesterThread(params: Record<string, unknown>): ThreadInfo | undefined {
    const requesterSessionId = stringParam(params, "requesterSessionId");
    const requesterSessionName = stringParam(params, "requesterSessionName");
    if (!requesterSessionId && !requesterSessionName) return undefined;
    const byId = requesterSessionId ? threadBySessionId(requesterSessionId) : undefined;
    const byName = requesterSessionName ? threadBySessionName(requesterSessionName) : undefined;
    if (byId && byName && byId.id !== byName.id) return undefined;
    return byId ?? byName;
  }

  function hasRequesterIdentity(params: Record<string, unknown>): boolean {
    return Boolean(stringParam(params, "requesterSessionId") || stringParam(params, "requesterSessionName"));
  }

  function isActiveChild(thread: ThreadInfo): boolean {
    if (isTerminalChildTaskStatus(thread.childTaskStatus)) return false;
    return (
      thread.childTaskStatus === "starting" ||
      thread.childTaskStatus === "running" ||
      thread.status === "connecting" ||
      thread.status === "running"
    );
  }

  function activeChildCount(parentThreadId: string): number {
    return app.state.threads.filter(
      (thread) => !thread.archived && thread.parentThreadId === parentThreadId && isActiveChild(thread),
    ).length;
  }

  function reservedChildCapacity(parentThreadId: string): number {
    const pendingNames = pendingChildNamesByParent.get(parentThreadId) ?? new Set<string>();
    const representedPendingNames = new Set(
      app.state.threads.flatMap((thread) =>
        !thread.archived &&
        thread.parentThreadId === parentThreadId &&
        isActiveChild(thread) &&
        thread.relaySessionName &&
        pendingNames.has(thread.relaySessionName)
          ? [thread.relaySessionName]
          : [],
      ),
    );
    return activeChildCount(parentThreadId) + pendingNames.size - representedPendingNames.size;
  }

  function terminalChildKey(thread: ThreadInfo): string {
    return `${thread.id}:${thread.childTaskFinishedAt ?? thread.childTaskStatus ?? "terminal"}`;
  }

  function childResult(thread: ThreadInfo): string | undefined {
    const result =
      thread.childTaskStatus === "done"
        ? lastAssistantResponseText(deps.threadUiAdapter(app, thread.id).state.blocks).trim()
        : "";
    return result || thread.latestResultPreview?.trim() || undefined;
  }

  function childSessionName(value: string | undefined): string {
    const liveNames = app.state.threads.flatMap((thread) =>
      !thread.archived && deps.threadClient(thread.id) !== null ? [threadRelaySessionName(thread)] : [],
    );
    const unavailableNames = [...liveNames, ...pendingSessionNames];
    const name = value
      ? normalizeRelaySessionName(value)
      : relaySessionNameFromId(createRelaySessionId(), unavailableNames);
    if (unavailableNames.includes(name)) {
      throw new Error(`Session name ${name} is already in use`); // effect-shape-allow: control request reports duplicate live session name.
    }
    return name;
  }

  function attributedMessageText(
    target: ThreadInfo,
    senderSessionId: string | undefined,
    senderSessionName: string | undefined,
    text: string,
  ): string {
    const sender = senderSessionId
      ? threadBySessionId(senderSessionId)
      : senderSessionName
        ? threadBySessionName(senderSessionName)
        : undefined;
    const senderName = sender ? threadRelaySessionName(sender) : senderSessionName;
    if (!senderName) return text;
    if (!sender) return formatLiveSessionMessage("session", senderName, text);
    return formatLiveSessionMessage(
      liveSessionMessageRelation(sessionInfo(sender), sessionInfo(target)),
      senderName,
      text,
    );
  }

  async function configureChildSession(
    threadId: string,
    client: AcpClient,
    initialResult: AcpSessionResult | undefined,
    model: string | undefined,
    thinkingLevel: string | undefined,
  ): Promise<void> {
    if (!model && !thinkingLevel) return;
    if (!initialResult) throw new Error("Child session capabilities are unavailable"); // effect-shape-allow: control request reports unavailable child configuration capabilities.
    let capabilities = initialResult;
    if (model) {
      const configId = modelConfigIdFromSessionResult(capabilities);
      const available = availableModelIdsFromSessionResult(capabilities);
      if (!configId) throw new Error("The active agent does not support model selection"); // effect-shape-allow: control request reports unsupported explicit child configuration.
      if (!available.includes(model)) {
        throw new Error(`Model ${model} is unavailable. Available models: ${available.join(", ") || "none"}`); // effect-shape-allow: control request reports unavailable explicit child configuration.
      }
      capabilities = await client.setSessionModel(model, configId);
      store.threadSessionCapabilities.set(
        threadId,
        mergeSessionCapabilities(store.threadSessionCapabilities.get(threadId), capabilities),
      );
    }
    if (thinkingLevel) {
      const configId = thinkingConfigIdFromSessionResult(capabilities);
      const available = availableThinkingLevelsFromSessionResult(capabilities);
      if (!configId) throw new Error("The active agent does not support thinking-level selection"); // effect-shape-allow: control request reports unsupported explicit child configuration.
      if (!available.includes(thinkingLevel)) {
        throw new Error( // effect-shape-allow: control request reports unavailable explicit child configuration.
          `Thinking level ${thinkingLevel} is unavailable. Available thinking levels: ${available.join(", ") || "none"}`,
        );
      }
      const result = await client.setSessionThinkingLevel(thinkingLevel, configId);
      store.threadSessionCapabilities.set(
        threadId,
        mergeSessionCapabilities(store.threadSessionCapabilities.get(threadId), result),
      );
    }
  }

  async function deliverInboxMessage(
    target: ThreadInfo,
    sender: ThreadInfo | undefined,
    content: string,
    notifyActiveParent: boolean,
  ): Promise<LiveSessionMessageResult> {
    const event: LiveSessionInboxEvent = {
      id: `re_${randomUUID().replaceAll("-", "")}`,
      kind: "message",
      sourceSessionId: sender?.relaySessionId ?? sender?.id ?? "external",
      sourceSessionName: sender ? threadRelaySessionName(sender) : "external-shell",
      content,
      createdAt: new Date().toISOString(),
    };
    const latestTarget = app.state.threads.find((thread) => thread.id === target.id) ?? target;
    updateThread(app, target.id, {
      liveSessionInbox: appendLiveSessionInboxEvent(latestTarget.liveSessionInbox, event),
    });
    const client = deps.threadClient(target.id);
    if (notifyActiveParent && target.status === "running" && client?.supportsActiveTurnInput()) {
      const delivery = await client.sendActiveTurnInput(content);
      if (delivery.accepted) {
        const deliveredAt = new Date().toISOString();
        const refreshedTarget = app.state.threads.find((thread) => thread.id === target.id) ?? latestTarget;
        updateThread(app, target.id, {
          liveSessionInbox: (refreshedTarget.liveSessionInbox ?? []).map((candidate) =>
            candidate.id === event.id ? { ...candidate, deliveredAt } : candidate,
          ),
        });
        return {
          messageId: event.id,
          targetSessionId: target.relaySessionId ?? target.id,
          delivery: "steered",
          accepted: true,
        };
      }
    }
    return {
      messageId: event.id,
      targetSessionId: target.relaySessionId ?? target.id,
      delivery: "queued",
      accepted: true,
    };
  }

  async function createChildSession(input: CreateChildSessionInput): Promise<ThreadInfo> {
    const parent = threadBySessionId(input.parentSessionId);
    if (!parent) throw new Error(`Parent session ${input.parentSessionId} was not found`); // effect-shape-allow: control request reports invalid live-session target.
    if (liveSessionRole(parent) !== "parent") {
      throw new Error(`Child session ${threadRelaySessionName(parent)} cannot create sessions`); // effect-shape-allow: control request enforces the two-level live-session hierarchy.
    }
    if (reservedChildCapacity(parent.id) >= MAX_ACTIVE_CHILD_SESSIONS) {
      // effect-shape-allow: control request reports live-session capacity.
      throw new Error(
        `Parent session ${threadRelaySessionName(parent)} already has ${MAX_ACTIVE_CHILD_SESSIONS} active children`,
      ); // effect-shape-allow: control request reports live-session capacity.
    }
    const task = input.task.trim();
    if (!task) throw new Error("Child task must not be empty"); // effect-shape-allow: control request reports invalid child task.
    const basePrompt = input.openingPrompt?.trim() || task;
    const openingPrompt = childSessionOpeningPrompt(
      basePrompt,
      deps.threadUiAdapter(app, parent.id).state.blocks,
      input.history ?? { mode: "none" },
      parent.status === "running" || parent.status === "connecting",
    );
    const sessionName = childSessionName(input.name);
    const parentAgent = parent.agentName ?? deps.agentName();
    const agent = input.agent?.trim() || parentAgent;
    const inheritsParentConfiguration = agent === parentAgent;
    const parentCapabilities = store.threadSessionCapabilities.get(parent.id);
    const model =
      input.model?.trim() ||
      (inheritsParentConfiguration
        ? (currentModelIdFromSessionResult(parentCapabilities) ?? parent.modelId)
        : undefined);
    const thinkingLevel =
      input.thinkingLevel?.trim() ||
      (inheritsParentConfiguration
        ? (currentThinkingLevelFromSessionResult(parentCapabilities) ?? parent.thinkingLevel)
        : undefined);
    pendingSessionNames.add(sessionName);
    const pendingChildNames = pendingChildNamesByParent.get(parent.id) ?? new Set<string>();
    pendingChildNames.add(sessionName);
    pendingChildNamesByParent.set(parent.id, pendingChildNames);
    let child: ThreadInfo | undefined;
    try {
      const createdChild = await deps.createThread(app, input.worktree === true, {
        snapshotCurrent: false,
        cwd: parent.cwd,
        select: false,
        parentThreadId: parent.id,
        relationKind: input.relation ?? "child",
        relationGoal: task,
        title: input.name?.trim() || summarizeThreadRequest(task),
        relaySessionName: sessionName,
        childTaskType: input.taskType,
        agentName: agent,
        modelId: model,
        thinkingLevel,
      });
      child = createdChild;
      const session = await deps.ensureThreadSession(app, createdChild);
      await configureChildSession(createdChild.id, session.client, session.result, model, thinkingLevel);
      const startedChild = app.state.threads.find((thread) => thread.id === createdChild.id) ?? createdChild;
      if (parent.sessionId && startedChild.sessionId) {
        updateThread(app, createdChild.id, {
          relationParentSessionId: parent.sessionId,
          relationChildSessionId: startedChild.sessionId,
        });
      }
      await deps.submitPromptToAgent(openingPrompt, app, "in-place", {
        source: "plugin",
        targetThreadId: createdChild.id,
        drainQueueOnCompletion: true,
      });
      return app.state.threads.find((thread) => thread.id === createdChild.id) ?? createdChild;
    } catch (error) {
      if (child) {
        const failedChild = child;
        const failure = error instanceof Error ? error.message : String(error);
        updateThread(app, failedChild.id, {
          childTaskStatus: "failed",
          childTaskFinishedAt: new Date().toISOString(),
          latestResultPreview: failure.slice(0, 240),
        });
        await deps.publishChildCompletion?.(
          app,
          app.state.threads.find((thread) => thread.id === failedChild.id) ?? failedChild,
          "failed",
          failure,
        );
      }
      throw error; // effect-shape-allow: child startup preserves the original failure for the control response.
    } finally {
      pendingSessionNames.delete(sessionName);
      const remainingNames = pendingChildNamesByParent.get(parent.id);
      remainingNames?.delete(sessionName);
      if (remainingNames?.size === 0) pendingChildNamesByParent.delete(parent.id);
    }
  }

  function handleInspect(request: LiveSessionControlRequest): LiveSessionControlResponse {
    const params = request.params ?? {};
    const targetSessionId = stringParam(params, "targetSessionId");
    if (!targetSessionId) return failure(request.requestId, "invalid_request", "targetSessionId is required");
    const target = threadBySessionId(targetSessionId);
    if (!target)
      return failure(request.requestId, "session_not_found", `Live session ${targetSessionId} was not found`);
    const history =
      params.history === undefined
        ? { mode: "recent" as const, turns: 3 }
        : childSessionHistoryFromValue(params.history);
    if (!history) {
      return failure(request.requestId, "invalid_history", "history must be none, all, or recent with positive turns");
    }
    const requester = requesterThread(params);
    if (hasRequesterIdentity(params) && !requester) {
      return failure(request.requestId, "requester_not_found", "The requesting Relay session was not found");
    }
    if (requester && !canInspectLiveSession(sessionInfo(requester), sessionInfo(target))) {
      return failure(
        request.requestId,
        "inspection_forbidden",
        `Session ${threadRelaySessionName(requester)} may inspect only itself and its direct children`,
      );
    }
    try {
      const sessionRunning = target.status === "running" || target.status === "connecting";
      return success(request.requestId, {
        session: liveSessionInfo(target, app.state.threads, deps.agentName()),
        history: childSessionHistoryLabel(history),
        turns: inspectedSessionContextTurns(deps.threadUiAdapter(app, target.id).state.blocks, history, sessionRunning),
      });
    } catch (error) {
      return failure(request.requestId, "inspection_failed", error instanceof Error ? error.message : String(error));
    }
  }

  async function handleMessage(request: LiveSessionControlRequest): Promise<LiveSessionControlResponse> {
    const params = request.params ?? {};
    const targetSessionId = stringParam(params, "targetSessionId");
    const text = stringParam(params, "text");
    const requestedDelivery = stringParam(params, "delivery") ?? "mailbox";
    if (!targetSessionId || !text)
      return failure(request.requestId, "invalid_request", "targetSessionId and text are required");
    if (new TextEncoder().encode(text).byteLength > LIVE_SESSION_MESSAGE_MAX_BYTES) {
      return failure(
        request.requestId,
        "message_too_large",
        `Messages may not exceed ${LIVE_SESSION_MESSAGE_MAX_BYTES} bytes`,
      );
    }
    if (!["mailbox", "steer", "turn", "auto", "next"].includes(requestedDelivery)) {
      return failure(request.requestId, "invalid_delivery", `Unsupported delivery mode ${requestedDelivery}`);
    }
    const thread = threadBySessionId(targetSessionId);
    if (!thread)
      return failure(request.requestId, "session_not_found", `Live session ${targetSessionId} was not found`);
    const senderSessionId = stringParam(params, "senderSessionId");
    const senderSessionName = stringParam(params, "senderSessionName");
    const hasSenderIdentity = Boolean(senderSessionId || senderSessionName);
    const sender = senderSessionId
      ? threadBySessionId(senderSessionId)
      : senderSessionName
        ? threadBySessionName(senderSessionName)
        : undefined;
    if (hasSenderIdentity && !sender) {
      return failure(request.requestId, "sender_not_found", "The sending Relay session was not found");
    }
    if (sender?.id === thread.id) {
      return failure(
        request.requestId,
        "self_message_rejected",
        `Session ${threadRelaySessionName(thread)} cannot message itself`,
      );
    }
    if (sender && !canMessageLiveSession(sessionInfo(sender), sessionInfo(thread))) {
      return failure(
        request.requestId,
        "message_forbidden",
        `Session ${threadRelaySessionName(sender)} cannot message ${threadRelaySessionName(thread)}`,
      );
    }
    const delivery =
      requestedDelivery === "next"
        ? "turn"
        : requestedDelivery === "auto"
          ? thread.status === "running"
            ? "steer"
            : "turn"
          : requestedDelivery;
    const attributedText = attributedMessageText(thread, senderSessionId, senderSessionName, text);
    const client = deps.threadClient(thread.id);

    if (delivery === "mailbox") {
      const message = await deliverInboxMessage(
        thread,
        sender,
        attributedText,
        Boolean(sender && (sender.parentThreadId === thread.id || thread.parentThreadId === sender.id)),
      );
      return success(request.requestId, message);
    }

    if (delivery === "steer") {
      if (thread.status !== "running") {
        return failure(request.requestId, "session_not_running", `Session ${targetSessionId} is not running`);
      }
      if (!client?.supportsActiveTurnInput()) {
        return failure(request.requestId, "steering_unsupported", `Session ${targetSessionId} cannot accept steering`);
      }
      const result = await client.sendActiveTurnInput(attributedText);
      if (!result.accepted) {
        return failure(request.requestId, "steering_rejected", result.reason ?? "Active-turn input was rejected");
      }
      const messageId = `rm_${randomUUID().replaceAll("-", "")}`;
      const blockId = `live-${messageId}`;
      const acpSessionId = thread.sessionId ?? client.sessionId;
      if (acpSessionId) {
        const latestThread = app.state.threads.find((candidate) => candidate.id === thread.id) ?? thread;
        const persistedMessage: PersistedLiveSessionMessage = {
          id: blockId,
          acpSessionId,
          content: attributedText,
          delivery: "current-turn-guidance",
          createdAt: new Date().toISOString(),
        };
        updateThread(app, thread.id, {
          liveSessionMessages: [...(latestThread.liveSessionMessages ?? []), persistedMessage],
        });
      }
      deps.threadUiAdapter(app, thread.id).addBlock({
        type: "user",
        id: blockId,
        content: attributedText,
        origin: "local",
        delivery: "current-turn-guidance",
      });
      return success(request.requestId, {
        messageId,
        targetSessionId,
        delivery: "steered",
        accepted: true,
      } satisfies LiveSessionMessageResult);
    }

    const wasRunning = thread.status === "running" || thread.status === "connecting";
    if (
      thread.parentThreadId &&
      !isActiveChild(thread) &&
      reservedChildCapacity(thread.parentThreadId) >= MAX_ACTIVE_CHILD_SESSIONS
    ) {
      return failure(
        request.requestId,
        "capacity",
        `Parent session already has ${MAX_ACTIVE_CHILD_SESSIONS} active children`,
      );
    }
    if (wasRunning) {
      if (!deps.queuePromptForThread?.(attributedText, thread.id)) {
        return failure(request.requestId, "mailbox_full", `Session ${targetSessionId} cannot accept another message`);
      }
    } else {
      await deps.submitPromptToAgent(attributedText, app, "end", {
        source: "plugin",
        targetThreadId: thread.id,
        drainQueueOnCompletion: true,
      });
    }
    return success(request.requestId, {
      messageId: `rm_${randomUUID().replaceAll("-", "")}`,
      targetSessionId,
      delivery: wasRunning ? "queued" : "started_turn",
      accepted: true,
    } satisfies LiveSessionMessageResult);
  }

  async function handleWait(request: LiveSessionControlRequest): Promise<LiveSessionControlResponse> {
    const params = request.params ?? {};
    const targetSessionId = stringParam(params, "targetSessionId");
    const requester = requesterThread(params);
    if (hasRequesterIdentity(params) && !requester) {
      return failure(request.requestId, "requester_not_found", "The requesting Relay session was not found");
    }
    if (!targetSessionId && (!requester || liveSessionRole(requester) !== "parent")) {
      return failure(
        request.requestId,
        "wait_forbidden",
        "Waiting for the next child requires a managed parent session",
      );
    }
    const target = targetSessionId ? threadBySessionId(targetSessionId) : undefined;
    if (targetSessionId && !target) {
      return failure(request.requestId, "session_not_found", `Live session ${targetSessionId} was not found`);
    }
    if (requester && target && !canInspectLiveSession(sessionInfo(requester), sessionInfo(target))) {
      return failure(
        request.requestId,
        "wait_forbidden",
        `Session ${threadRelaySessionName(requester)} cannot wait for ${threadRelaySessionName(target)}`,
      );
    }
    const timeoutValue = params.timeoutMs ?? LIVE_SESSION_WAIT_DEFAULT_MS;
    if (
      typeof timeoutValue !== "number" ||
      !Number.isFinite(timeoutValue) ||
      timeoutValue < LIVE_SESSION_WAIT_MIN_MS ||
      timeoutValue > LIVE_SESSION_WAIT_MAX_MS
    ) {
      return failure(
        request.requestId,
        "invalid_timeout",
        `timeoutMs must be between ${LIVE_SESSION_WAIT_MIN_MS} and ${LIVE_SESSION_WAIT_MAX_MS}`,
      );
    }

    if (requester) store.liveSessionWaitingThreads.add(requester.id);
    const finishWait = (response: LiveSessionControlResponse): LiveSessionControlResponse => {
      if (requester) store.liveSessionWaitingThreads.delete(requester.id);
      return response;
    };
    const reported = requester
      ? (reportedTerminalChildrenByParent.get(requester.id) ?? new Set<string>())
      : new Set<string>();
    if (requester) reportedTerminalChildrenByParent.set(requester.id, reported);
    const candidates = (): ThreadInfo[] =>
      targetSessionId
        ? ([threadBySessionId(targetSessionId)].filter(Boolean) as ThreadInfo[])
        : app.state.threads.filter(
            (thread) =>
              !thread.archived && thread.parentThreadId === requester?.id && deps.threadClient(thread.id) !== null,
          );
    const completed = (): ThreadInfo | undefined =>
      candidates().find(
        (thread) =>
          isTerminalChildTaskStatus(thread.childTaskStatus) &&
          (targetSessionId !== undefined || !reported.has(terminalChildKey(thread))),
      );
    const inboxEvent = (): LiveSessionInboxEvent | undefined => {
      if (!requester) return undefined;
      const sourceIds = new Set(candidates().map((thread) => thread.relaySessionId ?? thread.id));
      const currentParent = app.state.threads.find((thread) => thread.id === requester.id) ?? requester;
      return (currentParent.liveSessionInbox ?? []).find(
        (event) => !event.consumedAt && sourceIds.has(event.sourceSessionId),
      );
    };
    const inboxResponse = (event: LiveSessionInboxEvent, startedAt: number): LiveSessionControlResponse => {
      if (!requester) return failure(request.requestId, "wait_forbidden", "A parent session is required");
      const currentParent = app.state.threads.find((thread) => thread.id === requester.id) ?? requester;
      updateThread(app, requester.id, {
        liveSessionInbox: (currentParent.liveSessionInbox ?? []).map((candidate) =>
          candidate.id === event.id ? { ...candidate, requiresContinuation: true } : candidate,
        ),
      });
      const source = threadBySessionId(event.sourceSessionId);
      if (source && event.kind === "completion") reported.add(terminalChildKey(source));
      const sourceInfo = source ? sessionInfo(source) : undefined;
      return success(request.requestId, {
        ...(sourceInfo
          ? {
              session:
                event.kind === "completion" && event.childTaskStatus
                  ? { ...sourceInfo, taskState: event.childTaskStatus }
                  : sourceInfo,
            }
          : {}),
        outcome: event.kind === "completion" ? "terminal" : "message",
        waitedMs: Date.now() - startedAt,
        delivery: "continuation",
        result: LIVE_SESSION_CONTINUATION_ACKNOWLEDGEMENT,
      });
    };
    const terminalResponse = (thread: ThreadInfo, startedAt: number): LiveSessionControlResponse => {
      reported.add(terminalChildKey(thread));
      const result = childResult(thread);
      return success(request.requestId, {
        session: sessionInfo(thread),
        outcome: "terminal",
        waitedMs: Date.now() - startedAt,
        delivery: "inline",
        ...(result ? { result } : {}),
      });
    };

    const startedAt = Date.now();
    const pendingEvent = inboxEvent();
    if (pendingEvent) return finishWait(inboxResponse(pendingEvent, startedAt));
    const alreadyCompleted = completed();
    if (alreadyCompleted) return finishWait(terminalResponse(alreadyCompleted, startedAt));
    if (!candidates().some(isActiveChild)) {
      return finishWait(success(request.requestId, { outcome: "idle", waitedMs: Date.now() - startedAt }));
    }
    while (Date.now() - startedAt < timeoutValue) {
      const message = inboxEvent();
      if (message) return finishWait(inboxResponse(message, startedAt));
      const finished = completed();
      if (finished) return finishWait(terminalResponse(finished, startedAt));
      await Bun.sleep(Math.min(100, timeoutValue - (Date.now() - startedAt)));
    }
    const currentTarget = targetSessionId ? threadBySessionId(targetSessionId) : undefined;
    return finishWait(
      success(request.requestId, {
        ...(currentTarget ? { session: sessionInfo(currentTarget) } : {}),
        outcome: "timeout",
        waitedMs: Date.now() - startedAt,
      }),
    );
  }

  async function handleCancel(request: LiveSessionControlRequest): Promise<LiveSessionControlResponse> {
    const params = request.params ?? {};
    const targetSessionId = stringParam(params, "targetSessionId");
    if (!targetSessionId) return failure(request.requestId, "invalid_request", "targetSessionId is required");
    const target = threadBySessionId(targetSessionId);
    if (!target)
      return failure(request.requestId, "session_not_found", `Live session ${targetSessionId} was not found`);
    const requester = requesterThread(params);
    if (hasRequesterIdentity(params) && !requester) {
      return failure(request.requestId, "requester_not_found", "The requesting Relay session was not found");
    }
    if (requester && !canCancelLiveSession(sessionInfo(requester), sessionInfo(target))) {
      return failure(
        request.requestId,
        "cancel_forbidden",
        `Session ${threadRelaySessionName(requester)} cannot cancel ${threadRelaySessionName(target)}`,
      );
    }
    if (isTerminalChildTaskStatus(target.childTaskStatus)) {
      return success(request.requestId, { session: sessionInfo(target), cancelled: true });
    }
    const client = deps.threadClient(target.id);
    if (target.status === "running" && client) {
      const runId = store.threadPromptRunIds.get(target.id) ?? 0;
      store.suppressedThreadPromptRunIds.set(target.id, runId);
      store.threadPromptRunIds.set(target.id, runId + 1);
      await client.cancel(target.sessionId ?? undefined).catch(() => undefined);
    }
    updateThread(app, target.id, {
      status: "paused",
      ...(target.parentThreadId
        ? { childTaskStatus: "interrupted" as const, childTaskFinishedAt: new Date().toISOString() }
        : {}),
    });
    const cancelledTarget = app.state.threads.find((thread) => thread.id === target.id) ?? target;
    if (cancelledTarget.parentThreadId) {
      await deps.publishChildCompletion?.(app, cancelledTarget, "interrupted", "Child session was interrupted.");
    }
    return success(request.requestId, { session: sessionInfo(cancelledTarget), cancelled: true });
  }

  async function handleRequest(request: LiveSessionControlRequest): Promise<LiveSessionControlResponse> {
    if (request.method === "session.list") {
      const params = request.params ?? {};
      const requester = requesterThread(params);
      if (hasRequesterIdentity(params) && !requester) {
        return failure(request.requestId, "requester_not_found", "The requesting Relay session was not found");
      }
      return success(request.requestId, {
        sessions: app.state.threads
          .filter((thread) => !thread.archived && deps.threadClient(thread.id) !== null)
          .map((thread) => sessionInfo(thread))
          .filter((session) => !requester || isLiveSessionVisibleTo(sessionInfo(requester), session)),
      });
    }
    if (request.method === "session.inspect") return handleInspect(request);
    if (request.method === "session.message") return await handleMessage(request);
    if (request.method === "session.wait") return await handleWait(request);
    if (request.method === "session.cancel") return await handleCancel(request);
    if (request.method === "session.createChild") {
      const params = request.params ?? {};
      const parentSessionId = stringParam(params, "parentSessionId");
      const task = stringParam(params, "task");
      if (!parentSessionId || !task) {
        return failure(request.requestId, "invalid_request", "parentSessionId and task are required");
      }
      const requester = requesterThread(params);
      if (hasRequesterIdentity(params) && !requester) {
        return failure(request.requestId, "requester_not_found", "The requesting Relay session was not found");
      }
      const requestedParent = threadBySessionId(parentSessionId);
      if (requester && (liveSessionRole(requester) !== "parent" || requester.id !== requestedParent?.id)) {
        return failure(
          request.requestId,
          "child_creation_forbidden",
          `Session ${threadRelaySessionName(requester)} cannot create a child for ${parentSessionId}`,
        );
      }
      const history =
        params.history === undefined ? { mode: "none" as const } : childSessionHistoryFromValue(params.history);
      if (!history) {
        return failure(
          request.requestId,
          "invalid_history",
          "history must be none, all, or recent with positive turns",
        );
      }
      try {
        const requestedName = stringParam(params, "name");
        if (requestedName) {
          const normalizedName = normalizeRelaySessionName(requestedName);
          const existing = threadBySessionName(normalizedName);
          if (existing && existing.parentThreadId === requestedParent?.id && existing.relationGoal === task) {
            return success(request.requestId, { session: sessionInfo(existing), replayed: true });
          }
        }
        const child = await createChildSession({
          parentSessionId,
          task,
          ...(stringParam(params, "name") ? { name: stringParam(params, "name") } : {}),
          ...(params.worktree === true ? { worktree: true } : {}),
          relation: params.relation === "handoff" ? "handoff" : "child",
          history,
          ...(stringParam(params, "openingPrompt") ? { openingPrompt: stringParam(params, "openingPrompt") } : {}),
          ...(stringParam(params, "taskType") ? { taskType: stringParam(params, "taskType") } : {}),
          ...(stringParam(params, "agent") ? { agent: stringParam(params, "agent") } : {}),
          ...(stringParam(params, "model") ? { model: stringParam(params, "model") } : {}),
          ...(stringParam(params, "thinkingLevel") ? { thinkingLevel: stringParam(params, "thinkingLevel") } : {}),
        });
        return success(request.requestId, { session: liveSessionInfo(child, app.state.threads, deps.agentName()) });
      } catch (error) {
        return failure(request.requestId, "child_start_failed", error instanceof Error ? error.message : String(error));
      }
    }
    return failure(request.requestId, "method_not_found", `Unsupported method ${request.method}`);
  }

  return { createChildSession, handleRequest };
}
