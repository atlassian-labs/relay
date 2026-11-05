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

describe("App frame-capture E2E: agent status and rendering", () => {
  test("shows latest ACP activity in status while a prompt is running", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 2_000 });
    faux.setDefaultResponse(acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("status activity prompt");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Working");
      });

      await waitFor(() => {
        expect(faux.prompts).toHaveLength(1);
      });
      faux.emit(acpThinkingChunk("checking plan"));
      faux.emit(acpToolCallStart({ toolCallId: "status-tool", toolName: "Read" }));
      faux.emit(acpToolCallUpdate({ toolCallId: "status-tool", status: "success", rawOutput: "ok" }));
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Working");
      });

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).not.toContain("Working");
      }, 4000);
    } finally {
      app.renderer.destroy();
    }
  });

  test("renders normalized ACP diffs with the default renderer", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      faux.emit(acpToolCallStart({ toolCallId: "tc_diff", toolName: "patch" }));
      faux.emit(
        acpToolCallUpdate({
          toolCallId: "tc_diff",
          status: "success",
          content: acpToolDiffContent({
            path: path.join(cwd, "src/config.json"),
            oldText: '{\n  "debug": false\n}',
            newText: '{\n  "debug": true\n}',
          }),
        }),
      );

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("patch src/config.json");
        expect(frame).toContain("+1");
        expect(frame).toContain("-1");
        expect(frame).toContain('"debug": false');
        expect(frame).toContain('"debug": true');
      });
    } finally {
      app.renderer.destroy();
    }
  }, 10_000);

  test("rerenders completed tool blocks when plugins register tool renderers", async () => {
    const cwd = tmpWorkspace();
    const pluginPath = path.join(cwd, "late-tool-renderer.mjs");
    fs.writeFileSync(
      pluginPath,
      `
export default function plugin(relay) {
  relay.on("prompt:complete", () => {
    setTimeout(() => {
      relay.tools.registerRenderer({
        toolNames: ["Read"],
        renderCall: () => ({ kind: "lines", lines: [{ text: "plugin read renderer" }] }),
        renderResult: () => ({ kind: "lines", lines: [{ text: "plugin read result" }] }),
      });
    }, 10);
  });
}
`,
      "utf-8",
    );
    configureFauxAgentWithPlugins([pluginPath]);
    const faux = createFauxAcpAgent();
    faux.script(
      [
        acpToolCallStart({
          toolCallId: "read-1",
          toolName: "Read",
          rawInput: { file_path: path.join(cwd, "README.md") },
        }),
        acpToolCallUpdate({ toolCallId: "read-1", status: "success", rawOutput: "README contents" }),
      ],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("read file");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("plugin read renderer");
        expect(frame).toContain("plugin read result");
      }, 4000);
    } finally {
      app.renderer.destroy();
    }
  }, 10_000);

  test("renders normalized ACP diffs for arbitrary tool names and multi-line edits", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      faux.emit(acpToolCallStart({ toolCallId: "tc_custom_diff", toolName: "totally_custom_patch_tool" }));
      faux.emit(
        acpToolCallUpdate({
          toolCallId: "tc_custom_diff",
          status: "success",
          content: acpToolDiffContent({
            path: path.join(cwd, "src/custom.ts"),
            oldText: "alpha\nbeta\ngamma\n",
            newText: "alpha\nBETA\ngamma\ndelta\n",
          }),
        }),
      );

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("totally_custom_patch_tool src/custom.ts");
        expect(frame).toContain("+2");
        expect(frame).toContain("-1");
        expect(frame).toContain("BETA");
        expect(frame).toContain("delta");
      });
    } finally {
      app.renderer.destroy();
    }
  }, 10_000);

  test("renders multiple normalized ACP diffs and accompanying text in protocol order", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      faux.emit(acpToolCallStart({ toolCallId: "tc_multi_diff", toolName: "bulk_patch" }));
      faux.emit(
        acpToolCallUpdate({
          toolCallId: "tc_multi_diff",
          status: "success",
          content: acpToolMixedContent([
            "updated 2 files",
            { path: path.join(cwd, "src/a.ts"), oldText: "alpha\n", newText: "ALPHA\n" },
            { path: path.join(cwd, "src/b.ts"), oldText: "beta\n", newText: "BETA\ngamma\n" },
          ]),
        }),
      );

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("bulk_patch src/a.ts (2 files)");
        expect(frame).toContain("+3");
        expect(frame).toContain("-2");
        expect(frame).toContain("updated 2 files");
        expect(frame).toContain("src/a.ts");
        expect(frame).toContain("src/b.ts");
        expect(frame).toContain("ALPHA");
        expect(frame).toContain("BETA");
        expect(frame).toContain("gamma");
      });
    } finally {
      app.renderer.destroy();
    }
  }, 10_000);

  test("routes agent-advertised slash commands through ACP while native commands stay local", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      availableCommands: [{ name: "deploy", description: "Deploy through agent" }],
    });
    faux.script([acpAgentMessageChunk("Deploy command handled by agent")], acpPromptResponse({ inputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/deploy prod");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Deploy command handled by agent");
        expect(faux.prompts).toEqual(["/deploy prod"]);
      });

      await waitFor(() => {
        app.renderOnce();
        return !app.captureCharFrame().includes("Working");
      });
      await app.mockInput.typeText("/sessions");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("No ACP sessions available to resume.");
        expect(faux.prompts).toEqual(["/deploy prod"]);
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("changes modes via slash command and overlay selection", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      capabilities: {
        currentModeId: "plan",
        availableModes: [
          { id: "plan", name: "Plan" },
          { id: "code", name: "Code" },
          { id: "review", name: "Review" },
        ],
      },
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/mode code");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Switched to mode: code");
        expect(frame).toContain("code");
      });
      expect(faux.modeChanges).toEqual(["code"]);

      await app.mockInput.typeText("/mode");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("plan");
        expect(frame).toContain("review");
      });
      app.mockInput.pressArrow("down");
      app.mockInput.pressArrow("down");
      app.mockInput.pressEnter();
      await waitFor(() => faux.modeChanges.length === 2);
      expect(faux.modeChanges).toEqual(["code", "review"]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("failed session load keeps global prompt history navigation", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ rejectLoadSessionIds: ["missing-session"] });
    faux.script([acpAgentMessageChunk("global complete")], acpPromptResponse({ inputTokens: 1 }));
    faux.script([acpAgentMessageChunk("local complete")], acpPromptResponse({ inputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("global before new session");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("global complete");
      });

      await app.mockInput.typeText("/new");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("New thread");
      });

      await app.mockInput.typeText("local after new session");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("local complete");
      });

      await app.mockInput.typeText("/resume missing-session");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Failed to load session: Error: Failed to load missing-session");
      });
      expect(faux.loadSessions).toEqual(["missing-session"]);

      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("/resume missing-session");
      });
      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("local after new session");
      });
      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("global before new session");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("loads explicit and picker-selected sessions without leaking prior state", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      sessions: [
        { sessionId: "session-a", title: "Alpha session", cwd, updatedAt: "2025-01-01T00:00:00.000Z" },
        { sessionId: "session-b", title: "Beta session", cwd, updatedAt: "2025-01-02T00:00:00.000Z" },
      ],
    });
    faux.script([acpUsageUpdate({ inputTokens: 4, outputTokens: 5 })], acpPromptResponse({ inputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("before resume");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("↑5");
      });

      await app.mockInput.typeText("/resume session-a");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Resumed ACP session: session-a");
        expect(frame).not.toContain("tokens");
        expect(frame).not.toContain("before resume");
      });
      expect(faux.loadSessions).toEqual(["session-a"]);

      await app.mockInput.typeText("/resume");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Alpha session");
        expect(frame).toContain("Beta session");
      });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("→ Beta session");
      });
      app.mockInput.pressEnter();
      await waitFor(() => {
        expect(faux.loadSessions).toEqual(["session-a", "session-b"]);
      });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Resumed ACP session: session-b");
      });
      expect(faux.loadSessions).toEqual(["session-a", "session-b"]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("formats user bash thread previews with bracket labels", () => {
    const localBlock: ChatBlock = {
      type: "user-bash",
      id: "local-bash-preview",
      command: "printf local-bash",
      output: "local-bash",
      exitCode: 0,
      status: "done",
      excludeFromContext: true,
    };
    const contextBlock: ChatBlock = {
      type: "user-bash",
      id: "context-bash-preview",
      command: "printf relay-bash",
      output: "relay-bash",
      exitCode: 0,
      status: "done",
      excludeFromContext: false,
    };

    expect(previewFromBlocks([localBlock])).toBe("[bash] local — $ printf local-bash");
    expect(previewFromBlocks([contextBlock])).toBe("[bash] context — $ printf relay-bash");
  });
});
