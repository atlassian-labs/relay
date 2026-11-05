import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  additionalDirectoriesForThread,
  archiveRelayWorktree,
  createRelayWorktree,
  normalizeRelaySessionName,
  relaySessionNameFromId,
  summarizeThreadRequest,
  threadSessionRelations,
  type ThreadInfo,
} from "../../src/core/threads";

interface GitFixtureEnv {
  sandbox: string;
  home: string;
  xdgConfigHome: string;
  globalConfig: string;
}

describe("thread helpers", () => {
  let gitFixtureEnv: GitFixtureEnv | null = null;

  beforeEach(() => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-thread-git-env-"));
    const fixtureEnv = {
      sandbox,
      home: path.join(sandbox, "home"),
      xdgConfigHome: path.join(sandbox, "config"),
      globalConfig: path.join(sandbox, "global.gitconfig"),
    };
    fs.mkdirSync(fixtureEnv.home, { recursive: true });
    fs.mkdirSync(fixtureEnv.xdgConfigHome, { recursive: true });
    gitFixtureEnv = fixtureEnv;
  });

  afterEach(() => {
    if (gitFixtureEnv) {
      fs.rmSync(gitFixtureEnv.sandbox, { recursive: true, force: true });
    }
    gitFixtureEnv = null;
  });

  function gitEnv(cwd: string): NodeJS.ProcessEnv {
    if (!gitFixtureEnv) {
      throw new Error("git fixture environment is not initialized");
    }
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith("GIT_") && value !== undefined) {
        env[key] = value;
      }
    }
    env.HOME = gitFixtureEnv.home;
    env.USERPROFILE = gitFixtureEnv.home;
    env.XDG_CONFIG_HOME = gitFixtureEnv.xdgConfigHome;
    env.GIT_CONFIG_GLOBAL = gitFixtureEnv.globalConfig;
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.PWD = cwd;
    return env;
  }

  function runGit(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync("git", args, {
      cwd,
      env: gitEnv(cwd),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      status: result.status,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  }

  function git(cwd: string, args: string[]): string {
    const result = runGit(cwd, args);
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout.trim();
  }

  function createGitRepo(defaultBranch: string): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "relay-thread-repo-"));
    git(repo, ["init", "--initial-branch", defaultBranch]);
    fs.writeFileSync(path.join(repo, "README.md"), "# test repo\n", "utf8");
    git(repo, ["add", "README.md"]);
    git(repo, ["-c", "user.email=relay-tests@example.com", "-c", "user.name=Relay Tests", "commit", "-m", "initial"]);
    return repo;
  }
  test("summarizes the first user request into a compact title", () => {
    expect(summarizeThreadRequest("  add threads, git branch and worktree support to Relay  ")).toBe(
      "add threads, git branch and workt…",
    );
    expect(summarizeThreadRequest("fix bug")).toBe("fix bug");
    expect(summarizeThreadRequest("\n\t")).toBe("New thread");
  });

  test("normalizes agent-selected two-word session names", () => {
    expect(normalizeRelaySessionName("Review Auth")).toBe("review-auth");
    expect(() => normalizeRelaySessionName("review-auth-tests")).toThrow("must be two words");
  });

  test("generates two-word session names and avoids names already in use", () => {
    const first = relaySessionNameFromId("rs_0123456789abcdef");
    const second = relaySessionNameFromId("rs_0123456789abcdef", [first]);

    expect(first).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(second).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(second).not.toBe(first);
  });

  test("derives resumable session relationships from native parent threads", () => {
    const base = {
      cwd: "/tmp/project",
      workspaceKind: "local" as const,
      status: "paused" as const,
      archived: false,
      title: "Thread",
    };
    const threads: ThreadInfo[] = [
      { ...base, id: "parent", relaySessionId: "rs_parent", sessionId: "acp-parent" },
      {
        ...base,
        id: "child",
        relaySessionId: "rs_child",
        sessionId: "acp-unrelated-resume",
        parentThreadId: "parent",
        relationKind: "child",
        relationParentSessionId: "acp-parent",
        relationChildSessionId: "acp-child",
      },
      {
        ...base,
        id: "second-child",
        relaySessionId: "rs_second_child",
        sessionId: "acp-second-child",
        parentThreadId: "parent",
        relationKind: "child",
      },
      {
        ...base,
        id: "pending",
        relaySessionId: "rs_pending",
        sessionId: null,
        parentThreadId: "parent",
        relationKind: "handoff",
      },
    ];

    expect(threadSessionRelations(threads)).toEqual([
      { parentSessionId: "acp-parent", childSessionId: "acp-child" },
      { parentSessionId: "acp-parent", childSessionId: "acp-second-child" },
    ]);
  });

  test("derives additional directories from other visible thread workspaces", () => {
    const root = path.join(os.tmpdir(), "relay-root");
    const firstWorktree = path.join(os.tmpdir(), "relay-worktree-a");
    const secondWorktree = path.join(os.tmpdir(), "relay-worktree-b");
    const archivedWorktree = path.join(os.tmpdir(), "relay-worktree-archived");

    expect(
      additionalDirectoriesForThread({ cwd: root }, [
        { cwd: root, archived: false },
        { cwd: firstWorktree, worktreePath: firstWorktree, archived: false },
        { cwd: firstWorktree, worktreePath: firstWorktree, archived: false },
        { cwd: secondWorktree, worktreePath: secondWorktree, archived: false },
        { cwd: archivedWorktree, worktreePath: archivedWorktree, archived: true },
      ]),
    ).toEqual([path.resolve(firstWorktree), path.resolve(secondWorktree)]);
  });

  test("creates fixture commits without persisting the test identity in git config", () => {
    const repo = createGitRepo("main");

    try {
      expect(git(repo, ["log", "-1", "--format=%an <%ae>"])).toBe("Relay Tests <relay-tests@example.com>");
      expect(runGit(repo, ["config", "--local", "--get", "user.name"]).status).toBe(1);
      expect(runGit(repo, ["config", "--local", "--get", "user.email"]).status).toBe(1);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("creates relay worktrees from HEAD instead of a hardcoded default branch", () => {
    const repo = createGitRepo("master");
    let worktreePath: string | null = null;

    try {
      const head = git(repo, ["rev-parse", "HEAD"]);
      const worktree = createRelayWorktree(repo, "thread-head-master", "repo");
      worktreePath = worktree.path;

      expect(fs.existsSync(worktree.path)).toBe(true);
      expect(worktree.branch).toBe("relay/thread-head-master");
      expect(git(worktree.path, ["rev-parse", "HEAD"])).toBe(head);
      expect(git(worktree.path, ["branch", "--show-current"])).toBe(worktree.branch);
    } finally {
      if (worktreePath && fs.existsSync(worktreePath)) {
        archiveRelayWorktree(worktreePath);
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("archives managed worktrees from their repository root", () => {
    const repo = createGitRepo("main");

    try {
      const worktree = createRelayWorktree(repo, "thread-archive-root", "repo");
      expect(fs.existsSync(worktree.path)).toBe(true);

      archiveRelayWorktree(worktree.path);

      expect(fs.existsSync(worktree.path)).toBe(false);
      expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(worktree.path);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("archives managed worktrees after their directory is missing git metadata", () => {
    const repo = createGitRepo("main");

    try {
      const worktree = createRelayWorktree(repo, "thread-archive-missing-metadata", "repo");
      expect(fs.existsSync(worktree.path)).toBe(true);
      fs.rmSync(path.join(worktree.path, ".git"), { force: true });

      archiveRelayWorktree(worktree.path, repo);

      expect(fs.existsSync(worktree.path)).toBe(false);
      expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(worktree.path);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
