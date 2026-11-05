import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { getWorkingTreeDiff } from "../../src/core/git-diff";
import { runTestEffect } from "../../src/effect/runtime";

function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
}

describe("getWorkingTreeDiff", () => {
  test("includes tracked and untracked file patches", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "relay-git-diff-"));
    try {
      runGit(cwd, ["init"]);
      runGit(cwd, ["config", "user.email", "relay@example.test"]);
      runGit(cwd, ["config", "user.name", "Relay Test"]);
      writeFileSync(path.join(cwd, "tracked.txt"), "old\n");
      runGit(cwd, ["add", "."]);
      runGit(cwd, ["commit", "-m", "initial"]);
      writeFileSync(path.join(cwd, "tracked.txt"), "new\n");
      writeFileSync(path.join(cwd, "untracked.txt"), "hello\n");

      const files = await runTestEffect(getWorkingTreeDiff(cwd));

      expect(files.map((file) => ({ path: file.path, status: file.status }))).toEqual([
        { path: "tracked.txt", status: "modified" },
        { path: "untracked.txt", status: "added" },
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
