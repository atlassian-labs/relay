import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AcpClient } from "../../../src/acp/client";
import type { ThreadInfo } from "../../../src/core/threads";
import type { BuiltinSkill } from "../../../src/builtin-skills/types";
import { createSlashCommandHandler } from "../../../src/ui/app/slash-command-handler";
import { SelectionMode, type ListItem } from "../../../src/ui/autocomplete";
import type { RelayAuthMethod } from "../../../src/acp/capabilities";
import type { ChatBlock, SessionModelOption, SessionThinkingLevelOption } from "../../../src/ui/state";
import type { SelectionOverlayBehavior } from "../../../src/ui/app/selection-overlay";
import { PluginRunner } from "../../../src/plugins";
import { store } from "../../../src/ui/app/runtime-store";

afterEach(() => {
  store.threadYoloEnabled.clear();
  store.threadYoloLaunchEnabled.clear();
});

type Handler = ReturnType<typeof createSlashCommandHandler>;
type HandlerApp = Parameters<Handler>[1];
type HandlerDeps = Parameters<typeof createSlashCommandHandler>[0];

interface HandlerCalls {
  createdThreads: boolean[];
  createdThreadTitles: (string | undefined)[];
  forkedThreads: number;
  ensuredSessions: number;
  submittedPrompts: string[];
  externalEditorPrompts: string[];
  switchedModels: string[];
  loadedSessions: string[];
  builtinSkills: string[];
  nativeHandoffs: string[];
  authenticatedMethods: string[];
  terminalAuthMethods: string[];
  loggedOut: number;
  blocks: string[];
  toasts: Array<{ message: string; variant?: string; durationMs?: number }>;
  overlays: Array<{ mode: SelectionMode; items: ListItem[]; layout?: unknown; selectedIndex?: number }>;
  overlayBehaviors: SelectionOverlayBehavior[];
}

function thread(status: ThreadInfo["status"] = "paused"): ThreadInfo {
  return {
    id: "thread-1",
    title: "Thread one",
    sessionId: null,
    cwd: "/tmp/relay-thread-one",
    workspaceKind: "local",
    status,
    archived: false,
  };
}

function createApp(
  overrides: {
    authMethods?: RelayAuthMethod[];
    authLogoutAvailable?: boolean;
    connecting?: boolean;
    threadStatus?: ThreadInfo["status"];
    blocks?: string[];
    chatBlocks?: ChatBlock[];
    availableModels?: SessionModelOption[];
    modelId?: string;
    availableThinkingLevels?: SessionThinkingLevelOption[];
    thinkingLevel?: string;
    cwd?: string;
  } = {},
): HandlerApp {
  const activeThread = thread(overrides.threadStatus);
  const cwd = overrides.cwd ?? activeThread.cwd;
  activeThread.cwd = cwd;
  const state = {
    connecting: overrides.connecting ?? false,
    activeThreadId: activeThread.id,
    threads: [activeThread],
    blocks: overrides.chatBlocks ?? [],
    cwd,
    availableCommands: [],
    availableModels: overrides.availableModels ?? [],
    modelId: overrides.modelId ?? "",
    availableThinkingLevels: overrides.availableThinkingLevels ?? [],
    thinkingLevel: overrides.thinkingLevel ?? "",
    authMethods: overrides.authMethods ?? [{ id: "oauth", name: "OAuth", type: "agent", supported: true }],
    authLogoutAvailable: overrides.authLogoutAvailable ?? true,
    authStatus: "unknown",
    authMessage: "",
  };
  return {
    state: state as unknown as HandlerApp["state"],
    addBlock: (block: { content?: unknown }) => {
      if (typeof block.content === "string") overrides.blocks?.push(block.content);
    },
    setState: (key: string, value: unknown) => {
      (state as Record<string, unknown>)[key] = value;
    },
  } as unknown as HandlerApp;
}

function createDeps(
  calls: HandlerCalls,
  options: {
    supportsSessionLoad?: boolean;
    supportsSessionList?: boolean;
    supportsSessionResume?: boolean;
    authMethods?: RelayAuthMethod[];
    pluginRunner?: PluginRunner | null;
    disabledBuiltinSlashCommands?: readonly string[];
    runTerminalAuth?: boolean;
  } = {},
): HandlerDeps {
  const acpClient = {
    sessionId: null,
    supportsSessionLoad: () => options.supportsSessionLoad ?? true,
    supportsSessionList: () => options.supportsSessionList ?? true,
    supportsSessionResume: () => options.supportsSessionResume ?? false,
    authMethods: () =>
      options.authMethods ?? [
        { id: "oauth", name: "OAuth", type: "agent", supported: true },
        {
          id: "terminal",
          name: "Terminal",
          type: "terminal",
          supported: false,
          unsupportedReason: "Relay does not support terminal ACP auth methods yet.",
        },
      ],
    supportsAuthLogout: () => true,
    authenticate: async (methodId: string) => {
      calls.authenticatedMethods.push(methodId);
    },
    logout: async () => {
      calls.loggedOut += 1;
    },
  } as unknown as AcpClient;
  return {
    submitPromptToAgent: async (text) => {
      calls.submittedPrompts.push(text);
    },
    createThread: async (_app, inWorktree, options) => {
      calls.createdThreads.push(inWorktree);
      calls.createdThreadTitles.push(options?.title);
    },
    forkThread: async () => {
      calls.forkedThreads += 1;
    },
    loadSession: async (sessionId) => {
      calls.loadedSessions.push(sessionId);
    },
    openResumePicker: async () => undefined,
    switchSessionModel: async (_app, modelId) => {
      calls.switchedModels.push(modelId);
    },
    switchSessionThinkingLevel: async () => undefined,
    ensureSessionForCommand: async () => {
      calls.ensuredSessions += 1;
    },
    shutdownAndExit: async () => undefined,
    showSelectionOverlay: (items, mode, layout, selectedIndex, behavior) => {
      const overlay: HandlerCalls["overlays"][number] = { mode, items };
      if (layout !== undefined) overlay.layout = layout;
      if (selectedIndex !== undefined) overlay.selectedIndex = selectedIndex;
      if (behavior !== undefined) calls.overlayBehaviors.push(behavior);
      calls.overlays.push(overlay);
    },
    showToast: (message, variant, durationMs) => {
      calls.toasts.push({ message, variant, durationMs });
    },
    openSettingsOverlay: () => undefined,
    openPluginsOverlay: () => undefined,
    openPromptInExternalEditor: (initialText) => {
      calls.externalEditorPrompts.push(initialText ?? "");
    },
    hideOverlay: () => undefined,
    setWelcomeDismissed: () => undefined,
    setShowThreadSidebar: () => undefined,
    setSidebarFocused: () => undefined,
    setSidebarFocusedIndex: () => undefined,
    acpClient: () => acpClient,
    activeAgentName: () => "faux",
    pluginRunner: () => options.pluginRunner ?? null,
    reloadPlugins: () => null,
    exitRenderer: () => null,
    commandContext: (app) => ({
      cwd: app.state.cwd,
      sessionId: null,
      threadId: app.state.activeThreadId,
      userMessageCount: app.state.blocks.filter((block) => block.type === "user").length,
      running: false,
      waitForIdle: () => Promise.resolve(),
      toast: () => undefined,
    }),
    runBuiltinSkillCommand: async (_app, skill: BuiltinSkill, args, ctx) => {
      calls.builtinSkills.push(`${skill.name}:${args}@${ctx.cwd}`);
    },
    runNativeHandoffCommand: async (_app, args, ctx) => {
      calls.nativeHandoffs.push(`${args}@${ctx.cwd}`);
    },
    disabledBuiltinSlashCommands: () => options.disabledBuiltinSlashCommands ?? [],
    ...(options.runTerminalAuth
      ? {
          runTerminalAuth: async (method: RelayAuthMethod) => {
            calls.terminalAuthMethods.push(method.id);
          },
        }
      : {}),
  };
}

function createCalls(): HandlerCalls {
  return {
    createdThreads: [],
    createdThreadTitles: [],
    forkedThreads: 0,
    ensuredSessions: 0,
    submittedPrompts: [],
    externalEditorPrompts: [],
    switchedModels: [],
    loadedSessions: [],
    builtinSkills: [],
    nativeHandoffs: [],
    authenticatedMethods: [],
    terminalAuthMethods: [],
    loggedOut: 0,
    blocks: [],
    toasts: [],
    overlays: [],
    overlayBehaviors: [],
  };
}

describe("createSlashCommandHandler", () => {
  test("queues session-owned slash commands while ACP is still connecting", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls));

    await handler("/models model-b", createApp({ connecting: true }));

    expect(calls.submittedPrompts).toEqual(["/models model-b"]);
    expect(calls.ensuredSessions).toBe(0);
    expect(calls.switchedModels).toEqual([]);
  });

  test("opens model selection with the default overlay layout", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls));
    const availableModels: SessionModelOption[] = [
      { modelId: "model-a", name: "Model A", description: "fast" },
      { modelId: "model-b", name: "Model B" },
    ];

    await handler("/models", createApp({ availableModels, modelId: "model-b" }));

    expect(calls.overlays).toEqual([
      {
        mode: SelectionMode.MODEL,
        items: [
          {
            value: availableModels[0],
            label: "model-a",
            description: "Model A · fast",
            active: false,
          },
          {
            value: availableModels[1],
            label: "model-b",
            description: "Model B",
            active: true,
          },
        ],
      },
    ]);
  });

  test("opens the selected model's thinking levels after switching models", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls));
    const availableModels: SessionModelOption[] = [{ modelId: "model-a", name: "Model A" }];
    const availableThinkingLevels: SessionThinkingLevelOption[] = [
      { id: "low", name: "Low" },
      { id: "high", name: "High", description: "More reasoning" },
    ];
    const app = createApp({ availableModels, availableThinkingLevels, thinkingLevel: "high" });

    await handler("/models", app);
    expect(calls.overlayBehaviors[0]?.closeOnSelect).toBe(false);
    calls.overlayBehaviors[0]?.onSelect(calls.overlays[0].items[0], app);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.switchedModels).toEqual(["model-a"]);
    expect(calls.overlays[1]).toEqual({
      mode: SelectionMode.THINKING,
      selectedIndex: 0,
      layout: { labelMinWidth: 16, labelMaxWidth: 32 },
      items: [
        { value: availableThinkingLevels[0], label: "low", description: "Low", active: false },
        {
          value: availableThinkingLevels[1],
          label: "high",
          description: "High · More reasoning",
          active: true,
        },
      ],
    });
  });

  test("keeps preferred existing native commands ahead of ACP conflicts", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls));
    const app = createApp({ availableModels: [{ modelId: "model-a", name: "Model A" }] });
    app.setState("availableCommands", [{ name: "models", description: "Agent models" }]);

    await handler("/models model-a", app);

    expect(calls.switchedModels).toEqual(["model-a"]);
    expect(calls.submittedPrompts).toEqual([]);
  });

  test("dispatches plugin commands before ACP-advertised commands", async () => {
    const calls = createCalls();
    const runner = new PluginRunner({ cwd: "/tmp/relay-thread-one" });
    const pluginEvents: string[] = [];
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.commands.register("review", {
          run(args) {
            pluginEvents.push(args);
          },
        });
      },
    });
    const handler = createSlashCommandHandler(createDeps(calls, { pluginRunner: runner }));
    const app = createApp();
    app.setState("availableCommands", [{ name: "review", description: "Agent review" }]);

    await handler("/review now", app);

    expect(pluginEvents).toEqual(["now"]);
    expect(calls.submittedPrompts).toEqual([]);
  });

  test("dispatches built-in skills and native handoff while forwarding non-native goal", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls));
    const app = createApp();

    await handler("/review #214", app);
    await handler("/goal ship it", app);
    await handler("/handoff continue in a new thread", app);

    expect(calls.builtinSkills).toEqual(["review:#214@/tmp/relay-thread-one"]);
    expect(calls.nativeHandoffs).toEqual(["continue in a new thread@/tmp/relay-thread-one"]);
    expect(calls.submittedPrompts).toEqual(["/goal ship it"]);
  });

  test("keeps Relay built-ins ahead of agent commands while forwarding goal", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls));
    const app = createApp();
    app.setState("availableCommands", [
      { name: "review", description: "Agent review" },
      { name: "goal", description: "Agent goal" },
    ]);

    await handler("/review #214", app);
    await handler("/goal ship it", app);
    await handler("/relay.goal ship it", app);

    expect(calls.submittedPrompts).toEqual(["/goal ship it", "/relay.goal ship it"]);
    expect(calls.builtinSkills).toEqual(["review:#214@/tmp/relay-thread-one"]);
  });

  test("disabled Relay built-ins fall through to agent commands", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls, { disabledBuiltinSlashCommands: ["review"] }));
    const app = createApp();
    app.setState("availableCommands", [
      { name: "review", description: "Agent review" },
      { name: "goal", description: "Agent goal" },
    ]);

    await handler("/review #214", app);
    await handler("/goal ship it", app);

    expect(calls.submittedPrompts).toEqual(["/review #214", "/goal ship it"]);
    expect(calls.builtinSkills).toEqual([]);
  });

  test("disabled Relay built-in aliases fall through to agent commands", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls, { disabledBuiltinSlashCommands: ["models"] }));
    const app = createApp({ availableModels: [{ modelId: "native-model", name: "Native model" }] });
    app.setState("availableCommands", [{ name: "model", description: "Agent model" }]);

    await handler("/model custom-model", app);

    expect(calls.submittedPrompts).toEqual(["/model custom-model"]);
    expect(calls.switchedModels).toEqual([]);
  });

  test("dispatches bundled authoring skills locally", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls));

    await handler("/relay-plugins add a command", createApp());
    await handler("/relay-themes midnight", createApp());

    expect(calls.builtinSkills).toEqual([
      "relay-plugins:add a command@/tmp/relay-thread-one",
      "relay-themes:midnight@/tmp/relay-thread-one",
    ]);
    expect(calls.submittedPrompts).toEqual([]);
  });

  test("shows enabled MCP servers without ensuring a session", async () => {
    const calls = createCalls();
    const runner = new PluginRunner({ cwd: "/tmp/relay-thread-one" });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.mcp.addServer({ name: "faux-mcp", command: "faux-mcp", args: ["--stdio"], env: { TOKEN: "secret" } });
      },
    });
    const handler = createSlashCommandHandler(createDeps(calls, { pluginRunner: runner }));

    await handler("/mcp", createApp({ blocks: calls.blocks }));

    expect(calls.blocks.join("\n")).toContain("Enabled MCP servers");
    expect(calls.blocks.join("\n")).toContain("faux-mcp: faux-mcp --stdio · 1 env var");
    expect(calls.ensuredSessions).toBe(0);
    expect(calls.submittedPrompts).toEqual([]);
  });

  test("uses a toast for transient copy feedback", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls));

    await handler("/copy", createApp({ blocks: calls.blocks }));

    expect(calls.blocks).toEqual([]);
    expect(calls.toasts).toEqual([
      { message: "No assistant response to copy", variant: "warning", durationMs: undefined },
    ]);
  });

  test("dispatches native edit locally without ensuring a session", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls));

    await handler("/edit draft text", createApp());

    expect(calls.externalEditorPrompts).toEqual(["draft text"]);
    expect(calls.submittedPrompts).toEqual([]);
    expect(calls.ensuredSessions).toBe(0);
  });

  test("opens a message-only conversation tree without ensuring a session", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls));
    const chatBlocks: ChatBlock[] = [
      { type: "user", id: "u1", content: "show me\n the tree" },
      { type: "thinking", id: "th1", content: "hidden", finalized: true },
      {
        type: "tool",
        id: "t1",
        toolCallId: "tc1",
        toolName: "read",
        display: "src/main.ts",
        status: "success",
      },
      { type: "content", id: "c1", content: "Here it is.", finalized: true },
      { type: "info", id: "i1", content: "not a message", variant: "info" },
    ];

    await handler("/tree", createApp({ blocks: calls.blocks, chatBlocks }));

    expect(calls.blocks).toEqual([]);
    expect(calls.toasts).toEqual([
      {
        message:
          "Conversation tree is incomplete: it is currently read-only and cannot fork or branch from a selected point.",
        variant: "warning",
        durationMs: 6000,
      },
    ]);
    expect(calls.overlays).toHaveLength(1);
    expect(calls.overlays[0].mode).toBe(SelectionMode.TREE);
    expect(calls.overlays[0].selectedIndex).toBe(2);
    expect(calls.overlays[0].items.map((item) => item.label)).toEqual([
      "• user: show me the tree",
      "• [read: src/main.ts]",
      "• assistant: Here it is.",
    ]);
    expect(calls.ensuredSessions).toBe(0);
    expect(calls.submittedPrompts).toEqual([]);
  });

  test("exports the active conversation to markdown without ensuring a session", async () => {
    const calls = createCalls();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "relay-export-test-"));
    const handler = createSlashCommandHandler(createDeps(calls));

    await handler(
      "/export",
      createApp({
        cwd,
        blocks: calls.blocks,
        chatBlocks: [
          { type: "user", id: "u1", content: "hello" },
          {
            type: "tool",
            id: "t1",
            toolCallId: "tc1",
            toolName: "bash",
            display: "bun test",
            status: "success",
            rawInput: null,
            rawOutput: null,
          },
          { type: "thinking", id: "th1", content: "hidden", finalized: true },
          {
            type: "tool",
            id: "t2",
            toolCallId: "tc2",
            toolName: "read_file",
            display: "read",
            status: "success",
            rawInput: null,
            rawOutput: null,
          },
          { type: "content", id: "c1", content: "hi", finalized: true },
        ],
      }),
    );

    const exported = fs.readdirSync(cwd).filter((entry) => entry.startsWith("relay-export-"));
    expect(exported).toHaveLength(1);
    const markdown = fs.readFileSync(path.join(cwd, exported[0]), "utf-8");
    expect(markdown).toContain("## User\n\nhello");
    expect(markdown).toContain("> Tool activity: 2 calls: bash, read_file");
    expect(markdown).toContain("## Assistant\n\nhi");
    expect(markdown).not.toContain("hidden");
    expect(calls.blocks.join("\n")).toContain("Exported conversation to");
    expect(calls.ensuredSessions).toBe(0);
    expect(calls.submittedPrompts).toEqual([]);
  });

  test("dispatches native new-thread aliases locally", async () => {
    for (const command of ["/thread", "/worktree"]) {
      const calls = createCalls();
      const handler = createSlashCommandHandler(createDeps(calls));

      await handler(command, createApp());

      expect(calls.createdThreads).toEqual([false]);
      expect(calls.submittedPrompts).toEqual([]);
      expect(calls.ensuredSessions).toBe(0);
    }
  });

  test("uses /new arguments as the thread title", async () => {
    for (const [command, title] of [
      ["/new", undefined],
      ["/new  Fix   login bug ", "Fix login bug"],
      ["/thread Refactor parser", "Refactor parser"],
    ] as const) {
      const calls = createCalls();
      await createSlashCommandHandler(createDeps(calls))(command, createApp());
      expect(calls.createdThreadTitles).toEqual([title]);
    }
  });

  test("dispatches native fork locally after ensuring a session", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls));

    await handler("/fork", createApp());

    expect(calls.forkedThreads).toBe(1);
    expect(calls.submittedPrompts).toEqual([]);
    expect(calls.ensuredSessions).toBe(1);
  });

  test("dispatches explicit native login without ensuring a session", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls));

    await handler("/login oauth", createApp());

    expect(calls.authenticatedMethods).toEqual(["oauth"]);
    expect(calls.ensuredSessions).toBe(0);
    expect(calls.submittedPrompts).toEqual([]);
  });

  test("runs terminal auth before ACP authenticate for terminal methods", async () => {
    const calls = createCalls();
    const terminalMethod: RelayAuthMethod = {
      id: "terminal",
      name: "Terminal",
      type: "terminal",
      terminal: { command: "agent", args: ["auth", "login"] },
      supported: true,
    };
    const handler = createSlashCommandHandler(
      createDeps(calls, { authMethods: [terminalMethod], runTerminalAuth: true }),
    );

    await handler("/login terminal", createApp({ authMethods: [terminalMethod] }));

    expect(calls.terminalAuthMethods).toEqual(["terminal"]);
    expect(calls.authenticatedMethods).toEqual(["terminal"]);
    expect(calls.ensuredSessions).toBe(0);
    expect(calls.submittedPrompts).toEqual([]);
  });

  test("dispatches explicit resume when session/resume is available without session/load", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(
      createDeps(calls, { supportsSessionLoad: false, supportsSessionResume: true }),
    );

    await handler("/resume existing-session", createApp());

    expect(calls.loadedSessions).toEqual(["existing-session"]);
    expect(calls.submittedPrompts).toEqual([]);
  });

  test("opens auth method selection when multiple login methods are available", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls));

    await handler(
      "/login",
      createApp({
        authMethods: [
          { id: "oauth", name: "OAuth", type: "agent", supported: true },
          { id: "device", name: "Device", type: "agent", supported: true },
        ],
      }),
    );

    expect(calls.authenticatedMethods).toEqual([]);
    expect(calls.overlays).toEqual([
      {
        mode: SelectionMode.AUTH_METHOD,
        items: [
          {
            value: { id: "oauth", name: "OAuth", type: "agent", supported: true },
            label: "OAuth",
            description: "oauth",
          },
          {
            value: { id: "device", name: "Device", type: "agent", supported: true },
            label: "Device",
            description: "device",
          },
        ],
      },
    ]);
  });

  test("shows actionable guidance when only env-var auth is advertised", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls));

    await handler(
      "/login",
      createApp({
        blocks: calls.blocks,
        authMethods: [
          {
            id: "api-key",
            name: "API key",
            type: "env_var",
            vars: [
              { name: "API_KEY", label: "API key", secret: true, optional: false },
              { name: "API_BASE_URL", secret: false, optional: true },
            ],
            link: "https://example.com/key",
            supported: false,
            unsupportedReason: "Relay cannot pass new environment variables to an already-running ACP agent.",
          },
        ],
      }),
    );

    expect(calls.authenticatedMethods).toEqual([]);
    expect(calls.blocks.join("\n")).toContain("Required environment variables: API_KEY (API key)");
    expect(calls.blocks.join("\n")).toContain("Optional environment variables: API_BASE_URL");
    expect(calls.blocks.join("\n")).toContain("Credential URL: https://example.com/key");
    expect(calls.blocks.join("\n")).toContain("restart Relay, then run /login api-key");
  });

  test("shows unsupported method details for explicit login method ids", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls));

    await handler("/login terminal", createApp({ blocks: calls.blocks }));

    expect(calls.authenticatedMethods).toEqual([]);
    expect(calls.blocks.join("\n")).toContain("Terminal auth requires ACP terminal client support");
  });

  test("toggles Relay yoloo and adds info messages when the agent does not publish it", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls));
    const app = createApp({ blocks: calls.blocks });

    await handler("/yoloo", app);
    expect(store.threadYoloEnabled.has("thread-1")).toBe(true);
    expect(calls.blocks).toEqual(["/yoloo enabled: All requests, including unsafe commands, are auto-approved."]);

    await handler("/yoloo", app);
    expect(store.threadYoloEnabled.has("thread-1")).toBe(false);
    expect(calls.blocks[1]).toBe("/yoloo disabled: Permission requests will require approval.");
    expect(calls.submittedPrompts).toEqual([]);
  });

  test("forwards yoloo when the ACP agent publishes the command", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls));
    const app = createApp({ blocks: calls.blocks });
    app.setState("availableCommands", [{ name: "yoloo", description: "Agent yoloo" }]);

    await handler("/yoloo", app);

    expect(calls.submittedPrompts).toEqual(["/yoloo"]);
    expect(store.threadYoloEnabled.has("thread-1")).toBe(false);
    expect(calls.blocks).toEqual([]);
  });

  test("dispatches native logout without ensuring a session", async () => {
    const calls = createCalls();
    const handler = createSlashCommandHandler(createDeps(calls));

    await handler("/logout", createApp());

    expect(calls.loggedOut).toBe(1);
    expect(calls.ensuredSessions).toBe(0);
    expect(calls.submittedPrompts).toEqual([]);
  });
});
