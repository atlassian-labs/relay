import type { SessionListPolicy } from "../../acp/agent-profile";
import type { ThreadInfo } from "../../core/threads";
import { isInternalSessionTitle } from "./session-list";

export function sanitizeInternalThreadTitle(thread: ThreadInfo, policy: SessionListPolicy = {}): ThreadInfo {
  if (!isInternalSessionTitle(thread.title, policy)) return thread;
  return {
    ...thread,
    title: thread.workspaceKind === "worktree" ? "New worktree thread" : "New thread",
    titleQuality: undefined,
    sessionId: null,
  };
}
