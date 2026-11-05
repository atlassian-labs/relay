import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  await execFileAsync(command, args, { cwd, env });
}

function fixtureEnv(root: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH ?? ""}` };
}

async function makeFixtureRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-pre-commit-"));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, "scripts/hooks"), { recursive: true });
  await fs.mkdir(path.join(root, "bin"), { recursive: true });
  await fs.copyFile("scripts/install-pre-commit-hook.sh", path.join(root, "scripts/install-pre-commit-hook.sh"));
  await fs.copyFile("scripts/hooks/pre-commit", path.join(root, "scripts/hooks/pre-commit"));
  await fs.chmod(path.join(root, "scripts/install-pre-commit-hook.sh"), 0o755);
  await fs.chmod(path.join(root, "scripts/hooks/pre-commit"), 0o755);
  await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify({ scripts: {} })}\n`);
  await fs.writeFile(
    path.join(root, "bin/bun"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${GIT_DIR+x}" = x ] || [ "\${GIT_WORK_TREE+x}" = x ]; then
  printf "leaked git environment\n" >&2
  exit 1
fi
printf "%s\n" "$PWD :: $*" >> "$PRE_COMMIT_CALL_LOG"
`,
  );
  await fs.writeFile(
    path.join(root, "bin/git"),
    `#!/usr/bin/env bash
set -euo pipefail
config_file="$PWD/.git/config"
if [ "$1" = "-C" ]; then
  shift 2
fi

case "$1" in
  init)
    mkdir -p "$PWD/.git"
    touch "$config_file"
    ;;
  rev-parse)
    if [ "$2" = "--show-toplevel" ]; then
      printf "%s\n" "$PWD"
    elif [ "$2" = "--local-env-vars" ]; then
      printf "GIT_DIR\nGIT_WORK_TREE\n"
    else
      exit 1
    fi
    ;;
  config)
    if [ "$2" = "--get" ]; then
      key="$3"
      awk -F= -v key="$key" '$1 == key { print $2 }' "$config_file"
    else
      key="$2"
      value="$3"
      grep -v "^\${key}=" "$config_file" > "$config_file.tmp" || true
      mv "$config_file.tmp" "$config_file"
      printf "%s=%s\n" "$key" "$value" >> "$config_file"
    fi
    ;;
  *)
    exit 1
    ;;
esac
`,
  );
  await fs.chmod(path.join(root, "bin/bun"), 0o755);
  await fs.chmod(path.join(root, "bin/git"), 0o755);
  const env = fixtureEnv(root);
  await run("git", ["init"], root, env);
  await run("git", ["config", "user.email", "test@example.com"], root, env);
  await run("git", ["config", "user.name", "Test User"], root, env);
  return root;
}

async function readCalls(root: string): Promise<string> {
  return fs.readFile(path.join(root, "calls.log"), "utf8");
}

async function readPrepareScript(): Promise<string> {
  const packageJson = JSON.parse(await fs.readFile("package.json", "utf8"));
  return packageJson.scripts.prepare;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("pre-commit hook", () => {
  test("installs Git hooks by pointing core.hooksPath at tracked hooks", async () => {
    const root = await makeFixtureRoot();

    const env = fixtureEnv(root);
    await execFileAsync("bash", ["scripts/install-pre-commit-hook.sh"], { cwd: root, env });

    await expect(
      execFileAsync("git", ["config", "--get", "core.hooksPath"], { cwd: root, env }),
    ).resolves.toMatchObject({
      stdout: "scripts/hooks\n",
    });
  });

  test("prepare installs hooks in a Git worktree", async () => {
    const root = await makeFixtureRoot();

    const env = fixtureEnv(root);
    await execFileAsync("sh", ["-c", await readPrepareScript()], { cwd: root, env });

    await expect(
      execFileAsync("git", ["config", "--get", "core.hooksPath"], { cwd: root, env }),
    ).resolves.toMatchObject({
      stdout: "scripts/hooks\n",
    });
  });

  test("tracked pre-commit runs the exact CI check script", async () => {
    const root = await makeFixtureRoot();

    await execFileAsync("bash", ["scripts/hooks/pre-commit"], {
      cwd: root,
      env: {
        ...fixtureEnv(root),
        GIT_DIR: path.join(root, ".git"),
        GIT_WORK_TREE: root,
        PRE_COMMIT_CALL_LOG: path.join(root, "calls.log"),
      },
    });

    expect(await readCalls(root)).toContain(`${root} :: run check`);
  });
});
