import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import type { DiffFile } from "../../../src/core/diff-utils";
import { AppContext } from "../../../src/ui/state";
import { createAppStateValue } from "../../../src/ui/context/app-state";
import { DiffOverlay, type DiffOverlayCommand, type DiffOverlayRequest } from "../../../src/ui/component/diff-overlay";

function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
}

function setupDiffRepo(cwd: string): void {
  runGit(cwd, ["init"]);
  runGit(cwd, ["config", "user.email", "relay@example.test"]);
  runGit(cwd, ["config", "user.name", "Relay Test"]);
  writeFileSync(path.join(cwd, "a.txt"), "one\n");
  writeFileSync(path.join(cwd, "b.txt"), "two\n");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "initial"]);
  writeFileSync(path.join(cwd, "a.txt"), "one changed\n");
  writeFileSync(path.join(cwd, "b.txt"), "two changed\n");
}

function setupNestedDiffRepo(cwd: string): void {
  runGit(cwd, ["init"]);
  runGit(cwd, ["config", "user.email", "relay@example.test"]);
  runGit(cwd, ["config", "user.name", "Relay Test"]);
  mkdirSync(path.join(cwd, "src", "core"), { recursive: true });
  mkdirSync(path.join(cwd, "src", "ui"), { recursive: true });
  writeFileSync(path.join(cwd, "src", "core", "a.ts"), "one\n");
  writeFileSync(path.join(cwd, "src", "ui", "b.ts"), "two\n");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "initial"]);
  writeFileSync(path.join(cwd, "src", "core", "a.ts"), "one changed\n");
  writeFileSync(path.join(cwd, "src", "ui", "b.ts"), "two changed\n");
}

async function waitForFrame(
  app: Awaited<ReturnType<typeof testRender>>,
  predicate: (frame: string) => boolean,
): Promise<string> {
  let lastFrame = "";
  for (let attempt = 0; attempt < 100; attempt++) {
    await app.renderOnce();
    lastFrame = app.captureCharFrame();
    if (predicate(lastFrame)) return lastFrame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for frame. Last frame:\n${lastFrame}`);
}

describe("DiffOverlay", () => {
  test("renders as a full-screen overlay with visible close affordance", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "relay-diff-overlay-"));
    const contextValue = createAppStateValue(cwd);
    let app: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      app = await testRender(
        () => (
          <AppContext.Provider value={contextValue}>
            <box width="100%" height="100%" flexDirection="column">
              <text>UNDERLAY MARKER</text>
              <box flexGrow={1} />
              <DiffOverlay open={() => true} onClose={() => undefined} />
            </box>
          </AppContext.Provider>
        ),
        { width: 100, height: 24, targetFps: 30 },
      );

      await app.renderOnce();
      const frame = app.captureCharFrame();
      expect(frame).not.toContain("UNDERLAY MARKER");
      expect(frame).toContain("Diff working tree");
      expect(frame).toContain("q/esc close");
    } finally {
      app?.renderer.destroy();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("accepts commands to move between files", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "relay-diff-overlay-"));
    const contextValue = createAppStateValue(cwd);
    const [command, setCommand] = createSignal<DiffOverlayCommand | null>(null);
    let commandId = 0;
    let app: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      setupDiffRepo(cwd);
      app = await testRender(
        () => (
          <AppContext.Provider value={contextValue}>
            <DiffOverlay open={() => true} onClose={() => undefined} command={command} />
          </AppContext.Provider>
        ),
        { width: 100, height: 24, targetFps: 30 },
      );

      await waitForFrame(app, (frame) => frame.includes("one changed"));
      setCommand({ id: ++commandId, action: "next-file" });
      const frame = await waitForFrame(app, (nextFrame) => nextFrame.includes("two changed"));
      expect(frame).toContain("two changed");
      expect(frame).toContain("←→/n/p file");
    } finally {
      app?.renderer.destroy();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("renders tree file list with connected separators", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "relay-diff-overlay-"));
    const contextValue = createAppStateValue(cwd);
    let app: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      setupNestedDiffRepo(cwd);
      app = await testRender(
        () => (
          <AppContext.Provider value={contextValue}>
            <DiffOverlay open={() => true} onClose={() => undefined} />
          </AppContext.Provider>
        ),
        { width: 100, height: 24, targetFps: 30 },
      );

      const frame = await waitForFrame(app, (nextFrame) => nextFrame.includes("▾ src"));
      const separatorRows = frame.split("\n").filter((line) => line.includes("──"));
      expect(frame).toContain("▾ src");
      expect(frame).toContain("┬");
      expect(separatorRows.length).toBeGreaterThanOrEqual(2);
    } finally {
      app?.renderer.destroy();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("does not render stale split connector while loading a new request", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "relay-diff-overlay-"));
    const contextValue = createAppStateValue(cwd);
    const initialFiles: readonly DiffFile[] = [
      {
        path: "a.txt",
        patch: [
          "diff --git a/a.txt b/a.txt",
          "index 1111111..2222222 100644",
          "--- a/a.txt",
          "+++ b/a.txt",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
        additions: 1,
        deletions: 1,
        status: "modified",
      },
    ];
    let resolveLoading: ((files: readonly DiffFile[]) => void) | undefined;
    const [request, setRequest] = createSignal<DiffOverlayRequest>({
      id: 1,
      title: "Diff",
      load: async () => initialFiles,
    });
    let app: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      app = await testRender(
        () => (
          <AppContext.Provider value={contextValue}>
            <DiffOverlay open={() => true} onClose={() => undefined} request={request} />
          </AppContext.Provider>
        ),
        { width: 100, height: 24, targetFps: 30 },
      );

      await waitForFrame(app, (frame) => frame.includes("a.txt") && frame.includes("┬"));
      setRequest({
        id: 2,
        title: "PR Diff",
        load: () =>
          new Promise<readonly DiffFile[]>((resolve) => {
            resolveLoading = resolve;
          }),
      });
      const frame = await waitForFrame(app, (nextFrame) => nextFrame.includes("Loading diff..."));
      expect(frame).not.toContain("┬");
    } finally {
      resolveLoading?.([]);
      app?.renderer.destroy();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
