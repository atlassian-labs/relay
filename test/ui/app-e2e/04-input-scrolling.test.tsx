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
  type FauxRenderedApp,
} from "./helpers";

async function waitForVisibleChatMarker(app: FauxRenderedApp): Promise<string> {
  let visibleChatMarker = "";
  await waitFor(() => {
    app.renderOnce();
    const marker = app.captureCharFrame().match(/(?:FIRST|SECOND)-\d{2}/)?.[0];
    if (!marker) throw new Error("Expected a visible chat marker before prompt-owned scrolling");
    visibleChatMarker = marker;
  });
  return visibleChatMarker;
}

async function waitForManualScrollbackFrame(
  app: FauxRenderedApp,
  previousMarker: string,
  latestTailMarker: string,
): Promise<string> {
  let visibleFrame = "";
  await waitFor(() => {
    app.renderOnce();
    const frame = app.captureCharFrame();
    expect(frame).toContain(previousMarker);
    expect(frame).not.toContain(latestTailMarker);
    visibleFrame = frame;
  });
  return visibleFrame;
}

describe("App frame-capture E2E: input and scrolling", () => {
  test("runs user bash locally without attaching output to the next ACP prompt", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const localFaux = createFauxAcpAgent();
    localFaux.script([acpAgentMessageChunk("local prompt complete")], acpPromptResponse({ inputTokens: 1 }));

    const localApp = await renderFauxApp(cwd, localFaux, { height: 40 });

    try {
      await waitForConnected(localApp);
      await localApp.mockInput.typeText("!printf local-bash");
      localApp.mockInput.pressEnter();
      await waitFor(() => {
        localApp.renderOnce();
        const frame = localApp.captureCharFrame();
        expect(frame).toContain("[bash] local");
        expect(frame).not.toContain("[local]");
        expect(frame).toContain("$ printf local-bash");
        expect(frame).toContain("local-bash");
        expectSpanPanelFilled(localApp, "printf local-bash");
      }, 2000);

      await new Promise((resolve) => setTimeout(resolve, 20));
      await localApp.mockInput.typeText("ordinary prompt");
      localApp.mockInput.pressEnter();
      await waitFor(() => localFaux.prompts.length === 1);
      expect(localFaux.prompts[0]).toContain("ordinary prompt");
      expect(localFaux.prompts[0]).not.toContain("local-bash");
      await waitFor(() => {
        localApp.renderOnce();
        expect(localApp.captureCharFrame()).toContain("local prompt complete");
      });
    } finally {
      localApp.renderer.destroy();
    }
  });

  test("runs user bash and attaches requested output to the next ACP prompt", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux, { height: 40 });

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("!!printf relay-bash");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("[bash] context");
        expect(frame).not.toContain("[llm-request]");
        expect(frame).toContain("relay-bash");
      }, 2000);

      expect(faux.prompts).toHaveLength(0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await app.mockInput.typeText("use bash result");
      app.mockInput.pressEnter();
      await waitFor(() => faux.prompts.length === 1);
      expect(faux.prompts[0]).toContain("use bash result");
      expect(faux.prompts[0]).toContain("relay-bash");
    } finally {
      app.renderer.destroy();
    }
  });

  test("navigates prompt history after submissions", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    faux.script([acpAgentMessageChunk("first complete")], acpPromptResponse({ inputTokens: 1 }));
    faux.script([acpAgentMessageChunk("second complete")], acpPromptResponse({ inputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("first history prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("first complete");
      });

      await app.mockInput.typeText("second history prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("second complete");
      });

      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("second history prompt");
      });
      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("first history prompt");
      });
      app.mockInput.pressArrow("down");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("second history prompt");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("navigates prompt history while the agent is running", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ tokensPerSecond: 50 });
    faux.script([acpAgentMessageChunk("seed complete")], acpPromptResponse({ inputTokens: 1 }));
    faux.script([acpAgentMessageChunk("x".repeat(1000))], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("seed history prompt while idle");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("seed complete");
      });

      await app.mockInput.typeText("running history prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Working");
      });

      await app.mockInput.typeText("draft while agent works");

      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("running history prompt");
      });

      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("seed history prompt while idle");
      });

      app.mockInput.pressArrow("down");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("running history prompt");
      });

      app.mockInput.pressArrow("down");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("draft while agent works");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("selects and submits slash command completion with enter", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("/set");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("/settings");
      });

      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("notifications");
        expect(frame).toContain("slash panel position: bottom");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("clears a completed diff command while the diff modal suspends the prompt", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("/di");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("/diff");
      });

      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Diff");
        expect(frame).toContain("working tree");
      });

      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).not.toContain("/diff");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("sends unmatched slash input as a prompt", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    faux.script([acpAgentMessageChunk("slash prompt handled")], acpPromptResponse({ inputTokens: 1 }));
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("/thiswontsend");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).not.toContain("Press Enter");
      });

      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["/thiswontsend"]);
        expect(app.captureCharFrame()).toContain("slash prompt handled");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("skips slash-only commands in prompt history navigation", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("ordinary history prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.prompts).toEqual(["ordinary history prompt"]);
        expect(frame).toContain("ordinary history prompt");
        expect(frame).not.toContain("Working");
      });

      await app.mockInput.typeText("/copy");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("No assistant response to copy");
      });

      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("ordinary history prompt");
        expect(frame).not.toContain("/copy");
        expect(frame).not.toContain("Copy last assistant response");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("escape restores draft while browsing prompt history", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("remembered prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("remembered prompt");
      });

      await app.mockInput.typeText("draft before history");
      app.mockInput.pressArrow("up");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("remembered prompt");
        expect(frame).not.toContain("draft before history");
      });

      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("draft before history");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("shows and accepts file completion overlay without moving cursor to start", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    fs.writeFileSync(path.join(cwd, "README.md"), "hello");
    fs.mkdirSync(path.join(cwd, "src"));

    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("read @READ");

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("read @READ");
        expect(frame).toContain("README.md");
      });

      app.mockInput.pressEnter();
      await app.mockInput.typeText("after");

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("read @README.md after");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps file completion overlay open with zero matches", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    fs.writeFileSync(path.join(cwd, "README.md"), "hello");

    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("read @READ");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("README.md");
      });

      await app.mockInput.typeText("zz");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("read @READzz");
        expect(frame).toContain("(0/0)");
        expect(frame).not.toContain("context • tokens");
        expect(frame).not.toContain("(faux)");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps file completion overlay mounted while refining matches", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    fs.writeFileSync(path.join(cwd, "README.md"), "hello");

    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("read @R");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("README.md");
      });

      await app.mockInput.typeText("E");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("read @RE");
        expect(frame).toContain("README.md");
        expect(frame).not.toContain("context • tokens");
      });

      await app.mockInput.typeText("z");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("read @REz");
        expect(frame).not.toContain("context • tokens");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("renders submitted user messages with vertical panel padding", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    faux.script([acpAgentMessageChunk("panel response")], acpPromptResponse({ inputTokens: 1, outputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("padded user prompt");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("padded user prompt");
        expect(frame).toContain("panel response");
      });

      expectSpanPanelFilled(app, "padded user prompt");
      expectPanelVerticalPaddingAroundText(app, "padded user prompt");
    } finally {
      app.renderer.destroy();
    }
  });

  test("continues auto-scrolling after wheel-down at the bottom", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ tokensPerSecond: 100000, chunkSize: { max: 2000 } });
    faux.script(
      [acpAgentMessageChunk(longLineResponse("FIRST"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );
    faux.script(
      [acpAgentMessageChunk(longLineResponse("SECOND"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );

    const app = await renderFauxApp(cwd, faux, { width: 80, height: 20 });

    try {
      await waitForConnected(app);
      await submitPrompt(app, "first long response");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("FIRST-49");
      });

      await scrollMouse(app, 20, 5, "down", 1);

      await submitPrompt(app, "second long response");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("SECOND-49");
        expect(frame).not.toContain("FIRST-49");
      }, 5000);
    } finally {
      app.renderer.destroy();
    }
  });

  test("preserves manual scrollback and does not reengage on partial downward scroll", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ tokensPerSecond: 100000, chunkSize: { max: 2000 } });
    faux.script(
      [acpAgentMessageChunk(longLineResponse("FIRST"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );
    faux.script(
      [acpAgentMessageChunk(longLineResponse("SECOND"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );
    faux.script(
      [acpAgentMessageChunk(longLineResponse("THIRD"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );

    const app = await renderFauxApp(cwd, faux, { width: 80, height: 20 });

    try {
      await waitForConnected(app);
      await submitPrompt(app, "first long response");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("FIRST-49");
      });

      await scrollMouse(app, 20, 5, "up", 8);
      expect(app.captureCharFrame()).not.toContain("FIRST-49");

      await submitPrompt(app, "second long response");
      await waitForPromptCountWithoutWorking(app, faux, 2);
      await waitForManualScrollbackFrame(app, "FIRST-", "SECOND-49");

      await scrollMouse(app, 20, 5, "down", 4);
      expect(app.captureCharFrame()).not.toContain("SECOND-49");

      await submitPrompt(app, "third long response");
      await waitForPromptCountWithoutWorking(app, faux, 3);
      const stillManualFrame = app.captureCharFrame();
      expect(stillManualFrame).not.toContain("THIRD-49");
    } finally {
      app.renderer.destroy();
    }
  }, 10000);

  test("reengages manual scrollback after returning to the bottom over the chat viewport", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ tokensPerSecond: 100000, chunkSize: { max: 2000 } });
    faux.script(
      [acpAgentMessageChunk(longLineResponse("FIRST"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );
    faux.script(
      [acpAgentMessageChunk(longLineResponse("SECOND"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );
    faux.script(
      [acpAgentMessageChunk(longLineResponse("THIRD"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );

    const app = await renderFauxApp(cwd, faux, { width: 80, height: 20 });

    try {
      await waitForConnected(app);
      await submitPrompt(app, "first long response");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("FIRST-49");
      });

      await scrollMouse(app, 20, 5, "up", 8);
      expect(app.captureCharFrame()).not.toContain("FIRST-49");

      await submitPrompt(app, "second long response");
      await waitForPromptCountWithoutWorking(app, faux, 2);
      await waitForManualScrollbackFrame(app, "FIRST-", "SECOND-49");

      await scrollMouse(app, 20, 5, "down", 120);
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("SECOND-49");
      }, 5000);

      await submitPrompt(app, "third long response");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("THIRD-49");
        expect(frame).not.toContain("SECOND-49");
      }, 5000);
    } finally {
      app.renderer.destroy();
    }
  }, 10000);

  test("reengages manual scrollback after returning to the bottom over prompt and footer rows", async () => {
    for (const target of [
      { name: "prompt", y: 16 },
      { name: "footer", y: 18 },
    ]) {
      configureFauxAgent();
      const cwd = tmpWorkspace();
      const faux = createFauxAcpAgent({ tokensPerSecond: 100000, chunkSize: { max: 2000 } });
      faux.script(
        [acpAgentMessageChunk(longLineResponse(`FIRST-${target.name}`))],
        acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
      );
      faux.script(
        [acpAgentMessageChunk(longLineResponse(`SECOND-${target.name}`))],
        acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
      );
      faux.script(
        [acpAgentMessageChunk(longLineResponse(`THIRD-${target.name}`))],
        acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
      );

      const app = await renderFauxApp(cwd, faux, { width: 80, height: 20 });

      try {
        await waitForConnected(app);
        await submitPrompt(app, `first long response ${target.name}`);
        await waitFor(() => {
          app.renderOnce();
          expect(app.captureCharFrame()).toContain(`FIRST-${target.name}-49`);
        });

        await scrollMouse(app, 20, 5, "up", 8);
        expect(app.captureCharFrame()).not.toContain(`FIRST-${target.name}-49`);

        await submitPrompt(app, `second long response ${target.name}`);
        await waitForPromptCountWithoutWorking(app, faux, 2);
        await waitForManualScrollbackFrame(app, `FIRST-${target.name}-`, `SECOND-${target.name}-49`);

        await scrollMouse(app, 20, target.y, "down", 120);
        await waitFor(() => {
          app.renderOnce();
          expect(app.captureCharFrame()).toContain(`SECOND-${target.name}-49`);
        }, 5000);

        await submitPrompt(app, `third long response ${target.name}`);
        await waitFor(() => {
          app.renderOnce();
          const frame = app.captureCharFrame();
          expect(frame).toContain(`THIRD-${target.name}-49`);
          expect(frame).not.toContain(`SECOND-${target.name}-49`);
        }, 5000);
      } finally {
        app.renderer.destroy();
      }
    }
  }, 20000);

  test("resumes tail-following for streaming output after prompt-row reengagement", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ tokensPerSecond: 600, chunkSize: { max: 60 } });
    faux.script(
      [acpAgentMessageChunk(longLineResponse("FIRST"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );
    faux.script(
      [acpAgentMessageChunk(longLineResponse("STREAM", 160))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );

    const app = await renderFauxApp(cwd, faux, { width: 80, height: 20 });

    try {
      await waitForConnected(app);
      await submitPrompt(app, "first long response");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("FIRST-49");
      }, 5000);

      await submitPrompt(app, "streaming response");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("STREAM-05");
      }, 5000);
      expect(app.captureCharFrame()).not.toContain("STREAM-159");

      await scrollMouse(app, 20, 5, "up", 8);
      expect(app.captureCharFrame()).not.toContain("STREAM-159");

      await scrollMouse(app, 20, 16, "down", 400);
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("STREAM-159");
      }, 10000);
    } finally {
      app.renderer.destroy();
    }
  }, 15000);

  test("does not reengage chat scrolling from sidebar wheel gestures", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ tokensPerSecond: 100000, chunkSize: { max: 2000 } });
    faux.script(
      [acpAgentMessageChunk(longLineResponse("FIRST"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );
    faux.script(
      [acpAgentMessageChunk(longLineResponse("SECOND"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );
    faux.script(
      [acpAgentMessageChunk(longLineResponse("THIRD"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );

    const app = await renderFauxApp(cwd, faux, { width: 100, height: 20 });

    try {
      await waitForConnected(app);
      await submitPrompt(app, "first long response");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("FIRST-49");
      });

      await scrollMouse(app, 40, 5, "up", 8);
      expect(app.captureCharFrame()).not.toContain("FIRST-49");

      await submitPrompt(app, "second long response");
      await waitForPromptCountWithoutWorking(app, faux, 2);
      await waitForManualScrollbackFrame(app, "FIRST-", "SECOND-49");

      emitKey(app, "b", { ctrl: true, sequence: "\u0002", raw: "\u0002" });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Threads");
      });

      await scrollMouse(app, 5, 5, "down", 120);
      emitKey(app, "b", { ctrl: true, sequence: "\u0002", raw: "\u0002" });
      await app.renderOnce();

      await submitPrompt(app, "third long response");
      await waitForPromptCountWithoutWorking(app, faux, 3);
      expect(app.captureCharFrame()).not.toContain("THIRD-49");
    } finally {
      app.renderer.destroy();
    }
  }, 10000);

  test("does not reengage chat scrolling while the prompt textarea can consume wheel gestures", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ tokensPerSecond: 100000, chunkSize: { max: 2000 } });
    faux.script(
      [acpAgentMessageChunk(longLineResponse("FIRST"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );
    faux.script(
      [acpAgentMessageChunk(longLineResponse("SECOND"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );

    const app = await renderFauxApp(cwd, faux, { width: 80, height: 20 });

    try {
      await waitForConnected(app);
      await submitPrompt(app, "first long response");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("FIRST-49");
      });

      await scrollMouse(app, 20, 5, "up", 8);
      expect(app.captureCharFrame()).not.toContain("FIRST-49");

      await submitPrompt(app, "second long response");
      await waitForPromptCountWithoutWorking(app, faux, 2);
      await waitForManualScrollbackFrame(app, "FIRST-", "SECOND-49");

      await app.mockInput.typeText(Array.from({ length: 30 }, (_, index) => `draft line ${index}`).join("\n"));
      emitKey(app, "home", { sequence: "", raw: "" });
      const visibleChatMarker = await waitForVisibleChatMarker(app);

      await scrollMouse(app, 20, 16, "down", 20);
      const promptOwnedFrame = app.captureCharFrame();
      expect(promptOwnedFrame).toContain(visibleChatMarker);
      expect(promptOwnedFrame).not.toContain("SECOND-49");
      expect(promptOwnedFrame).not.toContain("draft line 00");
      expect(promptOwnedFrame).toContain("draft line 20");
    } finally {
      app.renderer.destroy();
    }
  }, 10000);

  test("falls through from prompt wheel gestures after the prompt reaches its scroll boundary", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ tokensPerSecond: 100000, chunkSize: { max: 2000 } });
    faux.script(
      [acpAgentMessageChunk(longLineResponse("FIRST"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );
    faux.script(
      [acpAgentMessageChunk(longLineResponse("SECOND"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );
    faux.script(
      [acpAgentMessageChunk(longLineResponse("THIRD"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );

    const app = await renderFauxApp(cwd, faux, { width: 80, height: 20 });

    try {
      await waitForConnected(app);
      await submitPrompt(app, "first long response");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("FIRST-49");
      });

      await scrollMouse(app, 20, 5, "up", 8);
      expect(app.captureCharFrame()).not.toContain("FIRST-49");

      await submitPrompt(app, "second long response");
      await waitForPromptCountWithoutWorking(app, faux, 2);
      await waitForManualScrollbackFrame(app, "FIRST-", "SECOND-49");

      await app.mockInput.typeText(Array.from({ length: 30 }, (_, index) => `draft line ${index}`).join("\n"));
      emitKey(app, "home", { sequence: "", raw: "" });
      const visibleChatMarker = await waitForVisibleChatMarker(app);

      await scrollMouse(app, 20, 16, "down", 20);
      const promptOwnedFrame = app.captureCharFrame();
      expect(promptOwnedFrame).toContain(visibleChatMarker);
      expect(promptOwnedFrame).not.toContain("SECOND-49");
      expect(promptOwnedFrame).not.toContain("draft line 00");
      expect(promptOwnedFrame).toContain("draft line 20");

      await scrollMouse(app, 20, 16, "down", 120);
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("SECOND-49");
      }, 5000);

      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("THIRD-49");
        expect(frame).not.toContain("SECOND-49");
      }, 5000);
    } finally {
      app.renderer.destroy();
    }
  }, 10000);

  test("does not reengage chat scrolling while a modal owns wheel gestures", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ tokensPerSecond: 100000, chunkSize: { max: 2000 } });
    faux.script(
      [acpAgentMessageChunk(longLineResponse("FIRST"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );
    faux.script(
      [acpAgentMessageChunk(longLineResponse("SECOND"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );
    faux.script(
      [acpAgentMessageChunk(longLineResponse("THIRD"))],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );

    const app = await renderFauxApp(cwd, faux, { width: 80, height: 20 });

    try {
      await waitForConnected(app);
      await submitPrompt(app, "first long response");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("FIRST-49");
      });

      await scrollMouse(app, 20, 5, "up", 8);
      expect(app.captureCharFrame()).not.toContain("FIRST-49");

      await submitPrompt(app, "second long response");
      await waitForPromptCountWithoutWorking(app, faux, 2);
      await waitForManualScrollbackFrame(app, "FIRST-", "SECOND-49");

      emitKey(app, "?", { sequence: "?", raw: "?", shift: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Keyboard shortcuts");
      });
      await scrollMouse(app, 20, 16, "down", 120);
      emitKey(app, "escape", { sequence: "\u001b", raw: "\u001b" });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).not.toContain("Keyboard shortcuts");
      });

      await submitPrompt(app, "third long response");
      await waitForPromptCountWithoutWorking(app, faux, 3);
      expect(app.captureCharFrame()).not.toContain("THIRD-49");
    } finally {
      app.renderer.destroy();
    }
  }, 10000);
});
