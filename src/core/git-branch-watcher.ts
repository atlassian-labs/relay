/**
 * Git branch watcher — event-driven branch tracking with fallback strategies.
 *
 * Adapted from pi-mono's FooterDataProvider approach:
 *
 * 1. Primary: fs.watch on the directory containing .git/HEAD (kernel-level,
 *    zero CPU when idle). We watch the *directory* rather than the file because
 *    git uses atomic writes (write temp → rename) which swap the inode and
 *    break file-level watchers.
 *
 * 2. Fallback 1: fs.watchFile (stat-poll at 1000ms) on HEAD as a
 *    belt-and-suspenders safety net for filesystems where fs.watch is delayed
 *    or misses git's atomic HEAD rewrites.
 *
 * 3. Fallback 2: fs.watch on reftable/ directory — newer git repos using the
 *    reftable format update reftable/ instead of HEAD on branch switches.
 *
 * 4. Fallback 3: fs.watchFile (stat-poll at 250ms) on reftable/tables.list for
 *    filesystems where fs.watch on individual files is unreliable.
 *
 * All watcher events are debounced through a 500ms window so rapid changes
 * during e.g. `git checkout` coalesce into a single resolution.
 *
 * If each watcher errors out (EMFILE, network FS, etc.) all watchers are torn
 * down and retried after 5 seconds.
 */

import { execFile, spawnSync, type ExecFileException } from "../platform/process";
import { existsSync, type FSWatcher, readFileSync, statSync, unwatchFile, watch, watchFile } from "../platform/fs";
import { dirname, join, resolve } from "path";
import { Effect, type Scope } from "effect";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce window for coalescing watcher events before resolving the branch. */
const WATCH_DEBOUNCE_MS = 500;

/** Delay before retrying watchers after an error. */
const WATCHER_RETRY_DELAY_MS = 5_000;

/** Polling interval for HEAD as a low-frequency safety net. */
const HEAD_POLL_INTERVAL_MS = 1_000;

// ---------------------------------------------------------------------------
// Git path resolution
// ---------------------------------------------------------------------------

interface GitPaths {
  /** Root of the working tree (where .git lives). */
  repoDir: string;
  /** The shared .git directory (same as repoDir/.git for normal repos). */
  commonGitDir: string;
  /** Full path to the HEAD file for this worktree. */
  headPath: string;
}

/**
 * Walk up from `cwd` to find the git metadata paths.
 * Handles both regular repos (.git is a directory) and worktrees (.git is a file
 * containing `gitdir: <path>`).
 */
function findGitPaths(cwd: string): GitPaths | null {
  let dir = cwd;
  while (true) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isFile()) {
          // Worktree: .git is a file with "gitdir: <path>"
          const content = readFileSync(gitPath, "utf8").trim();
          if (content.startsWith("gitdir: ")) {
            const gitDir = resolve(dir, content.slice(8).trim());
            const headPath = join(gitDir, "HEAD");
            if (!existsSync(headPath)) return null;
            const commonDirPath = join(gitDir, "commondir");
            const commonGitDir = existsSync(commonDirPath)
              ? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
              : gitDir;
            return { repoDir: dir, commonGitDir, headPath };
          }
        } else if (stat.isDirectory()) {
          const headPath = join(gitPath, "HEAD");
          if (!existsSync(headPath)) return null;
          return { repoDir: dir, commonGitDir: gitPath, headPath };
        }
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Branch resolution helpers
// ---------------------------------------------------------------------------

/** Synchronous branch resolution — used for the initial read. */
function resolveBranchWithGitSync(repoDir: string): string | null {
  const result = spawnSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const branch = result.status === 0 ? result.stdout.trim() : "";
  return branch || null;
}

/** Async branch resolution — used for debounced refreshes to avoid blocking the UI. */
function resolveBranchWithGitAsync(repoDir: string): Promise<string | null> {
  // effect-shape-allow: legacy git watcher async bridge; scoped watcher API added, full timer/process migration remains tracked.
  return new Promise((res) => {
    execFile(
      "git",
      ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
      { cwd: repoDir, encoding: "utf8" },
      (error: ExecFileException | null, stdout: string) => {
        if (error) {
          res(null);
          return;
        }
        const branch = stdout.trim();
        res(branch || null);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Watcher helpers
// ---------------------------------------------------------------------------

function closeWatcher(watcher: FSWatcher | null): void {
  if (!watcher) return;
  try {
    watcher.close();
  } catch {
    /* ignore */
  }
}

function watchWithErrorHandler(
  path: string,
  listener: (eventType: string, filename: string | null) => void,
  onError: () => void,
): FSWatcher | null {
  try {
    const watcher = watch(path, listener);
    watcher.on("error", onError);
    return watcher;
  } catch {
    onError();
    return null;
  }
}

// ---------------------------------------------------------------------------
// GitBranchWatcher
// ---------------------------------------------------------------------------

export class GitBranchWatcher {
  private cwd: string;
  private gitPaths: GitPaths | null;

  // Cached branch value: undefined = not yet resolved
  private cachedBranch: string | null | undefined = undefined;

  // Watchers
  private headWatcher: FSWatcher | null = null;
  private headWatchFilePath: string | null = null;
  private reftableWatcher: FSWatcher | null = null;
  private reftableTablesListWatcher: FSWatcher | null = null;
  private reftableTablesListPath: string | null = null;

  // Timers
  // effect-shape-allow: legacy git watcher timer handle; disposed by GitBranchWatcher.dispose.
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  // effect-shape-allow: legacy git watcher retry timer handle; disposed by GitBranchWatcher.dispose.
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  // Async refresh guards
  private refreshInFlight = false;
  private refreshPending = false;

  private disposed = false;
  private listeners = new Set<(branch: string | null) => void>();

  constructor(cwd: string) {
    this.cwd = cwd;
    this.gitPaths = findGitPaths(cwd);
    this.setupWatchers();
  }

  static scoped(cwd: string): Effect.Effect<GitBranchWatcher, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => new GitBranchWatcher(cwd)),
      (watcher) => Effect.sync(() => watcher.dispose()),
    );
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Current branch name, null if not in a repo or detached HEAD. */
  getBranch(): string | null {
    if (this.cachedBranch === undefined) {
      this.cachedBranch = this.resolveSync();
    }
    return this.cachedBranch;
  }

  /** Subscribe to branch changes. Returns an unsubscribe function. */
  onChange(callback: (branch: string | null) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Update the working directory (e.g. if the user changes cwd at runtime). */
  setCwd(cwd: string): void {
    if (this.cwd === cwd) return;
    this.cwd = cwd;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.clearWatchers();
    this.cachedBranch = undefined;
    this.gitPaths = findGitPaths(cwd);
    this.setupWatchers();
    this.notify();
  }

  /** Tear down all watchers and timers. */
  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.clearWatchers();
    this.listeners.clear();
  }

  // -----------------------------------------------------------------------
  // Branch resolution
  // -----------------------------------------------------------------------

  /** Read .git/HEAD synchronously — fast path for initial render. */
  private resolveSync(): string | null {
    try {
      if (!this.gitPaths) return null;
      const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
      if (content.startsWith("ref: refs/heads/")) {
        const branch = content.slice(16);
        // Reftable repos write ".invalid" as the HEAD ref; resolve via git.
        return branch === ".invalid" ? (resolveBranchWithGitSync(this.gitPaths.repoDir) ?? "detached") : branch;
      }
      return "detached";
    } catch {
      return null;
    }
  }

  /** Read .git/HEAD and resolve asynchronously (reftable falls back to git). */
  private async resolveAsync(): Promise<string | null> {
    try {
      if (!this.gitPaths) return null;
      const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
      if (content.startsWith("ref: refs/heads/")) {
        const branch = content.slice(16);
        return branch === ".invalid"
          ? ((await resolveBranchWithGitAsync(this.gitPaths.repoDir)) ?? "detached")
          : branch;
      }
      return "detached";
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Debounced refresh
  // -----------------------------------------------------------------------

  private scheduleRefresh(): void {
    if (this.disposed || this.refreshTimer) return;
    if (this.refreshInFlight) {
      this.refreshPending = true;
      return;
    }
    // effect-shape-allow: legacy debounce timer; scoped watcher API guarantees disposal.
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshAsync();
    }, WATCH_DEBOUNCE_MS);
  }

  private async refreshAsync(): Promise<void> {
    if (this.disposed) return;
    if (this.refreshInFlight) {
      this.refreshPending = true;
      return;
    }

    this.refreshInFlight = true;
    try {
      const nextBranch = await this.resolveAsync();
      if (this.disposed) return;
      if (this.cachedBranch !== undefined && this.cachedBranch !== nextBranch) {
        this.cachedBranch = nextBranch;
        this.notify();
        return;
      }
      this.cachedBranch = nextBranch;
    } finally {
      this.refreshInFlight = false;
      if (this.refreshPending && !this.disposed) {
        this.refreshPending = false;
        this.scheduleRefresh();
      }
    }
  }

  // -----------------------------------------------------------------------
  // Notification
  // -----------------------------------------------------------------------

  private notify(): void {
    const branch = this.cachedBranch ?? null;
    for (const cb of this.listeners) cb(branch);
  }

  // -----------------------------------------------------------------------
  // Watcher setup / teardown
  // -----------------------------------------------------------------------

  private clearWatchers(): void {
    closeWatcher(this.headWatcher);
    this.headWatcher = null;
    if (this.headWatchFilePath) {
      unwatchFile(this.headWatchFilePath);
      this.headWatchFilePath = null;
    }
    closeWatcher(this.reftableWatcher);
    this.reftableWatcher = null;
    closeWatcher(this.reftableTablesListWatcher);
    this.reftableTablesListWatcher = null;
    if (this.reftableTablesListPath) {
      unwatchFile(this.reftableTablesListPath);
      this.reftableTablesListPath = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private handleWatcherError(): void {
    this.clearWatchers();
    this.scheduleWatcherRetry();
  }

  private scheduleWatcherRetry(): void {
    if (this.disposed || this.retryTimer) return;
    // effect-shape-allow: legacy retry timer; scoped watcher API guarantees disposal.
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.setupWatchers();
    }, WATCHER_RETRY_DELAY_MS);
  }

  private setupWatchers(): void {
    this.clearWatchers();
    if (!this.gitPaths) return;

    // Strategy 1: Watch the directory containing HEAD.
    // Git uses atomic writes (write temp → rename over HEAD) which changes the
    // inode, so we watch the directory instead of the file itself.
    this.headWatcher = watchWithErrorHandler(
      dirname(this.gitPaths.headPath),
      (_eventType, filename) => {
        if (!filename || filename === "HEAD") {
          this.scheduleRefresh();
        }
      },
      () => this.handleWatcherError(),
    );
    if (!this.headWatcher) return;

    // Safety net: some platforms/filesystems can drop or delay fs.watch events
    // for atomic HEAD rewrites. Stat-poll HEAD too so branch labels eventually
    // update even when the kernel watcher misses the checkout.
    this.headWatchFilePath = this.gitPaths.headPath;
    watchFile(this.gitPaths.headPath, { interval: HEAD_POLL_INTERVAL_MS }, (current, previous) => {
      if (
        current.mtimeMs !== previous.mtimeMs ||
        current.ctimeMs !== previous.ctimeMs ||
        current.size !== previous.size
      ) {
        this.scheduleRefresh();
      }
    });

    // Strategy 2: Watch the reftable/ directory.
    // Repos using the reftable format update files here instead of HEAD on
    // branch switches.
    const reftableDir = join(this.gitPaths.commonGitDir, "reftable");
    if (!existsSync(reftableDir)) return;

    this.reftableWatcher = watchWithErrorHandler(
      reftableDir,
      () => this.scheduleRefresh(),
      () => this.handleWatcherError(),
    );
    if (!this.reftableWatcher) return;

    // Strategy 3: fs.watch + fs.watchFile on reftable/tables.list.
    // fs.watchFile (stat-poll) is a safety net for platforms/filesystems where
    // kernel-level fs.watch on individual files is unreliable.
    const tablesListPath = join(reftableDir, "tables.list");
    if (!existsSync(tablesListPath)) return;

    this.reftableTablesListPath = tablesListPath;
    this.reftableTablesListWatcher = watchWithErrorHandler(
      tablesListPath,
      () => this.scheduleRefresh(),
      () => this.handleWatcherError(),
    );
    if (!this.reftableTablesListWatcher) return;

    watchFile(tablesListPath, { interval: 250 }, (current, previous) => {
      if (
        current.mtimeMs !== previous.mtimeMs ||
        current.ctimeMs !== previous.ctimeMs ||
        current.size !== previous.size
      ) {
        this.scheduleRefresh();
      }
    });
  }
}
