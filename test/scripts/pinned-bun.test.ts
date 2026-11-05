import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const tempRoots: string[] = [];
const pinnedBunVersion = (await Bun.file(".bun-version").text()).trim();

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "relay-pinned-bun-"));
  tempRoots.push(root);
  mkdirSync(path.join(root, "bin"), { recursive: true });
  return root;
}

function writeFakeBun(root: string, version: string): string {
  const bunDir = path.join(root, "bin");
  mkdirSync(bunDir, { recursive: true });
  const bunPath = path.join(bunDir, "bun");
  writeFileSync(
    bunPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf '${version}\\n'
  exit 0
fi
printf 'path_head=%s\\n' "\${PATH%%:*}"
index=1
for arg in "$@"; do
  printf 'arg%s=%s\\n' "$index" "$arg"
  index=$((index + 1))
done
`,
  );
  chmodSync(bunPath, 0o755);
  return bunPath;
}

interface PinnedBunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runPinnedBun(args: string[], env: NodeJS.ProcessEnv): PinnedBunResult {
  const result = Bun.spawnSync({
    cmd: ["bash", "scripts/pinned-bun.sh", ...args],
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe("scripts/pinned-bun.sh", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  test("execs a matching BUN_BIN and forwards arguments with that binary first on PATH", () => {
    const root = fixtureRoot();
    const bunPath = writeFakeBun(root, pinnedBunVersion);
    const env = {
      ...process.env,
      BUN_BIN: bunPath,
      BUN_INSTALL: path.join(root, "install"),
      RELAY_BUN_AUTO_INSTALL: "0",
      PATH: `${path.dirname(bunPath)}:${process.env.PATH ?? ""}`,
    };

    const result = runPinnedBun(["run", "check:pinned", "--flag"], env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`path_head=${path.dirname(bunPath)}`);
    expect(result.stdout).toContain("arg1=run");
    expect(result.stdout).toContain("arg2=check:pinned");
    expect(result.stdout).toContain("arg3=--flag");
  });

  test("prefers BUN_INSTALL pinned Bun over a stale PATH Bun", () => {
    const root = fixtureRoot();
    const staleBunPath = writeFakeBun(path.join(root, "stale"), "0.0.0");
    const installRoot = path.join(root, "install");
    const pinnedBunPath = writeFakeBun(installRoot, pinnedBunVersion);
    const env = {
      ...process.env,
      BUN_BIN: "",
      BUN_INSTALL: installRoot,
      RELAY_BUN_AUTO_INSTALL: "0",
      PATH: `${path.dirname(staleBunPath)}:${process.env.PATH ?? ""}`,
    };

    const result = runPinnedBun(["run", "check:pinned"], env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`path_head=${path.dirname(pinnedBunPath)}`);
    expect(result.stdout).toContain("arg1=run");
    expect(result.stdout).toContain("arg2=check:pinned");
  });

  test("fails by default instead of auto-installing when no candidate matches the pinned version", () => {
    const root = fixtureRoot();
    const bunPath = writeFakeBun(root, "0.0.0");
    const env = {
      ...process.env,
      BUN_BIN: bunPath,
      BUN_INSTALL: path.join(root, "missing-install"),
      RELAY_BUN_AUTO_INSTALL: "",
      PATH: `${path.dirname(bunPath)}:${process.env.PATH ?? ""}`,
    };

    const result = runPinnedBun(["--version"], env);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Relay requires Bun ${pinnedBunVersion}; current runtime is Bun 0.0.0.`);
    expect(result.stderr).toContain(`curl -fsSL https://bun.sh/install | bash -s -- bun-v${pinnedBunVersion}`);
  });
});
