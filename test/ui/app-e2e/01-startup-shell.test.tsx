import { createTextAttributes } from "@opentui/core";
import { describe, expect, test } from "bun:test";
import {
  ApprovalResponse,
  Buffer,
  CaptureTitleOutput,
  Config,
  SETTING_VALUE_CHOICES,
  acpAgentMessageChunk,
  acpPromptResponse,
  acpThinkingChunk,
  acpToolCallStart,
  acpToolCallUpdate,
  acpToolDiffContent,
  acpToolMixedContent,
  acpUsageUpdate,
  acpUserMessageChunk,
  configureFauxAgent,
  configureFauxAgentWithPlugins,
  configureFauxAgentWithSlashPanelPosition,
  configureFauxAltaAgent,
  createFauxAcpAgent,
  emitKey,
  expectPanelVerticalPaddingAroundText,
  expectSpanNotPanelFilled,
  expectSpanPanelFilled,
  fauxConfigToml,
  filesystemSkillUserMessage,
  fs,
  getColors,
  getConfig,
  getConfigDir,
  getThemeIds,
  longLineResponse,
  parseColor,
  path,
  pressCtrlEnter,
  pressCtrlO,
  pressRawKeypadEnter,
  previewFromBlocks,
  renderFauxApp,
  resetConfig,
  saveThreadsForWorkspace,
  scrollMouse,
  setConfig,
  spinnerTitlePattern,
  submitPrompt,
  tmpWorkspace,
  twoChoiceSchema,
  waitFor,
  waitForConnected,
  waitForPromptCountWithoutWorking,
  writeFauxConfig,
  type ChatBlock,
} from "./helpers";

describe("App frame-capture E2E: startup and shell", () => {
  test("renders a random tip under the working status for each turn", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ hangPrompts: true });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await submitPrompt(app, "show a turn tip");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        const tipLine = frame.split("\n").find((line) => line.includes("L Tip:"));
        const tipSpanLine = app.captureSpans().lines.find((line) =>
          line.spans
            .map((span) => span.text)
            .join("")
            .includes("L Tip:"),
        );
        const tipPrefixIndex = tipSpanLine?.spans.findIndex((span) => span.text === "Tip:") ?? -1;
        const tipPrefixSpan = tipPrefixIndex >= 0 ? tipSpanLine?.spans[tipPrefixIndex] : undefined;
        const tipTextSpan = tipPrefixIndex >= 0 ? tipSpanLine?.spans[tipPrefixIndex + 1] : undefined;
        expect(frame).toContain("Working...");
        expect(tipLine?.trim()).toMatch(/^L Tip: \S/);
        expect(frame.split("\n").some((line) => line.trim().startsWith(">") && line.includes("L Tip:"))).toBe(false);
        expect(tipPrefixSpan?.fg.toString()).toBe(parseColor(getColors().textMuted).toString());
        expect(tipPrefixSpan?.attributes).toBe(createTextAttributes({ bold: true }));
        expect(tipTextSpan?.text.startsWith(" ")).toBe(true);
        expect(tipTextSpan?.fg.toString()).toBe(parseColor(getColors().textMuted).toString());
        expect(tipTextSpan?.attributes).toBe(createTextAttributes());
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("anchors right-side status lane above the editor independently from working status", async () => {
    const cwd = tmpWorkspace();
    const pluginPath = path.join(cwd, "right-status-plugin.mjs");
    fs.writeFileSync(
      pluginPath,
      `export default function plugin(relay) {
  relay.ui.setEditorStatusSegment("prs", {
    render: (ctx) => ({
      text: "PR(9) ctrl+p",
      segments: [{ text: "PR(9)", fg: ctx.colors.textMuted }, { text: " ctrl+p" }],
    }),
  });
}
`,
    );
    writeFauxConfig(
      fauxConfigToml({
        pluginPaths: [pluginPath],
      }),
    );
    const faux = createFauxAcpAgent({ hangPrompts: true });
    const app = await renderFauxApp(cwd, faux, { width: 120, height: 30 });

    try {
      await waitForConnected(app);
      await submitPrompt(app, "show a turn tip");
      await waitFor(() => {
        app.renderOnce();
        const lines = app.captureCharFrame().split("\n");
        const workingIndex = lines.findIndex((line) => line.includes("Working..."));
        const tipIndex = lines.findIndex((line) => line.includes("L Tip:"));
        const rightStatusIndex = lines.findIndex((line) => line.includes("PR(9) ctrl+p"));
        const statusSpanLine = app.captureSpans().lines.find((line) =>
          line.spans
            .map((span) => span.text)
            .join("")
            .includes("PR(9) ctrl+p"),
        );
        const prSpan = statusSpanLine?.spans.find((span) => span.text === "PR(9)");
        expect(workingIndex).toBeGreaterThanOrEqual(0);
        expect(tipIndex).toBeGreaterThanOrEqual(0);
        expect(rightStatusIndex).toBe(tipIndex);
        expect(rightStatusIndex).not.toBe(workingIndex);
        expect(prSpan?.fg.toString()).toBe(parseColor(getColors().textMuted).toString());
        expect(prSpan?.attributes).toBe(createTextAttributes());
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("shows an unknown launch agent error on the welcome screen", async () => {
    writeFauxConfig(fauxConfigToml({}));
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux, { initialAgent: "missing-agent", width: 120, height: 24 });

    try {
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("No agent runner configured for: missing-agent");
        expect(frame).toContain("Available agents: code-");
        expect(frame).toContain("agent, alta, faux, rovo, codex, claude, cursor");
        expect(frame).toContain("↗");
        const errorLines = frame
          .split("\n")
          .filter(
            (line) =>
              line.includes("No agent runner configured") ||
              line.includes("Available agents:") ||
              line.includes("agent, alta, faux, rovo, codex, claude, cursor"),
          );
        expect(errorLines.length).toBeGreaterThan(0);
        expect(errorLines.every((line) => line.trim().length <= 72)).toBe(true);
        expect(frame).not.toContain("Connected to faux agent");
        expect(faux.clientImpl.connected).toBe(false);
      });
    } finally {
      app.renderer.destroy();
    }
  });

  for (const transcriptRendererMode of ["legacy", "windowed"] as const) {
    test(`keeps startup plugin discovery warnings visible in the ${transcriptRendererMode} transcript`, async () => {
      configureFauxAgent();
      const cwd = tmpWorkspace();
      fs.mkdirSync(path.join(cwd, ".relay", "plugins"), { recursive: true });
      const app = await renderFauxApp(cwd, createFauxAcpAgent(), {
        transcriptRendererMode,
        width: 120,
        height: 24,
      });

      try {
        await waitForConnected(app);
        await waitFor(() => {
          app.renderOnce();
          const frame = app.captureCharFrame();
          expect(frame).toContain("Workspace plugins found at");
          expect(frame).toContain("project plugins are not enabled");
        });
      } finally {
        app.renderer.destroy();
      }
    });
  }

  test("shows config migration warnings in the chat log instead of the welcome screen", async () => {
    writeFauxConfig(`[meta]
config_version = 1

[ui]
show_tips = false
collapse_thinking = true

[notifications]
sound_enabled = false

[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
`);
    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd, createFauxAcpAgent(), { width: 120, height: 24 });

    try {
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Config migration:");
        expect(frame).toContain("Backup:");
        expect(frame).not.toContain("░█▀▄░█▀▀░█░░░█▀█░█░█");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("F2 opens the prompt in an external editor and reloads the saved text", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();

    const app = await renderFauxApp(cwd, faux, {
      externalEditor: async () => ({ text: "edited via external editor", changed: true, exitCode: 0 }),
    });

    try {
      await waitForConnected(app);

      emitKey(app, "f2");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("edited via external editor");
      }, 3000);

      app.mockInput.pressEnter();
      await waitFor(() => faux.prompts.length === 1, 2000);
      expect(faux.prompts[0]).toBe("edited via external editor");
    } finally {
      app.renderer.destroy();
    }
  });

  test("queues a prompt submitted while the ACP agent is connecting", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ connectDelayMs: 1000 });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain(" >");
      });

      await submitPrompt(app, "queued during startup");

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (1/10)");
        expect(frame).toContain("Queued prompt #1 · queued during startup");
        expect(faux.prompts).toEqual([]);
      });

      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["queued during startup"]);
      }, 3000);
    } finally {
      app.renderer.destroy();
    }
  });

  test("serializes an initial prompt before a prompt queued during ACP startup", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      newSessionDelayMs: 1000,
      promptDelayMs: 300,
      rejectConcurrentPrompts: true,
    });
    const app = await renderFauxApp(cwd, faux, { initialPrompt: "initial startup prompt" });

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain(" >");
      });

      await submitPrompt(app, "queued behind initial startup prompt");

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (1/10)");
        expect(frame).toContain("Queued prompt #1 · queued behind initial startup prompt");
        expect(faux.prompts).toEqual([]);
      });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).not.toContain("ACP prompt error");
        expect(faux.prompts).toEqual(["initial startup prompt", "queued behind initial startup prompt"]);
      }, 5000);

      await waitForPromptCountWithoutWorking(app, faux, 2);
      expect(faux.newSessions).toEqual([{ cwd }]);
      expect(app.captureCharFrame()).not.toContain("ACP prompt error");
    } finally {
      app.renderer.destroy();
    }
  });

  test("reuses one lazy session start when startup queue and direct prompt race", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      connectDelayMs: 200,
      newSessionDelayMs: 800,
      promptDelayMs: 50,
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain(" >");
      });

      await submitPrompt(app, "queued before connect");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Queued prompt #1 · queued before connect");
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      await submitPrompt(app, "direct while session starts");

      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["queued before connect", "direct while session starts"]);
      }, 5000);
      expect(faux.newSessions).toEqual([{ cwd }]);
      expect(app.captureCharFrame()).not.toContain("ACP prompt error");
    } finally {
      app.renderer.destroy();
    }
  });

  test("drains multiple prompts queued during ACP startup in order", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      connectDelayMs: 1000,
      promptDelayMs: 150,
      rejectConcurrentPrompts: true,
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain(" >");
      });

      await submitPrompt(app, "startup queued one");
      await submitPrompt(app, "startup queued two");

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (2/10)");
        expect(frame).toContain("Queued prompt #1 · startup queued one");
        expect(frame).toContain("Queued prompt #2 · startup queued two");
        expect(faux.prompts).toEqual([]);
      });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).not.toContain("ACP prompt error");
        expect(faux.prompts).toEqual(["startup queued one", "startup queued two"]);
      }, 5000);

      await waitForPromptCountWithoutWorking(app, faux, 2);
      expect(app.captureCharFrame()).not.toContain("ACP prompt error");
    } finally {
      app.renderer.destroy();
    }
  });

  test("renders the default prompt without the framed composer border", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);
      const frame = app.captureCharFrame();
      expect(frame).toContain(" >");
      expect(frame).not.toContain("│  >");
      expect(frame).not.toContain("Enter send · Shift+Enter newline");
      expect(frame).not.toContain("/ commands · @ files · ! bash");
      expect(frame).not.toContain("╭");
      expect(frame).not.toContain("╰");
    } finally {
      app.renderer.destroy();
    }
  }, 10_000);

  test("? opens and closes the shortcut reference", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);
      emitKey(app, "?", { sequence: "?", raw: "?", shift: true });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Keyboard shortcuts");
        expect(frame).toContain("Show shortcuts");
      });

      emitKey(app, "escape", { sequence: "\u001b", raw: "\u001b" });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).not.toContain("Keyboard shortcuts");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("renders full-screen plugin overlays with bottom chrome", async () => {
    const cwd = tmpWorkspace();
    const pluginPath = path.join(cwd, "overlay-plugin.mjs");
    fs.writeFileSync(
      pluginPath,
      `export default function plugin(relay) {
  relay.commands.register("open-overlay", {
    run() {
      relay.ui.setWidget("overlay", {
        placement: "overlay",
        modalCorners: {
          topLeft: { text: "Plugin Overlay" },
          bottomLeft: { text: "q close", segments: [{ text: "q", bold: true }, { text: " close", fg: "#6c7086" }] },
        },
        render(ctx) {
          return [{ text: \`body \${ctx.width}x\${ctx.height}\` }];
        },
      });
    },
  });
}
`,
    );
    writeFauxConfig(
      fauxConfigToml({
        pluginPaths: [pluginPath],
      }),
    );
    let externalEditorCalls = 0;
    const app = await renderFauxApp(cwd, createFauxAcpAgent(), {
      width: 80,
      height: 20,
      externalEditor: async () => {
        externalEditorCalls += 1;
        return { text: "edited", changed: true, exitCode: 0 };
      },
    });

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/open-overlay");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Plugin Overlay");
        expect(frame).toContain("body 78x18");
        expect(frame).toContain("q close");
        expect(frame).not.toContain("Connected to faux agent");
      });

      emitKey(app, "f2");
      await app.renderOnce();
      expect(externalEditorCalls).toBe(0);

      await app.mockInput.typeText("IGNORED_OVERLAY_TEXT");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Plugin Overlay");
        expect(frame).not.toContain("IGNORED_OVERLAY_TEXT");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("opens plugin-provided diffs in the native diff overlay", async () => {
    const cwd = tmpWorkspace();
    const pluginPath = path.join(cwd, "diff-plugin.mjs");
    const pluginDiff = [
      "diff --git a/README.md b/README.md",
      "index 1111111..2222222 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,2 @@",
      "-old line",
      "+new line",
      "+added line",
    ].join("\n");
    fs.writeFileSync(
      pluginPath,
      `const diffText = ${JSON.stringify(pluginDiff)};
export default function plugin(relay) {
  relay.commands.register("open-plugin-diff", {
    run() {
      relay.ui.openDiff({ title: "Plugin Diff", subtitle: "PR #123", diffText });
    },
  });
}
`,
    );
    configureFauxAgentWithPlugins([pluginPath]);
    const app = await renderFauxApp(cwd, createFauxAcpAgent(), { width: 100, height: 24 });

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/open-plugin-diff");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Plugin Diff");
        expect(frame).toContain("PR #123");
        expect(frame).toContain("README.md");
        expect(frame).toContain("+2");
        expect(frame).toContain("-1");
      });

      await app.mockInput.typeText("IGNORED_DIFF_OVERLAY_TEXT");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Plugin Diff");
        expect(frame).not.toContain("IGNORED_DIFF_OVERLAY_TEXT");
      });

      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).not.toContain("Plugin Diff");
        expect(frame).not.toContain("IGNORED_DIFF_OVERLAY_TEXT");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("/exit bounds ACP disposal wait before terminating the process", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ disposeDelayMs: 300 });
    const originalExit = process.exit;
    const exitCalls: number[] = [];
    process.exit = ((code?: string | number | null) => {
      exitCalls.push(typeof code === "number" ? code : 0);
      return undefined as never;
    }) as typeof process.exit;
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/exit");
      app.mockInput.pressEnter();

      await waitFor(() => faux.disposeStarts === 1);
      expect(faux.disposals).toBe(0);
      expect(faux.forceDisposals).toBe(0);

      await waitFor(() => {
        expect(exitCalls).toEqual([0]);
        expect(faux.forceDisposals).toBe(1);
        expect(faux.disposals).toBe(0);
      }, 400);
    } finally {
      process.exit = originalExit;
      if (exitCalls.length === 0) app.renderer.destroy();
    }
  });

  test("/exit waits for ACP disposal that completes within the shutdown budget", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ disposeDelayMs: 150 });
    const originalExit = process.exit;
    const exitCalls: number[] = [];
    const disposalsAtExit: number[] = [];
    process.exit = ((code?: string | number | null) => {
      exitCalls.push(typeof code === "number" ? code : 0);
      disposalsAtExit.push(faux.disposals);
      return undefined as never;
    }) as typeof process.exit;
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/exit");
      app.mockInput.pressEnter();

      await waitFor(() => {
        expect(exitCalls).toEqual([0]);
        expect(disposalsAtExit).toEqual([1]);
        expect(faux.forceDisposals).toBe(0);
      });
    } finally {
      process.exit = originalExit;
      if (exitCalls.length === 0) app.renderer.destroy();
    }
  });

  test("/exit keeps the ACP client available through plugin shutdown handlers", async () => {
    const cwd = tmpWorkspace();
    const markerPath = path.join(cwd, "plugin-shutdown.json");
    const readyPath = path.join(cwd, "plugin-ready");
    const pluginPath = path.join(cwd, "shutdown-plugin.mjs");
    fs.writeFileSync(
      pluginPath,
      `import { writeFileSync } from "node:fs";
export default function plugin(relay) {
  writeFileSync(${JSON.stringify(readyPath)}, "ready");
  relay.on("relay:shutdown", async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ sessionId: relay.agent.sessionId }));
  });
}
`,
    );
    configureFauxAgentWithPlugins([pluginPath]);
    const faux = createFauxAcpAgent();
    const originalExit = process.exit;
    const exitCalls: number[] = [];
    process.exit = ((code?: string | number | null) => {
      exitCalls.push(typeof code === "number" ? code : 0);
      return undefined as never;
    }) as typeof process.exit;
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await waitFor(() => expect(fs.readFileSync(readyPath, "utf8")).toBe("ready"));
      await submitPrompt(app, "create a session before plugin shutdown");
      await waitForPromptCountWithoutWorking(app, faux, 1);
      expect(faux.client.sessionId).toBe("faux-session-1");

      await app.mockInput.typeText("/exit");
      app.mockInput.pressEnter();

      await waitFor(() => {
        expect(exitCalls).toEqual([0]);
        expect(JSON.parse(fs.readFileSync(markerPath, "utf8"))).toEqual({ sessionId: "faux-session-1" });
      });
    } finally {
      process.exit = originalExit;
      if (exitCalls.length === 0) app.renderer.destroy();
    }
  });

  test("renderer cleanup bounds hung plugins and ACP disposal", async () => {
    const cwd = tmpWorkspace();
    const blockingReadyPath = path.join(cwd, "renderer-blocking-plugin-ready");
    const observingMarkerPath = path.join(cwd, "renderer-observing-shutdown.json");
    const observingReadyPath = path.join(cwd, "renderer-observing-plugin-ready");
    const blockingPluginPath = path.join(cwd, "renderer-blocking-shutdown-plugin.mjs");
    const observingPluginPath = path.join(cwd, "renderer-observing-shutdown-plugin.mjs");
    fs.writeFileSync(
      blockingPluginPath,
      `import { writeFileSync } from "node:fs";
export default function plugin(relay) {
  writeFileSync(${JSON.stringify(blockingReadyPath)}, "ready");
  relay.on("relay:shutdown", async () => {
    await new Promise(() => {});
  });
}
`,
    );
    fs.writeFileSync(
      observingPluginPath,
      `import { writeFileSync } from "node:fs";
export default function plugin(relay) {
  writeFileSync(${JSON.stringify(observingReadyPath)}, "ready");
  relay.on("relay:shutdown", () => {
    writeFileSync(${JSON.stringify(observingMarkerPath)}, JSON.stringify({ sessionId: relay.agent.sessionId }));
  });
}
`,
    );
    configureFauxAgentWithPlugins([blockingPluginPath, observingPluginPath]);
    const faux = createFauxAcpAgent({ disposeDelayMs: 300 });
    const app = await renderFauxApp(cwd, faux);

    await waitForConnected(app);
    await waitFor(() => {
      expect(fs.readFileSync(blockingReadyPath, "utf8")).toBe("ready");
      expect(fs.readFileSync(observingReadyPath, "utf8")).toBe("ready");
    });
    await submitPrompt(app, "create a session before renderer cleanup");
    await waitForPromptCountWithoutWorking(app, faux, 1);

    app.renderer.destroy();

    await waitFor(() => {
      expect(JSON.parse(fs.readFileSync(observingMarkerPath, "utf8"))).toEqual({ sessionId: "faux-session-1" });
      expect(faux.disposeStarts).toBe(1);
      expect(faux.disposals).toBe(0);
      expect(faux.forceDisposals).toBe(1);
    }, 800);
  });

  test("/exit starts every plugin shutdown handler once before bounded ACP disposal", async () => {
    const cwd = tmpWorkspace();
    const blockingCountPath = path.join(cwd, "blocking-shutdown-count");
    const blockingReadyPath = path.join(cwd, "blocking-plugin-ready");
    const observingMarkerPath = path.join(cwd, "observing-shutdown.json");
    const observingReadyPath = path.join(cwd, "observing-plugin-ready");
    const blockingPluginPath = path.join(cwd, "blocking-shutdown-plugin.mjs");
    const observingPluginPath = path.join(cwd, "observing-shutdown-plugin.mjs");
    fs.writeFileSync(
      blockingPluginPath,
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
export default function plugin(relay) {
  writeFileSync(${JSON.stringify(blockingReadyPath)}, "ready");
  relay.on("relay:shutdown", async () => {
    const count = existsSync(${JSON.stringify(blockingCountPath)})
      ? Number(readFileSync(${JSON.stringify(blockingCountPath)}, "utf8"))
      : 0;
    writeFileSync(${JSON.stringify(blockingCountPath)}, String(count + 1));
    await new Promise(() => {});
  });
}
`,
    );
    fs.writeFileSync(
      observingPluginPath,
      `import { writeFileSync } from "node:fs";
export default function plugin(relay) {
  writeFileSync(${JSON.stringify(observingReadyPath)}, "ready");
  relay.on("relay:shutdown", () => {
    writeFileSync(${JSON.stringify(observingMarkerPath)}, JSON.stringify({ sessionId: relay.agent.sessionId }));
  });
}
`,
    );
    configureFauxAgentWithPlugins([blockingPluginPath, observingPluginPath]);
    const faux = createFauxAcpAgent({ disposeDelayMs: 300 });
    const originalExit = process.exit;
    const exitCalls: number[] = [];
    let shutdownStartedAt = 0;
    let shutdownElapsedMs = 0;
    process.exit = ((code?: string | number | null) => {
      exitCalls.push(typeof code === "number" ? code : 0);
      shutdownElapsedMs = Date.now() - shutdownStartedAt;
      return undefined as never;
    }) as typeof process.exit;
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await waitFor(() => {
        expect(fs.readFileSync(blockingReadyPath, "utf8")).toBe("ready");
        expect(fs.readFileSync(observingReadyPath, "utf8")).toBe("ready");
      });
      await submitPrompt(app, "create a session before bounded plugin shutdown");
      await waitForPromptCountWithoutWorking(app, faux, 1);

      shutdownStartedAt = Date.now();
      await app.mockInput.typeText("/exit");
      app.mockInput.pressEnter();

      await waitFor(() => expect(exitCalls).toEqual([0]), 900);
      expect(JSON.parse(fs.readFileSync(observingMarkerPath, "utf8"))).toEqual({ sessionId: "faux-session-1" });
      expect(fs.readFileSync(blockingCountPath, "utf8")).toBe("1");
      expect(faux.disposals).toBe(0);
      expect(faux.forceDisposals).toBe(1);
      expect(shutdownElapsedMs).toBeLessThan(900);
    } finally {
      process.exit = originalExit;
      if (exitCalls.length === 0) app.renderer.destroy();
    }
  });

  test("/exit prints resume command after ACP clients are cleared", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const originalExit = process.exit;
    const originalStdoutWrite = process.stdout.write;
    const exitCalls: number[] = [];
    const stdoutChunks: string[] = [];
    process.exit = ((code?: string | number | null) => {
      exitCalls.push(typeof code === "number" ? code : 0);
      return undefined as never;
    }) as typeof process.exit;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await submitPrompt(app, "create resumable session before exit");
      await waitForPromptCountWithoutWorking(app, faux, 1);
      expect(faux.client.sessionId).toBe("faux-session-1");
      await app.mockInput.typeText("/exit");
      app.mockInput.pressEnter();

      await waitFor(() => {
        expect(exitCalls).toEqual([0]);
        expect(faux.client.sessionId).toBeNull();
        expect(stdoutChunks.join("")).toContain("relay -r faux-session-1");
      });
    } finally {
      process.exit = originalExit;
      process.stdout.write = originalStdoutWrite;
      if (exitCalls.length === 0) app.renderer.destroy();
    }
  });

  test(":q quits Relay from prompt text", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const originalExit = process.exit;
    const exitCalls: number[] = [];
    process.exit = ((code?: string | number | null) => {
      exitCalls.push(typeof code === "number" ? code : 0);
      return undefined as never;
    }) as typeof process.exit;
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText(":q");
      app.mockInput.pressEnter();

      await waitFor(() => {
        expect(exitCalls).toEqual([0]);
        expect(faux.prompts).toEqual([]);
      });
    } finally {
      process.exit = originalExit;
      if (exitCalls.length === 0) app.renderer.destroy();
    }
  });

  test("shows slash command overlay with keyboard guidance while typing /thr", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("/thr");

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("/thr");
        expect(frame).toContain("/threads");
        expect(frame).toContain("open thread sidebar");
        expect(frame).toContain("↑/↓ navigate · enter select · esc close");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("bottom slash command overlay hides the footer", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("/thr");

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("/threads");
        expect(frame).not.toContain("context • tokens");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("bottom overlay hides the footer after switching from top at runtime", async () => {
    configureFauxAgentWithSlashPanelPosition("top");
    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("/thr");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("/threads");
        expect(frame).toContain(cwd);
      });

      configureFauxAgentWithSlashPanelPosition("bottom");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("/threads");
        expect(frame).not.toContain(cwd);
      });
    } finally {
      app.renderer.destroy();
    }
  });
});
