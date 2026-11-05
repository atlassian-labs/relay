import * as path from "path";
import { createHash } from "node:crypto";
import { uuid } from "../platform/crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "../platform/fs";
import { spawnSync } from "../platform/process";
import { getConfigDir } from "../platform/paths";
import { currentEnv } from "../platform/env";

export type ThreadStatus = "running" | "paused" | "connecting";
export type ThreadWorkspaceKind = "local" | "worktree";
export type ThreadWorktreeLocation = "relay" | "repo";
export type ThreadTitleQuality = "fallback" | "strong";
export type ThreadRelationKind = "child" | "handoff";
export type ChildTaskStatus = "starting" | "running" | "done" | "failed" | "interrupted";

export interface PersistedLiveSessionMessage {
  id: string;
  acpSessionId: string;
  content: string;
  delivery: "current-turn-guidance";
  createdAt: string;
}

export interface LiveSessionInboxEvent {
  id: string;
  kind: "message" | "completion";
  sourceSessionId: string;
  sourceSessionName: string;
  content: string;
  createdAt: string;
  childTaskStatus?: ChildTaskStatus;
  deliveredAt?: string;
  consumedAt?: string;
  requiresContinuation?: boolean;
}

export interface ThreadInfo {
  id: string;
  /** Stable Relay-owned identity used by the live-session control plane. */
  relaySessionId?: string;
  /** Short, human-friendly address for the live-session control plane. */
  relaySessionName?: string;
  title: string;
  /** Provider-owned ACP session identity. */
  sessionId: string | null;
  /** Native parent relation. Children remain ordinary independently resumable threads. */
  parentThreadId?: string;
  relationKind?: ThreadRelationKind;
  relationGoal?: string;
  relationCreatedAt?: string;
  /** Immutable ACP identities used to preserve this relationship when a thread later loads another session. */
  relationParentSessionId?: string;
  relationChildSessionId?: string;
  childTaskStatus?: ChildTaskStatus;
  childTaskFinishedAt?: string;
  latestResultPreview?: string;
  childTaskType?: string;
  agentName?: string;
  modelId?: string;
  thinkingLevel?: string;
  /** Relay-owned active-turn messages that ACP session history may not replay. */
  liveSessionMessages?: PersistedLiveSessionMessage[];
  /** Collaboration events delivered without creating ordinary queued prompts. */
  liveSessionInbox?: LiveSessionInboxEvent[];
  cwd: string;
  workspaceKind: ThreadWorkspaceKind;
  worktreePath?: string;
  worktreeBranch?: string;
  status: ThreadStatus;
  archived: boolean;
  managedWorktree?: boolean;
  /** Quality of a Relay-generated title, used to replace weak fallbacks with stronger intent later. */
  titleQuality?: ThreadTitleQuality;
  createdAt?: string;
  updatedAt?: string;
}

export interface PersistedThreads {
  activeThreadId: string | null;
  threads: ThreadInfo[];
}

export interface CreatedWorktree {
  path: string;
  branch: string;
}

export interface GitWorktreeInfo {
  path: string;
  branch: string | null;
  head: string | null;
  bare: boolean;
  detached: boolean;
}

export function createRelaySessionId(): string {
  return `rs_${uuid().replaceAll("-", "")}`;
}

const SESSION_NAME_VERBS = [
  "audit",
  "build",
  "check",
  "craft",
  "debug",
  "deploy",
  "design",
  "explore",
  "fix",
  "forge",
  "guard",
  "inspect",
  "map",
  "measure",
  "migrate",
  "model",
  "patch",
  "plan",
  "probe",
  "refine",
  "review",
  "scan",
  "shape",
  "solve",
  "test",
  "trace",
  "tune",
  "verify",
  "watch",
  "wire",
  "write",
  "zoom",
] as const;

const SESSION_NAME_NOUNS = [
  "badger",
  "beacon",
  "cedar",
  "comet",
  "coral",
  "crane",
  "delta",
  "falcon",
  "forest",
  "harbor",
  "heron",
  "island",
  "jaguar",
  "lantern",
  "lynx",
  "maple",
  "meadow",
  "meteor",
  "otter",
  "panda",
  "phoenix",
  "quartz",
  "raven",
  "river",
  "sparrow",
  "summit",
  "tiger",
  "valley",
  "willow",
  "wolf",
  "wren",
  "zephyr",
] as const;

export function normalizeRelaySessionName(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  if (!/^[a-z0-9]+-[a-z0-9]+$/.test(normalized)) {
    throw new Error("Session name must be two words, for example review-otter"); // effect-shape-allow: session creation reports invalid user input.
  }
  return normalized;
}

export function relaySessionNameFromId(relaySessionId: string, unavailable: Iterable<string> = []): string {
  const compactId = relaySessionId.replace(/^rs_/, "").replace(/[^a-fA-F0-9]/g, "");
  const combinations = SESSION_NAME_VERBS.length * SESSION_NAME_NOUNS.length;
  const seed = Number.parseInt(compactId.slice(0, 12) || "0", 16) % combinations;
  const used = new Set(unavailable);
  for (let offset = 0; offset < combinations; offset += 1) {
    const index = (seed + offset) % combinations;
    const verb = SESSION_NAME_VERBS[Math.floor(index / SESSION_NAME_NOUNS.length)];
    const noun = SESSION_NAME_NOUNS[index % SESSION_NAME_NOUNS.length];
    const candidate = `${verb}-${noun}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("No unused Relay session names are available"); // effect-shape-allow: session creation reports exhausted local names.
}

export function threadRelaySessionName(thread: Pick<ThreadInfo, "relaySessionId" | "relaySessionName" | "id">): string {
  return thread.relaySessionName ?? relaySessionNameFromId(thread.relaySessionId ?? thread.id);
}

export function childThreads(threads: readonly ThreadInfo[], parentThreadId: string): ThreadInfo[] {
  return threads.filter((thread) => !thread.archived && thread.parentThreadId === parentThreadId);
}

export function threadSessionRelations(
  threads: readonly ThreadInfo[],
): Array<{ readonly parentSessionId: string; readonly childSessionId: string }> {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  return threads.flatMap((child) => {
    if (!child.parentThreadId) return [];
    const parent = byId.get(child.parentThreadId);
    const parentSessionId = child.relationParentSessionId ?? parent?.sessionId;
    const childSessionId = child.relationChildSessionId ?? child.sessionId;
    return parentSessionId && childSessionId ? [{ parentSessionId, childSessionId }] : [];
  });
}

export function threadWorkspacePath(thread: Pick<ThreadInfo, "cwd" | "worktreePath">): string {
  return path.resolve(thread.worktreePath ?? thread.cwd);
}

export function additionalDirectoriesForThread(
  thread: Pick<ThreadInfo, "cwd" | "worktreePath">,
  threads: readonly Pick<ThreadInfo, "cwd" | "worktreePath" | "archived">[],
): string[] {
  const seen = new Set([path.resolve(thread.cwd), threadWorkspacePath(thread)]);
  const directories: string[] = [];
  for (const candidate of threads) {
    if (candidate.archived) continue;
    const directory = threadWorkspacePath(candidate);
    if (seen.has(directory)) continue;
    seen.add(directory);
    directories.push(directory);
  }
  return directories;
}

export function summarizeThreadRequest(text: string, maxLength = 34): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "New thread";
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function git(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env = { ...currentEnv() };
  for (const key of Object.keys(env)) {
    if (key === "GIT_EXEC_PATH" || key === "GIT_SSH" || key === "GIT_SSH_COMMAND" || key === "GIT_CONFIG_NOSYSTEM")
      continue;
    if (key.startsWith("GIT_")) delete env[key];
  }
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

export function findGitRoot(cwd: string): string | null {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.status !== 0) return null;
  const root = result.stdout.trim();
  return root || null;
}

function workspaceKey(cwd: string): string {
  const root = findGitRoot(cwd) ?? path.resolve(cwd);
  return createHash("sha1").update(root).digest("hex").slice(0, 16);
}

export function threadsStatePath(cwd: string): string {
  return path.join(getConfigDir(), "threads", `${workspaceKey(cwd)}.json`);
}

export function loadThreadsForWorkspace(cwd: string): PersistedThreads | null {
  const file = threadsStatePath(cwd);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedThreads>;
    if (!Array.isArray(parsed.threads)) return null;
    const usedNames = new Set<string>();
    const threads = parsed.threads.filter(isThreadInfo).map((thread) => {
      const relaySessionId = typeof thread.relaySessionId === "string" ? thread.relaySessionId : createRelaySessionId();
      let relaySessionName: string | undefined;
      if (typeof thread.relaySessionName === "string") {
        try {
          relaySessionName = normalizeRelaySessionName(thread.relaySessionName);
        } catch {
          relaySessionName = undefined;
        }
      }
      if (!relaySessionName || usedNames.has(relaySessionName)) {
        relaySessionName = relaySessionNameFromId(relaySessionId, usedNames);
      }
      usedNames.add(relaySessionName);
      return {
        ...thread,
        relaySessionId,
        relaySessionName,
        titleQuality: isThreadTitleQuality(thread.titleQuality) ? thread.titleQuality : undefined,
        status: "paused" as const,
      };
    });
    return {
      activeThreadId: typeof parsed.activeThreadId === "string" ? parsed.activeThreadId : null,
      threads,
    };
  } catch {
    return null;
  }
}

export function saveThreadsForWorkspace(cwd: string, state: PersistedThreads): void {
  const file = threadsStatePath(cwd);
  mkdirSync(path.dirname(file), { recursive: true });
  const threads = state.threads.map((thread) => ({ ...thread, status: "paused" as ThreadStatus }));
  writeFileSync(file, `${JSON.stringify({ activeThreadId: state.activeThreadId, threads }, null, 2)}\n`, "utf8");
}

function isThreadTitleQuality(value: unknown): value is ThreadTitleQuality {
  return value === "fallback" || value === "strong";
}

function isThreadInfo(value: unknown): value is ThreadInfo {
  if (!value || typeof value !== "object") return false;
  const thread = value as Partial<ThreadInfo>;
  return (
    typeof thread.id === "string" &&
    typeof thread.title === "string" &&
    (typeof thread.sessionId === "string" || thread.sessionId === null) &&
    typeof thread.cwd === "string" &&
    (thread.workspaceKind === "local" || thread.workspaceKind === "worktree") &&
    typeof thread.archived === "boolean"
  );
}

function safeSegment(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function createRelayWorktree(
  cwd: string,
  threadId: string,
  location: ThreadWorktreeLocation = "relay",
): CreatedWorktree {
  const root = findGitRoot(cwd);
  if (!root) throw new Error("Cannot create a worktree outside a git repository"); // effect-shape-allow: synchronous UI helper surfaces git failure to event handler toast.

  const repoName = safeSegment(path.basename(root)) || "repo";
  const branch = `relay/${safeSegment(threadId)}`;
  const basePath =
    location === "repo"
      ? path.join(path.dirname(root), `${repoName}-relay-worktrees`)
      : path.join(getConfigDir(), "worktrees", repoName);
  const worktreePath = path.join(basePath, safeSegment(threadId));
  mkdirSync(path.dirname(worktreePath), { recursive: true });

  const result = git(root, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "git worktree add failed").trim()); // effect-shape-allow: synchronous UI helper surfaces git failure to event handler toast.
  }

  return { path: worktreePath, branch };
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export function relayWorktreeBasePath(cwd: string): string | null {
  const root = findGitRoot(cwd);
  if (!root) return null;
  const repoName = safeSegment(path.basename(root)) || "repo";
  return path.join(getConfigDir(), "worktrees", repoName);
}

export function repoWorktreeBasePath(cwd: string): string | null {
  const root = findGitRoot(cwd);
  if (!root) return null;
  const repoName = safeSegment(path.basename(root)) || "repo";
  return path.join(path.dirname(root), `${repoName}-relay-worktrees`);
}

export function discoverThreadWorktreeCandidates(cwd: string): GitWorktreeInfo[] {
  const byPath = new Map<string, GitWorktreeInfo>();
  for (const worktree of listGitWorktrees(cwd)) byPath.set(worktree.path, worktree);
  for (const base of [relayWorktreeBasePath(cwd), repoWorktreeBasePath(cwd)]) {
    if (!base || !isDirectory(base)) continue;
    for (const entry of readdirSync(base)) {
      const candidate = path.join(base, entry);
      if (!isDirectory(candidate) || byPath.has(candidate)) continue;
      const root = findGitRoot(candidate);
      if (!root) continue;
      const branchResult = git(candidate, ["branch", "--show-current"]);
      const headResult = git(candidate, ["rev-parse", "HEAD"]);
      byPath.set(candidate, {
        path: candidate,
        branch: branchResult.status === 0 && branchResult.stdout.trim() ? branchResult.stdout.trim() : null,
        head: headResult.status === 0 && headResult.stdout.trim() ? headResult.stdout.trim() : null,
        bare: false,
        detached: false,
      });
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function listGitWorktrees(cwd: string): GitWorktreeInfo[] {
  const root = findGitRoot(cwd);
  if (!root) return [];
  const result = git(root, ["worktree", "list", "--porcelain"]);
  if (result.status !== 0) return [];
  const worktrees: GitWorktreeInfo[] = [];
  let current: GitWorktreeInfo | null = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = { path: line.slice("worktree ".length), branch: null, head: null, bare: false, detached: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    else if (line === "bare") current.bare = true;
    else if (line === "detached") current.detached = true;
  }
  if (current) worktrees.push(current);
  return worktrees;
}

export function archiveRelayWorktree(worktreePath: string, mainWorktreeCwd?: string): void {
  if (!existsSync(worktreePath)) return;
  const root = findGitRoot(mainWorktreeCwd ?? worktreePath) ?? findGitRoot(worktreePath);
  const result = git(root ?? worktreePath, ["worktree", "remove", "--force", worktreePath]);
  if (result.status === 0) return;

  const message = (result.stderr || result.stdout || "git worktree remove failed").trim();
  if (root && /validation failed, cannot remove working tree/i.test(message)) {
    rmSync(worktreePath, { recursive: true, force: true });
    const prune = git(root, ["worktree", "prune"]);
    if (prune.status === 0) return;
    throw new Error((prune.stderr || prune.stdout || message).trim()); // effect-shape-allow: synchronous UI helper surfaces git failure to event handler toast.
  }
  throw new Error(message); // effect-shape-allow: synchronous UI helper surfaces git failure to event handler toast.
}
