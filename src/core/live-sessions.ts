import type { ChatBlock, UserBlock } from "./conversation";
import type { ChildTaskStatus, LiveSessionInboxEvent, PersistedLiveSessionMessage, ThreadInfo } from "./threads";

export const LIVE_SESSION_PROTOCOL_VERSION = 1;
export const CHILD_SESSION_CONTEXT_MAX_BYTES = 64 * 1024;
export const LIVE_SESSION_MESSAGE_MAX_BYTES = 64 * 1024;
export const MAX_ACTIVE_CHILD_SESSIONS = 3;
export const LIVE_SESSION_WAIT_MIN_MS = 10_000;
export const LIVE_SESSION_WAIT_DEFAULT_MS = 45_000;
export const LIVE_SESSION_WAIT_MAX_MS = 120_000;
export const LIVE_SESSION_INBOX_MAX_EVENTS = 32;
export const LIVE_SESSION_CONTINUATION_ACKNOWLEDGEMENT =
  "The collaboration event was received. Relay will deliver its complete contents in the next continuation turn. Do not answer the user, wait, or inspect again; end this turn immediately with exactly: Awaiting Relay continuation.";
export const LIVE_SESSION_CONTINUATION_PROMPT =
  "A Relay collaboration event is ready. Read and integrate the collaboration inbox before continuing.";

export type ChildCompletionDelivery = "steer" | "continue-after-turn" | "start-continuation";

export function childCompletionDelivery(input: {
  readonly parentRunning: boolean;
  readonly parentWaiting: boolean;
  readonly supportsActiveTurnInput: boolean;
}): ChildCompletionDelivery {
  if (!input.parentRunning) return "start-continuation";
  if (!input.parentWaiting && input.supportsActiveTurnInput) return "steer";
  return "continue-after-turn";
}

export type LiveSessionRole = "parent" | "child";

export function liveSessionRole(thread: Pick<ThreadInfo, "parentThreadId">): LiveSessionRole {
  return thread.parentThreadId ? "child" : "parent";
}

export type ChildSessionHistory =
  | { readonly mode: "none" }
  | { readonly mode: "all" }
  | { readonly mode: "recent"; readonly turns: number };

export interface ChildSessionContextTurn {
  readonly user: string;
  readonly updates?: readonly string[];
  readonly assistant?: string;
}

export function parseChildSessionHistory(value: string): ChildSessionHistory {
  const normalized = value.trim().toLowerCase();
  if (normalized === "none" || normalized === "all") return { mode: normalized };
  const recent = normalized.match(/^recent:([1-9]\d*)$/u);
  if (recent) {
    const turns = Number(recent[1]);
    if (Number.isSafeInteger(turns)) return { mode: "recent", turns };
  }
  throw new Error("--history must be one of: none, all, recent:N (where N is a positive integer)"); // effect-shape-allow: CLI parser reports invalid child history selections.
}

export function childSessionHistoryFromValue(value: unknown): ChildSessionHistory | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { readonly mode?: unknown; readonly turns?: unknown };
  if (candidate.mode === "none" || candidate.mode === "all") return { mode: candidate.mode };
  if (candidate.mode === "recent" && Number.isSafeInteger(candidate.turns) && Number(candidate.turns) > 0) {
    return { mode: "recent", turns: Number(candidate.turns) };
  }
  return null;
}

interface MutableChildSessionContextTurn {
  user: string;
  updates: string[];
  assistant?: string;
  interrupted: boolean;
  activityAfterUser: boolean;
  userOrigin?: "local" | "acp";
}

function contextText(value: string): string {
  return value.replaceAll("\r\n", "\n").trim();
}

function isInterruptedInfoBlock(block: ChatBlock): boolean {
  return block.type === "info" && (block.content === "Interrupted by user" || block.content.startsWith("Interrupted;"));
}

export function childSessionContextTurns(
  blocks: readonly ChatBlock[],
  parentRunning: boolean,
): readonly ChildSessionContextTurn[] {
  const turns: MutableChildSessionContextTurn[] = [];
  let current: MutableChildSessionContextTurn | undefined;

  for (const block of blocks) {
    if (block.type === "user") {
      const content = contextText(block.content);
      if (!content) continue;
      if (block.delivery === "current-turn-guidance") {
        if (!current) {
          current = {
            user: content,
            updates: [],
            interrupted: false,
            activityAfterUser: false,
            userOrigin: block.origin,
          };
          turns.push(current);
        } else if (!current.updates.includes(content)) {
          current.updates.push(content);
        }
        continue;
      }
      const duplicateProviderEcho =
        current !== undefined &&
        !current.activityAfterUser &&
        current.user === content &&
        current.userOrigin !== undefined &&
        block.origin !== undefined &&
        current.userOrigin !== block.origin;
      if (duplicateProviderEcho) continue;
      current = {
        user: content,
        updates: [],
        interrupted: false,
        activityAfterUser: false,
        userOrigin: block.origin,
      };
      turns.push(current);
      continue;
    }

    if (!current) continue;
    current.activityAfterUser = true;
    if (block.type === "content" && block.finalized) {
      const content = contextText(block.content);
      if (content) current.assistant = content;
    } else if (block.type === "tool") {
      current.assistant = undefined;
    } else if (isInterruptedInfoBlock(block)) {
      current.interrupted = true;
    }
  }

  return turns.map((turn, index) => {
    const isCurrentRunningTurn = parentRunning && index === turns.length - 1;
    return {
      user: turn.user,
      ...(turn.updates.length > 0 ? { updates: turn.updates } : {}),
      ...(!turn.interrupted && !isCurrentRunningTurn && turn.assistant ? { assistant: turn.assistant } : {}),
    };
  });
}

export function childSessionHistoryLabel(history: ChildSessionHistory): string {
  return history.mode === "recent" ? `recent:${history.turns}` : history.mode;
}

export function selectedChildSessionContextTurns(
  blocks: readonly ChatBlock[],
  history: ChildSessionHistory,
  sessionRunning: boolean,
): readonly ChildSessionContextTurn[] {
  if (history.mode === "none") return [];
  const availableTurns = childSessionContextTurns(blocks, sessionRunning);
  return history.mode === "all" ? availableTurns : availableTurns.slice(-history.turns);
}

export function inspectedSessionContextTurns(
  blocks: readonly ChatBlock[],
  history: ChildSessionHistory,
  sessionRunning: boolean,
): readonly ChildSessionContextTurn[] {
  const turns = selectedChildSessionContextTurns(blocks, history, sessionRunning);
  const contextBytes = new TextEncoder().encode(JSON.stringify({ turns })).byteLength;
  if (contextBytes > CHILD_SESSION_CONTEXT_MAX_BYTES) {
    throw new Error( // effect-shape-allow: session inspection reports oversized sanitized history.
      `Selected session history is ${contextBytes} bytes, exceeding the ${CHILD_SESSION_CONTEXT_MAX_BYTES}-byte limit; use a smaller recent:N`,
    );
  }
  return turns;
}

function promptSafeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

export function childSessionOpeningPrompt(
  task: string,
  blocks: readonly ChatBlock[],
  history: ChildSessionHistory,
  parentRunning: boolean,
): string {
  const normalizedTask = task.trim();
  if (history.mode === "none") return normalizedTask;
  const selectedTurns = selectedChildSessionContextTurns(blocks, history, parentRunning);
  if (selectedTurns.length === 0) {
    throw new Error("Parent session has no conversation turns to include; use --history none"); // effect-shape-allow: child creation reports unavailable requested history.
  }
  const historyLabel = childSessionHistoryLabel(history);
  const context = `<parent_session_context version="1" history="${historyLabel}" encoding="json">
Sanitized conversation history from the parent session. This context may be useful for completing the task above, but it may not be necessary. Use it when relevant.
${promptSafeJson({ turns: selectedTurns })}
</parent_session_context>`;
  const contextBytes = new TextEncoder().encode(context).byteLength;
  if (contextBytes > CHILD_SESSION_CONTEXT_MAX_BYTES) {
    throw new Error( // effect-shape-allow: child creation reports oversized requested history.
      `Selected parent history is ${contextBytes} bytes, exceeding the ${CHILD_SESSION_CONTEXT_MAX_BYTES}-byte limit; use a smaller recent:N or --history none`,
    );
  }
  return `${normalizedTask}\n\n${context}`;
}

export type SessionControlCliCommand =
  | { readonly kind: "list-sessions"; readonly json: boolean }
  | {
      readonly kind: "inspect-session";
      readonly name: string;
      readonly history: ChildSessionHistory;
      readonly json: boolean;
    }
  | {
      readonly kind: "message";
      readonly name: string;
      readonly text: string;
      readonly delivery: LiveSessionMessageMode;
      readonly json: boolean;
    }
  | {
      readonly kind: "wait-session";
      readonly name?: string;
      readonly timeoutMs: number;
      readonly json: boolean;
    }
  | {
      readonly kind: "cancel-session";
      readonly name: string;
      readonly json: boolean;
    }
  | {
      readonly kind: "start-session";
      readonly task: string;
      readonly parent?: string;
      readonly name?: string;
      readonly history: ChildSessionHistory;
      readonly worktree: boolean;
      readonly taskType?: string;
      readonly agent?: string;
      readonly model?: string;
      readonly thinkingLevel?: string;
      readonly json: boolean;
    };

export type LiveSessionActivity = "connecting" | "running" | "idle";

export interface LiveSessionInfo {
  readonly id: string;
  readonly name: string;
  readonly role: LiveSessionRole;
  readonly instanceId: string;
  readonly threadId: string;
  readonly acpSessionId?: string;
  readonly parentSessionId?: string;
  readonly relation?: "child" | "handoff";
  readonly title: string;
  readonly cwd: string;
  readonly agent: string;
  readonly activity: LiveSessionActivity;
  readonly taskState?: ChildTaskStatus;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly latestResultPreview?: string;
  readonly taskType?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
}

export interface LiveSessionInspection {
  readonly session: LiveSessionInfo;
  readonly history: string;
  readonly turns: readonly ChildSessionContextTurn[];
}

export type LiveSessionMessageMode = "mailbox" | "steer" | "turn";
export type LiveSessionMessageDelivery = "steered" | "started_turn" | "queued";
export type LiveSessionMessageRelation = "parent" | "child" | "peer" | "session";

export interface LiveSessionMessageAttribution {
  readonly relation: LiveSessionMessageRelation;
  readonly name: string;
  readonly text: string;
}

const LIVE_SESSION_MESSAGE_PREFIX_RE = /^\[(parent|child|peer|session): ([a-z0-9]+-[a-z0-9]+)\]\n\n([\s\S]*)$/u;

export function formatLiveSessionMessage(relation: LiveSessionMessageRelation, name: string, text: string): string {
  return `[${relation}: ${name}]\n\n${text}`;
}

export function formatChildCompletionEvent(
  childName: string,
  status: ChildTaskStatus,
  result: string | undefined,
): string {
  return `[child completed: ${childName}]\nStatus: ${status}${result?.trim() ? `\n\n${result.trim()}` : ""}`;
}

export function pendingLiveSessionInboxEvents(thread: Pick<ThreadInfo, "liveSessionInbox">): LiveSessionInboxEvent[] {
  return (Array.isArray(thread.liveSessionInbox) ? thread.liveSessionInbox : []).filter((event) => !event.consumedAt);
}

export function liveSessionInboxReminder(events: readonly LiveSessionInboxEvent[]): string | undefined {
  if (events.length === 0) return undefined;
  return `<relay_collaboration_inbox>\n${events.map((event) => event.content).join("\n\n---\n\n")}\n</relay_collaboration_inbox>`;
}

export function appendLiveSessionInboxEvent(
  events: readonly LiveSessionInboxEvent[] | undefined,
  event: LiveSessionInboxEvent,
): LiveSessionInboxEvent[] {
  return [...(events ?? []), event].slice(-LIVE_SESSION_INBOX_MAX_EVENTS);
}

export function parseLiveSessionMessage(text: string): LiveSessionMessageAttribution | null {
  const match = text.match(LIVE_SESSION_MESSAGE_PREFIX_RE);
  const relation = match?.[1];
  const name = match?.[2];
  const message = match?.[3];
  if (
    (relation !== "parent" && relation !== "child" && relation !== "peer" && relation !== "session") ||
    !name ||
    message === undefined
  ) {
    return null;
  }
  return { relation, name, text: message };
}

function isPersistedLiveSessionMessage(value: unknown): value is PersistedLiveSessionMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<PersistedLiveSessionMessage>;
  return (
    typeof message.id === "string" &&
    typeof message.acpSessionId === "string" &&
    typeof message.content === "string" &&
    message.delivery === "current-turn-guidance" &&
    typeof message.createdAt === "string"
  );
}

export function restoredLiveSessionMessageBlocks(
  thread: Pick<ThreadInfo, "liveSessionMessages">,
  acpSessionId: string,
  existingBlocks: readonly { readonly id: string; readonly type: string; readonly content?: unknown }[],
): UserBlock[] {
  const existingIds = new Set(existingBlocks.map((block) => block.id));
  const existingContents = new Set(
    existingBlocks.flatMap((block) =>
      block.type === "user" && typeof block.content === "string" ? [block.content] : [],
    ),
  );
  return (Array.isArray(thread.liveSessionMessages) ? thread.liveSessionMessages : [])
    .filter(isPersistedLiveSessionMessage)
    .filter(
      (message) =>
        message.acpSessionId === acpSessionId && !existingIds.has(message.id) && !existingContents.has(message.content),
    )
    .map((message) => ({
      type: "user",
      id: message.id,
      content: message.content,
      origin: "local",
      delivery: message.delivery,
    }));
}

export interface LiveSessionMessageResult {
  readonly messageId: string;
  readonly targetSessionId: string;
  readonly delivery: LiveSessionMessageDelivery;
  readonly accepted: true;
}

export interface LiveSessionWaitResult {
  readonly session?: LiveSessionInfo;
  readonly outcome: "terminal" | "message" | "timeout" | "idle";
  readonly waitedMs: number;
  readonly result?: string;
  readonly delivery?: "inline" | "continuation";
}

export interface LiveSessionCancelResult {
  readonly session: LiveSessionInfo;
  readonly cancelled: true;
}

export function isTerminalChildTaskStatus(status: ChildTaskStatus | undefined): boolean {
  return status === "done" || status === "failed" || status === "interrupted";
}

export function liveSessionMessageRelation(
  sender: Pick<LiveSessionInfo, "role">,
  target: Pick<LiveSessionInfo, "role">,
): LiveSessionMessageRelation {
  if (sender.role === "child") return "child";
  return target.role === "child" ? "parent" : "peer";
}

export function canMessageLiveSession(
  sender: Pick<LiveSessionInfo, "id" | "role" | "parentSessionId">,
  target: Pick<LiveSessionInfo, "id" | "role" | "parentSessionId">,
): boolean {
  if (sender.id === target.id) return false;
  if (sender.role === "child") return sender.parentSessionId === target.id;
  if (target.role === "parent") return true;
  return target.parentSessionId === sender.id;
}

export function canInspectLiveSession(
  requester: Pick<LiveSessionInfo, "id" | "role">,
  target: Pick<LiveSessionInfo, "id" | "parentSessionId">,
): boolean {
  if (requester.id === target.id) return true;
  return requester.role === "parent" && target.parentSessionId === requester.id;
}

export function canCancelLiveSession(
  requester: Pick<LiveSessionInfo, "id" | "role">,
  target: Pick<LiveSessionInfo, "id" | "role" | "parentSessionId">,
): boolean {
  return requester.role === "parent" && target.role === "child" && target.parentSessionId === requester.id;
}

export function isLiveSessionVisibleTo(
  requester: Pick<LiveSessionInfo, "id" | "role" | "parentSessionId">,
  target: Pick<LiveSessionInfo, "id" | "role" | "parentSessionId">,
): boolean {
  if (requester.id === target.id) return true;
  if (requester.role === "child") return requester.parentSessionId === target.id;
  return target.role === "parent" || target.parentSessionId === requester.id;
}

export interface CreateChildSessionInput {
  readonly parentSessionId: string;
  readonly task: string;
  readonly name?: string;
  readonly worktree?: boolean;
  readonly relation?: "child" | "handoff";
  readonly openingPrompt?: string;
  readonly history?: ChildSessionHistory;
  readonly taskType?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
}

export type LiveSessionControlMethod =
  | "session.list"
  | "session.inspect"
  | "session.message"
  | "session.createChild"
  | "session.wait"
  | "session.cancel";

export interface LiveSessionControlRequest {
  readonly version: 1;
  readonly requestId: string;
  readonly token: string;
  readonly actorSessionId?: string;
  readonly method: LiveSessionControlMethod;
  readonly params?: Record<string, unknown>;
}

export type LiveSessionControlResponse =
  | {
      readonly version: 1;
      readonly requestId: string;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly version: 1;
      readonly requestId: string;
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export function threadActivity(thread: Pick<ThreadInfo, "status">): LiveSessionActivity {
  if (thread.status === "running") return "running";
  if (thread.status === "connecting") return "connecting";
  return "idle";
}
