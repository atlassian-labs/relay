import { describe, expect, test } from "bun:test";
import { acpAvailableCommands } from "../../lib/acp-events";
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
  hasAnimatedBorderColor,
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

describe("App frame-capture E2E: prompt queue and active turn input", () => {
  test("queue navigation does not open autocomplete for exact slash skill prompts", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      hangPrompts: true,
      availableCommands: [{ name: "test-skill", description: "Agent-owned slash skill" }],
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await submitPrompt(app, "running prompt before slash queue navigation");
      await waitFor(() => expect(faux.prompts).toEqual(["running prompt before slash queue navigation"]));

      await submitPrompt(app, "ordinary queued prompt");
      await app.mockInput.typeText("/test-skill ");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Queued prompt #2 · /test-skill");
      });

      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("❯ Queued prompt #2");
        expect(frame).not.toContain("agent-owned slash skill");
        expect(frame).not.toContain("↑/↓ · enter · esc");
      });

      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("❯ Queued prompt #1");
      });
      app.mockInput.pressArrow("down", { meta: true });
      app.mockInput.pressEnter();
      app.mockInput.pressKey("END");
      await app.mockInput.typeText(" edited");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queued prompt #2 · /test-skill edited");
        expect(frame).not.toContain("agent-owned slash skill");
        expect(frame).not.toContain("↑/↓ · enter · esc");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("delayed ACP commands do not open autocomplete over an idle queue edit", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ hangPrompts: true });
    const app = await renderFauxApp(cwd, faux);
    const command = { name: "delayed-skill", description: "Delayed agent skill" };

    try {
      await waitForConnected(app);
      await submitPrompt(app, "running prompt before delayed queue command");
      await waitFor(() => expect(faux.prompts).toEqual(["running prompt before delayed queue command"]));

      await submitPrompt(app, "/delayed-");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Queued prompt #1 · /delayed-");
      });

      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Interrupted; 1 queued prompt preserved.");
      });
      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("❯ Queued prompt #1");
      });

      faux.emit(acpAvailableCommands([command]));
      app.renderOnce();
      const queueFrame = app.captureCharFrame();
      expect(queueFrame).toContain("❯ Queued prompt #1");
      expect(queueFrame).not.toContain("/delayed-skill");
      expect(queueFrame).not.toContain("delayed agent skill");
      expect(queueFrame).not.toContain("↑/↓ · enter · esc");

      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).not.toContain("enter edit");
      });
      await app.mockInput.typeText("/delayed-");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("delayed agent skill");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("queues ACP slash skill commands as literal prompts while active", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      tokensPerSecond: 500,
      availableCommands: [{ name: "test-skill", description: "Agent-owned slash skill" }],
    });
    faux.script([acpAgentMessageChunk("x".repeat(1000))], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Working");
      });

      await app.mockInput.typeText("/test-skill deploy prod\n  with context");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (1/10)");
        expect(frame).toContain("/test-skill deploy prod with context");
        expect(frame).not.toContain("[skill] test-skill");
        expect(frame).not.toContain("Use the test skill carefully.");
        expect(faux.prompts).toEqual(["first prompt"]);
      });

      await waitFor(() => {
        expect(faux.prompts).toHaveLength(2);
      }, 4000);
      expect(faux.prompts[1]).toBe("/test-skill deploy prod\n  with context");
    } finally {
      app.renderer.destroy();
    }
  });

  test("browses queued prompts without editing until Enter", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ tokensPerSecond: 500 });
    faux.script([acpAgentMessageChunk("x".repeat(1000))], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Working");
      });

      await app.mockInput.typeText("queued prompt");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (1/10)");
        expect(frame).toContain("queued prompt");
        expectSpanNotPanelFilled(app, "queued prompt");
        expect(frame).toContain("⌥↑/⌥↓ browse queued prompts");
        expect(faux.prompts).toEqual(["first prompt"]);
      });

      app.renderOnce();
      const footerRowsBeforeSelection = app
        .captureCharFrame()
        .split("\n")
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.includes(cwd) || line.includes("context • tokens"))
        .map(({ index }) => index);

      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("⏸ Queue (1/10)");
        expect(frame).toContain("enter edit");
        expect(frame).not.toContain("auto-send paused");
        expect(frame).toContain("Working");
        const titleSpan = app
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .find((span) => span.text.includes("⏸ Queue (1/10)"));
        expect(titleSpan?.fg.toString()).toBe(parseColor(getColors().diffRemoved).toString());
        const footerRowsAfterSelection = frame
          .split("\n")
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => line.includes(cwd) || line.includes("context • tokens"))
          .map(({ index }) => index);
        expect(footerRowsAfterSelection).toEqual(footerRowsBeforeSelection);
      });

      await app.mockInput.typeText("composer typing leaves browse mode");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).not.toContain("enter edit");
        expect(frame).toContain("Queued prompt #1 · queued prompt");
        expect(frame).toContain("composer typing leaves browse mode");
      });
      expect(faux.prompts).toEqual(["first prompt"]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("escape while editing a queued prompt restores it and clears discarded composer edits", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ hangPrompts: true });

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Working");
      });

      await app.mockInput.typeText("queued original");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (1/10)");
        expect(frame).toContain("Queued prompt #1 · queued original");
      });

      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("enter edit");
      });
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("enter save");
      });

      const composerPanelText = () => {
        const panelBg = parseColor(getColors().panelUser).toString();
        return app
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .filter((span) => span.bg.toString() === panelBg)
          .map((span) => span.text)
          .join("");
      };
      const expectRestoredQueue = async () => {
        await waitFor(() => {
          app.renderOnce();
          const frame = app.captureCharFrame();
          expect(frame).toContain("❯ Queued prompt #1");
          expect(frame).toContain("Queued prompt #1 · queued original");
          expect(frame).not.toContain("enter save");
        });
      };

      await app.mockInput.typeText(" discarded edit");
      app.mockInput.pressEscape();

      await expectRestoredQueue();
      app.renderOnce();
      expect(composerPanelText()).not.toContain("discarded edit");

      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (1/10)");
        expect(frame).not.toContain("enter edit");
      });
      app.renderOnce();
      expect(composerPanelText()).not.toContain("queued original");

      expect(faux.prompts).toEqual(["first prompt"]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("delete preserves pasted composer drafts while removing queued rows", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ hangPrompts: true });

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("running prompt before queue delete");
      app.mockInput.pressEnter();
      await waitFor(() => expect(faux.prompts).toEqual(["running prompt before queue delete"]));

      for (const prompt of ["queued prompt one", "queued prompt two", "queued prompt three"]) {
        await app.mockInput.typeText(prompt);
        app.mockInput.pressEnter();
      }
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Queue (3/10)");
      });

      const composerDraft = "composer\ndraft\npreserved\nwhile\nqueue\ndeletes";
      await app.mockInput.pasteBracketedText(composerDraft);
      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("❯ Queued prompt #3");
        expect(frame).toContain("Queued prompt #3 · queued prompt three");
        expect(frame).toContain("[paste #1 +6 lines - composer draft preserved while...]");
      });

      app.mockInput.pressKey("BACKSPACE");
      emitKey(app, "escape", { sequence: "\u001b", raw: "\u001b" });
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (2/10)");
        expect(frame).toContain("Queued prompt #2 · queued prompt two");
        expect(frame).toContain("[paste #1 +6 lines - composer draft preserved while...]");
        expect(frame).not.toContain("enter edit");
        expect(frame).not.toContain("queued prompt three");
      });

      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("❯ Queued prompt #2");
      });
      app.mockInput.pressKey("BACKSPACE");
      // Queue deletion hands focus to the next item on a zero-delay timer.
      // Let that handoff settle before rendering so slower CI runners cannot starve it.
      await Bun.sleep(0);
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("❯ Queued prompt #1");
        expect(frame).toContain("Queued prompt #1 · queued prompt one");
        expect(frame).not.toContain("queued prompt two");
      });
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("enter save");
      });

      emitKey(app, "d", { ctrl: true, sequence: "\u0004", raw: "\u0004" });
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Deleted queued prompt #1");
        expect(frame).toContain("[paste #1 +6 lines - composer draft preserved while...]");
        expect(frame).not.toContain("enter edit");
        expect(frame).not.toContain("Queue (1/10)");
        expect(faux.prompts).toEqual(["running prompt before queue delete"]);
      });

      app.mockInput.pressEscape();
      await waitFor(() => expect(faux.cancellations).toBe(1));
      app.mockInput.pressEnter();
      await waitFor(() => {
        expect(faux.prompts).toEqual(["running prompt before queue delete", composerDraft]);
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("plain up browses history while option-up selects queued prompts", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ tokensPerSecond: 500 });
    faux.script([acpAgentMessageChunk("x".repeat(1000))], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("running prompt before history fallthrough");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Working");
      });

      await app.mockInput.typeText("queued history fallthrough");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (1/10)");
        expect(frame).toContain("queued history fallthrough");
      });

      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("running prompt before history fallthrough");
        expect(frame).not.toContain("enter edit");
      });

      app.mockInput.pressArrow("down");

      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("❯ Queued prompt #1");
      });

      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("enter save");
      });
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["running prompt before history fallthrough", "queued history fallthrough"]);
      }, 4000);
    } finally {
      app.renderer.destroy();
    }
  });

  test("option-up navigates the queue with a composer draft and restores the draft on exit", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ hangPrompts: true });

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("running prompt before draft-preserving queue navigation");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toHaveLength(1);
      });

      await app.mockInput.typeText("queued prompt behind composer draft");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Queue (1/10)");
      });

      await app.mockInput.typeText("composer draft preserved across queue navigation");
      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("enter edit");
        expect(frame).toContain("queued prompt behind composer draft");
        expect(frame).toContain("composer draft preserved across queue navigation");
      });

      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (1/10)");
        expect(frame).toContain("composer draft preserved across queue navigation");
        expect(frame).not.toContain("enter edit");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("queue editing starts explicitly with the cursor at the end of the prompt", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ tokensPerSecond: 500 });
    faux.script([acpAgentMessageChunk("x".repeat(1000))], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("running prompt before queue reclaim");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Working");
      });

      await app.mockInput.typeText("queued prompt before reclaim");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (1/10)");
        expect(frame).toContain("queued prompt before reclaim");
      });

      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("enter edit");
      });
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("enter save");
      });

      await app.mockInput.typeText(" edited inline");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("enter save");
        expect(frame).toContain("queued prompt before reclaim edited inline");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("backspace edits a focused queued prompt in the rendered app", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ tokensPerSecond: 250 });
    faux.script([acpAgentMessageChunk("x".repeat(1000))], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["first prompt"]);
      });

      await app.mockInput.typeText("queued one");
      app.mockInput.pressEnter();
      await app.mockInput.typeText("queued two");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (2/10)");
        expect(frame).toContain("queued one");
        expect(frame).toContain("queued two");
      });

      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("❯ Queued prompt #2");
      });
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("enter save");
      });

      app.mockInput.pressKey("END");
      app.mockInput.pressKey("BACKSPACE");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("enter save");
        expect(frame).toContain("queued tw");
      });

      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["first prompt", "queued one", "queued tw"]);
      }, 6000);
    } finally {
      app.renderer.destroy();
    }
  }, 10000);

  test("pauses queue draining until an active edit is explicitly saved", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 1_500 });
    faux.script([acpAgentMessageChunk("first done")], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));
    faux.script([acpAgentMessageChunk("queued done")], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => expect(faux.prompts).toEqual(["first prompt"]));

      await app.mockInput.typeText("queued prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Queue (1/10)");
      });

      await app.mockInput.typeText("composer draft");
      emitKey(app, "up", { option: true });
      app.mockInput.pressEnter();
      await app.mockInput.typeText(" edited");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("queued prompt edited");
      });

      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["first prompt"]);
        const frame = app.captureCharFrame();
        expect(frame).toContain("enter save");
        expect(frame).not.toContain("auto-send paused");
      }, 5000);

      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["first prompt", "queued prompt edited"]);
        expect(app.captureCharFrame()).toContain("composer draft");
      }, 4000);
    } finally {
      app.renderer.destroy();
    }
  }, 10000);

  test("runs plugin prompt interceptors once for queued prompts with queue source", async () => {
    const cwd = tmpWorkspace();
    const pluginPath = path.join(cwd, "prompt-source-plugin.mjs");
    fs.writeFileSync(
      pluginPath,
      `
export default function plugin(relay) {
  relay.input.onBeforeSubmit(({ text, source }) => text + " [" + source + "]");
}
`,
      "utf-8",
    );
    configureFauxAgentWithPlugins([pluginPath]);
    const faux = createFauxAcpAgent({ promptDelayMs: 500 });
    faux.script([acpAgentMessageChunk("first done")], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));
    faux.script([acpAgentMessageChunk("queued done")], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        expect(faux.prompts).toEqual(["first prompt [user]"]);
      });

      await app.mockInput.typeText("queued prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("queued prompt");
      });

      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["first prompt [user]", "queued prompt [queue]"]);
      }, 4000);
    } finally {
      app.renderer.destroy();
    }
  }, 10000);

  test("Option+Enter sends guidance to a running turn without queueing for meta-shaped key events", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 1_000, activeTurnInput: true });
    faux.script([acpAgentMessageChunk("working")], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toHaveLength(1);
      });

      await app.mockInput.typeText("guide this turn");
      app.mockInput.pressEnter({ meta: true });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.activeTurnInputs).toEqual(["guide this turn"]);
        expect(faux.prompts).toHaveLength(1);
        expect(frame).toContain("[turn update]");
        expect(frame).toContain("guide this turn");
        expectSpanPanelFilled(app, "guide this turn");
        expect(frame).toContain("Added to current turn");
        expect(frame).not.toContain("current-turn guidance ·");
        expect(frame).not.toContain("Queue (1/10)");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("Option+Enter sends guidance to a running turn without queueing for option-shaped key events", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 1_000, activeTurnInput: true });
    faux.script([acpAgentMessageChunk("working")], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toHaveLength(1);
      });

      await app.mockInput.typeText("guide via option");
      app.renderer.keyInput.emit("keypress", {
        name: "return",
        ctrl: false,
        meta: false,
        shift: false,
        option: true,
        sequence: "\r",
        number: false,
        raw: "\r",
        eventType: "press",
        source: "raw",
        get defaultPrevented() {
          return false;
        },
        get propagationStopped() {
          return false;
        },
        preventDefault() {},
        stopPropagation() {},
      } as Parameters<typeof app.renderer.keyInput.emit>[1]);

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.activeTurnInputs).toEqual(["guide via option"]);
        expect(faux.prompts).toHaveLength(1);
        expect(frame).toContain("[turn update]");
        expect(frame).toContain("guide via option");
        expect(frame).toContain("Added to current turn");
        expect(frame).not.toContain("current-turn guidance ·");
        expect(frame).not.toContain("Queue (1/10)");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("Option+keypad Enter sends guidance to a running turn without queueing", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 1_000, activeTurnInput: true });
    faux.script([acpAgentMessageChunk("working")], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);
    const observedKeys: Array<{ name?: string; meta?: boolean; option?: boolean; shift?: boolean; ctrl?: boolean }> =
      [];
    app.renderer.keyInput.on("keypress", (evt) => {
      observedKeys.push({ name: evt.name, meta: evt.meta, option: evt.option, shift: evt.shift, ctrl: evt.ctrl });
    });

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toHaveLength(1);
      });

      await app.mockInput.typeText("guide via keypad enter");
      pressRawKeypadEnter(app, "option");

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(observedKeys.at(-1)).toMatchObject({ name: "kpenter", meta: true, option: true });
        expect(faux.activeTurnInputs).toEqual(["guide via keypad enter"]);
        expect(faux.prompts).toHaveLength(1);
        expect(frame).toContain("[turn update]");
        expect(frame).toContain("guide via keypad enter");
        expect(frame).toContain("Added to current turn");
        expect(frame).not.toContain("current-turn guidance ·");
        expect(frame).not.toContain("Queue (1/10)");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("option-enter cannot send an unfinished queue edit as active-turn guidance", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ hangPrompts: true, activeTurnInput: true });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await submitPrompt(app, "running prompt before guarded queue edit guidance");
      await waitFor(() => expect(faux.prompts).toEqual(["running prompt before guarded queue edit guidance"]));

      await submitPrompt(app, "queued edit must stay queued");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Queue (1/10)");
      });

      app.mockInput.pressArrow("up", { meta: true });
      app.mockInput.pressEnter();
      await app.mockInput.typeText(" with unfinished changes");
      app.mockInput.pressEnter({ meta: true });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.activeTurnInputs).toEqual([]);
        expect(frame).toContain("enter save");
        expect(frame).toContain("queued edit must stay queued with unfinished changes");
        expect(frame).toContain("Save or cancel the queue edit first");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("tab steers the active queued prompt into the running turn", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ hangPrompts: true, activeTurnInput: true });

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("running prompt before queued steer");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["running prompt before queued steer"]);
      });

      await app.mockInput.typeText("queued steer prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (1/10)");
        expect(frame).toContain("queued steer prompt");
      });

      await app.mockInput.typeText("draft retained while steering queued prompt");
      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("⏸ Queue (1/10)");
      });

      app.mockInput.pressKey("TAB");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.activeTurnInputs).toEqual(["queued steer prompt"]);
        expect(faux.prompts).toEqual(["running prompt before queued steer"]);
        expect(frame).not.toContain("Queue (1/10)");
        expect(frame).toContain("Added to current turn");
        expect(frame).toContain("draft retained while steering queued prompt");
        expect(frame.match(/queued steer prompt/g)).toHaveLength(1);
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("Option+Enter keeps skill-shaped guidance visually distinct from normal skill prompts", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 1_000, activeTurnInput: true });
    faux.script([acpAgentMessageChunk("working")], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));
    const skillGuidance = `<skill name="steer" location="/tmp/steer/SKILL.md">\nUse this as literal turn-update text.\n</skill>\n\nprefer the safer path`;

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toHaveLength(1);
      });

      await app.mockInput.typeText(skillGuidance);
      app.mockInput.pressEnter({ meta: true });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.activeTurnInputs).toEqual([skillGuidance]);
        expect(frame).toContain("[turn update]");
        expect(frame).toContain('<skill name="steer" location="/tmp/steer/SKILL.md">');
        expect(frame).not.toContain("current-turn guidance · <skill");
        expect(frame).toContain("prefer the safer path");
        expectSpanPanelFilled(app, "prefer the safer path");
        expect(frame).not.toContain("[skill] steer");
        expect(frame).not.toContain("Queue (1/10)");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("Option+Enter guidance enters prompt history when accepted", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 1_000, activeTurnInput: true });
    faux.script([acpAgentMessageChunk("working")], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toHaveLength(1);
      });

      await app.mockInput.typeText("guide should be history");
      app.mockInput.pressEnter({ meta: true });
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.activeTurnInputs).toEqual(["guide should be history"]);
        expect(frame).toContain("[turn update]");
        expect(frame).toContain("guide should be history");
        expect(frame).not.toContain("current-turn guidance ·");
        expectSpanPanelFilled(app, "guide should be history");
      });

      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("guide should be history");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("Option+Enter records multiple accepted guidance messages newest-first in prompt history", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 1_000, activeTurnInput: true });
    faux.script([acpAgentMessageChunk("working")], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("multi steer running prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toHaveLength(1);
      });

      await app.mockInput.typeText("first steering history item");
      app.mockInput.pressEnter({ meta: true });
      await app.mockInput.typeText("second steering history item");
      app.mockInput.pressEnter({ meta: true });

      await waitFor(() => {
        app.renderOnce();
        expect(faux.activeTurnInputs).toEqual(["first steering history item", "second steering history item"]);
      });

      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("second steering history item");
      });

      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("first steering history item");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("prompt history orders queued prompts before earlier steering messages", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 1_000, activeTurnInput: true });
    faux.script([acpAgentMessageChunk("working")], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("queue ordering running prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toHaveLength(1);
      });

      await app.mockInput.typeText("queue ordering steer one");
      app.mockInput.pressEnter({ meta: true });
      await app.mockInput.typeText("queue ordering steer two");
      app.mockInput.pressEnter({ meta: true });
      await app.mockInput.typeText("queue ordering queued prompt");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.activeTurnInputs).toEqual(["queue ordering steer one", "queue ordering steer two"]);
        expect(frame).toContain("Queue (1/10)");
        expect(frame).toContain("queue ordering queued prompt");
      });

      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("queue ordering queued prompt");
      });

      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("queue ordering steer two");
      });

      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("queue ordering steer one");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("Option+Enter guidance history preserves paste marker expansion", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 1_000, activeTurnInput: true });
    faux.script([acpAgentMessageChunk("working")], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));
    faux.script([acpAgentMessageChunk("replayed paste")], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));
    const pastedText = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta";

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("paste steering running prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toHaveLength(1);
      });

      await app.mockInput.typeText("paste steering ");
      await app.mockInput.pasteBracketedText(pastedText);
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("[paste #1 +6 lines - alpha beta gamma delta...]");
      });
      app.mockInput.pressEnter({ meta: true });

      await waitFor(() => {
        app.renderOnce();
        expect(faux.activeTurnInputs).toEqual([`paste steering ${pastedText}`]);
      });

      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("[paste #1 +6 lines - alpha beta gamma delta...]");
      });
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["paste steering running prompt", `paste steering ${pastedText}`]);
      }, 4000);
    } finally {
      app.renderer.destroy();
    }
  });

  test("Option+Enter restores text when active-turn guidance is unsupported", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 1_000 });
    faux.script([acpAgentMessageChunk("working")], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toHaveLength(1);
      });

      await app.mockInput.typeText("do not lose me");
      app.mockInput.pressEnter({ meta: true });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.activeTurnInputs).toEqual([]);
        expect(frame).toContain("cannot add to the current turn");
        expect(frame).toContain("do not lose me");
        expect(frame).not.toContain("Queue (1/10)");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("Option+Enter unsupported guidance restores expanded paste text for resubmit", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 1_000 });
    faux.script([acpAgentMessageChunk("working")], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));
    const pastedText = "unsupported\npaste\nrestore\nresubmit\ncontent\nend";

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("unsupported paste running prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toHaveLength(1);
      });

      await app.mockInput.typeText("restore paste ");
      await app.mockInput.pasteBracketedText(pastedText);
      app.mockInput.pressEnter({ meta: true });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.activeTurnInputs).toEqual([]);
        expect(frame).toContain("cannot add to the current turn");
        expect(frame).toContain("unsupported");
        expect(frame).not.toContain("[paste #1");
      });

      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["unsupported paste running prompt", `restore paste ${pastedText}`]);
      }, 4000);
    } finally {
      app.renderer.destroy();
    }
  });

  test("Option+Enter does not send slash commands as active-turn guidance", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 1_000, activeTurnInput: true });
    faux.script([acpAgentMessageChunk("working")], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toHaveLength(1);
      });

      await app.mockInput.typeText("/settings");
      app.mockInput.pressEnter({ meta: true });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.activeTurnInputs).toEqual([]);
        expect(faux.prompts).toHaveLength(1);
        expect(frame).toContain("Only ordinary prompts can be added to the current turn");
        expect(frame).toContain("/settings");
        expect(frame).not.toContain("Queue (1/10)");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("Option+Enter does not send bash commands as active-turn guidance", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 1_000, activeTurnInput: true });
    faux.script([acpAgentMessageChunk("working")], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toHaveLength(1);
      });

      await app.mockInput.typeText("!echo hi");
      app.mockInput.pressEnter({ meta: true });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.activeTurnInputs).toEqual([]);
        expect(faux.prompts).toHaveLength(1);
        expect(frame).toContain("Only ordinary prompts can be added to the current turn");
        expect(frame).toContain("!echo hi");
        expect(frame).not.toContain("Queue (1/10)");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("a delayed guidance rejection does not overwrite a concurrent queue edit", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      activeTurnInput: true,
      activeTurnInputResponse: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { accepted: false, reason: "turn-completing" };
      },
      hangPrompts: true,
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await submitPrompt(app, "running before guidance queue-edit race");
      await waitFor(() => expect(faux.prompts).toHaveLength(1));
      await submitPrompt(app, "committed queue item under edit");

      await app.mockInput.typeText("guidance rejected during queue edit");
      app.mockInput.pressEnter({ meta: true });
      app.mockInput.pressArrow("up", { meta: true });
      app.mockInput.pressEnter();
      await app.mockInput.typeText(" unfinished");

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.activeTurnInputs).toEqual(["guidance rejected during queue edit"]);
        expect(frame).toContain("enter save");
        expect(frame).toContain("committed queue item under edit unfinished");
        expect(frame).toContain("Queued prompt #2 · guidance rejected during queue edit");
      });

      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queued prompt #1 · committed queue item under edit");
        expect(frame).toContain("Queued prompt #2 · guidance rejected during queue edit");
        expect(frame).not.toContain("unfinished");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("a full queue restores delayed rejected guidance to the preserved composer draft", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      activeTurnInput: true,
      activeTurnInputResponse: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { accepted: false, reason: "turn-completing" };
      },
      hangPrompts: true,
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await submitPrompt(app, "running before full queue guidance race");
      await waitFor(() => expect(faux.prompts).toHaveLength(1));
      for (let index = 1; index <= 10; index++) await submitPrompt(app, `full queue item ${index}`);
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Queue (10/10)");
      });

      await app.mockInput.typeText("guidance restored after full queue race");
      app.mockInput.pressEnter({ meta: true });
      app.mockInput.pressArrow("up", { meta: true });
      app.mockInput.pressEnter();
      await app.mockInput.typeText(" unfinished");

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("enter save");
        expect(frame).toContain("full queue item 10 unfinished");
        expect(frame).toContain("Queue full; prompt restored to the composer draft");
      });

      app.mockInput.pressEscape();
      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (10/10)");
        expect(frame).toContain("guidance restored after full queue race");
        expect(frame).not.toContain("unfinished");
      });
    } finally {
      app.renderer.destroy();
    }
  }, 10000);

  test("full queue rejects deferred plugin prompts instead of silently losing them", async () => {
    const cwd = tmpWorkspace();
    const pluginPath = path.join(cwd, "deferred-queue-prompt-plugin.mjs");
    fs.writeFileSync(
      pluginPath,
      `
export default function plugin(relay) {
  relay.commands.register("deferred-plugin-prompt", {
    run(_args, ctx) {
      setTimeout(async () => {
        try {
          await relay.agent.prompt("plugin prompt must not be lost");
          ctx.toast("plugin queue prompt accepted");
        } catch (error) {
          ctx.toast("plugin queue rejected: " + error.message);
        }
      }, 50);
    },
  });
}
`,
      "utf-8",
    );
    configureFauxAgentWithPlugins([pluginPath]);
    const faux = createFauxAcpAgent({ hangPrompts: true });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await submitPrompt(app, "running prompt before full plugin queue race");
      await waitFor(() => expect(faux.prompts).toHaveLength(1));

      for (let index = 1; index <= 10; index++) await submitPrompt(app, `queued plugin capacity ${index}`);
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Queue (10/10)");
      });

      await submitPrompt(app, "/deferred-plugin-prompt");
      app.mockInput.pressArrow("up", { meta: true });
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("enter save");
        expect(frame).toContain("plugin queue rejected: Prompt queue is full");
        expect(frame).not.toContain("plugin queue prompt accepted");
        expect(faux.prompts).toEqual(["running prompt before full plugin queue race"]);
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("empty queue edits stay open with actionable feedback", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ hangPrompts: true });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await submitPrompt(app, "running before empty queue edit");
      await waitFor(() => expect(faux.prompts).toHaveLength(1));
      await submitPrompt(app, "x");
      app.mockInput.pressArrow("up", { meta: true });
      app.mockInput.pressEnter();
      app.mockInput.pressKey("BACKSPACE");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("enter save");
        expect(frame).toContain("Queued prompt cannot be empty");
        expect(faux.prompts).toEqual(["running before empty queue edit"]);
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("Option+Enter queues when active-turn guidance is rejected", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      activeTurnInput: true,
      activeTurnInputResponse: { accepted: false, reason: "turn-completing" },
      hangPrompts: true,
    });

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toHaveLength(1);
      });

      await app.mockInput.typeText("queue on rejection");
      app.mockInput.pressEnter({ meta: true });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.activeTurnInputs).toEqual(["queue on rejection"]);
        expect(frame).toContain("Queue (1/10)");
        expect(frame).toContain("Queued prompt #1 · queue on rejection");
        expect(frame).not.toContain("current-turn guidance");
      });

      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("queue on rejection");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("Option+Enter rejected guidance preserves a draft typed before fallback completes", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      activeTurnInput: true,
      activeTurnInputResponse: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { accepted: false, reason: "turn-completing" };
      },
      hangPrompts: true,
    });

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toHaveLength(1);
      });

      await app.mockInput.typeText("guidance that will be queued");
      app.mockInput.pressEnter({ meta: true });
      await app.mockInput.typeText("new draft after steering");

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.activeTurnInputs).toEqual(["guidance that will be queued"]);
        expect(frame).toContain("new draft after steering");
        expect(frame).toContain("guidance that will be queued");
        expect(frame).not.toContain("current-turn guidance");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("Option+Enter restores guidance text when rejected and the queue is full", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      activeTurnInput: true,
      activeTurnInputResponse: { accepted: false, reason: "turn-completing" },
      hangPrompts: true,
    });

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toHaveLength(1);
      });

      const queuedPrompts = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
      for (const prompt of queuedPrompts) {
        await app.mockInput.typeText(`queued ${prompt}`);
        app.mockInput.pressEnter();
      }

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Queue (10/10)");
      });

      await app.mockInput.typeText("do not drop this guidance");
      app.mockInput.pressEnter({ meta: true });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.activeTurnInputs).toEqual(["do not drop this guidance"]);
        expect(frame).toContain("Queue full (max 10)");
        expect(frame).toContain("do not drop this guidance");
        expect(frame).toContain("Queue (10/10)");
        expect(frame).not.toContain("current-turn guidance");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("keypad Enter submits the normal prompt", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("keypad prompt");
      pressRawKeypadEnter(app);

      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["keypad prompt"]);
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("shift-keypad Enter inserts a newline in the normal prompt", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();

    const app = await renderFauxApp(cwd, faux, { otherModifiersMode: true });

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("line one");
      pressRawKeypadEnter(app, "shift");
      app.renderOnce();
      expect(faux.prompts).toEqual([]);

      await app.mockInput.typeText("line two");
      pressRawKeypadEnter(app);

      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["line one\nline two"]);
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("shift-enter inserts a newline in the normal prompt", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();

    const app = await renderFauxApp(cwd, faux, { otherModifiersMode: true });

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("line one");
      app.mockInput.pressEnter({ shift: true });
      app.renderOnce();
      expect(faux.prompts).toEqual([]);

      await app.mockInput.typeText("line two");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["line one\nline two"]);
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("shift-enter inserts a newline while editing a queued prompt", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ tokensPerSecond: 500 });
    faux.script([acpAgentMessageChunk("x".repeat(1000))], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux, { otherModifiersMode: true });

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Working");
      });

      await app.mockInput.typeText("queued line one");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Queue (1/10)");
      });

      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("enter edit");
      });
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("enter save");
      });

      app.mockInput.pressKey("END");
      app.mockInput.pressEnter({ shift: true });
      await app.mockInput.typeText("queued line two");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["first prompt", "queued line one\nqueued line two"]);
      }, 4000);
    } finally {
      app.renderer.destroy();
    }
  });

  test("plain and option up/down navigate selected queue rows without editing", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ tokensPerSecond: 500 });
    faux.script([acpAgentMessageChunk("x".repeat(1000))], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Working");
      });

      await app.mockInput.typeText("queued one");
      app.mockInput.pressEnter();
      await app.mockInput.typeText("queued two");
      app.mockInput.pressEnter();
      await app.mockInput.typeText("queued three");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (3/10)");
        expect(frame).toContain("Queued prompt #1 · queued one");
        expect(frame).toContain("Queued prompt #2 · queued two");
        expect(frame).toContain("Queued prompt #3 · queued three");
      });

      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("enter edit");
      });
      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("❯ Queued prompt #2");
      });
      app.mockInput.pressArrow("down");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("❯ Queued prompt #3");
      });

      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("❯ Queued prompt #2");
      });

      app.mockInput.pressArrow("down", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queued prompt #1 · queued one");
        expect(frame).toContain("Queued prompt #2 · queued two");
        expect(frame).toContain("Queued prompt #3 · queued three");
        expect(frame).toContain("❯ Queued prompt #3");
      });

      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("enter save");
      });
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["first prompt", "queued one", "queued two", "queued three"]);
      }, 5000);
    } finally {
      app.renderer.destroy();
    }
  });

  test("interrupt preserves queued prompts", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 3000, settlePromptAfterCancelMs: 200, hangPromptIndexes: [2] });
    faux.setDefaultResponse(acpPromptResponse({ inputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("running prompt before preserved queue");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["running prompt before preserved queue"]);
      });

      await app.mockInput.typeText("preserved queued one");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (1/10)");
        expect(frame).toContain("preserved queued one");
      });

      await app.mockInput.typeText("preserved queued two");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (2/10)");
        expect(frame).toContain("preserved queued one");
        expect(frame).toContain("preserved queued two");
      });

      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Interrupted; 2 queued prompts preserved.");
        expect(frame).not.toContain("※ Interrupted; 2 queued prompts preserved.");
        expect(frame).toContain("Use ⌥↑/⌥↓ to manage queue.");
        expect(frame).toContain("Queue (2/10)");
        expect(frame).toContain("preserved queued one");
        expect(frame).toContain("preserved queued two");
        expect(faux.cancellations).toBe(1);
      });

      await app.mockInput.typeText("new prompt after interrupt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["running prompt before preserved queue", "new prompt after interrupt"]);
        expect(app.captureCharFrame()).toContain("Working");
      });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (2/10)");
        expect(frame).toContain("preserved queued one");
        expect(frame).toContain("preserved queued two");
      });

      app.mockInput.pressArrow("up", { meta: true });
      app.mockInput.pressEnter();
      app.mockInput.pressKey("END");
      app.mockInput.pressKey("BACKSPACE");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("enter save");
        expect(frame).toContain("preserved queued one");
        expect(frame).toContain("preserved queued tw");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("enter saves a queued edit after interrupt and resumes queue dispatch", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ hangPrompts: true });

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await submitPrompt(app, "running prompt before interrupted queue edit");
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["running prompt before interrupted queue edit"]);
      });

      await submitPrompt(app, "queued prompt edited after interrupt");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Queue (1/10)");
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await app.mockInput.typeText("draft preserved after interrupted queue edit");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("draft preserved after interrupted queue edit");
      });
      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Interrupted; 1 queued prompt preserved.");
      });

      app.mockInput.pressArrow("up", { meta: true });
      app.mockInput.pressEnter();
      app.mockInput.pressKey("END");
      await app.mockInput.typeText(" updated");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.prompts).toEqual([
          "running prompt before interrupted queue edit",
          "queued prompt edited after interrupt updated",
        ]);
        expect(frame).toContain("Working");
        expect(frame).toContain("draft preserved after interrupted queue edit");
        expect(frame).not.toContain("enter save");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("surfaces ACP process exit during a hanging prompt and releases dispatch", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ hangPromptIndexes: [1] });
    faux.setDefaultResponse(acpPromptResponse({ inputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await submitPrompt(app, "hanging prompt before process exit");
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["hanging prompt before process exit"]);
        expect(app.captureCharFrame()).toContain("Working");
      });

      faux.exit({ code: 0 });
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("ACP agent process exited unexpectedly (code 0). Start a new prompt to reconnect.");
        expect(frame).not.toContain("ACP prompt error");
        expect(frame).not.toContain("Working");
        expect(frame).not.toContain("Queue (1/10)");
      });

      await submitPrompt(app, "new prompt after process exit");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.prompts).toEqual(["hanging prompt before process exit", "new prompt after process exit"]);
        expect(frame).not.toContain("Queue (1/10)");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("submits a new prompt after interrupting a prompt that never settles", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ hangPromptIndexes: [1] });
    faux.setDefaultResponse(acpPromptResponse({ inputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await submitPrompt(app, "hanging prompt before interrupt");
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["hanging prompt before interrupt"]);
      });

      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Interrupted by user");
        expect(frame).not.toContain("※ Interrupted by user");
        expect(faux.cancellations).toBe(1);
      });

      await submitPrompt(app, "new prompt after hanging interrupt");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.prompts).toEqual(["hanging prompt before interrupt", "new prompt after hanging interrupt"]);
        expect(frame).not.toContain("Queue (1/10)");
        expect(frame).not.toContain("ACP prompt error");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("ctrl-enter send now drains remaining queued prompts after the sent prompt completes", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelaySequenceMs: [3000, 100, 100], settlePromptAfterCancelMs: 50 });
    faux.setDefaultResponse(acpPromptResponse({ inputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("running prompt before send now");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["running prompt before send now"]);
      });

      await app.mockInput.typeText("queued stay behind");
      app.mockInput.pressEnter();
      await app.mockInput.typeText("queued send now");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (2/10)");
        expect(frame).toContain("queued stay behind");
        expect(frame).toContain("queued send now");
      });

      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Interrupted; 2 queued prompts preserved.");
        expect(frame).not.toContain("※ Interrupted; 2 queued prompts preserved.");
      });

      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("❯ Queued prompt #2");
      });

      pressCtrlEnter(app);
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["running prompt before send now", "queued send now"]);
        const frame = app.captureCharFrame();
        expect(frame).toContain("Sent queued prompt #2");
        expect(frame).toContain("Queue (1/10)");
        expect(frame).toContain("queued stay behind");
      });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.prompts).toEqual(["running prompt before send now", "queued send now", "queued stay behind"]);
        expect(frame).not.toContain("Queue (1/10)");
      }, 4000);
    } finally {
      app.renderer.destroy();
    }
  }, 10000);

  test("interrupting a send-now prompt preserves remaining queued prompts without draining stale completions", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelaySequenceMs: [3000, 3000, 0], settlePromptAfterCancelMs: 100 });
    faux.setDefaultResponse(acpPromptResponse({ inputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("running prompt before interrupted send now");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["running prompt before interrupted send now"]);
      });

      await app.mockInput.typeText("queued survives interrupted send now");
      app.mockInput.pressEnter();
      await app.mockInput.typeText("queued send now gets interrupted");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Queue (2/10)");
      });

      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Interrupted; 2 queued prompts preserved.");
      });

      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("❯ Queued prompt #2");
      });

      pressCtrlEnter(app);
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual([
          "running prompt before interrupted send now",
          "queued send now gets interrupted",
        ]);
        expect(app.captureCharFrame()).toContain("Working");
      });

      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Interrupted; 1 queued prompt preserved.");
        expect(frame).toContain("Queue (1/10)");
        expect(frame).toContain("queued survives interrupted send now");
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      app.renderOnce();
      const frame = app.captureCharFrame();
      expect(faux.prompts).toEqual(["running prompt before interrupted send now", "queued send now gets interrupted"]);
      expect(frame).toContain("Queue (1/10)");
      expect(frame).toContain("queued survives interrupted send now");
    } finally {
      app.renderer.destroy();
    }
  }, 10000);

  test("ctrl-enter send now does not consume pending bash context", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelaySequenceMs: [1000, 0, 0, 0], settlePromptAfterCancelMs: 200 });
    faux.setDefaultResponse(acpPromptResponse({ inputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("running prompt before bash-safe send now");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["running prompt before bash-safe send now"]);
      });

      await app.mockInput.typeText("queued bash-safe remaining after send now");
      app.mockInput.pressEnter();
      await app.mockInput.typeText("queued bash-safe send now");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Queue (2/10)");
      });

      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Interrupted; 2 queued prompts preserved.");
        expect(frame).not.toContain("※ Interrupted; 2 queued prompts preserved.");
      });

      await app.mockInput.typeText("!!printf send-now-bash");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("send-now-bash");
      }, 2000);
      await new Promise((resolve) => setTimeout(resolve, 20));

      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("❯ Queued prompt #2");
      });

      pressCtrlEnter(app);
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toHaveLength(3);
      });
      expect(faux.prompts[1]).toBe("queued bash-safe send now");
      expect(faux.prompts[2]).toBe("queued bash-safe remaining after send now");
      expect(faux.prompts[1]).not.toContain("send-now-bash");
      expect(faux.prompts[2]).not.toContain("send-now-bash");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).not.toContain("Working");
      });

      await app.mockInput.typeText("normal prompt gets bash context after send now");
      app.mockInput.pressEnter();
      await waitFor(() => {
        expect(faux.prompts).toHaveLength(4);
        expect(faux.prompts[3]).toContain("normal prompt gets bash context after send now");
        expect(faux.prompts[3]).toContain("send-now-bash");
      });
    } finally {
      app.renderer.destroy();
    }
  }, 10000);

  test("ctrl-enter send now does not consume pending bash context when a plugin handles the selected prompt", async () => {
    const cwd = tmpWorkspace();
    const pluginPath = path.join(cwd, "handled-send-now-plugin.mjs");
    fs.writeFileSync(
      pluginPath,
      `
export default function plugin(relay) {
  relay.input.onBeforeSubmit(({ text }) => {
    if (text === "queued handled send now") return { text, handled: true };
    return text;
  });
}
`,
      "utf-8",
    );
    configureFauxAgentWithPlugins([pluginPath]);
    const faux = createFauxAcpAgent({ promptDelaySequenceMs: [1000, 0, 0], settlePromptAfterCancelMs: 200 });
    faux.setDefaultResponse(acpPromptResponse({ inputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("running prompt before handled send now");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["running prompt before handled send now"]);
      });

      await app.mockInput.typeText("queued after handled send now");
      app.mockInput.pressEnter();
      await app.mockInput.typeText("queued handled send now");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Queue (2/10)");
      });

      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Interrupted; 2 queued prompts preserved.");
      });

      await app.mockInput.typeText("!!printf handled-send-now-bash");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("handled-send-now-bash");
      }, 2000);
      await new Promise((resolve) => setTimeout(resolve, 20));

      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("❯ Queued prompt #2");
      });

      pressCtrlEnter(app);
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toHaveLength(2);
      });
      expect(faux.prompts[1]).toBe("queued after handled send now");
      expect(faux.prompts[1]).not.toContain("handled-send-now-bash");
      expect(faux.prompts).not.toContain("queued handled send now");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).not.toContain("Working");
      });

      await app.mockInput.typeText("normal prompt gets handled bash context after send now");
      app.mockInput.pressEnter();
      await waitFor(() => {
        expect(faux.prompts).toHaveLength(3);
        expect(faux.prompts[2]).toContain("normal prompt gets handled bash context after send now");
        expect(faux.prompts[2]).toContain("handled-send-now-bash");
      });
    } finally {
      app.renderer.destroy();
    }
  }, 10000);

  test("ctrl-enter on a focused queued prompt is guarded while running", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 3000 });
    faux.setDefaultResponse(acpPromptResponse({ inputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("running prompt before guarded send now");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["running prompt before guarded send now"]);
      });

      await app.mockInput.typeText("guarded queued prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Queue (1/10)");
      });

      app.mockInput.pressArrow("up", { meta: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("⏸ Queue (1/10)");
      });

      pressCtrlEnter(app);
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.prompts).toEqual(["running prompt before guarded send now"]);
        expect(frame).toContain("⏸ Queue (1/10)");
        expect(frame).toContain("guarded queued prompt");
        expect(frame).toContain("enter edit");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("shows full queue capacity and rejects prompts beyond the max", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ tokensPerSecond: 500 });
    faux.script([acpAgentMessageChunk("x".repeat(1000))], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("first prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["first prompt"]);
      });

      const queuedPrompts = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
      for (const prompt of queuedPrompts) {
        await app.mockInput.typeText(`queued ${prompt}`);
        app.mockInput.pressEnter();
      }

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (10/10)");
        expect(frame).toContain("Queued prompt #1 · queued one");
        expect(frame).toContain("Queued prompt #10 · queued ten");
      });

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).not.toContain("Config reloaded");
      }, 3000);

      await app.mockInput.typeText("queued eleven");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("queued eleven");
      });
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (10/10)");
        expect(frame).toContain("Queue full (max 10)");
      });
    } finally {
      app.renderer.destroy();
    }
  });
});
