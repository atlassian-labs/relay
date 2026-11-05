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
import type { RelaySessionUpdate } from "../../../src/acp/sdk";
import { agentCommandCacheKey, writeCachedAgentCommands } from "../../../src/ui/app/agent-command-cache";
import { updateConfig } from "../../../src/config";

type RenderedFauxApp = Awaited<ReturnType<typeof renderFauxApp>>;

function relaySettingConfigUpdate(optionId: string, value: boolean | number | string): RelaySessionUpdate {
  return { sessionUpdate: "config_option_update", optionId, value } as unknown as RelaySessionUpdate;
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

async function selectOverlayItemByLabel(app: RenderedFauxApp, label: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await waitFor(() => {
      app.renderOnce();
      return app.captureCharFrame().includes(`→ ${label}`);
    }, 100).catch(() => undefined);
    app.renderOnce();
    if (app.captureCharFrame().includes(`→ ${label}`)) return;
    app.mockInput.pressArrow("down");
    await Bun.sleep(0);
  }

  app.renderOnce();
  expect(app.captureCharFrame()).toContain(`→ ${label}`);
}

describe("App frame-capture E2E: settings, config, and sessions", () => {
  test("ACP config option update cannot change fixed tool-name styling", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      faux.emit(relaySettingConfigUpdate("relay.ui.color_tool_names", false));
      await Bun.sleep(20);
      app.renderOnce();

      expect(fs.readFileSync(path.join(getConfigDir(), "config.toml"), "utf-8")).not.toContain("color_tool_names");
      expect(app.captureCharFrame()).not.toContain("Updated setting: Color tool names");
    } finally {
      app.renderer.destroy();
    }
  });

  test("ACP config option update cannot enable notification sounds", async () => {
    setConfig(
      new Config({
        notifications: { sound_enabled: false },
        agents: {
          default: "faux",
          runners: {
            faux: { command: "faux-agent", args: [], profile: "default" },
          },
        },
      }),
    );
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(
      path.join(getConfigDir(), "config.toml"),
      '[notifications]\nsound_enabled = false\n\n[agents]\ndefault = "faux"\n\n[agents.runners.faux]\ncommand = "faux-agent"\nargs = []\nprofile = "default"\n',
      "utf-8",
    );
    resetConfig();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      faux.emit(relaySettingConfigUpdate("relay.notifications.sound_enabled", true));
      await Bun.sleep(20);
      app.renderOnce();

      const configText = fs.readFileSync(path.join(getConfigDir(), "config.toml"), "utf-8");
      expect(configText).toContain("sound_enabled = false");
      expect(configText).not.toContain("sound_enabled = true");
      expect(configText).not.toContain("color_tool_names");
      expect(getConfig().notifications.sound_enabled).toBe(false);
      expect(app.captureCharFrame()).not.toContain("Updated setting: Notification sounds");
    } finally {
      app.renderer.destroy();
    }
  });

  test("hydrates active session model on fresh startup", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      capabilities: {
        currentModelId: "gpt-5.5-xhigh",
        availableModels: [{ modelId: "gpt-5.5-xhigh", name: "GPT 5.5 xhigh" }],
      },
    });
    const app = await renderFauxApp(cwd, faux, { width: 110 });

    try {
      await waitForConnected(app);
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("gpt-5.5-xhigh");
        expect(frame).not.toContain("(no model)");
      });
      expect(faux.newSessions).toEqual([{ cwd }]);

      await submitPrompt(app, "first real prompt");
      await waitFor(() => expect(faux.prompts).toEqual(["first real prompt"]));
      expect(faux.newSessions).toEqual([{ cwd }]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("places agent mode above model effort in footer", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      capabilities: {
        currentModelId: "model-a",
        availableModels: [{ modelId: "model-a", name: "Model A" }],
        currentThinkingLevel: "low",
        availableThinkingLevels: [{ id: "low", name: "Low" }],
        availableModes: [{ id: "review", name: "Review" }],
        currentModeId: "review",
      },
    });
    const app = await renderFauxApp(cwd, faux, { width: 100, height: 30 });

    try {
      await waitForConnected(app);
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        const lines = frame.split("\n").filter((line) => line.trim().length > 0);
        const footerBottomLine = lines.at(-1) ?? "";
        const footerTopLine = lines.at(-2) ?? "";

        expect(footerTopLine).toContain("faux (review)");
        expect(footerBottomLine).not.toContain("context • tokens");
        expect(footerBottomLine).toContain("model-a • low");
        expect(footerBottomLine).not.toContain("faux • model-a");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("Relay-owned slash commands do not create an extra ACP session", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await waitFor(() => expect(faux.newSessions).toEqual([{ cwd }]));

      await app.mockInput.typeText("/settings");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("slash panel position");
      });
      expect(faux.newSessions).toEqual([{ cwd }]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("cached ACP commands are available to slash autocomplete before startup session warms", async () => {
    configureFauxAgent();
    writeCachedAgentCommands(
      agentCommandCacheKey({
        agentName: "faux",
        profile: "default",
        transport: "stdio",
        command: "faux-agent",
        args: [],
      }),
      [{ name: "cached-skill", description: "cached startup command" }],
    );
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ connectDelayMs: 1000 });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain(">");
      });

      await app.mockInput.typeText("/cached-");

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("/cached-skill");
        expect(frame).toContain("cached startup command");
      }, 500);
      expect(faux.newSessions).toEqual([]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("cached ACP commands remain visible after session starts without authoritative commands", async () => {
    configureFauxAgent();
    writeCachedAgentCommands(
      agentCommandCacheKey({
        agentName: "faux",
        profile: "default",
        transport: "stdio",
        command: "faux-agent",
        args: [],
      }),
      [{ name: "cached-skill", description: "cached startup command" }],
    );
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await waitFor(() => expect(faux.newSessions).toEqual([{ cwd }]));

      await app.mockInput.typeText("/cached-");

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("/cached-skill");
        expect(frame).toContain("cached startup command");
      }, 500);
    } finally {
      app.renderer.destroy();
    }
  });

  test("bare slash autocomplete shows native commands while reusing startup ACP capabilities", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await waitFor(() => expect(faux.newSessions).toEqual([{ cwd }]));

      await app.mockInput.typeText("/");

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("/copy");
      });
      expect(faux.newSessions).toEqual([{ cwd }]);
      expect(faux.prompts).toEqual([]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("ACP commands published during startup config survive its partial capability result", async () => {
    configureFauxAgent("model-b");
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      capabilities: {
        currentModelId: "model-a",
        availableModels: [
          { modelId: "model-a", name: "Model A" },
          { modelId: "model-b", name: "Model B" },
        ],
      },
      availableCommandsOnConfigChange: [
        { name: "directories", description: "Manage agent directories" },
        { name: "herdr", description: "Control Herdr" },
      ],
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(faux.modelChanges).toEqual(["model-b"]);
        expect(app.captureCharFrame()).toContain("model-b");
      });

      await app.mockInput.typeText("/directories");

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("/directories");
        expect(frame).toContain("manage agent directories");
      });
      expect(faux.prompts).toEqual([]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("delayed ACP command updates reopen slash autocomplete for an agent-only prefix", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);
    const command = { name: "real-skill", description: "agent-side real skill command" };

    try {
      await waitForConnected(app);
      await waitFor(() => expect(faux.newSessions).toEqual([{ cwd }]));

      await app.mockInput.typeText("/real-");
      app.renderOnce();
      expect(app.captureCharFrame()).not.toContain("agent-side real skill command");

      faux.emit(acpAvailableCommands([command]));

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("/real-skill");
        expect(frame).toContain("agent-side real skill command");
      });
      expect(faux.prompts).toEqual([]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("delayed ACP command updates do not reopen slash autocomplete after prompt text changes", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);
    const command = { name: "real-skill", description: "agent-side real skill command" };

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/real-");
      await waitFor(() => expect(faux.newSessions).toEqual([{ cwd }]));

      await app.mockInput.typeText(" normal text");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("/real- normal text");
      });
      faux.emit(acpAvailableCommands([command]));
      await Bun.sleep(0);

      app.renderOnce();
      const frame = app.captureCharFrame();
      expect(frame).toContain("/real- normal text");
      expect(frame).not.toContain("/real-skill");
      expect(frame).not.toContain("agent-side real skill command");
    } finally {
      app.renderer.destroy();
    }
  });

  test("delayed ACP command updates do not replace a non-autocomplete overlay", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);
    const command = { name: "real-skill", description: "agent-side real skill command" };

    try {
      await waitForConnected(app);
      await submitPrompt(app, "first prompt uses warmed session before delayed commands");
      await waitFor(() => expect(faux.prompts).toEqual(["first prompt uses warmed session before delayed commands"]));
      expect(faux.newSessions).toEqual([{ cwd }]);

      await app.mockInput.typeText("/settings");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("slash panel position");
      });

      faux.emit(acpAvailableCommands([command]));
      await Bun.sleep(0);

      app.renderOnce();
      const frame = app.captureCharFrame();
      expect(frame).toContain("slash panel position");
      expect(frame).not.toContain("/real-skill");
      expect(frame).not.toContain("agent-side real skill command");
    } finally {
      app.renderer.destroy();
    }
  });

  test("agent-owned slash commands show session startup failures", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ rejectNewSession: true });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("ACP session capabilities failed: Failed to start new session");
      });
      await app.mockInput.typeText("/models model-b");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Failed to start ACP session: Failed to start new session");
      });
      expect(faux.prompts).toEqual([]);
      expect(faux.modelChanges).toEqual([]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("native model alias wins over an agent-advertised /model command", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      availableCommands: [{ name: "model", description: "agent model command" }],
      capabilities: {
        currentModelId: "model-a",
        availableModels: [
          { modelId: "model-a", name: "Model A" },
          { modelId: "model-b", name: "Model B" },
        ],
      },
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/model model-b");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Switched to model: model-b");
      });
      expect(faux.modelChanges).toEqual(["model-b"]);
      expect(faux.prompts).toEqual([]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("/settings opens an interactive menu and toggles settings persistently", async () => {
    setConfig(
      new Config({
        ui: { tool_result_preview_lines: 5 },
        notifications: { sound_enabled: false },
        agents: {
          default: "faux",
          runners: {
            faux: { command: "faux-agent", args: [], profile: "default" },
          },
        },
      }),
    );
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(
      path.join(getConfigDir(), "config.toml"),
      '[ui]\ntool_result_preview_lines = 5\n\n[notifications]\nsound_enabled = false\n\n[agents]\ndefault = "faux"\n\n[agents.runners.faux]\ncommand = "faux-agent"\nargs = []\nprofile = "default"\n',
      "utf-8",
    );
    resetConfig();
    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/settings");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("mermaid rendering: streaming");
        expect(frame).toContain("notifications");
        expect(frame).toContain("slash panel position: bottom");
      });

      await selectOverlayItemByLabel(app, "tool result preview lines: 5");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("→ 5");
        expect(frame).toContain("10");
      });

      app.mockInput.pressArrow("down");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("→ tool result preview lines: 10");
      });
      expect(fs.readFileSync(path.join(getConfigDir(), "config.toml"), "utf-8")).toContain(
        "tool_result_preview_lines = 10",
      );
    } finally {
      app.renderer.destroy();
    }
  });

  for (const transcriptRendererMode of ["legacy", "windowed"] as const) {
    test(`changing tool result preview lines redraws existing tool blocks (${transcriptRendererMode})`, async () => {
      configureFauxAgent();
      const faux = createFauxAcpAgent();
      const app = await renderFauxApp(tmpWorkspace(), faux, { transcriptRendererMode });

      try {
        await waitForConnected(app);
        faux.emit(acpToolCallStart({ toolCallId: "tc_preview", toolName: "bash" }));
        faux.emit(
          acpToolCallUpdate({
            toolCallId: "tc_preview",
            status: "success",
            rawOutput: "line one\nline two\nline three",
          }),
        );
        await waitFor(() => {
          app.renderOnce();
          expect(app.captureCharFrame()).toContain("line two");
        });

        updateConfig((data) => {
          data.ui = { ...(data.ui as Record<string, unknown>), tool_result_preview_lines: 0 };
        });
        await waitFor(() => {
          app.renderOnce();
          expect(app.captureCharFrame()).not.toContain("line one");
        });
      } finally {
        app.renderer.destroy();
      }
    });
  }

  test("/settings search selects the best label match", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/settings");
      app.mockInput.pressEnter();
      await app.mockInput.typeText("the");

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("→ themes:");
        expect(frame).not.toContain("notifications");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("/settings configures the prompt marker with curated choices", async () => {
    setConfig(
      new Config({
        ui: { prompt_marker: ">" },
        agents: {
          default: "faux",
          runners: {
            faux: { command: "faux-agent", args: [], profile: "default" },
          },
        },
      }),
    );
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(
      path.join(getConfigDir(), "config.toml"),
      '[ui]\nprompt_marker = ">"\n\n[agents]\ndefault = "faux"\n\n[agents.runners.faux]\ncommand = "faux-agent"\nargs = []\nprofile = "default"\n',
      "utf-8",
    );
    resetConfig();
    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/settings");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("prompt marker: >");
      });

      await selectOverlayItemByLabel(app, "prompt marker: >");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("→ >");
        expect(frame).toContain("❯");
      });

      app.mockInput.pressArrow("down");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("→ prompt marker: ❯");
      });
      expect(fs.readFileSync(path.join(getConfigDir(), "config.toml"), "utf-8")).toContain('prompt_marker = "❯"');
    } finally {
      app.renderer.destroy();
    }
  });

  test("/settings configures the editor style with curated choices", async () => {
    setConfig(
      new Config({
        ui: { editor_style: "codex" },
        agents: {
          default: "faux",
          runners: {
            faux: { command: "faux-agent", args: [], profile: "default" },
          },
        },
      }),
    );
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(
      path.join(getConfigDir(), "config.toml"),
      '[ui]\neditor_style = "codex"\n\n[agents]\ndefault = "faux"\n\n[agents.runners.faux]\ncommand = "faux-agent"\nargs = []\nprofile = "default"\n',
      "utf-8",
    );
    resetConfig();
    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/settings");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("editor style: codex");
      });

      await selectOverlayItemByLabel(app, "editor style: codex");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("→ codex");
        expect(frame).toContain("pi");
      });

      app.mockInput.pressArrow("down");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("→ editor style: pi");
      });
      expect(fs.readFileSync(path.join(getConfigDir(), "config.toml"), "utf-8")).toContain('editor_style = "pi"');
    } finally {
      app.renderer.destroy();
    }
  });

  test("/settings keeps the selected plugin setting row after toggling", async () => {
    const cwd = tmpWorkspace();
    const pluginPath = path.join(cwd, "settings-plugin.mjs");
    fs.writeFileSync(
      pluginPath,
      `export default function plugin(relay) {
  relay.settings.define("pull_requests_enabled", {
    title: "Pull requests",
    description: "Show a demo pull request surface.",
    type: "boolean",
    default: true,
  });
}
`,
    );
    writeFauxConfig(`[plugins]
enabled = true
allow_project_plugins = false
paths = [${JSON.stringify(pluginPath)}]
trusted_workspaces = []
disabled = []

[notifications]
sound_enabled = false

[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
`);
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/settings");
      app.mockInput.pressEnter();

      await selectOverlayItemByLabel(app, "settings-plugin: pull requests: on");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("→ settings-plugin: pull requests: off");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("/settings persists thinking visibility across app restarts", async () => {
    writeFauxConfig(`[ui]
show_thinking = true

[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
`);
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      faux.emit(acpThinkingChunk("visible thought before toggle"));
      faux.emit(acpAgentMessageChunk("response before toggle"));
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("visible thought before toggle");
        expect(frame).toContain("response before toggle");
      });

      await app.mockInput.typeText("/settings");
      app.mockInput.pressEnter();

      await selectOverlayItemByLabel(app, "thinking visibility: on");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("→ thinking visibility: off");
      });
      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).not.toContain("visible thought before toggle");
      });
      expect(fs.readFileSync(path.join(getConfigDir(), "config.toml"), "utf-8")).toContain("show_thinking = false");
    } finally {
      app.renderer.destroy();
    }

    resetConfig();
    const restartedFaux = createFauxAcpAgent();
    const restartedApp = await renderFauxApp(cwd, restartedFaux);
    try {
      await waitForConnected(restartedApp);
      await restartedApp.mockInput.typeText("/settings");
      restartedApp.mockInput.pressEnter();

      await selectOverlayItemByLabel(restartedApp, "thinking visibility: off");
      restartedApp.renderOnce();
      expect(restartedApp.captureCharFrame()).toContain("→ thinking visibility: off");
      restartedApp.mockInput.pressEscape();

      restartedFaux.emit(acpThinkingChunk("hidden thought after restart"));
      restartedFaux.emit(acpAgentMessageChunk("response after restart"));
      await waitFor(() => {
        restartedApp.renderOnce();
        const frame = restartedApp.captureCharFrame();
        expect(frame).toContain("response after restart");
        expect(frame).not.toContain("hidden thought after restart");
      });
    } finally {
      restartedApp.renderer.destroy();
    }
  });

  test("/plugins opens an interactive menu and toggles plugins persistently", async () => {
    const cwd = tmpWorkspace();
    const pluginPath = path.join(process.cwd(), "test", "fixtures", "plugins", "demo-plugin.mjs");
    writeFauxConfig(`[plugins]
enabled = true
allow_project_plugins = false
paths = [${JSON.stringify(pluginPath)}]
trusted_workspaces = []
disabled = [${JSON.stringify(`config:${pluginPath}`)}]

[notifications]
sound_enabled = false

[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
`);
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/plugins");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Enable/disable all plugins");
        expect(frame).toContain("[-] demo-plugin");
      });

      for (let i = 0; i < 8; i++) {
        app.renderOnce();
        if (app.captureCharFrame().includes("› [-] demo-plugin")) break;
        app.mockInput.pressArrow("down");
        await Bun.sleep(0);
      }
      app.renderOnce();
      expect(app.captureCharFrame()).toContain("› [-] demo-plugin");
      emitKey(app, "space", { sequence: " ", raw: " " });

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("› [*] demo-plugin");
      });
      const configText = fs.readFileSync(path.join(getConfigDir(), "config.toml"), "utf-8");
      expect(configText).not.toContain(`config:${pluginPath}`);
    } finally {
      app.renderer.destroy();
    }
  });

  test("/settings opens a nested theme picker", async () => {
    const themeIds = getThemeIds();
    const initialTheme = themeIds[0];
    const nextTheme = themeIds[1];
    if (!initialTheme || !nextTheme) throw new Error("expected at least two themes");
    setConfig(
      new Config({
        ui: { theme: initialTheme },
        agents: {
          default: "faux",
          runners: {
            faux: { command: "faux-agent", args: [], profile: "default" },
          },
        },
      }),
    );
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(
      path.join(getConfigDir(), "config.toml"),
      `[ui]\ntheme = "${initialTheme}"\n\n[agents]\ndefault = "faux"\n\n[agents.runners.faux]\ncommand = "faux-agent"\nargs = []\nprofile = "default"\n`,
      "utf-8",
    );
    resetConfig();
    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/settings");
      app.mockInput.pressEnter();

      await selectOverlayItemByLabel(app, `themes: ${initialTheme}`);
      app.mockInput.pressKey("TAB");

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain(`→ ${initialTheme}`);
        expect(frame).not.toContain("tool result preview lines:");
      });

      app.mockInput.pressArrow("down");
      app.mockInput.pressKey("TAB");

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain(`→ themes: ${nextTheme}`);
      });
      expect(fs.readFileSync(path.join(getConfigDir(), "config.toml"), "utf-8")).toContain(`theme = "${nextTheme}"`);
    } finally {
      app.renderer.destroy();
    }
  });

  test("/settings opens nested numeric setting pickers", async () => {
    // Skip 0, which is labelled "off" rather than a number.
    const previewChoices = SETTING_VALUE_CHOICES["ui.tool_result_preview_lines"]?.filter(({ value }) => value !== 0);
    const initialPreviewLines = previewChoices?.[0]?.value;
    const nextPreviewLines = previewChoices?.[1]?.value;
    if (typeof initialPreviewLines !== "number" || typeof nextPreviewLines !== "number") {
      throw new Error("expected at least two numeric tool result preview choices");
    }
    setConfig(
      new Config({
        ui: { tool_result_preview_lines: initialPreviewLines },
        notifications: { terminal_enabled: true, sound_enabled: true, volume: 0.5 },
        agents: {
          default: "faux",
          runners: {
            faux: { command: "faux-agent", args: [], profile: "default" },
          },
        },
      }),
    );
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(
      path.join(getConfigDir(), "config.toml"),
      `[ui]\ntool_result_preview_lines = ${initialPreviewLines}\n\n[notifications]\nterminal_enabled = true\nsound_enabled = true\nvolume = 0.5\n\n[agents]\ndefault = "faux"\n\n[agents.runners.faux]\ncommand = "faux-agent"\nargs = []\nprofile = "default"\n`,
      "utf-8",
    );
    resetConfig();
    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/settings");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("notifications");
      });

      await selectOverlayItemByLabel(app, `tool result preview lines: ${initialPreviewLines}`);
      app.mockInput.pressKey("TAB");

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain(`→ ${initialPreviewLines}`);
        expect(frame).not.toContain("themes:");
      });

      app.mockInput.pressArrow("down");
      app.mockInput.pressKey("TAB");

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain(`→ tool result preview lines: ${nextPreviewLines}`);
      });
      expect(fs.readFileSync(path.join(getConfigDir(), "config.toml"), "utf-8")).toContain(
        `tool_result_preview_lines = ${nextPreviewLines}`,
      );

      await selectOverlayItemByLabel(app, "notifications");
      app.mockInput.pressKey("TAB");

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("terminal notifications: on");
        expect(frame).toContain("notification sounds: on");
        expect(frame).toContain("notification volume: 50%");
        expect(frame).not.toContain("themes:");
      });

      await selectOverlayItemByLabel(app, "notification volume: 50%");
      app.mockInput.pressKey("TAB");

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("10%");
        expect(frame).toContain("80%");
        expect(frame).toContain("50%");
        expect(frame).not.toContain("volume level");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("persists selected model and applies it to new sessions", async () => {
    configureFauxAgent();
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(
      path.join(getConfigDir(), "config.toml"),
      '[agents]\ndefault = "faux"\n\n[agents.runners.faux]\ncommand = "faux-agent"\nargs = []\nprofile = "default"\n',
      "utf-8",
    );
    resetConfig();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      capabilities: {
        modelConfigId: "custom-model-selector",
        currentModelId: "model-a",
        availableModels: [
          { modelId: "model-a", name: "Model A" },
          { modelId: "model-b", name: "Model B" },
        ],
      },
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/models model-b");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Switched to model: model-b");
      });
      expect(fs.readFileSync(path.join(getConfigDir(), "config.toml"), "utf-8")).toContain(
        'preferred_model = "model-b"',
      );

      await app.mockInput.typeText("/new");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("New thread");
      });
      await waitFor(() => expect(faux.modelChanges).toEqual(["model-b", "model-b"]));
      expect(faux.modelConfigChanges).toEqual([
        { modelId: "model-b", configId: "custom-model-selector" },
        { modelId: "model-b", configId: "custom-model-selector" },
      ]);

      await submitPrompt(app, "first prompt in new thread uses persisted model");
      await waitFor(() => expect(faux.prompts).toContain("first prompt in new thread uses persisted model"));
      expect(faux.modelChanges).toEqual(["model-b", "model-b"]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("sets advertised reasoning effort through ACP config options", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      capabilities: {
        currentModelId: "model-a",
        availableModels: [
          { modelId: "model-a", name: "Model A" },
          { modelId: "model-b", name: "Model B" },
        ],
        configOptions: [
          {
            id: "thought_level",
            name: "Thinking",
            category: "thought_level",
            currentValue: "low",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
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

      await app.mockInput.typeText("/effort ");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("low");
        expect(frame).toContain("high");
        expect(frame).toContain("current");
      });
      app.mockInput.pressArrow("down");
      app.mockInput.pressEnter();

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Reasoning effort: High");
        expect(frame).toContain("model-a • high");
      });
      expect(faux.configOptionChanges).toContainEqual({ configId: "thought_level", value: "high" });

      await app.mockInput.typeText("/models");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("reasoning effort: High");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("does not reapply preferred model when agent already starts on it", async () => {
    configureFauxAgent("model-b");
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      capabilities: {
        currentModelId: "model-b",
        availableModels: [{ modelId: "model-b", name: "Model B" }],
      },
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await waitFor(() => expect(faux.newSessions).toEqual([{ cwd }]));
      expect(faux.modelChanges).toEqual([]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("applies preferred model when agent omits available model list", async () => {
    configureFauxAgent("model-b");
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      capabilities: {
        currentModelId: "model-a",
      },
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await waitFor(() => expect(faux.modelChanges).toEqual(["model-b"]));

      await submitPrompt(app, "first prompt uses the warmed preferred-model session");
      await waitFor(() => expect(faux.prompts).toEqual(["first prompt uses the warmed preferred-model session"]));
      expect(faux.modelChanges).toEqual(["model-b"]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("does not apply preferred model when model config id is missing", async () => {
    configureFauxAgent("model-b");
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      capabilities: {
        modelConfigId: null,
        currentModelId: "model-a",
        availableModels: [
          { modelId: "model-a", name: "Model A" },
          { modelId: "model-b", name: "Model B" },
        ],
      },
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain(
          "Preferred model could not be applied because this agent did not advertise a model switcher.",
        );
      });
      expect(faux.modelChanges).toEqual([]);
      expect(faux.modelConfigChanges).toEqual([]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("reapplies preferred model when new session omits current model", async () => {
    configureFauxAgent();
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(
      path.join(getConfigDir(), "config.toml"),
      '[agents]\ndefault = "faux"\n\n[agents.runners.faux]\ncommand = "faux-agent"\nargs = []\nprofile = "default"\npreferred_model = "model-b"\n',
      "utf-8",
    );
    resetConfig();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      capabilities: {
        availableModels: [
          { modelId: "model-a", name: "Model A" },
          { modelId: "model-b", name: "Model B" },
        ],
      },
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await waitFor(() => expect(faux.modelChanges).toEqual(["model-b"]));

      await app.mockInput.typeText("/new");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("New thread");
      });
      await waitFor(() => expect(faux.modelChanges).toEqual(["model-b", "model-b"]));

      await submitPrompt(app, "second thread uses the warmed preferred-model session");
      await waitFor(() => expect(faux.prompts).toContain("second thread uses the warmed preferred-model session"));
      expect(faux.modelChanges).toEqual(["model-b", "model-b"]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("holds prompts until startup preferred model application completes", async () => {
    configureFauxAgent("model-b");
    const cwd = tmpWorkspace();
    const modelApplied = new Deferred<void>();
    const faux = createFauxAcpAgent({
      capabilities: {
        currentModelId: "model-a",
        availableModels: [
          { modelId: "model-a", name: "Model A" },
          { modelId: "model-b", name: "Model B" },
        ],
      },
      setSessionModelBlocker: modelApplied.promise,
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await waitFor(() => expect(faux.modelChanges).toEqual(["model-b"]));

      await submitPrompt(app, "first prompt waits for preferred model setup");
      await Promise.resolve();
      expect(faux.prompts).toEqual([]);

      modelApplied.resolve();
      await waitFor(() => expect(faux.prompts).toEqual(["first prompt waits for preferred model setup"]));
    } finally {
      modelApplied.resolve();
      app.renderer.destroy();
    }
  });

  test("applies preferred model when resuming a session by id", async () => {
    configureFauxAgent("model-b");
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      capabilities: {
        currentModelId: "model-a",
        availableModels: [
          { modelId: "model-a", name: "Model A" },
          { modelId: "model-b", name: "Model B" },
        ],
      },
    });
    const app = await renderFauxApp(cwd, faux, { initialResumeSessionId: "session-123" });

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Resumed ACP session: session-123");
      });
      expect(faux.loadSessions).toEqual(["session-123"]);
      expect(faux.modelChanges).toEqual(["model-b"]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("shows loading status while resuming a session by id from startup", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({ loadSessionHistoryDelayMs: 250 });
    const app = await renderFauxApp(cwd, faux, { initialResumeSessionId: "session-123" });

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(faux.loadSessions).toEqual(["session-123"]);
        const frame = app.captureCharFrame();
        expect(frame).toContain("Loading session: session-123");
        expect(frame).not.toContain("Resumed ACP session: session-123");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("renders resumed history before delayed preferred model application completes", async () => {
    configureFauxAgent("model-b");
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      capabilities: {
        currentModelId: "model-a",
        availableModels: [
          { modelId: "model-a", name: "Model A" },
          { modelId: "model-b", name: "Model B" },
        ],
      },
      loadEvents: [acpUserMessageChunk("loaded prompt"), acpAgentMessageChunk("loaded response")],
      setSessionModelDelayMs: 250,
    });
    const app = await renderFauxApp(cwd, faux, { initialResumeSessionId: "session-123" });

    try {
      await waitFor(() => faux.modelChanges.length === 1);
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Resumed ACP session: session-123");
        expect(frame).toContain("loaded prompt");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("does not warm a blank session while startup resume picker is open", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      sessions: [
        { sessionId: "session-a", title: "Latest session", updatedAt: "2025-01-02T00:00:00.000Z" },
        { sessionId: "session-b", title: "Older session", updatedAt: "2025-01-01T00:00:00.000Z" },
      ],
    });
    const app = await renderFauxApp(cwd, faux, { initialResume: true });

    try {
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Latest session");
        expect(frame).toContain("Older session");
      });
      await Promise.resolve();
      expect(faux.newSessions).toEqual([]);

      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Resumed ACP session: session-a");
      });
      expect(faux.loadSessions).toEqual(["session-a"]);
      expect(faux.newSessions).toEqual([]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("filters a single Alta cache-title session from the slash resume picker", async () => {
    configureFauxAltaAgent();
    const cwd = tmpWorkspace();
    const cachePath = "/Users/me/.cache/alta/agents/axiom@1.0.0/node_modules/@atlassian/alta-agent-axiom/agent.yml";
    const faux = createFauxAcpAgent({
      sessions: [{ sessionId: "cache-session", title: cachePath, updatedAt: "2025-01-03T00:00:00.000Z" }],
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/resume");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("No ACP sessions available to resume");
        expect(frame).not.toContain("cache-session");
        expect(frame).not.toContain(".cache/alta/agents");
      });
      expect(faux.loadSessions).toEqual([]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("filters a configured Alta package-name fallback session from the slash resume picker", async () => {
    writeFauxConfig(`[notifications]
sound_enabled = false

[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = ["@atlassian/alta-agent-axiom-asumer"]
profile = "alta"
`);
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      sessions: [{ sessionId: "dummy-session", title: "axiom-asumer", updatedAt: "2025-01-03T00:00:00.000Z" }],
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/resume");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("No ACP sessions available to resume");
        expect(frame).not.toContain("axiom-asumer");
        expect(frame).not.toContain("dummy-session");
      });
      expect(faux.loadSessions).toEqual([]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("filters an inline Alta ACP package-name fallback session from the slash resume picker", async () => {
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      sessions: [{ sessionId: "dummy-session", title: "axiom-asumer", updatedAt: "2025-01-03T00:00:00.000Z" }],
    });
    const app = await renderFauxApp(cwd, faux, {
      initialAgent: "",
      initialAcpCommand:
        'env FOO=bar "/opt/atlassian/bin/atlas" alta agent run npm:@atlassian/alta-agent-axiom-asumer@2026.1.2',
    });

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Connected to acp agent");
      });
      await app.mockInput.typeText("/resume");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("No ACP sessions available to resume");
        expect(frame).not.toContain("axiom-asumer");
        expect(frame).not.toContain("dummy-session");
      });
      expect(faux.loadSessions).toEqual([]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("hides non-current Alta workspace sessions from the resume picker", async () => {
    configureFauxAltaAgent();
    const cwd = tmpWorkspace();
    const otherCwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      sessions: [
        {
          sessionId: "other-checkout",
          title: "Other checkout",
          cwd: otherCwd,
          updatedAt: "2025-01-03T00:00:00.000Z",
          _meta: { "alta/session-list": { scope: "project", workspaceScope: "same-project", cwdExists: true } },
        },
        {
          sessionId: "current-checkout",
          title: "Current checkout",
          cwd,
          updatedAt: "2025-01-02T00:00:00.000Z",
          _meta: { "alta/session-list": { scope: "project", workspaceScope: "current-cwd", cwdExists: true } },
        },
      ],
      loadEvents: [acpAgentMessageChunk("loaded from other checkout")],
    });
    const app = await renderFauxApp(cwd, faux, { initialResume: true });

    try {
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Current checkout");
        expect(frame).not.toContain("Other checkout");
      });

      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.loadSessionRequests).toEqual([{ sessionId: "current-checkout", cwd, additionalDirectories: [] }]);
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("hides Alta sessions whose workspace is missing", async () => {
    configureFauxAltaAgent();
    const cwd = tmpWorkspace();
    const missingCwd = path.join(cwd, "deleted-checkout");
    const faux = createFauxAcpAgent({
      sessions: [
        {
          sessionId: "missing-checkout",
          title: "Missing checkout",
          cwd: missingCwd,
          updatedAt: "2025-01-03T00:00:00.000Z",
          _meta: { "alta/session-list": { scope: "project", workspaceScope: "same-project", cwdExists: false } },
        },
      ],
    });
    const app = await renderFauxApp(cwd, faux, { initialResume: true });

    try {
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("No ACP sessions available to resume");
        expect(frame).not.toContain("Missing checkout");
      });

      app.mockInput.pressEnter();
      expect(faux.loadSessionRequests).toEqual([]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps resume picker rows navigable while selected session loads", async () => {
    configureFauxAltaAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      sessions: [
        {
          sessionId: "cache-session",
          title: "/Users/me/.cache/alta/agents/axiom@1.0.0/node_modules/@atlassian/alta-agent-axiom/agent.yml",
          updatedAt: "2025-01-03T00:00:00.000Z",
        },
        { sessionId: "session-456", title: "Other session", updatedAt: "2025-01-02T00:00:00.000Z" },
        { sessionId: "session-789", title: "Second session", updatedAt: "2025-01-01T00:00:00.000Z" },
      ],
      loadEvents: [acpUserMessageChunk("loaded prompt"), acpAgentMessageChunk("loaded response")],
      loadSessionHistoryDelayMs: 6000,
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await app.mockInput.typeText("/resume");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).not.toContain("cache-session");
        expect(frame).toContain("Other session");
        expect(frame).toContain("Second session");
        expect(frame).not.toContain(".cache/alta/agents");
      });

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("→ Other session");
      });
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.loadSessions).toEqual(["session-456"]);
        const loadingFrame = app.captureCharFrame();
        expect(loadingFrame).toContain("→ Other session");
        expect(loadingFrame).toContain("Second session");
        expect(loadingFrame).toContain("Loading session: Other session");
        expect(loadingFrame).not.toContain("→ Loading session: Other session");
        expect(loadingFrame).not.toContain("Resumed ACP session: session-456");
      });

      app.mockInput.pressArrow("down");
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("→ Second session");
      });
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(faux.loadSessions).toEqual(["session-456"]);
        expect(app.captureCharFrame()).toContain("Another session is already loading");
      });

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Resumed ACP session: session-456");
        expect(frame).toContain("loaded response");
      }, 9000);
    } finally {
      app.renderer.destroy();
    }
  }, 10_000);

  test("renders resumed marker before session history emitted during load", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      loadEvents: [acpUserMessageChunk("loaded prompt"), acpAgentMessageChunk("loaded response")],
    });
    const app = await renderFauxApp(cwd, faux, { initialResumeSessionId: "session-123" });

    try {
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Resumed ACP session: session-123");
        expect(frame).toContain("loaded prompt");
        expect(frame).toContain("loaded response");
        expect(frame.indexOf("Resumed ACP session: session-123")).toBeLessThan(frame.indexOf("loaded prompt"));
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("renders streamed history before a slow session load response", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      loadEvents: [acpUserMessageChunk("early prompt"), acpAgentMessageChunk("early response")],
      loadSessionResponseDelayMs: 3000,
    });
    const app = await renderFauxApp(cwd, faux, { initialResumeSessionId: "session-123" });

    try {
      const startedAt = Date.now();
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("early response");
        expect(frame).toContain("Loading session");
      });
      expect(Date.now() - startedAt).toBeLessThan(2500);

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).not.toContain("Loading session");
      }, 5000);
      const frame = app.captureCharFrame();
      expect(frame.split("Resumed ACP session: session-123")).toHaveLength(2);
      expect(frame.split("early response")).toHaveLength(2);
      expect(frame.indexOf("Resumed ACP session: session-123")).toBeLessThan(frame.indexOf("early prompt"));
    } finally {
      app.renderer.destroy();
    }
  }, 10_000);

  test("keeps a message split across early and final history in one block", async () => {
    configureFauxAgent();
    const faux = createFauxAcpAgent({
      loadEvents: [
        acpUserMessageChunk("prompt"),
        acpAgentMessageChunk("first half"),
        acpAgentMessageChunk(" second half"),
      ],
      loadSessionResponseDelayMs: 300,
      earlyLoadEventCount: 2,
    });
    const app = await renderFauxApp(tmpWorkspace(), faux, { initialResumeSessionId: "session-123" });

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("first half second half");
      }, 5000);
    } finally {
      app.renderer.destroy();
    }
  }, 10_000);

  test("clears early history when the session load then fails", async () => {
    configureFauxAgent();
    const faux = createFauxAcpAgent({
      loadEvents: [acpUserMessageChunk("early prompt"), acpAgentMessageChunk("early response")],
      loadSessionResponseDelayMs: 300,
      rejectLoadAfterHistory: true,
    });
    const app = await renderFauxApp(tmpWorkspace(), faux, { initialResumeSessionId: "session-123" });

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Failed to load session");
      }, 5000);
      expect(app.captureCharFrame()).not.toContain("early response");
    } finally {
      app.renderer.destroy();
    }
  }, 10_000);

  function saveEarlyHistoryThreads(cwd: string) {
    const createdAt = "2025-01-01T00:00:00.000Z";
    const thread = { cwd, workspaceKind: "local" as const, status: "paused" as const, archived: false, createdAt };
    saveThreadsForWorkspace(cwd, {
      activeThreadId: "thread-new",
      threads: [
        { ...thread, id: "thread-new", title: "Fresh thread", sessionId: null, updatedAt: "2025-01-03T00:00:00.000Z" },
        {
          ...thread,
          id: "thread-saved",
          title: "Saved thread",
          sessionId: "session-saved",
          updatedAt: "2025-01-02T00:00:00.000Z",
        },
      ],
    });
  }

  test("clears early history when a switched-to thread load fails", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    saveEarlyHistoryThreads(cwd);
    const faux = createFauxAcpAgent({
      loadEvents: [acpUserMessageChunk("early prompt"), acpAgentMessageChunk("early response")],
      loadSessionResponseDelayMs: 600,
      rejectLoadAfterHistory: true,
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      app.mockInput.pressKey("g", { ctrl: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Saved thread");
      });
      app.mockInput.pressArrow("down");
      app.mockInput.pressEnter();
      await waitFor(() => expect(faux.loadSessions).toEqual(["session-saved"]));
      app.mockInput.pressKey("g", { ctrl: true });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("early response");
      });
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Failed to switch thread");
      }, 5000);
      expect(app.captureCharFrame()).not.toContain("early response");
    } finally {
      app.renderer.destroy();
    }
  }, 10_000);

  test("renders restored thinking blocks when resuming a session", async () => {
    configureFauxAgent(undefined, { thinking_preview_lines: 0 });
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      loadEvents: [
        {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "**Restored** reasoning\nhidden restored detail" },
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "loaded answer" },
        },
      ],
    });
    const app = await renderFauxApp(cwd, faux, { initialResumeSessionId: "session-123" });

    try {
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Restored reasoning");
        expect(frame).toContain("hidden restored detail");
        expect(frame).toContain("loaded answer");
      });

      pressCtrlO(app);

      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Restored reasoning");
        expect(frame).toContain("hidden restored detail");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("does not persist config option updates replayed while resuming session history", async () => {
    configureFauxAgent();
    // Write a deterministic on-disk baseline so this test does not depend on
    // config.toml left behind by a previously-run test file (it reads the file
    // directly to assert the replayed update was not persisted).
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(
      path.join(getConfigDir(), "config.toml"),
      '[notifications]\nsound_enabled = false\n\n[agents]\ndefault = "faux"\n\n[agents.runners.faux]\ncommand = "faux-agent"\nargs = []\nprofile = "default"\n',
      "utf-8",
    );
    resetConfig();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      sessions: [{ sessionId: "session-456", title: "Other session", updatedAt: "2025-01-01T00:00:00.000Z" }],
      loadEvents: [relaySettingConfigUpdate("relay.notifications.sound_enabled", true)],
      loadEventDelayTurns: 20,
    });
    const app = await renderFauxApp(cwd, faux, { initialResumeSessionId: "session-123" });

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Resumed ACP session: session-123");
      });
      let configText = fs.readFileSync(path.join(getConfigDir(), "config.toml"), "utf-8");
      expect(configText).toContain("sound_enabled = false");
      expect(configText).not.toContain("sound_enabled = true");
      expect(getConfig().notifications.sound_enabled).toBe(false);
      expect(app.captureCharFrame()).not.toContain("Updated setting: Notification sounds");

      await app.mockInput.typeText("/resume session-456");
      app.mockInput.pressEnter();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Resumed ACP session: session-456");
      });
      configText = fs.readFileSync(path.join(getConfigDir(), "config.toml"), "utf-8");
      expect(configText).toContain("sound_enabled = false");
      expect(configText).not.toContain("sound_enabled = true");
      expect(getConfig().notifications.sound_enabled).toBe(false);
    } finally {
      app.renderer.destroy();
    }
  });

  test("recovers a persisted Alta cache-title thread without loading the stale session", async () => {
    configureFauxAltaAgent();
    const cwd = tmpWorkspace();
    const cacheTitle = "/Users/me/.cache/alta/agents/axiom@1.0.0/node_modules/@atlassian/alta-agent-axiom/agent.yml";
    saveThreadsForWorkspace(cwd, {
      activeThreadId: "thread-cache",
      threads: [
        {
          id: "thread-cache",
          title: cacheTitle,
          sessionId: "cache-session",
          cwd,
          workspaceKind: "local",
          status: "paused",
          archived: false,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-02T00:00:00.000Z",
        },
      ],
    });
    const faux = createFauxAcpAgent();
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      app.renderOnce();
      expect(app.captureCharFrame()).not.toContain(".cache/alta/agents");
      expect(faux.loadSessions).toEqual([]);
      await waitFor(() => expect(faux.newSessions).toEqual([{ cwd }]));

      await submitPrompt(app, "first prompt after cache-title recovery");
      await waitFor(() => expect(faux.prompts).toEqual(["first prompt after cache-title recovery"]));
      expect(faux.loadSessions).toEqual([]);
      expect(faux.newSessions).toEqual([{ cwd }]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("applies preferred model when continuing the most recent session", async () => {
    configureFauxAltaAgent("model-b");
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      capabilities: {
        currentModelId: "model-a",
        availableModels: [
          { modelId: "model-a", name: "Model A" },
          { modelId: "model-b", name: "Model B" },
        ],
      },
      sessions: [
        { sessionId: "old-session", title: "Old", updatedAt: "2024-01-01T00:00:00.000Z" },
        { sessionId: "new-session", title: "New", updatedAt: "2024-01-02T00:00:00.000Z" },
        {
          sessionId: "cache-session",
          title: "/Users/me/.cache/alta/agents/axiom@1.0.0/node_modules/@atlassian/alta-agent-axiom/agent.yml",
          updatedAt: "2024-01-03T00:00:00.000Z",
        },
      ],
    });
    const app = await renderFauxApp(cwd, faux, { initialContinue: true });

    try {
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Resumed ACP session: new-session");
        expect(frame).not.toContain(".cache/alta/agents");
      });
      expect(faux.loadSessions).toEqual(["new-session"]);
      expect(faux.modelChanges).toEqual(["model-b"]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("shows loading status while continuing the most recent session", async () => {
    configureFauxAgent();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      sessions: [
        { sessionId: "old-session", title: "Old", updatedAt: "2024-01-01T00:00:00.000Z" },
        { sessionId: "new-session", title: "Latest work", updatedAt: "2024-01-02T00:00:00.000Z" },
      ],
      loadSessionHistoryDelayMs: 250,
    });
    const app = await renderFauxApp(cwd, faux, { initialContinue: true });

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(faux.loadSessions).toEqual(["new-session"]);
        const frame = app.captureCharFrame();
        expect(frame).toContain("Loading session: Latest work");
        expect(frame).not.toContain("Resumed ACP session: new-session");
      });
    } finally {
      app.renderer.destroy();
    }
  });

  test("applies preferred thinking level for a new session", async () => {
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(
      path.join(getConfigDir(), "config.toml"),
      '[agents]\ndefault = "faux"\n\n[agents.runners.faux]\ncommand = "faux-agent"\nargs = []\nprofile = "default"\npreferred_thinking_level = "ultra"\n',
      "utf-8",
    );
    resetConfig();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      capabilities: {
        currentModelId: "model-a",
        availableModels: [{ modelId: "model-a", name: "Model A" }],
        currentThinkingLevel: "low",
        availableThinkingLevels: [
          { id: "low", name: "Low" },
          { id: "ultra", name: "Ultra" },
        ],
      },
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitForConnected(app);
      await waitFor(() =>
        expect(faux.thinkingLevelChanges).toEqual([{ thinkingLevel: "ultra", configId: "thought_level" }]),
      );

      await submitPrompt(app, "first prompt uses the warmed preferred-thinking session");
      await waitFor(() => expect(faux.prompts).toEqual(["first prompt uses the warmed preferred-thinking session"]));
      expect(faux.thinkingLevelChanges).toEqual([{ thinkingLevel: "ultra", configId: "thought_level" }]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("applies the launch --thinking-level override to the initial session", async () => {
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
    const app = await renderFauxApp(cwd, faux, { initialThinkingLevel: "high" });

    try {
      await waitForConnected(app);
      await waitFor(() =>
        expect(faux.thinkingLevelChanges).toEqual([{ thinkingLevel: "high", configId: "thought_level" }]),
      );

      await submitPrompt(app, "first prompt uses the warmed launch-thinking session");
      await waitFor(() => expect(faux.prompts).toEqual(["first prompt uses the warmed launch-thinking session"]));
      expect(faux.thinkingLevelChanges).toEqual([{ thinkingLevel: "high", configId: "thought_level" }]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("launch --thinking-level override takes precedence over the configured preferred thinking level", async () => {
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(
      path.join(getConfigDir(), "config.toml"),
      '[agents]\ndefault = "faux"\n\n[agents.runners.faux]\ncommand = "faux-agent"\nargs = []\nprofile = "default"\npreferred_thinking_level = "low"\n',
      "utf-8",
    );
    resetConfig();
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
    const app = await renderFauxApp(cwd, faux, { initialThinkingLevel: "high" });

    try {
      await waitForConnected(app);
      await waitFor(() =>
        expect(faux.thinkingLevelChanges).toEqual([{ thinkingLevel: "high", configId: "thought_level" }]),
      );

      await submitPrompt(app, "first prompt uses the warmed launch-thinking session");
      await waitFor(() => expect(faux.prompts).toEqual(["first prompt uses the warmed launch-thinking session"]));
      expect(faux.thinkingLevelChanges).toEqual([{ thinkingLevel: "high", configId: "thought_level" }]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("invalid launch --thinking-level override is not applied and leaves the configured preference intact", async () => {
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(
      path.join(getConfigDir(), "config.toml"),
      '[agents]\ndefault = "faux"\n\n[agents.runners.faux]\ncommand = "faux-agent"\nargs = []\nprofile = "default"\npreferred_thinking_level = "low"\n',
      "utf-8",
    );
    resetConfig();
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
    // "xhigh" is not offered by this agent.
    const app = await renderFauxApp(cwd, faux, { initialThinkingLevel: "xhigh" });

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain('Requested thinking level "xhigh" is not available; using low.');
      });
      await waitFor(() => expect(faux.newSessions).toEqual([{ cwd }]));
      // The unavailable launch override must not be sent to the agent...
      expect(faux.thinkingLevelChanges).toEqual([]);
      // ...and a one-off launch override must never clear the saved preference.
      expect(fs.readFileSync(path.join(getConfigDir(), "config.toml"), "utf-8")).toContain(
        'preferred_thinking_level = "low"',
      );
    } finally {
      app.renderer.destroy();
    }
  });

  test("clears stale preferred model when unavailable for a new session", async () => {
    configureFauxAgent("missing-model");
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(
      path.join(getConfigDir(), "config.toml"),
      '[agents]\ndefault = "faux"\n\n[agents.runners.faux]\ncommand = "faux-agent"\nargs = []\nprofile = "default"\npreferred_model = "missing-model"\n',
      "utf-8",
    );
    resetConfig();
    const cwd = tmpWorkspace();
    const faux = createFauxAcpAgent({
      capabilities: {
        currentModelId: "model-a",
        availableModels: [{ modelId: "model-a", name: "Model A" }],
      },
    });
    const app = await renderFauxApp(cwd, faux);

    try {
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Preferred model is no longer available");
      });
      expect(faux.modelChanges).toEqual([]);
      expect(fs.readFileSync(path.join(getConfigDir(), "config.toml"), "utf-8")).not.toContain("preferred_model");
    } finally {
      app.renderer.destroy();
    }
  });

  test("hot reloads vim keybindings config and resets visible Vim state when disabled", async () => {
    writeFauxConfig(`[ui]
vim_keybindings = false

[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
`);
    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);
      expect(app.captureCharFrame()).not.toContain("-- INSERT --");

      fs.writeFileSync(
        path.join(getConfigDir(), "config.toml"),
        `[ui]
vim_keybindings = true

[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
`,
        "utf-8",
      );
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("-- INSERT --");
      }, 2000);

      await app.mockInput.typeText("vim draft");
      app.mockInput.pressEscape();
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("-- NORMAL --");
      });

      fs.writeFileSync(
        path.join(getConfigDir(), "config.toml"),
        `[ui]
vim_keybindings = false

[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
`,
        "utf-8",
      );
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).not.toContain("-- NORMAL --");
      }, 2000);
    } finally {
      app.renderer.destroy();
    }
  });

  test("hot reloads prompt marker config in the composer", async () => {
    writeFauxConfig(`[ui]
prompt_marker = "#"

[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
`);
    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);
      expect(app.captureCharFrame()).toContain("#");

      fs.writeFileSync(
        path.join(getConfigDir(), "config.toml"),
        `[ui]
prompt_marker = "❯"

[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
`,
        "utf-8",
      );

      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("❯");
      }, 2000);
    } finally {
      app.renderer.destroy();
    }
  });

  test("shows parse reason when startup config falls back to defaults", async () => {
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.writeFileSync(path.join(getConfigDir(), "config.toml"), `[notifications\nsound_enabled = true\n`, "utf-8");
    resetConfig();

    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd, createFauxAcpAgent(), { initialAcpCommand: "faux-agent" });

    try {
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Config reload failed; using fallback settings:");
        expect(frame).toContain("Expected");
      }, 2000);
    } finally {
      app.renderer.destroy();
    }
  });

  test("hot reloads external config edits while preserving the last valid runtime config", async () => {
    writeFauxConfig(`[notifications]
terminal_enabled = true
sound_enabled = false

[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
`);
    const cwd = tmpWorkspace();
    const app = await renderFauxApp(cwd);

    try {
      await waitForConnected(app);

      fs.writeFileSync(path.join(getConfigDir(), "config.toml"), `[notifications\nsound_enabled = true\n`, "utf-8");
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("Config reload failed; keeping previous settings:");
        expect(frame).toContain("Expected");
      }, 2000);

      fs.writeFileSync(
        path.join(getConfigDir(), "config.toml"),
        `[ui]
theme = "not-a-theme"

[notifications]
terminal_enabled = true
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
      await waitFor(() => {
        app.renderOnce();
        const frame = app.captureCharFrame();
        expect(frame).toContain("⚠ Invalid theme for ui.theme");
      }, 2000);

      expect(getConfig().notifications.terminal_enabled).toBe(true);
      expect(getConfig().notifications.sound_enabled).toBe(true);

      fs.writeFileSync(
        path.join(getConfigDir(), "config.toml"),
        `[notifications]
terminal_enabled = true
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
      await waitFor(() => {
        app.renderOnce();
        expect(app.captureCharFrame()).toContain("Config reloaded");
      }, 2000);

      expect(getConfig().notifications.terminal_enabled).toBe(true);
      expect(getConfig().notifications.sound_enabled).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  });
});
