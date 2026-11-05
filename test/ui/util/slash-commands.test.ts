import { describe, expect, test } from "bun:test";
import { createInitialState, type AppState } from "../../../src/ui/state";
import {
  getVisibleSlashCommands,
  agentSlashSkillInvocationEcho,
  isAgentAdvertisedSlashCommand,
  slashCommandName,
  slashCommandUserMessage,
  shouldPreferNativeSlashCommand,
} from "../../../src/ui/util/slash-commands";
import {
  nativePreferredAgentCommandNames,
  nativeSlashCommandNames,
  nativeSlashCommands,
} from "../../../src/ui/util/native-slash-commands";
import { visibleSlashCommands as visibleAppSlashCommands } from "../../../src/ui/app/slash-commands";

function withActiveSession(state: AppState): AppState {
  state.activeThreadId = "thread-1";
  state.threads = [
    {
      id: "thread-1",
      title: "Thread one",
      sessionId: "session-1",
      cwd: state.cwd,
      workspaceKind: "local",
      status: "paused",
      archived: false,
    },
  ];
  return state;
}

describe("slash command utilities", () => {
  test("slashCommandName extracts the lower-cased command name", () => {
    expect(slashCommandName("/Model opus")).toBe("model");
    expect(slashCommandName("  /review now")).toBe("review");
    expect(slashCommandName("not-a-command")).toBe("");
    expect(slashCommandName("")).toBe("");
  });

  test("slash command user messages preserve multiline arguments", () => {
    expect(slashCommandUserMessage("/review and do it good")).toBe("and do it good");
    expect(slashCommandUserMessage("/review\nline one\n  line two\n")).toBe("line one\n  line two");
    expect(slashCommandUserMessage("/review")).toBeUndefined();
  });

  test("agent slash skill invocation echo uses advertised display name and arguments", () => {
    expect(agentSlashSkillInvocationEcho("/Review and do it good", [{ name: "review", description: "" }])).toEqual({
      name: "review",
      userMessage: "and do it good",
    });
    expect(agentSlashSkillInvocationEcho("/unknown", [{ name: "review", description: "" }])).toBeNull();
  });

  test("detects agent-advertised commands", () => {
    expect(isAgentAdvertisedSlashCommand("/foo", [{ name: "Foo", description: "" }])).toBe(true);
    expect(isAgentAdvertisedSlashCommand("/bar", [{ name: "Foo", description: "" }])).toBe(false);
  });

  test("native command preference depends on advertised capabilities", () => {
    const state = createInitialState("/tmp");
    const preferred = new Set(["models", "mode"]);

    expect(shouldPreferNativeSlashCommand("models", state, preferred)).toBe(false);
    state.availableModels = [{ modelId: "sonnet", name: "Sonnet" }];
    expect(shouldPreferNativeSlashCommand("models", state, preferred)).toBe(true);
    expect(shouldPreferNativeSlashCommand("model", state, new Set(["model"]))).toBe(true);

    state.availableModes = [{ id: "review", name: "Review" }];
    expect(shouldPreferNativeSlashCommand("modes", state, new Set(["modes"]))).toBe(true);
    expect(shouldPreferNativeSlashCommand("diff", state, new Set(["diff"]))).toBe(true);
  });

  test("visible commands hide preferred agent commands when native capability exists", () => {
    const state = createInitialState("/tmp");
    state.availableModes = [{ id: "review", name: "Review" }];

    expect(
      getVisibleSlashCommands(
        state,
        [
          { name: "mode", description: "agent mode" },
          { name: "help", description: "agent help" },
        ],
        [
          { name: "mode", description: "native mode" },
          { name: "skill", description: "skill" },
        ],
        new Set(["mode"]),
      ),
    ).toEqual([
      { name: "help", description: "agent help" },
      { name: "mode", description: "native mode" },
      { name: "skill", description: "skill" },
    ]);
  });

  test("visible commands hide preferred ACP conflicts in favor of native commands", () => {
    const state = createInitialState("/tmp");
    state.availableModes = [{ id: "review", name: "Review" }];

    expect(
      getVisibleSlashCommands(
        state,
        [
          { name: "review", description: "agent review" },
          { name: "mode", description: "agent mode" },
        ],
        [
          { name: "review", description: "native review" },
          { name: "mode", description: "native mode" },
        ],
        new Set(["review", "mode"]),
      ),
    ).toEqual([
      { name: "review", description: "native review" },
      { name: "mode", description: "native mode" },
    ]);
  });

  test("native command menu entries are capability-gated", () => {
    const state = createInitialState("/tmp");

    expect(nativeSlashCommands(state).map((command) => command.name)).not.toContain("fork");
    expect(nativeSlashCommands(state).map((command) => command.name)).not.toContain("resume");
    expect(nativeSlashCommands(state).map((command) => command.name)).not.toContain("thinking");
    expect(nativeSlashCommands(state).map((command) => command.name)).not.toContain("login");
    expect(nativeSlashCommands(state).map((command) => command.name)).not.toContain("logout");

    state.sessionResumeAvailable = true;
    expect(nativeSlashCommands(state).map((command) => command.name)).toEqual(
      expect.arrayContaining(["resume", "sessions"]),
    );
    state.sessionResumeAvailable = false;

    state.authMethods = [
      {
        id: "api-key",
        name: "API key",
        type: "env_var",
        supported: false,
        unsupportedReason: "Relay cannot pass new environment variables to an already-running ACP agent.",
      },
    ];
    expect(nativeSlashCommands(state).map((command) => command.name)).toContain("login");
    expect(nativeSlashCommands(state).map((command) => command.name)).not.toContain("logout");

    state.sessionLoadAvailable = true;
    state.sessionListAvailable = true;
    state.availableThinkingLevels = [{ id: "high", name: "High" }];
    state.sessionForkAvailable = true;
    state.authMethods = [{ id: "oauth", name: "OAuth", type: "agent", supported: true }];
    state.authLogoutAvailable = true;
    withActiveSession(state);

    expect(nativeSlashCommands(state).map((command) => command.name)).toEqual(
      expect.arrayContaining(["fork", "resume", "thinking", "login", "logout", "mcp"]),
    );
  });

  test("native command menu includes Relay built-in skills and native commands", () => {
    const state = createInitialState("/tmp");

    expect(nativeSlashCommands(state).map((command) => command.name)).toEqual(
      expect.arrayContaining(["review", "relay-plugins", "relay-themes", "handoff"]),
    );
  });

  test("native commands distinguish actions from slash-invoked skills", () => {
    const state = createInitialState("/tmp");
    state.availableModels = [{ modelId: "sonnet", name: "Sonnet" }];
    const commands = nativeSlashCommands(state);

    expect(commands.find((command) => command.name === "models")).toMatchObject({
      origin: "relay",
      kind: "action",
      invocation: { syntax: "slash", composable: false },
    });
    expect(commands.find((command) => command.name === "review")).toMatchObject({
      origin: "relay",
      kind: "skill",
      invocation: { syntax: "slash", composable: false },
    });
  });

  test("disabled built-in slash commands are removed from native suggestions", () => {
    const state = createInitialState("/tmp");
    state.availableCommands = [{ name: "review", description: "agent review" }];
    const disabledBuiltinCommands = ["review"];

    expect(nativeSlashCommands(state, { disabledBuiltinCommands }).map((command) => command.name)).not.toContain(
      "review",
    );
    const visible = getVisibleSlashCommands(
      state,
      state.availableCommands,
      nativeSlashCommands(state, { disabledBuiltinCommands }),
      nativePreferredAgentCommandNames({ disabledBuiltinCommands }),
    );
    expect(visible.filter((command) => command.name === "review")).toEqual([
      { name: "review", description: "agent review" },
    ]);
    expect(visible.map((command) => command.name)).not.toContain("relay.review");
  });

  test("disabling a native command also disables its aliases", () => {
    const disabledBuiltinCommands = ["models"];
    const names = nativeSlashCommandNames({ disabledBuiltinCommands });
    const preferred = nativePreferredAgentCommandNames({ disabledBuiltinCommands });

    expect(names.has("models")).toBe(false);
    expect(names.has("model")).toBe(false);
    expect(preferred.has("models")).toBe(false);
    expect(preferred.has("model")).toBe(false);
  });

  test("sessions is a native alias for resume", () => {
    const names = nativeSlashCommandNames();
    const preferred = nativePreferredAgentCommandNames();

    expect(names.has("resume")).toBe(true);
    expect(names.has("sessions")).toBe(true);
    expect(preferred.has("sessions")).toBe(true);
    expect(nativeSlashCommandNames({ disabledBuiltinCommands: ["resume"] }).has("sessions")).toBe(false);
  });

  test("reasoning effort alias is a visible native command", () => {
    const names = nativeSlashCommandNames();
    const commands = nativeSlashCommands().map((command) => command.name);

    expect(names.has("thinking")).toBe(true);
    expect(names.has("think")).toBe(false);
    expect(names.has("effort")).toBe(true);
    expect(commands).toEqual(expect.arrayContaining(["thinking", "effort"]));
  });

  test("quit is a visible native alias for exit", () => {
    const commands = nativeSlashCommands().map((command) => command.name);

    expect(commands).toEqual(expect.arrayContaining(["exit", "quit"]));
  });

  test("native command names do not include relay-prefixed aliases", () => {
    const names = nativeSlashCommandNames();

    expect(names.has("review")).toBe(true);
    expect(names.has("goal")).toBe(false);
    expect(names.has("handoff")).toBe(true);
    expect(names.has("relay.review")).toBe(false);
    expect(names.has("relay.goal")).toBe(false);
    expect(names.has("relay.handoff")).toBe(false);
  });

  test("app-visible commands prefer plugin commands over agent commands", () => {
    const state = createInitialState("/tmp");
    state.availableCommands = [{ name: "review", description: "agent review" }];

    expect(visibleAppSlashCommands(state, [{ name: "review", description: "plugin review" }])[0]).toEqual({
      name: "review",
      description: "plugin review",
    });
  });

  test("preferred agent command is visible until native capability is available", () => {
    const state = createInitialState("/tmp");
    const agentCommands = [{ name: "fork", description: "agent fork" }];
    const localCommands = nativeSlashCommands(state);

    expect(getVisibleSlashCommands(state, agentCommands, localCommands, new Set(["fork"]))).toContainEqual({
      name: "fork",
      description: "agent fork",
    });

    state.sessionForkAvailable = true;
    withActiveSession(state);
    expect(getVisibleSlashCommands(state, agentCommands, nativeSlashCommands(state), new Set(["fork"]))).toContainEqual(
      {
        name: "fork",
        description: "Fork current thread",
        origin: "relay",
        kind: "action",
        invocation: { syntax: "slash", composable: false },
      },
    );
  });
});
