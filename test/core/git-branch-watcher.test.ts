import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { GitBranchWatcher } from "../../src/core/git-branch-watcher";
import { runTestEffect } from "../lib/effect";

function tmpRepo(): string {
  const root = path.join(tmpdir(), `relay-git-watcher-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path.join(root, ".git"), { recursive: true });
  writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n", "utf-8");
  return root;
}

function waitForBranch(watcher: GitBranchWatcher, expected: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for branch ${expected}`));
    }, 2_000);
    const unsubscribe = watcher.onChange((branch) => {
      if (branch === expected) {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
}

describe("GitBranchWatcher", () => {
  test("reads the current branch from HEAD", () => {
    const root = tmpRepo();
    try {
      const watcher = new GitBranchWatcher(root);
      try {
        expect(watcher.getBranch()).toBe("main");
      } finally {
        watcher.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("updates when HEAD changes even if directory watcher misses the event", async () => {
    const root = tmpRepo();
    try {
      const watcher = new GitBranchWatcher(root);
      try {
        expect(watcher.getBranch()).toBe("main");
        const branchChange = waitForBranch(watcher, "feature");
        writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/feature\n", "utf-8");
        await branchChange;
        expect(watcher.getBranch()).toBe("feature");
      } finally {
        watcher.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scoped watcher disposes subscriptions on scope exit", async () => {
    const root = tmpRepo();
    try {
      let calls = 0;
      let watcher: GitBranchWatcher | undefined;
      await runTestEffect(
        Effect.scoped(
          Effect.gen(function* () {
            watcher = yield* GitBranchWatcher.scoped(root);
            watcher.onChange(() => {
              calls += 1;
            });
          }),
        ),
      );

      watcher?.setCwd(root);
      expect(calls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
