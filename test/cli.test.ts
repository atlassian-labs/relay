import { describe, expect, test } from "bun:test";

import { parseCli } from "../src/cli";

describe("Relay CLI parsing", () => {
  test("treats unquoted words after --prompt as the initial prompt text", () => {
    const parsed = parseCli(["--prompt", "no", "quotes", "here"]);

    expect(parsed.prompt).toBe("no quotes here");
    expect(parsed.args.positionals).toEqual([]);
  });

  test("treats unquoted words after -p as the initial prompt text", () => {
    const parsed = parseCli(["-p", "Needs", "to", "have", "quotes"]);

    expect(parsed.prompt).toBe("Needs to have quotes");
    expect(parsed.args.positionals).toEqual([]);
  });

  test("stops collecting unquoted prompt text at the next option", () => {
    const parsed = parseCli(["--prompt", "hello", "there", "--agent", "alta"]);

    expect(parsed.prompt).toBe("hello there");
    expect(parsed.args.values.agent).toBe("alta");
    expect(parsed.args.positionals).toEqual([]);
  });

  test("keeps subcommand-looking words inside unquoted prompt text", () => {
    const parsed = parseCli(["--prompt", "please", "add", "tests"]);

    expect(parsed.prompt).toBe("please add tests");
    expect(parsed.addArgs).toBeUndefined();
  });

  test("preserves positional resume session ids when no prompt flag is present", () => {
    const parsed = parseCli(["session-123"]);

    expect(parsed.prompt).toBeUndefined();
    expect(parsed.args.positionals).toEqual(["session-123"]);
  });

  test("parses the yoloo launch flag", () => {
    const parsed = parseCli(["--agent", "alta", "--yoloo"]);

    expect(parsed.args.values.yoloo).toBe(true);
    expect(parsed.args.values.agent).toBe("alta");
  });

  test("opens the web UI by default unless --no-open is set", () => {
    expect(parseCli(["web"]).args.values["no-open"]).toBe(false);
    expect(parseCli(["web", "--no-open"]).args.values["no-open"]).toBe(true);
  });

  test("parses exec with a positional prompt", () => {
    const parsed = parseCli(["exec", "explain this repository"]);

    expect(parsed.exec).toBe(true);
    expect(parsed.args.positionals).toEqual(["explain this repository"]);
  });

  test("parses exec agent, model, and thinking level overrides", () => {
    const parsed = parseCli([
      "exec",
      "--agent",
      "rovo",
      "--model",
      "model-a",
      "--thinking-level",
      "high",
      "review the changes",
    ]);

    expect(parsed.exec).toBe(true);
    expect(parsed.args.values.agent).toBe("rovo");
    expect(parsed.args.values.model).toBe("model-a");
    expect(parsed.args.values["thinking-level"]).toBe("high");
    expect(parsed.args.positionals).toEqual(["review the changes"]);
  });

  test("does not treat exec inside --prompt text as the exec subcommand", () => {
    const parsed = parseCli(["--prompt", "please", "exec", "this"]);

    expect(parsed.exec).toBe(false);
    expect(parsed.prompt).toBe("please exec this");
  });

  test("parses live session listing", () => {
    expect(parseCli(["list", "sessions", "--json"]).sessionControl).toEqual({
      kind: "list-sessions",
      json: true,
    });
  });

  test("parses live session inspection with sanitized history selection", () => {
    expect(parseCli(["inspect", "session", "review-otter", "--history", "recent:5", "--json"]).sessionControl).toEqual({
      kind: "inspect-session",
      name: "review-otter",
      history: { mode: "recent", turns: 5 },
      json: true,
    });
    expect(parseCli(["inspect", "session", "review-otter"]).sessionControl).toMatchObject({
      kind: "inspect-session",
      history: { mode: "recent", turns: 3 },
    });
  });

  test("parses session messages without interpreting message words as subcommands", () => {
    expect(parseCli(["message", "review-otter", "please", "add", "tests", "--steer"]).sessionControl).toEqual({
      kind: "message",
      name: "review-otter",
      text: "please add tests",
      delivery: "steer",
      json: false,
    });
  });

  test("defaults messages to mailbox delivery and supports explicit turns", () => {
    expect(parseCli(["message", "review-otter", "status"]).sessionControl).toMatchObject({
      kind: "message",
      delivery: "mailbox",
    });
    expect(parseCli(["message", "review-otter", "continue", "--turn"]).sessionControl).toMatchObject({
      kind: "message",
      delivery: "turn",
    });
  });

  test("parses bounded session waits and cancellation", () => {
    expect(parseCli(["wait", "review-otter", "--timeout", "12", "--json"]).sessionControl).toEqual({
      kind: "wait-session",
      name: "review-otter",
      timeoutMs: 12_000,
      json: true,
    });
    expect(parseCli(["wait"]).sessionControl).toEqual({
      kind: "wait-session",
      timeoutMs: 45_000,
      json: false,
    });
    expect(parseCli(["cancel", "review-otter"]).sessionControl).toEqual({
      kind: "cancel-session",
      name: "review-otter",
      json: false,
    });
    expect(parseCli(["wait", "review-otter", "--timeout", "120"]).sessionControl).toMatchObject({
      timeoutMs: 120_000,
    });
    expect(() => parseCli(["wait", "review-otter", "--timeout", "0"])).toThrow("--timeout must be between");
    expect(() => parseCli(["wait", "review-otter", "--timeout", "121"])).toThrow("--timeout must be between");
  });

  test("parses child session creation", () => {
    expect(
      parseCli([
        "start",
        "session",
        "review",
        "auth",
        "--parent",
        "build-beacon",
        "--name",
        "review-otter",
        "--history",
        "recent:3",
        "--worktree",
      ]).sessionControl,
    ).toEqual({
      kind: "start-session",
      task: "review auth",
      parent: "build-beacon",
      name: "review-otter",
      history: { mode: "recent", turns: 3 },
      worktree: true,
      json: false,
    });
  });

  test("parses child task type and direct configuration overrides", () => {
    const command = parseCli([
      "start",
      "session",
      "plan",
      "the",
      "migration",
      "--name",
      "plan-otter",
      "--task-type",
      "plan",
      "--agent",
      "codex",
      "--model",
      "model-a",
      "--thinking-level",
      "high",
    ]).sessionControl;

    expect(command).toMatchObject({
      kind: "start-session",
      taskType: "plan",
      agent: "codex",
      model: "model-a",
      thinkingLevel: "high",
    });
  });

  test("parses task type management commands", () => {
    expect(
      parseCli([
        "task-type",
        "set",
        "plan",
        "--description",
        "Architecture planning",
        "--keyword",
        "plan",
        "--keyword",
        "design proposal",
        "--agent",
        "codex",
        "--model",
        "model-a",
        "--thinking-level",
        "high",
      ]).taskTypeCommand,
    ).toEqual({
      kind: "set",
      name: "plan",
      description: "Architecture planning",
      keywords: ["plan", "design proposal"],
      agent: "codex",
      model: "model-a",
      thinkingLevel: "high",
    });
    expect(parseCli(["task-type", "list", "--json"]).taskTypeCommand).toEqual({ kind: "list", json: true });
    expect(parseCli(["task-type", "remove", "plan"]).taskTypeCommand).toEqual({ kind: "remove", name: "plan" });
  });

  test("defaults child session history to none", () => {
    const command = parseCli(["start", "session", "review", "auth", "--name", "review-otter"]).sessionControl;

    expect(command).toMatchObject({ kind: "start-session", history: { mode: "none" } });
  });

  test("rejects invalid child session history", () => {
    expect(() =>
      parseCli(["start", "session", "review", "auth", "--name", "review-otter", "--history", "recent:0"]),
    ).toThrow("--history must be one of");
  });

  test("requires agents to select a child session name", () => {
    expect(() => parseCli(["start", "session", "review", "auth"])).toThrow("required option");
  });

  test("parses add options through the command grammar", () => {
    expect(parseCli(["add", "alta", "atlas alta agent run", "--profile", "alta"]).addArgs).toEqual({
      agentName: "alta",
      commandString: "atlas alta agent run",
      profile: "alta",
    });
  });

  test("passes ACP command options through as command text", () => {
    expect(parseCli(["acp", "agent", "run", "--model", "test"]).acpCommand).toBe("agent run --model test");
  });
});
