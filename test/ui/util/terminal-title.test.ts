import { describe, expect, test } from "bun:test";
import type { ElicitationBlock, ToolBlock, UserBlock } from "../../../src/ui/state";
import { promptTitleIntentFromText } from "../../../src/ui/util/user-message";
import {
  NEEDS_INPUT_TERMINAL_TITLE_PREFIX,
  createTerminalTitleActivityTracker,
  createTerminalTitleManager,
  encodeOsc0Title,
  hasPendingTerminalTitleAction,
  MAX_TERMINAL_TITLE_CHARS,
  sanitizeTerminalTitle,
  shouldAnimateTerminalTitleSpinner,
  terminalTitleForState,
  workspaceTerminalTitleLabel,
} from "../../../src/ui/util/terminal-title";

class CaptureOutput {
  readonly chunks: string[] = [];

  constructor(readonly isTTY: boolean) {}

  write(chunk: string): void {
    this.chunks.push(chunk);
  }
}

function promptIntent(text: string, skill?: { name: string; userMessage?: string }) {
  return promptTitleIntentFromText(text, skill ?? null);
}

function pendingApprovalBlock(): ToolBlock {
  return {
    type: "tool",
    id: "tool-1",
    toolCallId: "call-1",
    toolName: "bash",
    display: "bash",
    status: "approval",
    resolveApproval: () => undefined,
  };
}

function pendingElicitationBlock(): ElicitationBlock {
  return {
    type: "elicitation",
    id: "elicitation-1",
    mode: "form",
    message: "Need input",
    status: "pending",
    fields: [],
    currentFieldIndex: 0,
    answers: {},
    respond: () => undefined,
  };
}

function userBlock(content: string, overrides: Partial<UserBlock> = {}): UserBlock {
  return {
    type: "user",
    id: "user-1",
    content,
    ...overrides,
  };
}

describe("terminal title utilities", () => {
  test("formats idle, running, connecting, and spinner-active titles", () => {
    expect(terminalTitleForState({ cwd: "/tmp/config" })).toBe("config");
    expect(terminalTitleForState({ cwd: "/tmp/config", running: true, spinnerFrame: "⠋" })).toBe("⠋ config");
    expect(terminalTitleForState({ cwd: "/tmp/config", connecting: true, spinnerFrame: "⠙" })).toBe("⠙ config");
    expect(terminalTitleForState({ cwd: "/tmp/config", spinnerActive: true, spinnerFrame: "⠹" })).toBe("⠹ config");
  });

  test("formats prompt intent before workspace context", () => {
    expect(
      terminalTitleForState({
        cwd: "/Users/kutsav/Workspaces/tui/relay",
        blocks: [{ type: "user", id: "user-1", content: "do we have any uncommited changes" }],
      }),
    ).toBe("do we have any uncommited changes · relay");
  });

  test("uses session title when no prompt intent is available", () => {
    expect(
      terminalTitleForState({
        cwd: "/Users/kutsav/Workspaces/tui/relay",
        sessionTitle: "Investigate release readiness",
      }),
    ).toBe("Investigate release readiness · relay");
  });

  test("uses latest prompt intent instead of stale session title", () => {
    expect(
      terminalTitleForState({
        cwd: "/Users/kutsav/Workspaces/tui/relay",
        sessionTitle: "Investigate release readiness",
        blocks: [userBlock("first prompt", { id: "user-1" }), userBlock("second prompt", { id: "user-2" })],
      }),
    ).toBe("second prompt · relay");
  });

  test("formats skill invocations as intent without transcript badges", () => {
    expect(
      terminalTitleForState({
        cwd: "/Users/kutsav/Workspaces/tui/relay",
        blocks: [
          userBlock("/review focus on regressions", {
            origin: "local",
            skillInvocation: { name: "review", userMessage: "focus on regressions" },
          }),
        ],
      }),
    ).toBe("review — focus on regressions · relay");
  });

  test("uses latest skill invocation instead of first skill invocation", () => {
    expect(
      terminalTitleForState({
        cwd: "/Users/kutsav/Workspaces/tui/relay",
        sessionTitle: "review — first",
        blocks: [
          userBlock("/review first", {
            id: "user-1",
            origin: "local",
            skillInvocation: { name: "review", userMessage: "first" },
          }),
          userBlock("/review second", {
            id: "user-2",
            origin: "local",
            skillInvocation: { name: "review", userMessage: "second" },
          }),
        ],
      }),
    ).toBe("review — second · relay");
  });

  test("uses latest prompt title before block history catches up", () => {
    expect(
      terminalTitleForState({
        cwd: "/Users/kutsav/Workspaces/tui/relay",
        latestPromptTitleIntent: promptIntent("review — second"),
        sessionTitle: "review — first",
        blocks: [
          userBlock("/review first", {
            id: "user-1",
            origin: "local",
            skillInvocation: { name: "review", userMessage: "first" },
          }),
        ],
      }),
    ).toBe("review — second · relay");
  });

  test("smart prompt source ignores low-signal latest inputs", () => {
    for (const lowSignal of [
      "yes",
      "no",
      "n",
      "ok.",
      "go ahead",
      "do it",
      "continue",
      "apply it",
      "implement it",
      "run it",
      "retry",
      "again",
      "thanks",
      "lgtm",
    ]) {
      expect(
        terminalTitleForState({
          cwd: "/Users/kutsav/Workspaces/tui/relay",
          latestPromptTitleIntent: promptIntent(lowSignal),
          blocks: [userBlock("implement terminal title smart mode", { id: "user-1" })],
        }),
      ).toBe("implement terminal title smart mode · relay");
    }
  });

  test("smart prompt source keeps short meaningful latest inputs", () => {
    for (const [input, title] of [
      ["review", "review"],
      ["fix tests", "fix tests"],
      ["run typecheck", "run typecheck"],
      ["no, use first prompt", "no, use first prompt"],
      ["apply config validation", "apply config validation"],
    ] as const) {
      expect(
        terminalTitleForState({
          cwd: "/Users/kutsav/Workspaces/tui/relay",
          latestPromptTitleIntent: promptIntent(input),
          blocks: [userBlock("implement terminal title smart mode", { id: "user-1" })],
        }),
      ).toBe(`${title} · relay`);
    }
  });

  test("first and last prompt sources are explicit escape hatches", () => {
    const blocks = [userBlock("first prompt", { id: "user-1" }), userBlock("yes", { id: "user-2" })];

    expect(
      terminalTitleForState({
        cwd: "/Users/kutsav/Workspaces/tui/relay",
        terminalTitlePromptSource: "first",
        latestPromptTitleIntent: promptIntent("latest prompt"),
        blocks,
      }),
    ).toBe("first prompt · relay");

    expect(
      terminalTitleForState({
        cwd: "/Users/kutsav/Workspaces/tui/relay",
        terminalTitlePromptSource: "last",
        latestPromptTitleIntent: promptIntent("yes"),
        blocks,
      }),
    ).toBe("yes · relay");
  });

  test("smart prompt source uses bare skill latest title only as a fallback", () => {
    expect(
      terminalTitleForState({
        cwd: "/Users/kutsav/Workspaces/tui/relay",
        latestPromptTitleIntent: promptIntent("/review", { name: "review" }),
        sessionTitle: "Investigate release readiness",
      }),
    ).toBe("Investigate release readiness · relay");

    expect(
      terminalTitleForState({
        cwd: "/Users/kutsav/Workspaces/tui/relay",
        latestPromptTitleIntent: promptIntent("/review", { name: "review" }),
        sessionTitle: "New thread",
      }),
    ).toBe("Review session · relay");
  });

  test("smart prompt source ranks strong prompts above bare skill fallbacks", () => {
    expect(
      terminalTitleForState({
        cwd: "/Users/kutsav/Workspaces/tui/relay",
        blocks: [
          userBlock("/review", {
            id: "user-1",
            origin: "local",
            skillInvocation: { name: "review" },
          }),
          userBlock("focus on regressions", { id: "user-2" }),
        ],
      }),
    ).toBe("focus on regressions · relay");

    expect(
      terminalTitleForState({
        cwd: "/Users/kutsav/Workspaces/tui/relay",
        sessionTitle: "New thread",
        blocks: [
          userBlock("/review", {
            id: "user-1",
            origin: "local",
            skillInvocation: { name: "review" },
          }),
        ],
      }),
    ).toBe("Review session · relay");

    expect(
      terminalTitleForState({
        cwd: "/Users/kutsav/Workspaces/tui/relay",
        blocks: [
          userBlock("/review focus on regressions", {
            id: "user-1",
            origin: "local",
            skillInvocation: { name: "review", userMessage: "focus on regressions" },
          }),
        ],
      }),
    ).toBe("review — focus on regressions · relay");

    expect(
      terminalTitleForState({
        cwd: "/Users/kutsav/Workspaces/tui/relay",
        blocks: [
          userBlock("implement smart titles", { id: "user-1" }),
          userBlock("/review", {
            id: "user-2",
            origin: "local",
            skillInvocation: { name: "review" },
          }),
        ],
      }),
    ).toBe("implement smart titles · relay");
  });

  test("smart prompt source falls back to session title when every prompt is low signal", () => {
    expect(
      terminalTitleForState({
        cwd: "/Users/kutsav/Workspaces/tui/relay",
        sessionTitle: "Implement terminal title setting",
        latestPromptTitleIntent: promptIntent("yes"),
        blocks: [userBlock("ok", { id: "user-1" }), userBlock("thanks", { id: "user-2" })],
      }),
    ).toBe("Implement terminal title setting · relay");
  });

  test("ignores current-turn guidance when choosing latest title intent", () => {
    expect(
      terminalTitleForState({
        cwd: "/Users/kutsav/Workspaces/tui/relay",
        sessionTitle: "Investigate release readiness",
        blocks: [
          userBlock("primary prompt", { id: "user-1" }),
          userBlock("guidance-only text", { id: "user-2", delivery: "current-turn-guidance" }),
        ],
      }),
    ).toBe("primary prompt · relay");
  });

  test("compacts raw ACP filesystem skill echoes for title intent", () => {
    expect(
      terminalTitleForState({
        cwd: "/Users/kutsav/Workspaces/tui/relay",
        blocks: [
          userBlock(
            [
              "---",
              "name: review",
              "description: Review changes",
              "register_cmd: true",
              "---",
              "# Review",
              "ARGUMENTS: focus on regressions",
            ].join("\n"),
            { origin: "acp" },
          ),
        ],
      }),
    ).toBe("review — focus on regressions · relay");
  });

  test("uses workspace basename and stable fallback", () => {
    expect(workspaceTerminalTitleLabel("/Users/asumer/work/asumer/")).toBe("asumer");
    expect(workspaceTerminalTitleLabel("C:\\Users\\asumer\\config\\")).toBe("config");
    expect(workspaceTerminalTitleLabel("/tmp/some-incredibly-long-workspace-directory-name")).toBe(
      "some-incredibly-long-workspace-directory-name",
    );
    expect(workspaceTerminalTitleLabel("/")).toBe("relay");
    expect(workspaceTerminalTitleLabel("\u001b]0;bad\u0007\u202e")).toBe("relay");
  });

  test("detects pending approvals and elicitations only while unresolved", () => {
    expect(hasPendingTerminalTitleAction([pendingApprovalBlock()])).toBe(true);
    expect(hasPendingTerminalTitleAction([pendingElicitationBlock()])).toBe(true);
    expect(
      hasPendingTerminalTitleAction([
        {
          ...pendingApprovalBlock(),
          status: "running",
        },
      ]),
    ).toBe(false);
    expect(
      hasPendingTerminalTitleAction([
        {
          ...pendingElicitationBlock(),
          status: "accepted",
        },
      ]),
    ).toBe(false);
  });

  test("action-required title takes precedence over spinner", () => {
    expect(
      terminalTitleForState({
        cwd: "/tmp/config",
        running: true,
        spinnerFrame: "⠋",
        blocks: [pendingApprovalBlock()],
      }),
    ).toBe(`${NEEDS_INPUT_TERMINAL_TITLE_PREFIX} · config`);
  });

  test("action-required title uses latest prompt intent", () => {
    expect(
      terminalTitleForState({
        cwd: "/tmp/config",
        sessionTitle: "first prompt",
        running: true,
        spinnerFrame: "⠋",
        blocks: [
          userBlock("first prompt", { id: "user-1" }),
          userBlock("second prompt", { id: "user-2" }),
          pendingApprovalBlock(),
        ],
      }),
    ).toBe(`${NEEDS_INPUT_TERMINAL_TITLE_PREFIX} · second prompt · config`);
  });

  test("sanitizes terminal title content before encoding", () => {
    expect(sanitizeTerminalTitle("  Project\t|\nWorking\x1b[31m red \x1b[0m  ")).toBe("Project | Working red");
    expect(sanitizeTerminalTitle("prefix \x1b]0;evil\x07 suffix")).toBe("prefix suffix");
    expect(sanitizeTerminalTitle("Pro\u202ej\u2066e\u200fc\u061ct\u200b \ufeffT\u2060itle")).toBe("Project Title");
    expect(sanitizeTerminalTitle("\x1b]0;\x07\u202e")).toBe("relay");
  });

  test("bounds sanitized titles", () => {
    const value = sanitizeTerminalTitle("a".repeat(MAX_TERMINAL_TITLE_CHARS + 10));
    expect(Array.from(value)).toHaveLength(MAX_TERMINAL_TITLE_CHARS);
  });

  test("encodes OSC 0 title bytes with BEL terminator", () => {
    expect(encodeOsc0Title("hello")).toBe("\x1b]0;hello\x07");
  });

  test("activity tracker keeps title active briefly after busy state ends", () => {
    const tracker = createTerminalTitleActivityTracker(1_000);

    expect(
      tracker.isActive({
        nowMs: 0,
        scopeKey: "thread-a\0/tmp/project",
        active: true,
        actionRequired: false,
        activitySequence: 0,
      }),
    ).toBe(true);
    expect(
      tracker.isActive({
        nowMs: 10,
        scopeKey: "thread-a\0/tmp/project",
        active: false,
        actionRequired: false,
        activitySequence: 0,
      }),
    ).toBe(true);
    expect(
      tracker.isActive({
        nowMs: 1_011,
        scopeKey: "thread-a\0/tmp/project",
        active: false,
        actionRequired: false,
        activitySequence: 0,
      }),
    ).toBe(false);
  });

  test("activity grace keeps title stable without animating the spinner", () => {
    const tracker = createTerminalTitleActivityTracker(1_000);

    expect(
      tracker.isActive({
        nowMs: 0,
        scopeKey: "thread-a\0/tmp/project",
        active: true,
        actionRequired: false,
        activitySequence: 0,
      }),
    ).toBe(true);
    const graceActive = tracker.isActive({
      nowMs: 10,
      scopeKey: "thread-a\0/tmp/project",
      active: false,
      actionRequired: false,
      activitySequence: 0,
    });

    expect(graceActive).toBe(true);
    expect(
      shouldAnimateTerminalTitleSpinner({
        actionRequired: false,
        connecting: false,
        running: false,
        spinnerActive: false,
      }),
    ).toBe(false);
    expect(terminalTitleForState({ cwd: "/tmp/config", active: graceActive, spinnerFrame: "⠹" })).toBe("⠹ config");
  });

  test("activity tracker extends title activity for late ACP updates after prompt completion", () => {
    const tracker = createTerminalTitleActivityTracker(1_000);

    expect(
      tracker.isActive({
        nowMs: 0,
        scopeKey: "thread-a\0/tmp/project",
        active: false,
        actionRequired: false,
        activitySequence: 1,
      }),
    ).toBe(false);
    expect(
      tracker.isActive({
        nowMs: 200,
        scopeKey: "thread-a\0/tmp/project",
        active: false,
        actionRequired: false,
        activitySequence: 2,
      }),
    ).toBe(true);
    expect(
      tracker.isActive({
        nowMs: 1_199,
        scopeKey: "thread-a\0/tmp/project",
        active: false,
        actionRequired: false,
        activitySequence: 2,
      }),
    ).toBe(true);
    expect(
      tracker.isActive({
        nowMs: 1_201,
        scopeKey: "thread-a\0/tmp/project",
        active: false,
        actionRequired: false,
        activitySequence: 2,
      }),
    ).toBe(false);
  });

  test("activity tracker treats action-required as busy but does not spin until action resolves", () => {
    const tracker = createTerminalTitleActivityTracker(1_000);

    expect(
      tracker.isActive({
        nowMs: 0,
        scopeKey: "thread-a\0/tmp/project",
        active: false,
        actionRequired: true,
        activitySequence: 0,
      }),
    ).toBe(false);
    expect(
      tracker.isActive({
        nowMs: 20,
        scopeKey: "thread-a\0/tmp/project",
        active: false,
        actionRequired: false,
        activitySequence: 0,
      }),
    ).toBe(true);
  });

  test("activity tracker resets keepalive when the title scope changes", () => {
    const tracker = createTerminalTitleActivityTracker(1_000);

    expect(
      tracker.isActive({
        nowMs: 0,
        scopeKey: "thread-a\0/tmp/project",
        active: true,
        actionRequired: false,
        activitySequence: 0,
      }),
    ).toBe(true);
    expect(
      tracker.isActive({
        nowMs: 10,
        scopeKey: "thread-b\0/tmp/other",
        active: false,
        actionRequired: false,
        activitySequence: 0,
      }),
    ).toBe(false);
  });

  test("manager writes only distinct TTY titles and clears managed title", () => {
    const output = new CaptureOutput(true);
    const manager = createTerminalTitleManager(output);

    expect(manager.set("config")).toBe(true);
    expect(manager.set("config")).toBe(false);
    expect(manager.update({ cwd: "/tmp/config", running: true, spinnerFrame: "⠋" })).toBe(true);
    expect(manager.update({ cwd: "/tmp/config", running: true, spinnerFrame: "⠋" })).toBe(false);
    expect(manager.clear()).toBe(true);
    expect(manager.clear()).toBe(false);

    expect(output.chunks).toEqual(["\x1b]0;config\x07", "\x1b]0;⠋ config\x07", "\x1b]0;\x07"]);
  });

  test("manager is a no-op when stdout is not a TTY", () => {
    const output = new CaptureOutput(false);
    const manager = createTerminalTitleManager(output);

    expect(manager.set("config")).toBe(false);
    expect(manager.update({ cwd: "/tmp/config", running: true, spinnerFrame: "⠋" })).toBe(false);
    expect(manager.clear()).toBe(false);
    expect(output.chunks).toEqual([]);
  });
});
