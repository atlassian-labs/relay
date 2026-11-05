import type { AcpClientOptions, AcpLaunchOptions } from "../../acp/client";
import { liveSessionRole, threadActivity, type LiveSessionInfo } from "../../core/live-sessions";
import { threadRelaySessionName, type ThreadInfo } from "../../core/threads";
import { liveSessionActorToken } from "../../platform/live-session-control";
import { store } from "./runtime-store";

export function liveSessionInfo(
  thread: ThreadInfo,
  threads: readonly ThreadInfo[],
  agentName: string,
): LiveSessionInfo {
  const parent = thread.parentThreadId
    ? threads.find((candidate) => candidate.id === thread.parentThreadId)
    : undefined;
  return {
    id: thread.relaySessionId ?? thread.id,
    name: threadRelaySessionName(thread),
    role: liveSessionRole(thread),
    instanceId: store.liveSessionInstanceId,
    threadId: thread.id,
    ...(thread.sessionId ? { acpSessionId: thread.sessionId } : {}),
    ...(parent ? { parentSessionId: parent.relaySessionId ?? parent.id } : {}),
    ...(thread.relationKind ? { relation: thread.relationKind } : {}),
    title: thread.title,
    cwd: thread.cwd,
    agent: thread.agentName ?? agentName,
    activity: threadActivity(thread),
    ...(thread.childTaskStatus ? { taskState: thread.childTaskStatus } : {}),
    ...(thread.createdAt ? { createdAt: thread.createdAt } : {}),
    ...(thread.updatedAt ? { updatedAt: thread.updatedAt } : {}),
    ...(thread.latestResultPreview ? { latestResultPreview: thread.latestResultPreview } : {}),
    ...(thread.childTaskType ? { taskType: thread.childTaskType } : {}),
    ...(thread.modelId ? { model: thread.modelId } : {}),
    ...(thread.thinkingLevel ? { thinkingLevel: thread.thinkingLevel } : {}),
  };
}

export function withLiveSessionEnv<T extends AcpLaunchOptions | AcpClientOptions>(
  options: T,
  thread: ThreadInfo,
  threads: readonly ThreadInfo[],
): T {
  if (!store.liveSessionEndpoint || !store.liveSessionInstanceId) return options;
  const parent = thread.parentThreadId
    ? threads.find((candidate) => candidate.id === thread.parentThreadId)
    : undefined;
  const sessionId = thread.relaySessionId ?? thread.id;
  return {
    ...options,
    env: {
      ...(options.env ?? {}),
      RELAY_CONTROL_ENDPOINT: store.liveSessionEndpoint,
      RELAY_CONTROL_TOKEN: liveSessionActorToken(store.liveSessionToken, sessionId),
      RELAY_INSTANCE_ID: store.liveSessionInstanceId,
      RELAY_SESSION_ID: sessionId,
      RELAY_SESSION_NAME: threadRelaySessionName(thread),
      RELAY_SESSION_ROLE: liveSessionRole(thread),
      ...(parent
        ? {
            RELAY_PARENT_SESSION_ID: parent.relaySessionId ?? parent.id,
            RELAY_PARENT_SESSION_NAME: threadRelaySessionName(parent),
          }
        : {}),
      RELAY_BIN_PATH: process.argv[1] ?? "relay",
    },
  };
}
