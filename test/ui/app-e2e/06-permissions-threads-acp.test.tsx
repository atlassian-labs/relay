import { describe, expect, test } from "bun:test";
import type { LiveSessionInfo, LiveSessionInspection } from "../../../src/core/live-sessions";
import { isPromptSubmission } from "../../../src/core/prompt-submission";
import { loadThreadsForWorkspace } from "../../../src/core/threads";
import { store } from "../../../src/ui/app/runtime-store";
import {
  discoverLiveSessionInstances,
  sendLiveSessionControlRequest,
  type LiveSessionInstanceManifest,
} from "../../../src/platform/live-session-control";
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

const STANDARD_PERMISSION_OPTIONS = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
] as const;

describe("App frame-capture E2E: permissions, threads, and ACP rendering", () => {
  test("approves and rejects ACP permission requests from the rendered UI", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      const approval = faux.requestPermission({
        toolCallId: "approval-allow",
        toolName: "Write",
        preview: "Write README.md\n+allowed change",
        options: STANDARD_PERMISSION_OPTIONS,
      });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Permission Required");
        expect(frame).toContain("Write");
        expect(frame).toContain("allowed change");
        expect(frame).toContain("Allow once");
      });
      app.mockInput.pressEnter();
      expect(await approval).toEqual(STANDARD_PERMISSION_OPTIONS[0]);

      const denial = faux.requestPermission({
        toolCallId: "approval-deny",
        toolName: "Bash",
        preview: "rm -rf ./dist",
        options: STANDARD_PERMISSION_OPTIONS,
      });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Permission Required");
        expect(frame).toContain("Bash");
        expect(frame).toContain("Reject once");
      });
      app.mockInput.pressArrow("right");
      app.mockInput.pressEnter();
      expect(await denial).toEqual(STANDARD_PERMISSION_OPTIONS[1]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("returns advertised ACP permission options from rendered UI", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      const options = [
        { optionId: "custom-allow", name: "Always allow", kind: "allow_always" },
        { optionId: "custom-reject", name: "Never allow", kind: "reject_always" },
      ] as const;
      const approval = faux.requestPermission({
        toolCallId: "approval-custom",
        toolName: "Write",
        preview: "Write README.md",
        options,
      });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("› Always allow");
        expect(frame).toContain("Never allow");
        expect(frame).not.toContain("○");
        expect(frame).not.toContain("●");
      });
      app.mockInput.pressArrow("right");
      app.mockInput.pressEnter();
      expect(await approval).toEqual(options[1]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("does not render fallback permission options when none are advertised", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      const approval = faux.requestPermission({
        toolCallId: "approval-empty-options",
        toolName: "Write",
        preview: "Write README.md",
        options: [],
      });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("No permission options available");
        expect(frame).not.toContain("Allow once");
        expect(frame).not.toContain("Reject once");
      });
      app.mockInput.pressEnter();
      expect(await approval).toBe(ApprovalResponse.DENY);
    } finally {
      app.renderer.destroy();
    }
  });

  test("updates managed terminal title for pending permission while a turn is running", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const workspace = path.basename(cwd);
    const titles = new CaptureTitleOutput();
    const faux = createFauxAcpAgent({ hangPrompts: true });
    const app = await renderFauxApp(cwd, faux, { terminalTitleOutput: titles });

    try {
      await waitFor(() => {
        expect(titles.titles()).toContain(workspace);
      });
      await waitForConnected(app);

      const promptTitle = `long running prompt · ${workspace}`;
      await submitPrompt(app, "long running prompt");
      await waitFor(() => {
        app.renderOnce();
        expect(titles.lastTitle()).toMatch(spinnerTitlePattern(promptTitle));
      });

      const approval = faux.requestPermission({
        toolCallId: "approval-title",
        toolName: "Write",
        preview: "Write README.md",
        options: STANDARD_PERMISSION_OPTIONS,
      });
      await waitFor(() => {
        app.renderOnce();
        expect(titles.lastTitle()).toBe(`Needs input · ${promptTitle}`);
      });

      app.mockInput.pressEnter();
      expect(await approval).toEqual(STANDARD_PERMISSION_OPTIONS[0]);
      await waitFor(() => {
        app.renderOnce();
        expect(titles.lastTitle()).toMatch(spinnerTitlePattern(promptTitle));
      });
    } finally {
      app.renderer.destroy();
    }

    expect(titles.lastTitle()).toBe("");
  });

  test("keeps managed terminal title busy for late ACP activity after early prompt completion", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const workspace = path.basename(cwd);
    const titles = new CaptureTitleOutput();
    const faux = createFauxAcpAgent({ promptDelayMs: 750 });
    const app = await renderFauxApp(cwd, faux, { terminalTitleOutput: titles });

    try {
      await waitForConnected(app);
      const promptTitle = `prompt with late post-approval activity · ${workspace}`;
      await submitPrompt(app, "prompt with late post-approval activity");
      await waitFor(() => {
        app.renderOnce();
        expect(faux.inFlightPrompts).toBe(1);
      });

      const approval = faux.requestPermission({
        toolCallId: "approval-before-late-activity",
        toolName: "Write",
        preview: "Write README.md",
        options: STANDARD_PERMISSION_OPTIONS,
      });
      await waitFor(() => {
        app.renderOnce();
        expect(titles.lastTitle()).toBe(`Needs input · ${promptTitle}`);
      });
      const titlesAfterActionRequired = titles.titles().length;

      const lateActivity = new Promise<void>((resolve) => {
        setTimeout(() => {
          faux.emit(acpAgentMessageChunk("late activity after early prompt completion"));
          resolve();
        }, 700);
      });

      app.mockInput.pressEnter();
      expect(await approval).toEqual(STANDARD_PERMISSION_OPTIONS[0]);
      await waitFor(() => {
        app.renderOnce();
        expect(faux.inFlightPrompts).toBe(0);
      }, 1500);
      app.renderOnce();
      expect(titles.lastTitle()).toMatch(spinnerTitlePattern(promptTitle));
      expect(titles.titles().slice(titlesAfterActionRequired)).not.toContain(promptTitle);

      await lateActivity;
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("late activity after early prompt completion");
        expect(titles.lastTitle()).toMatch(spinnerTitlePattern(promptTitle));
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("updates managed terminal title for pending elicitation while idle", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const workspace = path.basename(cwd);
    const titles = new CaptureTitleOutput();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux, { terminalTitleOutput: titles });

    try {
      await waitForConnected(app);
      const pending = faux.requestElicitation({
        mode: "form",
        message: "Choose deployment path",
        requestedSchema: {
          type: "object",
          properties: {
            environment: {
              type: "string",
              title: "Environment",
              oneOf: [
                { const: "staging", title: "Staging" },
                { const: "production", title: "Production" },
              ],
            },
          },
          required: ["environment"],
        },
      });

      await waitFor(() => {
        app.renderOnce();
        expect(titles.lastTitle()).toBe(`Needs input · ${workspace}`);
      });
      app.mockInput.pressEscape();
      await pending;
      await waitFor(() => {
        app.renderOnce();
        expect(titles.lastTitle()).toBe(workspace);
      });
    } finally {
      app.renderer.destroy();
    }

    expect(titles.lastTitle()).toBe("");
  });

  test("renders ask_user_questions tool calls with the actual question text", async () => {
    configureFauxAltaAgent();
    const cwd = tmpWorkspace();
    const rawInput = {
      questions: [
        {
          header: "Environment",
          question: "Which target should receive this release?",
          options: [
            { label: "Staging", description: "Deploy to staging first" },
            { label: "Production", description: "Deploy straight to production" },
          ],
        },
      ],
    };
    const faux = createFauxAcpAgent();
    faux.script(
      [
        acpToolCallStart({ toolCallId: "ask-1", toolName: "ask_user_questions", rawInput, status: "running" }),
        acpToolCallUpdate({ toolCallId: "ask-1", status: "success" }),
        acpAgentMessageChunk("Question complete."),
      ],
      acpPromptResponse({ inputTokens: 1, outputTokens: 1 }),
    );

    const app = await renderFauxApp(cwd, faux, { initialDefaultRenderer: false });

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("deploy");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["deploy"]);
      });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Question complete.");
        expect(frame).toContain("Which target should receive this release?");
        expect(frame).not.toContain("Environment");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("renders compact single-question chrome from the schema title", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux, { width: 60, height: 20 });

    try {
      await waitForConnected(app);
      const pending = faux.requestElicitation({
        mode: "form",
        message: "The agent has some questions for you.",
        requestedSchema: {
          type: "object",
          title: "Questions for you",
          properties: {
            "What is the capital of France?": {
              type: "string",
              title: "What is the capital of France?",
              description: "Trivia #1 — options: Paris, Berlin",
              oneOf: [
                { const: "Paris", title: "Paris" },
                { const: "Berlin", title: "Berlin" },
              ],
            },
          },
          required: ["What is the capital of France?"],
        },
      });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("What is the capital of France?");
        expect(frame).not.toContain("Trivia #1");
        expect(frame).toContain("› ○ Paris");
        expect(frame).toContain("○ Berlin");
        expect(frame).not.toContain("□");
        expect(frame).not.toContain("Submit");
        expect(frame).toContain("↑/↓ navigate · enter review · esc cancel");
        expect(frame).not.toContain("←/→ questions");
      });

      app.mockInput.pressEscape();
      expect(await pending).toEqual({ action: "cancel" });
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps unsupported single-field elicitation navigation honest", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      const pending = faux.requestElicitation({
        mode: "form",
        message: "Enter a release note",
        requestedSchema: {
          type: "object",
          properties: {
            releaseNote: { type: "string", title: "Release note" },
          },
          required: ["releaseNote"],
        },
      });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Release note");
        expect(frame).toContain("Submit");
        expect(frame).toContain("Unsupported form field · ←/→ navigate · esc cancel");
      });

      app.mockInput.pressArrow("right");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Review answers");
        expect(frame).toContain("enter jumps to first missing");
        expect(frame).not.toContain("enter submit · esc cancel");
      });

      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Unsupported form field");
      });

      app.mockInput.pressEscape();
      expect(await pending).toEqual({ action: "cancel" });
    } finally {
      app.renderer.destroy();
    }
  });

  test("renders multi-question elicitation tabs and navigates questions horizontally", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      const pending = faux.requestElicitation({
        mode: "form",
        message: "Answer all quiz questions",
        requestedSchema: {
          type: "object",
          properties: {
            hemispheres: {
              type: "string",
              title: "Hemispheres",
              oneOf: [
                { const: "kiribati", title: "Kiribati" },
                { const: "brazil", title: "Brazil" },
              ],
            },
            hemispheres_other: { type: "string", title: "Other" },
            smallest: { type: "string", title: "Smallest", enum: ["Vatican City", "Monaco"] },
            smallest_other: { type: "string", title: "Other" },
            time_zones: { type: "string", title: "Time zones", enum: ["France", "Russia"] },
            time_zones_other: { type: "string", title: "Other" },
            enclave: { type: "string", title: "Enclave", enum: ["Lesotho", "Eswatini"] },
            language: { type: "string", title: "Language", enum: ["English", "Spanish"] },
            currency: { type: "string", title: "Currency", enum: ["Dollar", "Euro"] },
          },
          required: [
            "hemispheres",
            "hemispheres_other",
            "smallest",
            "smallest_other",
            "time_zones",
            "time_zones_other",
            "enclave",
            "language",
            "currency",
          ],
        },
      });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Hemispheres");
        expect(frame).toContain("Smallest");
        expect(frame).toContain("Time zones");
        expect(frame).toContain("Enclave");
        expect(frame).toContain("Language");
        expect(frame).toContain("Currency");
        expect(frame).toContain("Submit");
        expect(frame).not.toContain("Other");
        expect(frame).toContain("Question 1 of 6");
      });

      app.mockInput.pressArrow("right");
      app.mockInput.pressArrow("right");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Question 3 of 6");
        expect(frame).toContain("Time zones");
        expect(frame).toContain("France");
      });

      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("✓ Time zones");
        expect(frame).toContain("Question 4 of 6");
      });

      app.mockInput.pressArrow("left");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Question 3 of 6");
        expect(frame).toContain("● France");
      });

      app.mockInput.pressEscape();
      expect(await pending).toEqual({ action: "cancel" });
    } finally {
      app.renderer.destroy();
    }
  });

  test("shows submitted elicitation answers on the scoped question tool", async () => {
    setConfig(
      new Config({
        notifications: { sound_enabled: false },
        agents: {
          default: "faux",
          runners: {
            faux: { command: "faux-agent", args: [], profile: "claude" },
          },
        },
      }),
    );
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux, { initialDefaultRenderer: false });

    try {
      await waitForConnected(app);
      const questions = [
        {
          header: "Largest planet",
          question: "What is the largest planet in our solar system?",
          options: [{ label: "Jupiter" }, { label: "Saturn" }],
        },
        {
          header: "Kangaroo country",
          question: "Which country is home to the kangaroo?",
          options: [{ label: "Australia" }, { label: "New Zealand" }],
        },
      ];
      faux.emit(
        acpToolCallStart({
          toolCallId: "ask-quiz",
          toolName: "Asking for your input",
          rawInput: { questions },
          status: "running",
        }),
      );
      const accepted = faux.requestElicitation({
        mode: "form",
        message: "Please answer the following questions.",
        toolCallId: "ask-quiz",
        requestedSchema: {
          type: "object",
          properties: {
            question_0: {
              type: "string",
              title: "Largest planet",
              description: "What is the largest planet in our solar system?",
              oneOf: [
                { const: "Jupiter", title: "Jupiter" },
                { const: "Saturn", title: "Saturn" },
              ],
            },
            question_0_custom: { type: "string", title: "Other" },
            question_1: {
              type: "string",
              title: "Kangaroo country",
              description: "Which country is home to the kangaroo?",
              oneOf: [
                { const: "Australia", title: "Australia" },
                { const: "New Zealand", title: "New Zealand" },
              ],
            },
            question_1_custom: { type: "string", title: "Other" },
          },
        },
      });

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Largest planet");
      });
      app.mockInput.pressEnter();
      app.mockInput.pressEnter();
      app.mockInput.pressEnter();
      await accepted;

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("ask-user");
        expect(frame).toContain("2 answers");
        expect(frame).toContain("What is the largest planet in our solar system?");
        expect(frame).toContain("Answer: Jupiter");
        expect(frame).toContain("Which country is home to the kangaroo?");
        expect(frame).toContain("Answer: Australia");
        expect(frame).not.toContain("Other");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("submits multi-step elicitation choices and supports cancellation", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      const accepted = faux.requestElicitation({
        mode: "form",
        message: "Choose deployment path",
        requestedSchema: {
          type: "object",
          properties: {
            environment: {
              type: "string",
              title: "Environment",
              oneOf: [
                { const: "staging", title: "Staging" },
                { const: "production", title: "Production" },
              ],
            },
            environment_other: { type: "string", title: "Other" },
            risk: {
              type: "string",
              title: "Risk",
              enum: ["low", "high"],
            },
            risk_other: { type: "string", title: "Other" },
          },
          required: ["environment", "environment_other", "risk", "risk_other"],
        },
      });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Question 1 of 2");
        expect(frame).toContain("Environment");
        expect(frame).toContain("Production");
      });
      app.mockInput.pressArrow("down");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Question 2 of 2");
        expect(frame).toContain("Risk");
        expect(frame).toContain("high");
      });
      app.mockInput.pressArrow("down");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Review answers");
        expect(frame).toContain("Submit");
        expect(frame).toContain("Production");
        expect(frame).toContain("high");
      });
      app.mockInput.pressEnter();
      expect(await accepted).toEqual({ action: "accept", content: { environment: "production", risk: "high" } });

      const cancelled = faux.requestElicitation({
        mode: "form",
        message: "Cancel this question",
        requestedSchema: twoChoiceSchema("keep", "cancel"),
      });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Decision");
        expect(frame).toContain("cancel");
      });
      app.mockInput.pressEscape();
      expect(await cancelled).toEqual({ action: "cancel" });
    } finally {
      app.renderer.destroy();
    }
  });

  test("opens the thread sidebar and creates a local thread", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    faux.script([acpAgentMessageChunk("First thread response")], acpPromptResponse({ inputTokens: 1 }));
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("first thread prompt");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("First thread response");
      }, 1500);

      app.mockInput.pressKey("b", { ctrl: true });
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Threads");
        expect(frame).toContain("+ local");
        expect(frame).toContain("+ new worktree");
        expect(frame).toContain("first thread prompt");
      });

      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("New thread");
        expect(frame).toContain("first thread prompt");
        expect(faux.newSessions).toHaveLength(2);
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("passes sanitized selected parent history to child sessions", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    faux.script(
      [
        acpThinkingChunk("private first-turn reasoning"),
        acpAgentMessageChunk("I will inspect the first request."),
        acpToolCallStart({
          toolCallId: "history-tool",
          toolName: "Read private history fixture",
          rawInput: { path: "private-history.txt" },
          status: "running",
        }),
        acpToolCallUpdate({
          toolCallId: "history-tool",
          rawOutput: "private tool result",
          status: "success",
        }),
        acpAgentMessageChunk("First parent final answer"),
      ],
      acpPromptResponse(),
    );
    faux.script(
      [acpThinkingChunk("private second-turn reasoning"), acpAgentMessageChunk("Second parent final answer")],
      acpPromptResponse(),
    );
    const app = await renderFauxApp(cwd, faux);
    let manifest: LiveSessionInstanceManifest | undefined;
    let parent: LiveSessionInfo | undefined;

    try {
      await waitForConnected(app);
      await submitPrompt(app, "First parent request");
      await waitForPromptCountWithoutWorking(app, faux, 1);
      await submitPrompt(app, "Second parent request");
      await waitForPromptCountWithoutWorking(app, faux, 2);
      await waitFor(() => faux.inFlightPrompts === 0);

      await waitFor(async () => {
        for (const candidate of discoverLiveSessionInstances()) {
          const response = await sendLiveSessionControlRequest(candidate, "session.list");
          if (!response.ok) continue;
          const sessions = (response.result as { sessions?: LiveSessionInfo[] }).sessions ?? [];
          const matchingParent = sessions.find((session) => session.cwd === cwd && !session.parentSessionId);
          if (!matchingParent) continue;
          manifest = candidate;
          parent = matchingParent;
          return true;
        }
        return false;
      }, 5000);
      if (!manifest || !parent) throw new Error("Live parent session was not discoverable");

      const recent = await sendLiveSessionControlRequest(manifest, "session.createChild", {
        parentSessionId: parent.id,
        task: "Recent child task",
        name: "recent-raven",
        history: { mode: "recent", turns: 1 },
        relation: "child",
      });
      if (!recent.ok) throw new Error(recent.error.message);
      await waitFor(() => faux.prompts.some((prompt) => prompt.startsWith("Recent child task\n\n")));
      const recentPrompt = faux.prompts.find((prompt) => prompt.startsWith("Recent child task\n\n"));
      expect(recentPrompt).toContain('history="recent:1"');
      expect(recentPrompt).toContain(
        "Sanitized conversation history from the parent session. This context may be useful for completing the task above, but it may not be necessary. Use it when relevant.\n",
      );
      expect(recentPrompt).not.toContain("Relay");
      expect(recentPrompt).toContain("Second parent request");
      expect(recentPrompt).toContain("Second parent final answer");
      expect(recentPrompt).not.toContain("First parent request");
      expect(recentPrompt).not.toContain("First parent final answer");
      expect(recentPrompt).not.toContain("private first-turn reasoning");
      expect(recentPrompt).not.toContain("private second-turn reasoning");
      expect(recentPrompt).not.toContain("private tool result");
      expect(recentPrompt).not.toContain("I will inspect the first request.");

      const all = await sendLiveSessionControlRequest(manifest, "session.createChild", {
        parentSessionId: parent.id,
        task: "All child task",
        name: "all-willow",
        history: { mode: "all" },
        relation: "child",
      });
      if (!all.ok) throw new Error(all.error.message);
      await waitFor(() => faux.prompts.some((prompt) => prompt.startsWith("All child task\n\n")));
      const allPrompt = faux.prompts.find((prompt) => prompt.startsWith("All child task\n\n"));
      expect(allPrompt).toContain('history="all"');
      expect(allPrompt).toContain("First parent request");
      expect(allPrompt).toContain("First parent final answer");
      expect(allPrompt).toContain("Second parent request");
      expect(allPrompt).toContain("Second parent final answer");
      expect(allPrompt).not.toContain("private first-turn reasoning");
      expect(allPrompt).not.toContain("private second-turn reasoning");
      expect(allPrompt).not.toContain("private-history.txt");
      expect(allPrompt).not.toContain("private tool result");
      expect(allPrompt).not.toContain("I will inspect the first request.");

      const none = await sendLiveSessionControlRequest(manifest, "session.createChild", {
        parentSessionId: parent.id,
        task: "None child task",
        name: "none-otter",
        history: { mode: "none" },
        relation: "child",
      });
      if (!none.ok) throw new Error(none.error.message);
      await waitFor(() => faux.prompts.includes("None child task"));
      expect(faux.prompts).toContain("None child task");
    } finally {
      app.renderer.destroy();
    }
  }, 10_000);

  test("injects task reminders, spawns, inspects, and messages a named child", async () => {
    writeFauxConfig(`[notifications]
sound_enabled = false

[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"

[agents.runners.reviewer]
command = "review-agent"
args = []
profile = "default"

[task_types.review]
description = "Review isolated parser behavior and report findings to the parent"
keywords = ["inspect parser", "parser review"]
agent = "reviewer"
thinking_level = "high"
`);
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      promptDelayMs: 1_000,
      promptDelaySequenceMs: [0],
      activeTurnInput: true,
      capabilities: {
        currentModelId: "model-a",
        availableModels: [{ modelId: "model-a", name: "Model A" }],
        currentThinkingLevel: "high",
        availableThinkingLevels: [{ id: "high", name: "High" }],
      },
    });
    const app = await renderFauxApp(cwd, faux);
    let manifest: LiveSessionInstanceManifest | undefined;
    let parent: LiveSessionInfo | undefined;

    try {
      await waitForConnected(app);
      await waitFor(async () => {
        for (const candidate of discoverLiveSessionInstances()) {
          const response = await sendLiveSessionControlRequest(candidate, "session.list");
          if (!response.ok) continue;
          const sessions = (response.result as { sessions?: LiveSessionInfo[] }).sessions ?? [];
          const matchingParent = sessions.find((session) => session.cwd === cwd && !session.parentSessionId);
          if (!matchingParent) continue;
          manifest = candidate;
          parent = matchingParent;
          return true;
        }
        return false;
      }, 5000);
      if (!manifest || !parent) throw new Error("Live parent session was not discoverable");
      const parentSession = parent;
      expect(parentSession.role).toBe("parent");

      await app.mockInput.typeText("Please inspect parser behavior before delegating work");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("task reminders: review");
        const taskNameSpan = app
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .find((span) => span.text === "review");
        expect(taskNameSpan?.fg.toString()).toBe(parseColor(getColors().textLabel).toString());
      });
      app.mockInput.pressEnter();
      await waitFor(() => faux.promptInputs.length === 1 && faux.inFlightPrompts === 0);
      const matchingPromptInput = faux.promptInputs[0];
      expect(isPromptSubmission(matchingPromptInput)).toBe(true);
      if (!isPromptSubmission(matchingPromptInput)) throw new Error("Task keyword reminder was not injected");
      expect(matchingPromptInput.text).toBe("Please inspect parser behavior before delegating work");
      expect(matchingPromptInput.systemReminders).toHaveLength(1);
      const collaborationReminder = matchingPromptInput.systemReminders?.[0] ?? "";
      expect(collaborationReminder).toContain('<child_session_collaboration version="5">');
      expect(collaborationReminder).toContain(`{"current":"${parentSession.name}","parent":null,"role":"parent"}`);
      expect(collaborationReminder).toContain('"name":"review"');
      expect(collaborationReminder).toContain('"agent":"reviewer"');
      expect(collaborationReminder).toContain('"matchedKeywords":["inspect parser"]');
      expect(collaborationReminder).toContain('"thinkingLevel":"high"');
      expect(collaborationReminder).toContain("never as a progress loop");
      expect(collaborationReminder).toContain("complete child response exactly once in the next continuation turn");
      expect(collaborationReminder).toContain("Never use agent-specific tools such as `invoke_agent`, `spawn_agent`");
      expect(collaborationReminder).toContain("Omit `--history` by default");
      expect(collaborationReminder).toContain("Do not redo a delegated task yourself");
      expect(collaborationReminder).toContain("relay wait <child-name>");
      expect(collaborationReminder).toContain("Default delivery uses the collaboration inbox");

      const created = await sendLiveSessionControlRequest(manifest, "session.createChild", {
        parentSessionId: parentSession.id,
        task: "inspect parser behavior",
        name: "review-otter",
        relation: "child",
      });
      if (!created.ok) throw new Error(created.error.message);
      const child = (created.result as { session: LiveSessionInfo }).session;
      expect(child.name).toBe("review-otter");
      expect(child.role).toBe("child");
      expect(child.parentSessionId).toBe(parentSession.id);
      expect(child.agent).toBe("faux");
      expect(child.model).toBe("model-a");
      expect(child.thinkingLevel).toBe("high");
      const childInfoBlocks = (store.threadBlocks.get(child.threadId) ?? []).filter((block) => block.type === "info");
      expect(childInfoBlocks.map((block) => block.content)).toContain("Child session: review-otter");
      expect(childInfoBlocks.map((block) => block.content)).not.toContain("Child session: inspect parser behavior");
      expect(faux.modelChanges).toContain("model-a");
      expect(faux.thinkingLevelChanges.map((change) => change.thinkingLevel)).toContain("high");
      expect(faux.launchOptions.some((options) => options.env?.RELAY_SESSION_ROLE === "parent")).toBe(true);
      expect(
        faux.launchOptions.some(
          (options) =>
            options.env?.RELAY_SESSION_ROLE === "child" &&
            options.env.RELAY_PARENT_SESSION_ID === parentSession.id &&
            options.env.RELAY_PARENT_SESSION_NAME === parentSession.name,
        ),
      ).toBe(true);
      const steered = await sendLiveSessionControlRequest(manifest, "session.message", {
        targetSessionId: child.id,
        senderSessionId: parentSession.id,
        text: "count parser branches too",
        delivery: "steer",
      });
      expect(steered.ok).toBe(true);
      await waitFor(() => {
        expect(faux.prompts).toContain("inspect parser behavior");
        expect(faux.activeTurnInputs).toContain(`[parent: ${parentSession.name}]\n\ncount parser branches too`);
      });
      expect(faux.promptInputs).toContain("inspect parser behavior");

      const nested = await sendLiveSessionControlRequest(manifest, "session.createChild", {
        parentSessionId: child.id,
        requesterSessionId: child.id,
        requesterSessionName: child.name,
        task: "Create a nested child",
        name: "nested-raven",
      });
      expect(nested).toMatchObject({ ok: false, error: { code: "child_creation_forbidden" } });

      const sibling = await sendLiveSessionControlRequest(manifest, "session.createChild", {
        parentSessionId: parentSession.id,
        requesterSessionId: child.id,
        requesterSessionName: child.name,
        task: "Create a sibling through the parent",
        name: "sibling-raven",
      });
      expect(sibling).toMatchObject({ ok: false, error: { code: "child_creation_forbidden" } });

      const parentToChild = await sendLiveSessionControlRequest(manifest, "session.message", {
        targetSessionId: child.id,
        senderSessionId: parentSession.id,
        text: "check parser edge cases",
        delivery: "next",
      });
      expect(parentToChild.ok).toBe(true);
      const childToParent = await sendLiveSessionControlRequest(manifest, "session.message", {
        targetSessionId: parentSession.id,
        senderSessionId: child.id,
        text: "parser review complete",
        delivery: "next",
      });
      expect(childToParent.ok).toBe(true);
      await waitFor(() => {
        expect(faux.prompts).toContain(`[parent: ${parentSession.name}]\n\ncheck parser edge cases`);
        expect(faux.prompts).toContain("[child: review-otter]\n\nparser review complete");
      });

      const inspected = await sendLiveSessionControlRequest(manifest, "session.inspect", {
        targetSessionId: child.id,
        requesterSessionId: parentSession.id,
        history: { mode: "recent", turns: 2 },
      });
      if (!inspected.ok) throw new Error(inspected.error.message);
      const inspection = inspected.result as LiveSessionInspection;
      expect(inspection.session.name).toBe("review-otter");
      expect(inspection.history).toBe("recent:2");
      expect(inspection.turns.map((turn) => turn.user)).toEqual([
        "inspect parser behavior",
        `[parent: ${parentSession.name}]\n\ncheck parser edge cases`,
      ]);
      expect(inspection.turns[0]?.updates).toEqual([`[parent: ${parentSession.name}]\n\ncount parser branches too`]);

      const forbiddenInspection = await sendLiveSessionControlRequest(manifest, "session.inspect", {
        targetSessionId: parentSession.id,
        requesterSessionId: child.id,
        history: { mode: "recent", turns: 1 },
      });
      expect(forbiddenInspection).toMatchObject({ ok: false, error: { code: "inspection_forbidden" } });

      const alternateAgentChild = await sendLiveSessionControlRequest(manifest, "session.createChild", {
        parentSessionId: parentSession.id,
        task: "perform an independent check",
        name: "audit-raven",
        agent: "reviewer",
        relation: "child",
      });
      if (!alternateAgentChild.ok) throw new Error(alternateAgentChild.error.message);
      const alternateSession = (alternateAgentChild.result as { session: LiveSessionInfo }).session;
      expect(alternateSession.agent).toBe("reviewer");
      expect(alternateSession.model).toBeUndefined();
      expect(alternateSession.thinkingLevel).toBeUndefined();
      expect(faux.launchOptions).toContainEqual(
        expect.objectContaining({ agentName: "reviewer", command: "review-agent" }),
      );

      const duplicate = await sendLiveSessionControlRequest(manifest, "session.createChild", {
        parentSessionId: parentSession.id,
        task: "duplicate child",
        name: "review-otter",
        relation: "child",
      });
      expect(duplicate.ok).toBe(false);
      if (duplicate.ok) throw new Error("Duplicate child session name was accepted");
      expect(duplicate.error.message).toContain("already in use");

      await submitPrompt(app, "/children");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("review-otter");
      });
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("ctrl+p back to parent");
        expect(frame).toContain(`[turn update] [parent: ${parentSession.name}]`);
        expect(frame).toContain("count parser branches too");
        expect(frame).toContain(`[parent: ${parentSession.name}]`);
        expect(frame).toContain("check parser edge cases");
        const hintSpan = app
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .find((span) => span.text === "ctrl+p");
        expect(hintSpan?.fg.toString()).toBe(parseColor(getColors().textLabel).toString());
      });
      await app.mockInput.typeText("inspect parser");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).not.toContain("task reminders: review");
      });

      emitKey(app, "p", { ctrl: true, sequence: "\u0010", raw: "\u0010" });
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("review-otter");
        expect(frame).toContain("[child: review-otter]");
        expect(frame).toContain("parser review complete");
        expect(frame).not.toContain("ctrl+p back to parent");
      });
    } finally {
      app.renderer.destroy();
    }
  }, 10_000);

  test("preserves queued prompts when switching between threads", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 5000 });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("slow thread one prompt");
      app.mockInput.pressEnter();
      await waitFor(() => expect(faux.prompts).toContain("slow thread one prompt"));

      await app.mockInput.typeText("queued only for thread one");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (1/10)");
        expect(frame).toContain("queued only for thread one");
      });

      app.mockInput.pressKey("b", { ctrl: true });
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("New thread");
        expect(frame).not.toContain("Queue (1/10)");
      });

      app.mockInput.pressKey("b", { ctrl: true });
      app.mockInput.pressArrow("down");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (1/10)");
        expect(frame).toContain("queued only for thread one");
      });
    } finally {
      await faux.client.cancel().catch(() => undefined);
      app.renderer.destroy();
    }
  });

  test("queues plugin prompts on their targeted running background thread", async () => {
    const cwd = tmpWorkspace();
    const pluginPath = path.join(cwd, "target-thread-queue-plugin.mjs");
    fs.writeFileSync(
      pluginPath,
      `
export default function plugin(relay) {
  relay.commands.register("queue-background-thread", {
    description: "Queue a prompt on the running background thread",
    async run(_args, ctx) {
      const current = relay.thread.current();
      const target = relay.thread.list().find((thread) => thread.id !== current?.id && thread.status === "running");
      if (!target) {
        ctx.toast("no running background thread", "error");
        return;
      }
      await relay.agent.prompt("plugin prompt targeted to background thread", { targetThreadId: target.id });
      ctx.toast("queued for background thread");
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
      await submitPrompt(app, "running prompt on original thread");
      await waitFor(() => expect(faux.prompts).toEqual(["running prompt on original thread"]));

      app.mockInput.pressKey("b", { ctrl: true });
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("New thread");
      });

      await submitPrompt(app, "/queue-background-thread");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("queued for background thread");
        expect(frame).not.toContain("Queue (1/10)");
      });

      app.mockInput.pressKey("b", { ctrl: true });
      app.mockInput.pressArrow("down");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (1/10)");
        expect(frame).toContain("plugin prompt targeted to background thread");
        expect(faux.prompts).toEqual(["running prompt on original thread"]);
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("resumes a queue paused by editing when returning to the thread", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 600 });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await submitPrompt(app, "thread one completes while queue edit is open");
      await waitFor(() => expect(faux.prompts).toEqual(["thread one completes while queue edit is open"]));

      await submitPrompt(app, "committed queue text survives thread switch");
      await app.mockInput.typeText("composer draft survives queue edit and thread switch");
      app.mockInput.pressArrow("up", { meta: true });
      app.mockInput.pressEnter();
      await app.mockInput.typeText(" unfinished edit");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("enter save");
      });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("enter save");
        expect(frame).not.toContain("Working");
        expect(faux.prompts).toEqual(["thread one completes while queue edit is open"]);
      }, 3000);

      app.mockInput.pressKey("b", { ctrl: true });
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("New thread");
      });

      app.mockInput.pressKey("b", { ctrl: true });
      app.mockInput.pressArrow("down");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual([
          "thread one completes while queue edit is open",
          "committed queue text survives thread switch",
        ]);
        const frame = app.captureCharFrame();
        expect(frame).toContain("composer draft survives queue edit and thread switch");
        expect(frame).not.toContain("unfinished edit");
      }, 3000);
    } finally {
      app.renderer.destroy();
    }
  }, 10000);

  test("keeps a lazy startup-queued prompt bound to its original thread after switching", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      connectDelayMs: 100,
      newSessionDelayMs: 1000,
      capabilities: {
        currentModelId: "model-a",
        availableModels: [{ modelId: "model-a", name: "Model A" }],
      },
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain(" >");
      });

      await submitPrompt(app, "queued before lazy thread switch");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Queue (1/10)");
        expect(frame).toContain("Queued prompt #1 · queued before lazy thread switch");
        expect(faux.prompts).toEqual([]);
      });

      await waitForConnected(app);
      await app.mockInput.typeText("/new");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).not.toContain("Queue (1/10)");
      });

      await waitFor(() => {
        app.renderOnce();
        expect(faux.prompts).toEqual(["queued before lazy thread switch"]);
      }, 5000);

      const persistedThreads = loadThreadsForWorkspace(cwd);
      const activeThread = persistedThreads?.threads.find((thread) => thread.id === persistedThreads.activeThreadId);
      const inactiveThreads = persistedThreads?.threads.filter(
        (thread) => thread.id !== persistedThreads.activeThreadId,
      );
      expect(activeThread?.title).toBe("New thread");
      expect(inactiveThreads?.some((thread) => thread.title === "queued before lazy thread switch")).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  }, 10000);

  test("restores advertised reasoning effort when switching back to an existing thread", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      capabilities: {
        currentModelId: "model-a",
        availableModels: [{ modelId: "model-a", name: "Model A" }],
        currentThinkingLevel: "low",
        availableThinkingLevels: [
          { id: "low", name: "Low" },
          { id: "high", name: "High" },
        ],
      },
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("model-a • low");
      });

      app.mockInput.pressKey("b", { ctrl: true });
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("New thread");
      });

      await app.mockInput.typeText("/effort high");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("model-a • high");
      });

      app.mockInput.pressKey("g", { ctrl: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Agents");
      });
      app.mockInput.pressArrow("down");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("model-a • low");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps terminal title scoped to the active thread while another thread finishes", async () => {
    configureFauxAgent();
    const rootCwd = tmpWorkspace();
    const secondCwd = tmpWorkspace();
    const rootWorkspace = path.basename(rootCwd);
    const secondWorkspace = path.basename(secondCwd);
    const rootTitle = `Root workspace · ${rootWorkspace}`;
    const rootPromptTitle = `slow root thread prompt · ${rootWorkspace}`;
    const secondTitle = `Second workspace · ${secondWorkspace}`;
    const createdAt = "2025-01-01T00:00:00.000Z";
    saveThreadsForWorkspace(rootCwd, {
      activeThreadId: "thread-root",
      threads: [
        {
          id: "thread-root",
          title: "Root workspace",
          sessionId: null,
          cwd: rootCwd,
          workspaceKind: "local",
          status: "paused",
          archived: false,
          createdAt,
          updatedAt: "2025-01-02T00:00:00.000Z",
        },
        {
          id: "thread-second",
          title: "Second workspace",
          sessionId: null,
          cwd: secondCwd,
          workspaceKind: "worktree",
          worktreePath: secondCwd,
          status: "paused",
          archived: false,
          createdAt,
          updatedAt: "2025-01-01T12:00:00.000Z",
        },
      ],
    });
    const titles = new CaptureTitleOutput();
    const faux = createFauxAcpAgent({ promptDelayMs: 1200 });
    const app = await renderFauxApp(rootCwd, faux, { terminalTitleOutput: titles });

    try {
      await waitForConnected(app);
      await waitFor(() => {
        expect(titles.lastTitle()).toBe(rootTitle);
      });

      await app.mockInput.typeText("slow root thread prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        expect(faux.prompts).toContain("slow root thread prompt");
        expect(titles.lastTitle()).toMatch(spinnerTitlePattern(rootPromptTitle));
      });

      app.mockInput.pressKey("b", { ctrl: true });
      app.mockInput.pressArrow("down");
      app.mockInput.pressArrow("down");
      app.mockInput.pressArrow("down");
      app.mockInput.pressArrow("down");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(titles.lastTitle()).toBe(secondTitle);
      }, 3000);
      const titlesAfterSwitch = titles.titles().length;

      await new Promise((resolve) => setTimeout(resolve, 1400));
      app.renderOnce();
      expect(titles.lastTitle()).toBe(secondTitle);
      expect(titles.titles().slice(titlesAfterSwitch)).not.toContain(rootTitle);
      expect(titles.titles().slice(titlesAfterSwitch)).not.toContainEqual(
        expect.stringMatching(spinnerTitlePattern(rootPromptTitle)),
      );
    } finally {
      await faux.client.cancel().catch(() => undefined);
      app.renderer.destroy();
    }
  });

  test("printable typing from compact thread sidebar returns focus to the composer", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      app.mockInput.pressKey("b", { ctrl: true });
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Threads");
        expect(frame).toContain("+ local");
      });

      await app.mockInput.typeText("typed after sidebar focus");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("+ local");
        expect(frame).toContain("typed after sidebar focus");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("suppresses config reload toast while a turn is active", async () => {
    writeFauxConfig(`[notifications]
sound_enabled = false

[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
`);
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ promptDelayMs: 250 });
    faux.script([acpAgentMessageChunk("done after reload")], acpPromptResponse({ inputTokens: 1 }));

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("reload while running");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Working");
      });

      fs.writeFileSync(
        path.join(getConfigDir(), "config.toml"),
        `[notifications]
sound_enabled = true

[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
`,
        "utf-8",
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      app.renderOnce();
      expect(app.captureCharFrame()).not.toContain("Config reloaded");

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("done after reload");
      }, 2000);
    } finally {
      app.renderer.destroy();
    }
  });

  test("cancels a running ACP turn and recovers for the next prompt", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ tokensPerSecond: 100, chunkSize: { max: 100 } });
    faux.script([acpAgentMessageChunk("streaming response ".repeat(100))], acpPromptResponse({ inputTokens: 1 }));
    faux.script(
      [acpAgentMessageChunk("Recovered after cancel")],
      acpPromptResponse({ inputTokens: 2, outputTokens: 3 }),
    );

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("long running prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Working");
      });

      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Interrupted by user");
        expect(frame).not.toContain("※ Interrupted by user");
        expect(faux.cancellations).toBe(1);
      });

      await app.mockInput.typeText("recover prompt");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Recovered after cancel");
        expect(faux.prompts).toEqual(["long running prompt", "recover prompt"]);
      }, 2000);
    } finally {
      app.renderer.destroy();
    }
  });

  test("renders thinking, tool output, usage, and session stats in one ACP turn", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    faux.script(
      [
        acpThinkingChunk("Need to inspect the file"),
        acpAgentMessageChunk("I will read the file."),
        acpToolCallStart({
          toolCallId: "read-1",
          toolName: "Read",
          rawInput: { file_path: path.join(cwd, "README.md") },
        }),
        acpToolCallUpdate({ toolCallId: "read-1", status: "success", rawOutput: "README contents" }),
        acpUsageUpdate({
          inputTokens: 11_000,
          outputTokens: 7_000,
          cachedReadTokens: 3_000,
          cachedWriteTokens: 2_000,
          used: 11_000,
        }),
        acpAgentMessageChunk("Done reading."),
      ],
      acpPromptResponse({ inputTokens: 5_000, outputTokens: 6_000 }),
    );

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("inspect readme");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Need to inspect the file");
        expect(frame).toContain("I will read the file.");
        expect(frame).toContain("README contents");
        expect(frame).toContain("Done reading.");
        expect(frame).toContain("11k • ↑16k ↓13k R3k W2k");
      }, 2000);
    } finally {
      app.renderer.destroy();
    }
  });

  test("shows finalized thinking preview and full details after transcript selection", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    faux.script(
      [
        acpThinkingChunk("**Plan** first line\n- hidden detail\nfinal detail"),
        acpAgentMessageChunk("Visible response."),
      ],
      acpPromptResponse(),
    );

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("think");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Plan first line");
        expect(frame).toContain("... (2 more lines)");
        expect(frame).not.toContain("hidden detail");
        expect(frame).not.toContain("final detail");
        expect(frame).toContain("Visible response.");
        expect(frame).not.toContain("**Plan**");
      }, 2000);

      const previewFrame = app.captureCharFrame().split("\n");
      const previewLine = previewFrame.findIndex((line) => line.includes("Plan first line"));
      expect(previewLine).toBeGreaterThanOrEqual(0);
      await app.mockMouse.click(previewFrame[previewLine].indexOf("Plan first line"), previewLine);
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Plan first line");
        expect(frame).toContain("hidden detail");
        expect(frame).toContain("final detail");
        expect(frame).not.toContain("**Plan**");
      }, 2000);
    } finally {
      app.renderer.destroy();
    }
  });

  test("renders full thinking as markdown in transcript details", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    faux.script(
      [acpThinkingChunk("**Full markdown**\n- visible detail"), acpAgentMessageChunk("Visible response.")],
      acpPromptResponse(),
    );

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("think");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Full markdown");
        expect(frame).toContain("Visible response.");
      }, 2000);

      const previewFrame = app.captureCharFrame().split("\n");
      const previewLine = previewFrame.findIndex((line) => line.includes("Full markdown"));
      expect(previewLine).toBeGreaterThanOrEqual(0);
      await app.mockMouse.click(previewFrame[previewLine].indexOf("Full markdown"), previewLine);
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Full markdown");
        expect(frame).toContain("visible detail");
        expect(frame).not.toContain("Visible response.");
        expect(frame).not.toContain("**Full markdown**");
      }, 2000);
    } finally {
      app.renderer.destroy();
    }
  });

  test("submits prompt to faux ACP agent and renders streamed response", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    faux.script(
      [
        acpToolCallStart({
          toolCallId: "tc_1",
          toolName: "Read",
          rawInput: { file_path: path.join(cwd, "README.md") },
        }),
        acpToolCallUpdate({ toolCallId: "tc_1", status: "success", rawOutput: "README contents" }),
        acpAgentMessageChunk("Hello from faux ACP."),
      ],
      acpPromptResponse({ inputTokens: 1, outputTokens: 2 }),
    );

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);

      await app.mockInput.typeText("say hi");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("say hi");
        expect(frame).toContain("Hello from faux ACP.");
        expect(frame).toContain("README contents");
      }, 1500);

      expect(faux.prompts).toEqual(["say hi"]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("initialPrompt auto-submits after ACP connection without user input", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    faux.script(
      [acpAgentMessageChunk("Response to initial prompt.")],
      acpPromptResponse({ inputTokens: 5, outputTokens: 3 }),
    );

    const app = await renderFauxApp(cwd, faux, { initialPrompt: "hello from CLI" });

    try {
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Response to initial prompt.");
      }, 2000);

      expect(faux.prompts).toEqual(["hello from CLI"]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("typed ACP slash command renders only the compact ACP skill echo", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();

    const faux = createFauxAcpAgent({
      availableCommands: [{ name: "test-skill", description: "Agent-owned slash skill" }],
    });
    faux.script(
      [
        acpUserMessageChunk(filesystemSkillUserMessage("test-skill", "typed args\n  with context")),
        acpAgentMessageChunk("Skill executed."),
      ],
      acpPromptResponse({ inputTokens: 10, outputTokens: 5 }),
    );

    const app = await renderFauxApp(cwd, faux, { otherModifiersMode: true });

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/test-skill typed args");
      app.mockInput.pressEnter({ shift: true });
      await app.mockInput.typeText("  with context");
      app.mockInput.pressEnter({ shift: true });
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.prompts.length).toBe(1);
        expect(frame).toContain("[skill] test-skill");
        expect(frame).toContain("typed args");
        expect(frame).toContain("with context");
        expect(frame).toContain("Skill executed.");
        expect(frame).not.toContain("/test-skill typed args");
        expect(frame).not.toContain("Agent-owned skill body.");
      }, 2000);

      expect(faux.prompts[0]).toBe("/test-skill typed args\n  with context\n");
    } finally {
      app.renderer.destroy();
    }
  });

  test("agent slash command without ACP user echo updates compact title for latest skill", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const workspace = path.basename(cwd);
    const titles = new CaptureTitleOutput();

    const faux = createFauxAcpAgent({
      availableCommands: [{ name: "test-skill", description: "Agent-owned slash skill" }],
    });
    faux.script(
      [acpAgentMessageChunk("First skill executed without echo.")],
      acpPromptResponse({ inputTokens: 10, outputTokens: 5 }),
    );
    faux.script(
      [acpAgentMessageChunk("Second skill executed without echo.")],
      acpPromptResponse({ inputTokens: 10, outputTokens: 5 }),
    );

    const app = await renderFauxApp(cwd, faux, { terminalTitleOutput: titles });

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/test-skill first no echo args");
      app.mockInput.pressEnter();

      const firstTitle = `test-skill — first no echo args · ${workspace}`;
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.prompts).toEqual(["/test-skill first no echo args"]);
        expect(titles.titles()).toContain(firstTitle);
        expect(frame).toContain("[skill] test-skill");
        expect(frame).toContain("first no echo args");
        expect(frame).toContain("First skill executed without echo.");
        expect(frame).not.toContain("/test-skill first no echo args");
      }, 2000);

      const titleCountAfterFirst = titles.titles().length;
      await app.mockInput.typeText("/test-skill second no echo args");
      app.mockInput.pressEnter();

      const secondTitle = `test-skill — second no echo args · ${workspace}`;
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        const titlesAfterSecond = titles.titles().slice(titleCountAfterFirst);
        expect(faux.prompts).toEqual(["/test-skill first no echo args", "/test-skill second no echo args"]);
        expect(
          titlesAfterSecond.some((title) => title === secondTitle || spinnerTitlePattern(secondTitle).test(title)),
        ).toBe(true);
        expect(
          titlesAfterSecond.some((title) => title === firstTitle || spinnerTitlePattern(firstTitle).test(title)),
        ).toBe(false);
        expect(frame).toContain("[skill] test-skill");
        expect(frame).toContain("second no echo args");
        expect(frame).toContain("Second skill executed without echo.");
        expect(frame).not.toContain("/test-skill second no echo args");
      }, 2000);
    } finally {
      app.renderer.destroy();
    }
  });

  test("resumed session result slash commands route through ACP", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    saveThreadsForWorkspace(cwd, {
      activeThreadId: "thread-existing",
      threads: [
        {
          id: "thread-existing",
          title: "Existing thread",
          sessionId: "existing-session",
          cwd,
          workspaceKind: "local",
          status: "paused",
          archived: false,
        },
      ],
    });

    const faux = createFauxAcpAgent({
      loadEvents: [
        {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "test-skill", description: "Agent-owned slash skill" }],
        },
      ],
    });
    faux.script(
      [
        acpUserMessageChunk(filesystemSkillUserMessage("test-skill", "resumed args")),
        acpAgentMessageChunk("Resumed skill executed."),
      ],
      acpPromptResponse({ inputTokens: 10, outputTokens: 5 }),
    );

    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/test-skill resumed args");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.prompts).toEqual(["/test-skill resumed args"]);
        expect(frame).toContain("[skill] test-skill");
        expect(frame).toContain("resumed args");
        expect(frame).toContain("Resumed skill executed.");
        expect(frame).not.toContain("/test-skill resumed args");
        expect(frame).not.toContain("Unknown command");
      }, 2000);
    } finally {
      app.renderer.destroy();
    }
  });

  test("initialPrompt ACP slash command ignores local SKILL.md files", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const skillDir = path.join(cwd, ".agents", "skills", "test-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "invalid skill body without frontmatter\n");

    const faux = createFauxAcpAgent({
      availableCommands: [{ name: "test-skill", description: "Agent-owned slash skill" }],
    });
    faux.script(
      [
        acpUserMessageChunk(filesystemSkillUserMessage("test-skill", "run through agent")),
        acpAgentMessageChunk("Agent command executed."),
      ],
      acpPromptResponse({ inputTokens: 10, outputTokens: 5 }),
    );

    const app = await renderFauxApp(cwd, faux, { initialPrompt: "/test-skill run through agent" });

    try {
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.prompts.length).toBe(1);
        expect(frame).toContain("[skill] test-skill");
        expect(frame).toContain("run through agent");
        expect(frame).toContain("Agent command executed.");
        expect(frame).not.toContain("/test-skill run through agent");
        expect(frame).not.toContain("Failed to load skill");
        expect(frame).not.toContain("invalid skill body");
      }, 2000);

      expect(faux.prompts[0]).toBe("/test-skill run through agent");
    } finally {
      app.renderer.destroy();
    }
  });

  test("ACP raw skill echo renders compact while submitted prompt stays literal", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();

    const faux = createFauxAcpAgent({
      availableCommands: [{ name: "test-skill", description: "Agent-owned slash skill" }],
    });
    faux.script(
      [
        acpUserMessageChunk(filesystemSkillUserMessage("test-skill", "run through agent")),
        acpAgentMessageChunk("Skill executed."),
      ],
      acpPromptResponse({ inputTokens: 10, outputTokens: 5 }),
    );

    const app = await renderFauxApp(cwd, faux, { initialPrompt: "/test-skill run through agent" });

    try {
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(faux.prompts.length).toBe(1);
        expect(frame).toContain("[skill] test-skill");
        expect(frame).toContain("run through agent");
        expect(frame).toContain("Skill executed.");
        expect(frame).not.toContain("/test-skill run through agent");
        expect(frame).not.toContain("register_cmd");
        expect(frame).not.toContain("Agent-owned skill body.");
      }, 2000);

      expect(faux.prompts[0]).toBe("/test-skill run through agent");
      expect(faux.prompts[0]).not.toContain('<skill name="test-skill"');
    } finally {
      app.renderer.destroy();
    }
  });

  test("streaming ACP raw skill echo never renders expanded frontmatter", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      faux.emit(acpUserMessageChunk("---\nname: test-skill\n"));

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("[skill] test-skill");
        expect(frame).not.toContain("name: test-skill");
      }, 2000);

      faux.emit(
        acpUserMessageChunk(
          [
            "description: Agent-owned skill",
            "register_cmd: true",
            "---",
            "",
            "Agent-owned skill body.",
            "ARGUMENTS: streamed args",
          ].join("\n"),
        ),
      );

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("[skill] test-skill");
        expect(frame).toContain("streamed args");
        expect(frame).not.toContain("register_cmd");
        expect(frame).not.toContain("Agent-owned skill body.");
      }, 2000);
    } finally {
      app.renderer.destroy();
    }
  });
});
