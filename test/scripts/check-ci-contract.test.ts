import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

const packageJson = await Bun.file("package.json").json();
const ciWorkflow = await Bun.file(".github/workflows/ci.yml").text();
const pinnedBunVersion = (await Bun.file(".bun-version").text()).trim();
const preCommitHook = await Bun.file("scripts/hooks/pre-commit").text();
const pinnedBunWrapper = await Bun.file("scripts/pinned-bun.sh").text();
const oxlintConfig = await Bun.file("oxlint.config.json").json();
const oxfmtConfig = await Bun.file("oxfmt.config.json").json();

function sourceFiles(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root)) {
    const fullPath = path.join(root, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      result.push(...sourceFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      result.push(fullPath);
    }
  }
  return result;
}

describe("CI contract", () => {
  test("local Bun version contract matches CI and type definitions", () => {
    expect(pinnedBunVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageJson.packageManager).toBe(`bun@${pinnedBunVersion}`);
    expect(packageJson.devDependencies?.["@types/bun"]).toBe(pinnedBunVersion);
    expect(packageJson.scripts?.["check:bun-version"]).toBe(
      "bash scripts/pinned-bun.sh run scripts/check-bun-version.ts",
    );
    expect(packageJson.scripts?.check).toBe("bash scripts/pinned-bun.sh run check:pinned");
    expect(packageJson.scripts?.["check:pinned"]).toStartWith("bun run scripts/check-bun-version.ts && ");
    expect(pinnedBunWrapper).toContain("curl -fsSL https://bun.sh/install");
    expect(pinnedBunWrapper).toContain("$BUN_INSTALL/bin/bun");
    // CI resolves Bun from .bun-version rather than pinning it a second time,
    // so the version contract cannot drift from the repository.
    expect(ciWorkflow).toContain("bun-version-file: .bun-version");
  });

  test("bun run check keeps local validation aggregated before build", () => {
    const checkScript = packageJson.scripts?.["check:pinned"];

    expect(packageJson.scripts?.check).toBe("bash scripts/pinned-bun.sh run check:pinned");
    expect(packageJson.scripts?.typecheck).toBe("tsgo --noEmit");
    expect(packageJson.devDependencies?.["@typescript/native-preview"]).toMatch(/^7\./);
    expect(checkScript).toContain("bun run typecheck");
    expect(checkScript).toContain("bun run lint");
    expect(checkScript).toContain("bun run lint:effect-shape");
    expect(checkScript).toContain("bun run lint:boundaries");
    expect(checkScript).toContain("bun run format:check");
    expect(checkScript).toContain("bun run test:unit");
    expect(checkScript.indexOf("bun run lint:effect-shape")).toBeLessThan(checkScript.indexOf("bun run build"));
    expect(checkScript.indexOf("bun run lint:boundaries")).toBeLessThan(checkScript.indexOf("bun run build"));
  });

  test("unit test script excludes real E2E suites", () => {
    const unitTestScript = packageJson.scripts?.["test:unit"];

    expect(unitTestScript).toContain("bash scripts/pinned-bun.sh test");
    expect(unitTestScript).toContain("./test/ui/app");
    // CI runners are several times slower than a developer machine, so Bun's
    // 5s default times out process-spawning and frame-capture tests at random.
    expect(unitTestScript).toContain("--timeout=60000");
    expect(unitTestScript).not.toContain("test/real-e2e");
    expect(unitTestScript).not.toContain("test/ui/app-e2e.test.tsx");
    expect(unitTestScript).not.toContain("test/ui/app-e2e");
  });

  test("CI runs the aggregated check on pushes to main and on pull requests", () => {
    expect(ciWorkflow).toMatch(/on:[\s\S]*push:[\s\S]*branches: \[main\]/);
    expect(ciWorkflow).toContain("pull_request:");
    expect(ciWorkflow).toContain("bun install --frozen-lockfile");
    expect(ciWorkflow).toContain("bun run check");
  });

  // Hardening required by the OSS checklist: a fork's pull request must never
  // reach a writable token or a mutable action reference.
  test("CI cannot be exploited by an untrusted pull request", () => {
    expect(ciWorkflow).toMatch(/permissions:\s*\n\s*contents: read/);
    // pull_request_target runs with the base repository's secrets against fork code.
    expect(ciWorkflow).not.toContain("pull_request_target");
    expect(ciWorkflow).not.toContain("secrets.");
    const actionRefs = [...ciWorkflow.matchAll(/uses: \S+@(\S+)/g)].map(([, ref]) => ref);
    expect(actionRefs.length).toBeGreaterThan(0);
    for (const ref of actionRefs) expect(ref).toMatch(/^[0-9a-f]{40}$/);
  });

  test("E2E scripts stay wired into clear CI lanes", () => {
    const expectedE2eScripts = [
      ["test:e2e:app", "bash scripts/pinned-bun.sh run scripts/run-app-e2e.ts"],
      [
        "test:e2e:cli",
        "bash scripts/pinned-bun.sh test ./test/real-e2e/relay-cli-real-e2e.test.ts && python3 test/real-e2e/footer-model-smoke.py",
      ],
      ["test:e2e:normalized-diff", "python3 test/real-e2e/normalized-diff-smoke.py"],
      ["test:e2e:ui-polish", "python3 test/real-e2e/ui-polish-smoke.py"],
      ["test:e2e:chat-autoscroll", "python3 test/real-e2e/chat-autoscroll-smoke.py"],
      [
        "test:e2e:split-mouse-escape",
        "python3 test/real-e2e/split-mouse-escape-smoke.py && python3 test/real-e2e/exit-mouse-report-smoke.py ctrl-c && python3 test/real-e2e/exit-mouse-report-smoke.py /exit && python3 test/real-e2e/exit-mouse-report-smoke.py :q",
      ],
      ["test:e2e:prompt-history", "python3 test/real-e2e/prompt-history-smoke.py"],
      ["test:e2e:prompt-queue", "python3 test/real-e2e/prompt-queue-smoke.py"],
      ["test:e2e:tui-stress", "python3 test/real-e2e/tui-stress-smoke.py"],
      ["test:e2e:path-autocomplete", "python3 test/real-e2e/path-autocomplete-smoke.py"],
      ["test:e2e:completion-sound", "python3 test/real-e2e/completion-sound-smoke.py"],
      ["test:e2e:terminal-notification", "python3 test/real-e2e/terminal-notification-smoke.py"],
      ["test:e2e:replayed-config-sound", "python3 test/real-e2e/replayed-config-sound-smoke.py"],
      ["test:e2e:live-config-sound", "python3 test/real-e2e/live-config-sound-smoke.py"],
      ["test:e2e:config-reload", "python3 test/real-e2e/config-reload-reason-smoke.py"],
      ["test:e2e:active-turn-input", "python3 test/real-e2e/active-turn-input-smoke.py"],
      ["test:e2e:vim-keybindings", "python3 test/real-e2e/vim-keybindings-smoke.py"],
      ["test:e2e:terminal-title", "python3 test/real-e2e/terminal-title-smoke.py"],
    ];

    for (const [scriptName, command] of expectedE2eScripts) {
      expect(packageJson.scripts?.[scriptName]).toContain(command);
      expect(packageJson.scripts?.["test:e2e"]).toContain(scriptName);
    }
    expect(packageJson.scripts?.["test:e2e"]).toContain("test:e2e:terminal-title");
    expect(packageJson.scripts?.["test:e2e:active-turn-input"]).toContain("python3 test/real-e2e/steering-smoke.py");
    expect(packageJson.scripts?.["test:e2e"]).not.toContain("test:e2e:active-turn-steering");
    expect(packageJson.scripts?.["test:e2e"]).not.toContain("test:e2e:steering");
  });

  test("skill compact real smoke stays wired into the UI polish E2E lane", () => {
    expect(packageJson.scripts?.["test:e2e:ui-polish"]).toContain("python3 test/real-e2e/skill-compact-smoke.py");
    expect(packageJson.scripts?.["test:e2e:skill-compact"]).toBe(
      "bash scripts/pinned-bun.sh run scripts/build.ts && python3 test/real-e2e/skill-compact-smoke.py",
    );
  });

  test("cursor style and position real smoke stays wired into the Vim keybindings E2E lane", async () => {
    const cursorSmoke = await Bun.file("test/real-e2e/cursor-style-smoke.py").text();

    expect(packageJson.scripts?.["test:e2e:vim-keybindings"]).toContain("python3 test/real-e2e/cursor-style-smoke.py");
    expect(packageJson.scripts?.["test:e2e:cursor-style"]).toBe(
      "bash scripts/pinned-bun.sh run scripts/build.ts && python3 test/real-e2e/cursor-style-smoke.py",
    );
    expect(cursorSmoke).toContain("def assert_prompt_cursor_position");
    expect(cursorSmoke).toContain("Cursor snapped to the top terminal row");
  });

  test("edge background real smoke stays wired into the TUI stress E2E lane", async () => {
    const edgeBackgroundSmoke = await Bun.file("test/real-e2e/edge-background-smoke.py").text();

    expect(packageJson.scripts?.["test:e2e:tui-stress"]).toContain("python3 test/real-e2e/edge-background-smoke.py");
    expect(packageJson.scripts?.["test:e2e:edge-background"]).toBe(
      "bash scripts/pinned-bun.sh run scripts/build.ts && python3 test/real-e2e/edge-background-smoke.py",
    );
    expect(packageJson.scripts?.["test:e2e"]).toContain("test:e2e:tui-stress");
    expect(edgeBackgroundSmoke).toContain("def assert_sampled_cells_blank");
    expect(edgeBackgroundSmoke).toContain("Expected blank sampled terminal cells");
  });

  test("Relay does not discover or install skills from user directories", async () => {
    const forbiddenPatterns = [
      /loadSkills/,
      /expandSkillInvocation/,
      /formatSkillInvocationPrompt/,
      /_skillCommands/,
      /skillCommandForName/,
      /\.agents[\\/].*skills/,
      /\.relay[\\/].*skills/,
    ];

    for (const file of sourceFiles("src")) {
      const content = readFileSync(file, "utf8");
      for (const pattern of forbiddenPatterns) {
        expect({ file, pattern: String(pattern), matched: pattern.test(content) }).toMatchObject({ matched: false });
      }
    }

    for (const file of sourceFiles("src").filter((file) => !file.startsWith("src/builtin-skills/"))) {
      expect({ file, matched: /SKILL\.md/.test(readFileSync(file, "utf8")) }).toMatchObject({ matched: false });
    }
    expect(await Bun.file("scripts/install-relay-skills.sh").exists()).toBe(false);
    expect(await Bun.file("cmd/relay/skills.go").exists()).toBe(false);
  });

  test("status heartbeat and web E2E remain targeted scripts outside default validation", () => {
    expect(packageJson.scripts?.["test:e2e:status-heartbeat"]).toBe(
      "bash scripts/pinned-bun.sh run scripts/build.ts && python3 test/real-e2e/status-heartbeat-smoke.py",
    );
    expect(packageJson.scripts?.["test:web"]).toBe("playwright test");
    expect(packageJson.scripts?.["test:e2e"]).not.toContain("python3 test/real-e2e/status-heartbeat-smoke.py");
  });

  test("vendor active-turn input methods stay isolated to the extension registry", async () => {
    const forbiddenFiles = [
      "src/acp/client.ts",
      "src/acp/sdk.ts",
      "src/acp/profiles/alta.ts",
      "src/ui/app.tsx",
      "src/ui/app-root.tsx",
      "src/ui/app/input-handlers.ts",
    ];

    for (const file of forbiddenFiles) {
      expect(await Bun.file(file).text()).not.toContain("_alta/session/steer");
    }
    expect(await Bun.file("src/acp/active-turn-input.ts").text()).toContain("_alta/session/steer");
  });

  test("pre-commit runs the same check command as CI", () => {
    expect(preCommitHook).toContain("bun run check");
    expect(preCommitHook).not.toContain("bun run lint:effect-shape");
  });

  test("Atlas release hooks keep Oxlint configuration compatible with Node 18", async () => {
    expect(packageJson.scripts?.lint).toBe("oxlint -c oxlint.config.json .");
    expect(await Bun.file("oxlint.config.json").exists()).toBe(true);
    expect(await Bun.file("oxlint.config.ts").exists()).toBe(false);
    expect(await Bun.file("oxlint.config.mts").exists()).toBe(false);
    expect(await Bun.file("oxlint.config.cts").exists()).toBe(false);
  });

  test("production lint uses Oxlint with type-aware Promise safety rules", () => {
    expect(packageJson.scripts?.lint).toBe("oxlint -c oxlint.config.json .");
    expect(packageJson.devDependencies?.oxlint).toMatch(/^\^1\./);
    expect(packageJson.devDependencies?.["oxlint-tsgolint"]).toMatch(/^\^0\./);
    expect(packageJson.dependencies?.typescript).toBeUndefined();
    expect(packageJson.devDependencies?.eslint).toBeUndefined();
    expect(packageJson.devDependencies?.typescript).toBeUndefined();
    expect(oxlintConfig.options?.typeAware).toBe(true);
    expect(oxlintConfig.overrides).toContainEqual({
      files: ["src/**/*.{ts,tsx}"],
      rules: {
        "typescript/no-floating-promises": "error",
        "typescript/no-misused-promises": "error",
      },
    });
  });

  test("Atlas release hooks keep Oxfmt configuration compatible with Node 18", async () => {
    expect(packageJson.scripts?.format).toBe("oxfmt -c oxfmt.config.json");
    expect(packageJson.scripts?.["format:check"]).toBe("oxfmt -c oxfmt.config.json --check");
    expect(await Bun.file("oxfmt.config.json").exists()).toBe(true);
    expect(await Bun.file("oxfmt.config.ts").exists()).toBe(false);
    expect(await Bun.file("oxfmt.config.mts").exists()).toBe(false);
    expect(await Bun.file("oxfmt.config.cts").exists()).toBe(false);
  });

  test("Atlas publish pipelines do not create release marker branches", async () => {
    expect(await Bun.file("scripts/ci-record-atlas-release.sh").exists()).toBe(false);
  });

  test("production formatting uses Oxfmt", async () => {
    expect(packageJson.devDependencies?.oxfmt).toMatch(/^0\./);
    expect(packageJson.devDependencies?.prettier).toBeUndefined();
    expect(await Bun.file(".prettierrc.json").exists()).toBe(false);
    expect(await Bun.file(".prettierignore").exists()).toBe(false);
    expect(oxfmtConfig.printWidth).toBe(120);
    expect(oxfmtConfig.sortPackageJson).toBe(false);
    expect(oxfmtConfig.sortImports).toBe(false);
    expect(oxfmtConfig.ignorePatterns).toContain("bun.lock");
  });

  test("strict Effect gate has no migration baseline artifact", async () => {
    expect(await Bun.file("test/fixtures/effect-shape-baseline.json").exists()).toBe(false);
  });
});
