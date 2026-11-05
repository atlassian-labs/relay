import { skillInvocationDisplay } from "../../skills";
import { saveThreadsForWorkspace, summarizeThreadRequest, type ThreadInfo } from "../../core/threads";
import type { UserSkillInvocationEcho, useApp } from "../state";
import { promptTitleIntentFromText, type UserPromptTitleIntent } from "../util/user-message";

let rootCwd: string | null = null;

export function setThreadMetadataRootCwd(cwd: string | null): void {
  rootCwd = cwd;
}

export function persistThreads(app: ReturnType<typeof useApp>): void {
  if (!rootCwd) return;
  saveThreadsForWorkspace(rootCwd, { activeThreadId: app.state.activeThreadId || null, threads: app.state.threads });
}

function normalizeThreadUpdates(updates: Partial<ThreadInfo>): Partial<ThreadInfo> {
  return "title" in updates && !("titleQuality" in updates) ? { ...updates, titleQuality: undefined } : updates;
}

export function updateThread(app: ReturnType<typeof useApp>, threadId: string, updates: Partial<ThreadInfo>): void {
  app.setState("threads", (thread) => thread.id === threadId, normalizeThreadUpdates(updates));
  persistThreads(app);
}

export function currentThread(app: ReturnType<typeof useApp>): ThreadInfo | undefined {
  return app.state.threads.find((thread) => thread.id === app.state.activeThreadId);
}

export function syncCurrentThreadSession(app: ReturnType<typeof useApp>, sessionId: string | null): void {
  const thread = currentThread(app);
  if (!thread) return;
  updateThread(app, thread.id, { sessionId, updatedAt: new Date().toISOString() });
}

export function syncCurrentThreadStatus(app: ReturnType<typeof useApp>, status: ThreadInfo["status"]): void {
  const thread = currentThread(app);
  if (!thread) return;
  updateThread(app, thread.id, { status });
}

export function syncThreadStatus(
  app: ReturnType<typeof useApp>,
  threadId: string,
  status: ThreadInfo["status"],
  options: { touch?: boolean } = {},
): void {
  updateThread(app, threadId, {
    status,
    ...(options.touch === true ? { updatedAt: new Date().toISOString() } : {}),
  });
}

function skillInvocationFromPromptText(text: string): UserSkillInvocationEcho | null {
  const skill = skillInvocationDisplay(text);
  if (!skill) return null;
  return {
    name: skill.name,
    ...(skill.userMessage === undefined ? {} : { userMessage: skill.userMessage }),
  };
}

function titleQualityFromIntent(intent: UserPromptTitleIntent): ThreadInfo["titleQuality"] | undefined {
  if (intent.quality === "strong" || intent.quality === "fallback") return intent.quality;
  return undefined;
}

function isDefaultThreadTitle(title: string): boolean {
  return title === "New thread" || title === "New worktree thread";
}

function isPersistableTitleIntent(intent: UserPromptTitleIntent): boolean {
  return intent.quality === "strong" || intent.quality === "fallback";
}

function canReplaceThreadTitle(
  thread: Pick<ThreadInfo, "title" | "titleQuality">,
  intent: UserPromptTitleIntent,
): boolean {
  if (!isPersistableTitleIntent(intent)) return false;
  if (isDefaultThreadTitle(thread.title)) return true;
  return thread.titleQuality === "fallback";
}

export function threadTitleUpdateFromPrompt(
  thread: Pick<ThreadInfo, "title" | "titleQuality">,
  text: string,
  skillInvocation?: UserSkillInvocationEcho | null,
): Pick<ThreadInfo, "title" | "titleQuality"> | null {
  const intent = promptTitleIntentFromText(text, skillInvocation ?? skillInvocationFromPromptText(text));
  if (!canReplaceThreadTitle(thread, intent)) return null;
  const title = summarizeThreadRequest(intent.label);
  if (title === "New thread") return null;
  return {
    title,
    titleQuality: titleQualityFromIntent(intent),
  };
}

export function threadTitleFromPrompt(text: string, skillInvocation?: UserSkillInvocationEcho | null): string {
  return threadTitleUpdateFromPrompt({ title: "New thread" }, text, skillInvocation)?.title ?? "New thread";
}

export function syncThreadTitle(
  app: ReturnType<typeof useApp>,
  threadId: string,
  text: string,
  skillInvocation?: UserSkillInvocationEcho | null,
): void {
  const thread = app.state.threads.find((item) => item.id === threadId);
  if (!thread) return;
  const titleUpdate = threadTitleUpdateFromPrompt(thread, text, skillInvocation);
  if (!titleUpdate) return;
  updateThread(app, threadId, {
    ...titleUpdate,
    updatedAt: new Date().toISOString(),
  });
}
