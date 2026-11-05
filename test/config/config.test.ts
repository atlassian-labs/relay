import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  addAgentRunner,
  consumeConfigWarnings,
  Config,
  CURRENT_CONFIG_VERSION,
  defaultAgentNameFor,
  defaultAgentRunners,
  migrateConfigV2ToV3,
  validateAgentsConfig,
  getChildSessionReminderTemplate,
  getChildSessionReminderTemplatePath,
  getConfig,
  getConfigDir,
  getConfigLoadResult,
  ensureConfigDir,
  getLegacyConfigDir,
  getPluginSettingRaw,
  listAvailableAgentNames,
  loadConfigEffect,
  reloadConfig,
  reloadConfigEffect,
  resolveConfiguredAgent,
  resolveConfiguredAgentProfile,
  resolveInlineAcpAgentProfile,
  resetConfig,
  scopedConfigWatcher,
  setAgentPreferredModel,
  setAgentPreferredThinkingLevel,
  setChildSessionTaskType,
  removeChildSessionTaskType,
  setConfigValue,
  setNotificationVolume,
  setNotificationSoundsEnabled,
  setPluginSettingValue,
  setPluginsEnabled,
  setRelayPluginEnabled,
  setTheme,
  startConfigWatcher,
  subscribeConfig,
  updateConfigEffect,
} from "../../src/config";
import { getTheme, getThemeIds, getThemeOptions } from "../../src/config/themes";
import { getPromptTemplate, getPromptTemplatePath, PROMPT_TEMPLATE_IDS } from "../../src/prompt-templates";
import { readTelemetryConsent } from "../../src/telemetry-storage";
import {
  CLAUDE_ACP_PACKAGE,
  CODEX_ACP_PACKAGE,
  CURSOR_AGENT_ARGS,
  CURSOR_AGENT_COMMAND,
  ROVO_AGENT_ARGS,
  ROVO_AGENT_COMMAND,
} from "../../src/config/builtin-agents";
import { Effect } from "effect";
import { runTestEffect } from "../lib/effect";

function configPath(): string {
  return path.join(getConfigDir(), "config.toml");
}

function writeConfig(text: string): void {
  fs.mkdirSync(getConfigDir(), { recursive: true });
  fs.writeFileSync(configPath(), text, "utf-8");
  resetConfig();
}

function writeCustomTheme(fileName: string, theme: Record<string, unknown>): void {
  const themesDir = path.join(getConfigDir(), "themes");
  fs.mkdirSync(themesDir, { recursive: true });
  fs.writeFileSync(path.join(themesDir, fileName), JSON.stringify(theme), "utf-8");
  resetConfig();
}

function customTheme(name: string): Record<string, unknown> {
  const colors = getTheme("catppuccin-mocha").colors;
  return {
    name,
    label: `Custom ${name}`,
    colors: {
      bg: colors.bg,
      fg: colors.fg,
      textSubtle: colors.textSubtle,
      textMuted: colors.textMuted,
      textLabel: colors.textLabel,
      title: colors.title,
      spinner: colors.spinner,
      accent: colors.accent,
      info: colors.info,
      markdownHeading: colors.markdownHeading,
      markdownCode: colors.markdownCode,
      selected: colors.selected,
      error: colors.error,
      notice: colors.notice,
      diffAdded: colors.diffAdded,
      diffRemoved: colors.diffRemoved,
      toolBg: colors.toolBg,
      badge: colors.badge,
      running: colors.running,
      success: colors.success,
      failed: colors.failed,
      panel: colors.panel,
      panelAlt: colors.panelAlt,
      panelUser: colors.panelUser,
      border: colors.border,
      thinking: colors.thinking,
    },
  };
}

let replaceConfigCounter = 0;

function replaceConfig(text: string): void {
  fs.mkdirSync(getConfigDir(), { recursive: true });
  replaceConfigCounter += 1;
  const tmpPath = path.join(getConfigDir(), `config.toml.${process.pid}.${replaceConfigCounter}.tmp`);
  fs.writeFileSync(tmpPath, text, "utf-8");
  fs.renameSync(tmpPath, configPath());
}

async function waitFor(assertion: () => void | boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = assertion();
      if (result !== false) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (lastError) throw lastError;
  throw new Error("Timed out waiting for assertion");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  resetConfig();
  fs.rmSync(getConfigDir(), { recursive: true, force: true });
  fs.rmSync(getLegacyConfigDir(), { recursive: true, force: true });
});

describe("child session task type config", () => {
  test("writes and reloads task types", () => {
    writeConfig("[meta]\nconfig_version = 3\n");
    setChildSessionTaskType({
      name: "plan",
      description: "Architecture planning",
      keywords: ["Plan", "design-proposal"],
      agent: "codex",
      model: "model-a",
      thinkingLevel: "high",
    });

    expect(getConfig().task_types.plan).toEqual({
      name: "plan",
      description: "Architecture planning",
      keywords: ["plan", "design proposal"],
      agent: "codex",
      model: "model-a",
      thinkingLevel: "high",
    });
    expect(fs.readFileSync(configPath(), "utf-8")).toContain("[task_types.plan]");

    removeChildSessionTaskType("plan");
    expect(getConfig().task_types).toEqual({});
  });

  test("requires keywords but allows agent, model, and thinking level to inherit", () => {
    writeConfig("[meta]\nconfig_version = 3\n");
    expect(() =>
      setChildSessionTaskType({ name: "plan", description: "Planning", keywords: [], model: "model-a" }),
    ).toThrow("At least one");

    setChildSessionTaskType({ name: "plan", description: "Planning", keywords: ["plan"] });
    expect(getConfig().task_types.plan).toEqual({
      name: "plan",
      description: "Planning",
      keywords: ["plan"],
    });
  });

  test("ignores outdated child-session prompt overrides", () => {
    writeConfig("[meta]\nconfig_version = 3\n");
    const templatePath = getChildSessionReminderTemplatePath();
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    fs.writeFileSync(
      templatePath,
      '<child_session_collaboration version="3">\nstale instructions\n</child_session_collaboration>',
      "utf-8",
    );
    resetConfig();
    getConfigLoadResult();

    expect(getChildSessionReminderTemplate()).toContain('<child_session_collaboration version="5">');
    expect(getChildSessionReminderTemplate()).toContain(
      "Relay is not an agent; it is the client connected to you over ACP",
    );
    expect(consumeConfigWarnings().join("\n")).toContain("Ignoring outdated child-session prompt override version 3");
  });

  test("loads optional prompt overrides without materializing built-in defaults", () => {
    writeConfig("[meta]\nconfig_version = 3\n");
    getConfigLoadResult();
    const templatePath = getChildSessionReminderTemplatePath();
    expect(templatePath).toBe(path.join(getConfigDir(), "prompts", "child-session-collaboration.md"));
    expect(fs.existsSync(templatePath)).toBe(false);
    expect(getChildSessionReminderTemplate()).toContain("<child_session_collaboration");

    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    for (const id of PROMPT_TEMPLATE_IDS) {
      fs.writeFileSync(getPromptTemplatePath(id), `custom ${id}`, "utf-8");
    }
    resetConfig();
    getConfigLoadResult();

    expect(getChildSessionReminderTemplate()).toBe("custom child-session-collaboration");
    for (const id of PROMPT_TEMPLATE_IDS) expect(getPromptTemplate(id)).toBe(`custom ${id}`);
  });
});

describe("tool call group config", () => {
  test("is disabled with no rules by default", () => {
    expect(new Config({}).ui.tool_call_groups).toEqual({ enabled: false, rules: [] });
  });

  test("loads valid rules and keeps aliases in one summary bucket", () => {
    const config = new Config({
      ui: {
        tool_call_groups: {
          enabled: true,
          rules: [
            {
              tool_names: ["read", "read_file"],
              singular: "Read {count} file",
              plural: "Read {count} files",
            },
          ],
        },
      },
    });
    expect(config.ui.tool_call_groups).toEqual({
      enabled: true,
      rules: [
        {
          tool_names: ["read", "read_file"],
          singular: "Read {count} file",
          plural: "Read {count} files",
        },
      ],
    });
  });

  test("ignores malformed templates and duplicate names", () => {
    const warnings: string[] = [];
    const config = new Config(
      {
        ui: {
          tool_call_groups: {
            enabled: true,
            rules: [
              { tool_names: ["read"], singular: "Read {count} file", plural: "Read {count} files" },
              { tool_names: ["read", "grep"], singular: "Used {count} tool", plural: "Used {count} tools" },
              { tool_names: ["find"], singular: "Found a path", plural: "Found paths" },
            ],
          },
        },
      },
      (warning) => warnings.push(warning),
    );
    expect(config.ui.tool_call_groups.rules.map((rule) => rule.tool_names)).toEqual([["read"], ["grep"]]);
    expect(warnings.some((warning) => warning.includes("Duplicate tool name"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("exactly one {count}"))).toBe(true);
  });

  test("config writes preserve arrays of tool call group tables", () => {
    writeConfig(`[ui.tool_call_groups]
enabled = true

[[ui.tool_call_groups.rules]]
tool_names = ["read"]
singular = "Read {count} file"
plural = "Read {count} files"

[[ui.tool_call_groups.rules]]
tool_names = ["grep"]
singular = "Searched {count} pattern"
plural = "Searched {count} patterns"

[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
`);

    setAgentPreferredModel("faux", "model-b");

    const config = reloadConfig();
    const text = fs.readFileSync(configPath(), "utf-8");
    expect(config.agents.runners.faux?.preferred_model).toBe("model-b");
    expect(config.ui.tool_call_groups.rules.map((rule) => rule.tool_names)).toEqual([["read"], ["grep"]]);
    expect(text.match(/\[\[ui\.tool_call_groups\.rules\]\]/g)).toHaveLength(2);
  });
});

describe("config persistence", () => {
  test("Effect config API loads, reloads, updates, and scopes the watcher", async () => {
    writeConfig(`[notifications]\nsound_enabled = false\n`);

    const load = await runTestEffect(loadConfigEffect());
    expect(load.config.notifications.sound_enabled).toBe(false);

    fs.writeFileSync(configPath(), `[notifications]\nsound_enabled = true\n`, "utf-8");
    const reloaded = await runTestEffect(reloadConfigEffect());
    expect(reloaded.notifications.sound_enabled).toBe(true);

    const updated = await runTestEffect(
      updateConfigEffect((data) => {
        const notifications = (data.notifications ?? {}) as Record<string, unknown>;
        notifications.sound_enabled = false;
        data.notifications = notifications;
      }),
    );
    expect(updated.notifications.sound_enabled).toBe(false);

    const seen: boolean[] = [];
    subscribeConfig((change) => seen.push(change.config.notifications.sound_enabled));
    await runTestEffect(
      Effect.scoped(
        Effect.gen(function* () {
          yield* scopedConfigWatcher();
          fs.writeFileSync(configPath(), `[notifications]\nsound_enabled = true\n`, "utf-8");
          yield* Effect.promise(() => waitFor(() => getConfig().notifications.sound_enabled === true));
        }),
      ),
    );

    fs.writeFileSync(configPath(), `[notifications]\nsound_enabled = false\n`, "utf-8");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(getConfig().notifications.sound_enabled).toBe(true);
    expect(seen.at(-1)).toBe(true);
  });

  test("loads vim keybindings config", () => {
    writeConfig(`[ui]\nvim_keybindings = true\n`);

    expect(getConfig().ui.vim_keybindings).toBe(true);
  });

  test("loads terminal title prompt source config", () => {
    writeConfig(`[ui]\nterminal_title_prompt_source = "first"\n`);

    expect(getConfig().ui.terminal_title_prompt_source).toBe("first");
  });

  test("loads Mermaid rendering mode config", () => {
    writeConfig(`[ui]\nmermaid_rendering = "final"\n`);

    expect(getConfig().ui.mermaid_rendering).toBe("final");
  });

  test("invalid Mermaid rendering mode falls back to streaming with a warning", () => {
    writeConfig(`[ui]\nmermaid_rendering = "always"\n`);

    const config = reloadConfig();
    const warnings = consumeConfigWarnings();

    expect(config.ui.mermaid_rendering).toBe("streaming");
    expect(warnings.some((warning) => warning.includes("ui.mermaid_rendering"))).toBe(true);
  });

  test("loads custom prompt marker config", () => {
    writeConfig(`[ui]\nprompt_marker = "❯"\n`);

    expect(getConfig().ui.prompt_marker).toBe("❯");
  });

  test("loads arbitrary short text prompt marker from config", () => {
    writeConfig(`[ui]\nprompt_marker = "λ"\n`);

    expect(getConfig().ui.prompt_marker).toBe("λ");
  });

  test("accepts 0 and 1 tool result preview lines", () => {
    writeConfig(`[ui]\ntool_result_preview_lines = 0\n`);
    expect(reloadConfig().ui.tool_result_preview_lines).toBe(0);
    writeConfig(`[ui]\ntool_result_preview_lines = 1\n`);
    expect(reloadConfig().ui.tool_result_preview_lines).toBe(1);
    expect(consumeConfigWarnings().some((warning) => warning.includes("tool_result_preview_lines"))).toBe(false);
  });

  test("allows disabling the prompt marker", () => {
    writeConfig(`[ui]\nprompt_marker = ""\n`);

    expect(getConfig().ui.prompt_marker).toBe("");
  });

  test("loads normalized disabled built-in slash commands", () => {
    writeConfig(`[ui]\ndisabled_builtin_slash_commands = ["review", "/goal", "relay.handoff", "review", "bad name"]\n`);

    const config = reloadConfig();
    const warnings = consumeConfigWarnings();

    expect(config.ui.disabled_builtin_slash_commands).toEqual(["review", "goal", "handoff"]);
    expect(warnings.some((warning) => warning.includes("ui.disabled_builtin_slash_commands"))).toBe(true);
  });

  test("rejects overwide prompt markers", () => {
    writeConfig(`[ui]\nprompt_marker = "xxxxx"\n`);

    const config = reloadConfig();
    const warnings = consumeConfigWarnings();

    expect(config.ui.prompt_marker).toBe(">");
    expect(warnings.some((warning) => warning.includes("ui.prompt_marker"))).toBe(true);
  });

  test("invalid prompt marker falls back to default with a warning", () => {
    writeConfig(`[ui]\nprompt_marker = "   "\n`);

    const config = reloadConfig();
    const warnings = consumeConfigWarnings();

    expect(config.ui.prompt_marker).toBe(">");
    expect(warnings.some((warning) => warning.includes("ui.prompt_marker"))).toBe(true);
  });

  test("control characters in prompt marker fall back to default with a warning", () => {
    writeConfig(`[ui]\nprompt_marker = "\\u001b[31m❯"\n`);

    const config = reloadConfig();
    const warnings = consumeConfigWarnings();

    expect(config.ui.prompt_marker).toBe(">");
    expect(warnings.some((warning) => warning.includes("ui.prompt_marker"))).toBe(true);
  });

  test("local bash prompt markers are reserved", () => {
    writeConfig(`[ui]\nprompt_marker = "!!"\n`);

    const config = reloadConfig();
    const warnings = consumeConfigWarnings();

    expect(config.ui.prompt_marker).toBe(">");
    expect(warnings.some((warning) => warning.includes("ui.prompt_marker"))).toBe(true);
  });

  test("invalid terminal title prompt source falls back to smart with a warning", () => {
    writeConfig(`[ui]\nterminal_title_prompt_source = "latest"\n`);

    const config = reloadConfig();
    const warnings = consumeConfigWarnings();

    expect(config.ui.terminal_title_prompt_source).toBe("smart");
    expect(warnings.some((warning) => warning.includes("ui.terminal_title_prompt_source"))).toBe(true);
  });

  test("loads logging level config", () => {
    writeConfig(`[logging]\nlevel = "debug"\n`);

    expect(getConfig().logging.level).toBe("debug");
  });

  test("missing configured agent error includes config file path", () => {
    writeConfig("");

    expect(() => resolveConfiguredAgent("missing-agent")).toThrow(
      `No agent runner configured for: missing-agent. Available agents: code-agent, alta, rovo, codex, claude, cursor. Config file: ${configPath()}`,
    );
  });

  test("resolves configured profile metadata without requiring configured command use", () => {
    writeConfig(`[agents]
default = "axiom"

[agents.runners.axiom]
command = "/opt/atlassian/bin/atlas"
args = ["alta", "agent", "run", "@atlassian/alta-agent-axiom-asumer"]
profile = "alta"
`);

    expect(resolveConfiguredAgentProfile("axiom")).toEqual({
      name: "axiom",
      profile: "alta",
      internalSessionTitleAliases: ["axiom-asumer"],
    });
  });

  test("returns null profile metadata for bare or missing inline ACP agents", () => {
    writeConfig(`[agents]
default = "axiom"

[agents.runners.axiom]
command = "/opt/atlassian/bin/atlas"
args = ["alta", "agent", "run", "@atlassian/alta-agent-axiom"]
profile = "alta"
`);

    expect(resolveConfiguredAgentProfile("")).toBeNull();
    expect(resolveConfiguredAgentProfile("missing-agent")).toBeNull();
  });

  test("derives Alta profile metadata from inline ACP commands", () => {
    writeConfig("");

    expect(
      resolveInlineAcpAgentProfile(
        "",
        'env FOO=bar "/opt/atlassian/bin/atlas" alta agent run npm:@atlassian/alta-agent-axiom-asumer@2026.1.2',
      ),
    ).toEqual({
      name: "acp",
      profile: "alta",
      internalSessionTitleAliases: ["axiom-asumer"],
    });
  });

  test("resolves first-class built-in Rovo, Codex, Claude, and Cursor agents without runner config", () => {
    writeConfig(`[agents]\ndefault = "codex"\n`);

    const config = reloadConfig();
    const warnings = consumeConfigWarnings();

    expect(config.agents.default).toBe("codex");
    expect(warnings.some((warning) => warning.includes("Unknown default agent codex"))).toBe(false);
    expect(listAvailableAgentNames()).toEqual(expect.arrayContaining(["alta", "rovo", "codex", "claude", "cursor"]));
    expect(resolveConfiguredAgent("rovodev")).toMatchObject({
      name: "rovo",
      command: ROVO_AGENT_COMMAND,
      args: [...ROVO_AGENT_ARGS],
      profile: "rovodev",
    });
    expect(resolveConfiguredAgent()).toMatchObject({
      name: "codex",
      command: "npx",
      args: ["--yes", "--loglevel=error", CODEX_ACP_PACKAGE],
      profile: "codex",
      env: { NO_BROWSER: "1" },
    });
    expect(resolveConfiguredAgent("claude-code")).toMatchObject({
      name: "claude",
      command: "npx",
      args: ["--yes", "--loglevel=error", CLAUDE_ACP_PACKAGE],
      profile: "claude",
      env: { NO_BROWSER: "1" },
    });
    expect(resolveConfiguredAgent("cursor-agent")).toMatchObject({
      name: "cursor",
      command: CURSOR_AGENT_COMMAND,
      args: [...CURSOR_AGENT_ARGS],
      profile: "default",
    });
  });

  test("stale stock built-in runners resolve through current built-in launchers", () => {
    writeConfig(`[agents]
default = "codex"

[agents.runners.codex]
command = "npx"
args = ["-y", "@agentclientprotocol/codex-acp@1.0.2"]
profile = "codex"
env = { NO_BROWSER = "1", CUSTOM = "ok" }
`);

    expect(resolveConfiguredAgent("codex")).toMatchObject({
      name: "codex",
      command: "npx",
      args: ["--yes", "--loglevel=error", CODEX_ACP_PACKAGE],
      profile: "codex",
      env: { NO_BROWSER: "1", CUSTOM: "ok" },
    });
  });

  test("built-in agent preferences materialize a canonical runner", () => {
    writeConfig("");

    setAgentPreferredModel("claude-code", "opus");
    setAgentPreferredThinkingLevel("claude", "high");

    const runner = reloadConfig().agents.runners.claude;
    const text = fs.readFileSync(configPath(), "utf-8");

    expect(runner).toMatchObject({
      command: "npx",
      args: ["--yes", "--loglevel=error", CLAUDE_ACP_PACKAGE],
      profile: "claude",
      env: { NO_BROWSER: "1" },
      preferred_model: "opus",
      preferred_thinking_level: "high",
    });
    expect(text).toContain("[agents.runners.claude]");
    expect(text).not.toContain("[agents.runners.claude-code]");
  });

  test("loads stdio agent runner env config", () => {
    writeConfig(`[agents]
default = "envy"

[agents.runners.envy]
command = "envy-agent"
args = []
env = { FOO = "bar", IGNORED = 7 }
`);

    const config = reloadConfig();
    const warnings = consumeConfigWarnings();

    expect(config.agents.runners.envy?.env).toEqual({ FOO: "bar" });
    expect(resolveConfiguredAgent("envy")?.env).toEqual({ FOO: "bar" });
    expect(warnings.some((warning) => warning.includes("agents.runners.envy.env.IGNORED"))).toBe(true);
  });

  test("getConfigDir ignores relative HOME values", () => {
    process.env.HOME = "relative-home";
    delete process.env.USERPROFILE;
    delete process.env.XDG_CONFIG_HOME;
    resetConfig();

    expect(getConfigDir()).toBe(path.join(os.homedir(), ".config", "relay"));
  });

  test("getConfigDir respects XDG_CONFIG_HOME", () => {
    const customXdg = path.join(os.tmpdir(), "relay-xdg-test");
    process.env.XDG_CONFIG_HOME = customXdg;
    resetConfig();

    expect(getConfigDir()).toBe(path.join(customXdg, "relay"));

    // Cleanup
    delete process.env.XDG_CONFIG_HOME;
  });

  test("getConfigDir uses $HOME/.config/relay when XDG_CONFIG_HOME is not set", () => {
    delete process.env.XDG_CONFIG_HOME;
    resetConfig();

    const home = process.env.HOME ?? os.homedir();
    expect(getConfigDir()).toBe(path.join(home, ".config", "relay"));
  });

  test("ensureConfigDir accepts an existing symlink to a directory", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-symlink-config-test-"));
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-symlink-config-target-"));
    process.env.HOME = tmpHome;
    delete process.env.XDG_CONFIG_HOME;
    resetConfig();

    fs.mkdirSync(path.dirname(getConfigDir()), { recursive: true });
    fs.symlinkSync(targetDir, getConfigDir(), "dir");

    expect(ensureConfigDir()).toBe(getConfigDir());
    fs.writeFileSync(path.join(getConfigDir(), "config.toml"), `[notifications]\nsound_enabled = true\n`, "utf-8");
    expect(fs.readFileSync(path.join(targetDir, "config.toml"), "utf-8")).toContain("sound_enabled = true");

    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  test("ensureConfigFile migrates legacy ~/.relay to new XDG location", () => {
    // Set up a fresh home with a legacy .relay directory
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-migrate-test-"));
    process.env.HOME = tmpHome;
    delete process.env.XDG_CONFIG_HOME;
    resetConfig();

    const legacyDir = getLegacyConfigDir();
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "config.toml"), `[notifications]\nsound_enabled = true\n`, "utf-8");
    fs.mkdirSync(path.join(legacyDir, "sounds"), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "sounds", "completion.wav"), "fake-wav-data", "utf-8");

    // Loading config should trigger migration
    const config = getConfig();
    const newDir = getConfigDir();

    // New location should have the files
    expect(fs.existsSync(path.join(newDir, "config.toml"))).toBe(true);
    expect(fs.existsSync(path.join(newDir, "sounds", "completion.wav"))).toBe(true);
    expect(fs.readFileSync(path.join(newDir, "sounds", "completion.wav"), "utf-8")).toBe("fake-wav-data");

    // Legacy dir should be gone
    expect(fs.existsSync(legacyDir)).toBe(false);

    // Config should have loaded the migrated values
    expect(config.notifications.sound_enabled).toBe(true);

    // Cleanup
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test("migration does not run when new config dir already exists", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-migrate-skip-test-"));
    process.env.HOME = tmpHome;
    delete process.env.XDG_CONFIG_HOME;
    resetConfig();

    const legacyDir = getLegacyConfigDir();
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "config.toml"), `[notifications]\nsound_enabled = true\n`, "utf-8");

    // Pre-create the new config dir
    const newDir = getConfigDir();
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, "config.toml"), `[notifications]\nsound_enabled = false\n`, "utf-8");

    const config = getConfig();

    // Should use new dir config, not legacy
    expect(config.notifications.sound_enabled).toBe(false);
    // Legacy dir should still exist (not removed)
    expect(fs.existsSync(legacyDir)).toBe(true);

    // Cleanup
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test("PromptHistory reads migrated history from new location", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-history-migrate-test-"));
    process.env.HOME = tmpHome;
    delete process.env.XDG_CONFIG_HOME;
    resetConfig();

    const legacyDir = getLegacyConfigDir();
    fs.mkdirSync(legacyDir, { recursive: true });
    const historyEntry = JSON.stringify({ text: "legacy prompt", timestamp: "2025-01-01T00:00:00.000Z" });
    fs.writeFileSync(path.join(legacyDir, "prompt-history.jsonl"), historyEntry + "\n", "utf-8");

    const { PromptHistory } = require("../../src/prompt-history");
    const history = new PromptHistory();

    const newDir = getConfigDir();
    expect(fs.existsSync(path.join(newDir, "prompt-history.jsonl"))).toBe(true);
    expect(fs.existsSync(legacyDir)).toBe(false);

    const result = history.navigate(-1, "");
    expect(result).not.toBeNull();
    expect(result!.text).toBe("legacy prompt");

    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test("migrates versioned configs with a backup while preserving custom agent runners", () => {
    const original = `[meta]
config_version = 1

[ui]
theme = "catppuccin-mocha"
collapse_thinking = true
agent_summaries = false

[notifications]
sound_enabled = false
min_tool_calls = 3
terminal_method = "auto"

[plugins]
enabled = true
disabled = ["bundled:j-gonzalez", "global:/tmp/demo:0"]

[agents]
default = "pi"

[agents.runners.pi]
command = "atlas"
args = ["alta", "agent", "run", "pi.yml"]
profile = "alta"

[agents.runners.rovodev]
command = "acli"
args = ["rovodev", "acp"]
renderer = "rovodev"
`;
    writeConfig(original);

    const config = reloadConfig();
    const warnings = consumeConfigWarnings();
    const text = fs.readFileSync(configPath(), "utf-8");
    const warning = warnings.find((entry) => entry.includes("Config migration:"));
    const backupPath = warning?.split("Backup: ")[1];

    expect(config.agents.default).toBe("pi");
    expect(config.agents.runners.pi).toMatchObject({ command: "atlas", profile: "alta" });
    expect(config.agents.runners.rovodev).toMatchObject({ command: "acli", profile: "rovodev" });
    expect(text).toContain(`config_version = ${CURRENT_CONFIG_VERSION}`);
    expect(text).toContain('thread_worktree_location = "relay"');
    expect(text).toContain('prompt_marker = ">"');
    expect(text).toContain("vim_keybindings = false");
    expect(text).toContain("[agents.runners.pi]");
    expect(text).toContain("[agents.runners.rovodev]");
    expect(text).not.toContain("collapse_thinking");
    expect(text).not.toContain("agent_summaries");
    expect(text).not.toContain("min_tool_calls");
    expect(text).not.toContain("terminal_method");
    expect(text).not.toContain("bundled:j-gonzalez");
    expect(text).toContain("global:/tmp/demo:0");
    expect(text).toContain('profile = "rovodev"');
    expect(text).not.toContain("renderer");
    expect(warning).toContain(`from version 1 to ${CURRENT_CONFIG_VERSION}`);
    expect(backupPath).toBeDefined();
    expect(path.dirname(backupPath!)).toBe(path.join(getConfigDir(), "backups"));
    expect(fs.existsSync(backupPath!)).toBe(true);
    expect(fs.readFileSync(backupPath!, "utf-8")).toBe(original);
  });

  test("moves legacy config backups out of the config root and keeps the newest five", () => {
    writeConfig(`[meta]\nconfig_version = ${CURRENT_CONFIG_VERSION}\n`);
    const configDir = getConfigDir();
    for (let index = 0; index < 6; index += 1) {
      const backupPath = path.join(configDir, `config.toml.bak.2025010100000${index}`);
      fs.writeFileSync(backupPath, `legacy backup ${index}`, "utf-8");
    }

    reloadConfig();

    const rootBackupNames = fs.readdirSync(configDir).filter((name) => name.startsWith("config.toml.bak."));
    const backupNames = fs.readdirSync(path.join(configDir, "backups"));
    expect(rootBackupNames).toEqual([]);
    expect(backupNames).toHaveLength(5);
    expect(backupNames).not.toContain("config.toml.bak.20250101000000");
    expect(backupNames).toContain("config.toml.bak.20250101000005");
  });

  test("migrates the stock Alta default to Code Agent while preserving runner preferences", () => {
    const original = `[meta]
config_version = 2

[agents]
default = "alta"

[agents.runners.alta]
command = "/opt/atlassian/bin/atlas"
args = ["alta", "agent", "run"]
profile = "alta"
preferred_model = "gpt-5-5-high"
preferred_thinking_level = "high"
env = { RELAY_TEST = "1" }
`;
    writeConfig(original);

    const config = reloadConfig();
    const warnings = consumeConfigWarnings();
    const text = fs.readFileSync(configPath(), "utf-8");

    expect(config.agents.default).toBe("code-agent");
    expect(config.agents.runners["code-agent"]).toEqual({
      command: "/opt/atlassian/bin/atlas",
      args: ["alta", "agent", "run", "code-agent"],
      profile: "alta",
      preferred_model: "gpt-5-5-high",
      preferred_thinking_level: "high",
      env: { RELAY_TEST: "1" },
    });
    expect(config.agents.runners.alta?.args).toEqual(["alta", "agent", "run"]);
    expect(text).toContain(`config_version = ${CURRENT_CONFIG_VERSION}`);
    expect(text).toContain("[agents.runners.code-agent]");
    expect(warnings.some((warning) => warning.includes("changed the default agent from alta to code-agent"))).toBe(
      true,
    );
  });

  test("adds Code Agent without replacing a customized Alta default", () => {
    writeConfig(`[meta]
config_version = 2

[agents]
default = "alta"

[agents.runners.alta]
command = "/opt/atlassian/bin/atlas"
args = ["alta", "agent", "run", "@atlassian/alta-agent-custom"]
profile = "alta"
`);

    const config = reloadConfig();

    expect(config.agents.default).toBe("alta");
    expect(config.agents.runners.alta?.args).toEqual(["alta", "agent", "run", "@atlassian/alta-agent-custom"]);
    expect(config.agents.runners["code-agent"]).toMatchObject({
      args: ["alta", "agent", "run", "code-agent"],
      profile: "alta",
    });
  });

  test("preserves Code Agent preferences while merging Alta runner environment", () => {
    writeConfig(`[meta]
config_version = 2

[agents]
default = "alta"

[agents.runners.alta]
command = "/opt/atlassian/bin/atlas"
args = ["alta", "agent", "run"]
profile = "alta"
preferred_model = "gpt-5-5-high"
env = { RELAY_TEST = "1", SHARED = "alta" }

[agents.runners.code-agent]
command = "/opt/atlassian/bin/atlas"
args = ["alta", "agent", "run", "code-agent"]
profile = "alta"
preferred_model = "gpt-5-6-terra"
env = { SHARED = "code" }
`);

    const config = reloadConfig();

    expect(config.agents.default).toBe("code-agent");
    expect(config.agents.runners["code-agent"]).toMatchObject({
      preferred_model: "gpt-5-6-terra",
      env: { RELAY_TEST: "1", SHARED: "code" },
    });
  });

  test("does not switch the default to an existing customized Code Agent runner", () => {
    writeConfig(`[meta]
config_version = 2

[agents]
default = "alta"

[agents.runners.alta]
command = "/opt/atlassian/bin/atlas"
args = ["alta", "agent", "run"]
profile = "alta"

[agents.runners.code-agent]
command = "custom-code-agent"
args = ["acp"]
profile = "default"
`);

    const config = reloadConfig();

    expect(config.agents.default).toBe("alta");
    expect(config.agents.runners["code-agent"]).toMatchObject({
      command: "custom-code-agent",
      args: ["acp"],
      profile: "default",
    });
  });

  test("uses Code Agent for fresh unversioned defaults", () => {
    writeConfig("");

    const config = reloadConfig();

    expect(config.agents.default).toBe("code-agent");
    expect(config.agents.runners["code-agent"]).toMatchObject({
      args: ["alta", "agent", "run", "code-agent"],
      profile: "alta",
    });
    expect(config.agents.runners.alta).toMatchObject({
      args: ["alta", "agent", "run"],
      profile: "alta",
    });
  });

  test("does not rewrite unversioned config fixtures", () => {
    const original = `[ui]
show_tips = false

[agents]
default = "custom"

[agents.runners.custom]
command = "custom-agent"
args = ["run"]
`;
    writeConfig(original);

    const config = reloadConfig();
    const warnings = consumeConfigWarnings();
    const text = fs.readFileSync(configPath(), "utf-8");

    expect(config.agents.default).toBe("custom");
    expect(config.agents.runners.custom).toMatchObject({ command: "custom-agent", args: ["run"] });
    expect(text).toBe(original);
    expect(warnings.some((entry) => entry.includes("Config migration:"))).toBe(false);
  });

  test("setNotificationSoundsEnabled writes disabled value and preserves agent runners", () => {
    writeConfig(`[meta]
config_version = 1

[notifications]
sound_enabled = true
volume = 0.5

[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = ["run"]
profile = "default"
`);

    const config = setNotificationSoundsEnabled(false);
    const text = fs.readFileSync(configPath(), "utf-8");

    expect(config.notifications.sound_enabled).toBe(false);
    expect(reloadConfig().notifications.sound_enabled).toBe(false);
    expect(text).toContain("sound_enabled = false");
    expect(text).toContain("[agents.runners.faux]");
    expect(text).toContain('command = "faux-agent"');
  });

  test("updates a symlinked config target without replacing the symlink", () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-config-file-target-"));
    const targetPath = path.join(targetDir, "config.toml");

    try {
      fs.mkdirSync(getConfigDir(), { recursive: true });
      fs.writeFileSync(targetPath, "[notifications]\nsound_enabled = true\n", "utf-8");
      fs.symlinkSync(targetPath, configPath(), "file");
      resetConfig();

      const config = setNotificationSoundsEnabled(false);

      expect(config.notifications.sound_enabled).toBe(false);
      expect(fs.lstatSync(configPath()).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(configPath())).toBe(targetPath);
      expect(fs.readFileSync(targetPath, "utf-8")).toContain("sound_enabled = false");
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test("does not overwrite syntactically invalid TOML", () => {
    writeConfig("[notifications\nsound_enabled = true\n");
    const before = fs.readFileSync(configPath(), "utf-8");

    expect(() => setNotificationSoundsEnabled(false)).toThrow("Cannot update invalid config");
    expect(fs.readFileSync(configPath(), "utf-8")).toBe(before);
  });

  test("invalid unrelated field does not reset valid notification value", () => {
    writeConfig(`[ui]
theme = "not-a-theme"

[notifications]
sound_enabled = false
`);

    const config = reloadConfig();
    const warnings = consumeConfigWarnings();

    expect(config.notifications.sound_enabled).toBe(false);
    expect(config.ui.theme).toBe("catppuccin-mocha");
    expect(warnings.some((warning) => warning.includes("Invalid theme for ui.theme"))).toBe(true);
  });

  test("uses accessible Catppuccin Mocha text hierarchy colors", () => {
    const colors = getTheme("catppuccin-mocha").colors;

    expect(colors.bg).toBe("#1e1e2e");
    expect(colors.textSubtle).toBe("#858aa3");
    expect(colors.textMuted).toBe("#9399b2");
    expect(colors.textLabel).toBe("#a6adc8");
    expect(colors.fg).toBe("#cdd6f4");
  });

  test("loads custom themes and makes them available to settings", () => {
    writeConfig(`[ui]\ntheme = "paper-cuts"\n`);
    const theme = customTheme("paper-cuts");
    const colors = theme.colors as Record<string, unknown>;
    theme.vars = { brand: "#123456" };
    colors.accent = "brand";
    colors.futurePluginColor = { mode: "experimental" };
    writeCustomTheme("paper-cuts.json", theme);

    const config = reloadConfig();

    expect(config.ui.theme).toBe("paper-cuts");
    expect(getThemeIds()).toContain("paper-cuts");
    expect(getThemeOptions()).toContainEqual(["paper-cuts", "Custom paper-cuts"]);
    expect(getTheme("paper-cuts").colors.accent).toBe("#123456");
  });

  test("valid custom themes override bundled themes with the same name", () => {
    writeConfig(`[ui]\ntheme = "catppuccin-mocha"\n`);
    const theme = customTheme("catppuccin-mocha");
    const colors = theme.colors as Record<string, unknown>;
    colors.accent = "#123456";
    writeCustomTheme("catppuccin-mocha.json", theme);

    expect(reloadConfig().colors.accent).toBe("#123456");
    expect(getThemeIds().filter((themeId) => themeId === "catppuccin-mocha")).toHaveLength(1);
  });

  test("invalid custom themes keep bundled themes and produce launch warnings", () => {
    writeConfig(`[ui]\ntheme = "catppuccin-mocha"\n`);
    const bundledAccent = getTheme("catppuccin-mocha").colors.accent;
    const theme = customTheme("catppuccin-mocha");
    const colors = theme.colors as Record<string, unknown>;
    colors.accent = "not-a-color";
    writeCustomTheme("catppuccin-mocha.json", theme);

    const load = getConfigLoadResult();

    expect(load.config.colors.accent).toBe(bundledAccent);
    expect(load.warnings.some((warning) => warning.includes("Custom theme warning"))).toBe(true);
    expect(load.warnings.some((warning) => warning.includes("colors.accent must be a #RRGGBB color"))).toBe(true);
  });

  test("string false is not treated as truthy boolean", () => {
    writeConfig(`[notifications]
sound_enabled = "false"
`);

    const config = reloadConfig();
    const warnings = consumeConfigWarnings();

    expect(config.notifications.sound_enabled).toBe(true);
    expect(warnings.some((warning) => warning.includes("Invalid boolean for notifications.sound_enabled"))).toBe(true);
  });

  test("setConfigValue writes nested key paths", () => {
    writeConfig(`[notifications]
volume = 0.5
`);

    setConfigValue("notifications.volume", 0.7);

    expect(reloadConfig().notifications.volume).toBe(0.7);
    expect(fs.readFileSync(configPath(), "utf-8")).toContain("volume = 0.7");
  });

  test("loads and writes terminal notification enabled", () => {
    writeConfig(`[notifications]
terminal_enabled = false
`);

    expect(reloadConfig().notifications.terminal_enabled).toBe(false);

    setConfigValue("notifications.terminal_enabled", true);

    expect(reloadConfig().notifications.terminal_enabled).toBe(true);
    expect(fs.readFileSync(configPath(), "utf-8")).toContain("terminal_enabled = true");
  });

  test("removed notification keys are ignored", () => {
    writeConfig(`[notifications]
enabled = true
terminal_method = "auto"
`);

    const config = reloadConfig();
    const warnings = consumeConfigWarnings();

    expect(config.notifications.sound_enabled).toBe(true);
    expect(config.notifications.terminal_enabled).toBe(true);
    expect(warnings.some((warning) => warning.includes("notifications.enabled"))).toBe(false);
    expect(warnings.some((warning) => warning.includes("notifications.terminal_method"))).toBe(false);
  });

  test("setConfigValue writes editable UI setting paths", () => {
    writeConfig(`[ui]
show_tips = true
`);

    setConfigValue("ui.show_tips", false);

    expect(reloadConfig().ui.show_tips).toBe(false);
    expect(fs.readFileSync(configPath(), "utf-8")).toContain("show_tips = false");
  });

  test("loads and writes thinking visibility", () => {
    writeConfig(`[ui]
show_thinking = false
`);

    expect(reloadConfig().ui.show_thinking).toBe(false);

    setConfigValue("ui.show_thinking", true);

    expect(reloadConfig().ui.show_thinking).toBe(true);
    expect(fs.readFileSync(configPath(), "utf-8")).toContain("show_thinking = true");
  });

  test("setConfigValue writes terminal title prompt source", () => {
    writeConfig(`[ui]\nterminal_title_prompt_source = "smart"\n`);

    setConfigValue("ui.terminal_title_prompt_source", "last");

    expect(reloadConfig().ui.terminal_title_prompt_source).toBe("last");
    expect(fs.readFileSync(configPath(), "utf-8")).toContain('terminal_title_prompt_source = "last"');
  });

  test("setConfigValue keeps the telemetry consent file in sync", () => {
    writeConfig(`[telemetry]
analytics_enabled = false
`);

    setConfigValue("telemetry.analytics_enabled", true);

    expect(reloadConfig().telemetry.analytics_enabled).toBe(true);
    expect(fs.readFileSync(configPath(), "utf-8")).toContain("analytics_enabled = true");
    expect(readTelemetryConsent(getConfigDir())).toBe(true);

    setConfigValue("telemetry.analytics_enabled", false);

    expect(reloadConfig().telemetry.analytics_enabled).toBe(false);
    expect(readTelemetryConsent(getConfigDir())).toBe(false);
  });

  test("plugin toggles persist under plugin config", () => {
    writeConfig(`[plugins]
enabled = false
disabled = []
`);

    setPluginsEnabled(true);
    setRelayPluginEnabled("config:/tmp/demo.mjs", false);

    const config = reloadConfig();
    const text = fs.readFileSync(configPath(), "utf-8");
    expect(config.plugins.enabled).toBe(true);
    expect(config.plugins.disabled).toEqual(["config:/tmp/demo.mjs"]);
    expect(text).toContain('disabled = ["config:/tmp/demo.mjs"]');

    setRelayPluginEnabled("config:/tmp/demo.mjs", true);
    expect(reloadConfig().plugins.disabled).toEqual([]);
  });

  test("plugin toggles preserve default disabled plugins when disabled list is omitted", () => {
    writeConfig(`[plugins]
enabled = true
`);

    setRelayPluginEnabled("config:/tmp/demo.mjs", false);
    expect(reloadConfig().plugins.disabled).toEqual(["config:/tmp/demo.mjs"]);

    setRelayPluginEnabled("config:/tmp/demo.mjs", true);
    expect(reloadConfig().plugins.disabled).toEqual([]);
  });

  test("plugin config ignores removed bundled plugins but preserves the restored goal plugin", () => {
    writeConfig(`[plugins]
enabled = true
disabled = ["bundled:a-shumer", "bundled:j-gonzalez", "bundled:goal"]
`);

    expect(reloadConfig().plugins.disabled).toEqual(["bundled:goal"]);

    setRelayPluginEnabled("config:/tmp/demo.mjs", false);
    expect(reloadConfig().plugins.disabled).toEqual(["bundled:goal", "config:/tmp/demo.mjs"]);
    expect(fs.readFileSync(configPath(), "utf-8")).not.toContain("bundled:a-shumer");
    expect(fs.readFileSync(configPath(), "utf-8")).not.toContain("bundled:j-gonzalez");
    expect(fs.readFileSync(configPath(), "utf-8")).toContain("bundled:goal");
  });

  test("setters reject invalid schema-backed values without changing file", () => {
    writeConfig(`[ui]
theme = "gruvbox-dark"

[notifications]
volume = 0.5
`);
    const before = fs.readFileSync(configPath(), "utf-8");

    expect(() => setTheme("not-a-theme")).toThrow("Invalid value for ui.theme");
    expect(() => setNotificationVolume(2)).toThrow("notifications.volume must be <= 1");
    expect(fs.readFileSync(configPath(), "utf-8")).toBe(before);
  });

  test("configured Alta agent runners drop explicit server port for reusable warm startup", () => {
    writeConfig(`[agents]
default = "local-alta"

[agents.runners.local-alta]
command = "/repo/node_modules/.bin/tsx"
args = ["/repo/services/alta-cli/bin/alta.ts", "agent", "run", "@fixtures/alta-agent-fixture", "--workspace", "/tmp/ws", "--server-port", "47042"]
profile = "alta"

[agents.runners.inline-tool]
command = "custom-acp"
args = ["--server-port", "47042"]
profile = "default"
`);

    expect(resolveConfiguredAgent("local-alta")?.args).toEqual([
      "/repo/services/alta-cli/bin/alta.ts",
      "agent",
      "run",
      "@fixtures/alta-agent-fixture",
      "--workspace",
      "/tmp/ws",
    ]);
    expect(resolveConfiguredAgent("inline-tool")?.args).toEqual(["--server-port", "47042"]);
  });

  test("configured direct Alta runners drop explicit server port", () => {
    writeConfig(`[agents]
default = "alta"

[agents.runners.alta]
command = "/usr/local/bin/alta"
args = ["agent", "run", "@fixtures/alta-agent-fixture", "--server-port", "47042"]
profile = "alta"
`);

    expect(resolveConfiguredAgent("alta")?.args).toEqual(["agent", "run", "@fixtures/alta-agent-fixture"]);
  });

  test("loads websocket agent runner config", () => {
    writeConfig(`[agents]
default = "alta-cloud"

[agents.runners.alta-cloud]
transport = "websocket"
url = "wss://alta.example.test/acp?token=secret"
headers = { Authorization = "Bearer redacted" }
protocols = ["acp.v1"]
framing = "ndjson"
profile = "alta"
`);

    expect(resolveConfiguredAgent("alta-cloud")).toEqual({
      name: "alta-cloud",
      command: "",
      args: [],
      profile: "alta",
      internalSessionTitleAliases: [],
      transport: "websocket",
      url: "wss://alta.example.test/acp?token=secret",
      headers: { Authorization: "Bearer redacted" },
      protocols: ["acp.v1"],
      framing: "ndjson",
    });
  });

  test("loads legacy renderer field as profile", () => {
    writeConfig(`[agents]
default = "legacy"

[agents.runners.legacy]
command = "legacy-agent"
args = []
renderer = "rovodev"
`);

    expect(getConfig().agents.runners.legacy?.profile).toBe("rovodev");
    expect(resolveConfiguredAgent("legacy")?.profile).toBe("rovodev");
  });

  test("config writes migrate legacy renderer field to profile", () => {
    writeConfig(`[agents]
default = "legacy"

[agents.runners.legacy]
command = "legacy-agent"
args = []
renderer = "rovodev"
`);

    setAgentPreferredModel("legacy", "model-b");
    const text = fs.readFileSync(configPath(), "utf-8");

    expect(text).toContain('profile = "rovodev"');
    expect(text).not.toContain("renderer");
  });

  test("configured Node-launched Alta runners drop explicit server port", () => {
    writeConfig(`[agents]
default = "local-alta"

[agents.runners.local-alta]
command = "/usr/local/bin/node"
args = ["--import", "file:///repo/node_modules/tsx/dist/loader.mjs", "/repo/services/alta-cli/bin/alta.ts", "agent", "run", "--server-port", "47042"]
profile = "alta"
`);

    expect(resolveConfiguredAgent("local-alta")?.args).toEqual([
      "--import",
      "file:///repo/node_modules/tsx/dist/loader.mjs",
      "/repo/services/alta-cli/bin/alta.ts",
      "agent",
      "run",
    ]);
  });

  test("configured Atlas Alta runners drop equals-style server port", () => {
    writeConfig(`[agents]
default = "alta"

[agents.runners.alta]
command = "/opt/atlassian/bin/atlas"
args = ["alta", "agent", "run", "--server-port=47042"]
profile = "alta"
`);

    expect(resolveConfiguredAgent("alta")?.args).toEqual(["alta", "agent", "run"]);
  });

  test("agent preferred model persists under runner and can be cleared", () => {
    writeConfig(`[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
`);

    setAgentPreferredModel("faux", " model-b ");

    expect(reloadConfig().agents.runners.faux?.preferred_model).toBe("model-b");
    expect(fs.readFileSync(configPath(), "utf-8")).toContain('preferred_model = "model-b"');

    setAgentPreferredModel("faux", undefined);

    expect(reloadConfig().agents.runners.faux?.preferred_model).toBeUndefined();
    expect(fs.readFileSync(configPath(), "utf-8")).not.toContain("preferred_model");
  });

  test("agent preferred thinking level persists under runner and can be cleared", () => {
    writeConfig(`[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
`);

    setAgentPreferredThinkingLevel("faux", " ultra ");

    expect(reloadConfig().agents.runners.faux?.preferred_thinking_level).toBe("ultra");
    expect(fs.readFileSync(configPath(), "utf-8")).toContain('preferred_thinking_level = "ultra"');

    setAgentPreferredThinkingLevel("faux", undefined);

    expect(reloadConfig().agents.runners.faux?.preferred_thinking_level).toBeUndefined();
    expect(fs.readFileSync(configPath(), "utf-8")).not.toContain("preferred_thinking_level");
  });

  test("blank preferred model is rejected", () => {
    writeConfig(`[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
preferred_model = "model-a"
`);
    const before = fs.readFileSync(configPath(), "utf-8");

    expect(() => setAgentPreferredModel("faux", "")).toThrow("Preferred model must be a non-empty string");
    expect(() => setAgentPreferredModel("faux", "   ")).toThrow("Preferred model must be a non-empty string");
    expect(fs.readFileSync(configPath(), "utf-8")).toBe(before);
  });

  test("setting preferred model requires an existing runner", () => {
    writeConfig(`[agents]
default = "faux"
`);
    const before = fs.readFileSync(configPath(), "utf-8");

    expect(() => setAgentPreferredModel("faux", "model-b")).toThrow("No agent runner configured for: faux");
    expect(fs.readFileSync(configPath(), "utf-8")).toBe(before);

    setAgentPreferredModel("faux", undefined);

    expect(fs.readFileSync(configPath(), "utf-8")).not.toContain("agents.runners.faux");
  });

  test("blank preferred thinking level is rejected", () => {
    writeConfig(`[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
preferred_thinking_level = "high"
`);
    const before = fs.readFileSync(configPath(), "utf-8");

    expect(() => setAgentPreferredThinkingLevel("faux", "")).toThrow(
      "Preferred thinking level must be a non-empty string",
    );
    expect(() => setAgentPreferredThinkingLevel("faux", "   ")).toThrow(
      "Preferred thinking level must be a non-empty string",
    );
    expect(fs.readFileSync(configPath(), "utf-8")).toBe(before);
  });

  test("blank preferred thinking level values are ignored with a warning", () => {
    writeConfig(`[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
preferred_thinking_level = "   "
`);

    const config = reloadConfig();
    const warnings = consumeConfigWarnings();

    expect(config.agents.runners.faux?.preferred_thinking_level).toBeUndefined();
    expect(warnings.some((warning) => warning.includes("invalid preferred_thinking_level"))).toBe(true);
  });

  test("invalid preferred model values are ignored with a warning", () => {
    writeConfig(`[agents]
default = "faux"

[agents.runners.faux]
command = "faux-agent"
args = []
profile = "default"
preferred_model = "   "
`);

    const config = reloadConfig();
    const warnings = consumeConfigWarnings();

    expect(config.agents.runners.faux?.preferred_model).toBeUndefined();
    expect(warnings.some((warning) => warning.includes("invalid preferred_model"))).toBe(true);
  });

  test("successful writes notify subscribers once", () => {
    writeConfig(`[notifications]
sound_enabled = true
`);
    const seen: boolean[] = [];
    subscribeConfig((change) => seen.push(change.config.notifications.sound_enabled));

    setNotificationSoundsEnabled(false);

    expect(seen).toEqual([false]);
  });

  test("watcher reloads external edits without duplicating internal writes", async () => {
    writeConfig(`[notifications]
sound_enabled = true
`);
    const seen: boolean[] = [];
    subscribeConfig((change) => seen.push(change.config.notifications.sound_enabled));
    const stop = startConfigWatcher();

    try {
      setNotificationSoundsEnabled(false);
      expect(seen).toEqual([false]);

      fs.writeFileSync(configPath(), `[notifications]\nsound_enabled = true\n`, "utf-8");
      await waitFor(() => getConfig().notifications.sound_enabled === true);

      expect(seen).toEqual([false, true]);
    } finally {
      stop();
    }
  });

  test("watcher waits for valid external edits to settle before applying them", async () => {
    writeConfig(`[notifications]
sound_enabled = false
volume = 0.2
`);
    expect(getConfig().notifications.sound_enabled).toBe(false);
    const seen: Array<{ enabled: boolean; volume: number; parseError: boolean; source: string }> = [];
    subscribeConfig((change) =>
      seen.push({
        enabled: change.config.notifications.sound_enabled,
        volume: change.config.notifications.volume,
        parseError: change.parseError !== null,
        source: change.source,
      }),
    );
    const stop = startConfigWatcher();

    try {
      await sleep(150);
      fs.writeFileSync(configPath(), `[notifications]\nsound_enabled = true\n`, "utf-8");
      await sleep(180);

      expect(getConfig().notifications.sound_enabled).toBe(false);
      expect(getConfig().notifications.volume).toBe(0.2);
      expect(seen).toEqual([]);

      fs.writeFileSync(configPath(), `[notifications]\nsound_enabled = true\nvolume = 0.8\n`, "utf-8");
      await waitFor(() => getConfig().notifications.sound_enabled === true && getConfig().notifications.volume === 0.8);

      expect(seen).toEqual([{ enabled: true, volume: 0.8, parseError: false, source: "watch" }]);
    } finally {
      stop();
    }
  });

  test("watcher ignores transient malformed external edits that recover before retry exhaustion", async () => {
    writeConfig(`[notifications]
sound_enabled = false
`);
    expect(getConfig().notifications.sound_enabled).toBe(false);
    const seen: Array<{ enabled: boolean; parseError: boolean; source: string }> = [];
    subscribeConfig((change) =>
      seen.push({
        enabled: change.config.notifications.sound_enabled,
        parseError: change.parseError !== null,
        source: change.source,
      }),
    );
    const stop = startConfigWatcher();

    try {
      await sleep(150);
      fs.writeFileSync(configPath(), `[notifications\nsound_enabled = true\n`, "utf-8");
      await sleep(250);

      expect(getConfig().notifications.sound_enabled).toBe(false);
      expect(seen.some((entry) => entry.parseError)).toBe(false);

      fs.writeFileSync(configPath(), `[notifications]\nsound_enabled = true\n`, "utf-8");
      await waitFor(() => getConfig().notifications.sound_enabled === true);

      expect(seen).toEqual([{ enabled: true, parseError: false, source: "watch" }]);
    } finally {
      stop();
    }
  });

  test("watcher ignores transient missing config files that recover before retry exhaustion", async () => {
    writeConfig(`[notifications]
sound_enabled = false
volume = 0.2
`);
    expect(getConfig().notifications.sound_enabled).toBe(false);
    const seen: Array<{ enabled: boolean; volume: number; parseError: boolean; source: string }> = [];
    subscribeConfig((change) =>
      seen.push({
        enabled: change.config.notifications.sound_enabled,
        volume: change.config.notifications.volume,
        parseError: change.parseError !== null,
        source: change.source,
      }),
    );
    const stop = startConfigWatcher();

    try {
      await sleep(150);
      fs.unlinkSync(configPath());
      await sleep(250);

      expect(getConfig().notifications.sound_enabled).toBe(false);
      expect(fs.existsSync(configPath())).toBe(false);
      expect(seen.some((entry) => entry.parseError)).toBe(false);

      replaceConfig(`[notifications]
sound_enabled = true
volume = 0.8
`);
      await waitFor(() => getConfig().notifications.sound_enabled === true && getConfig().notifications.volume === 0.8);

      expect(seen).toEqual([{ enabled: true, volume: 0.8, parseError: false, source: "watch" }]);
    } finally {
      stop();
    }
  });

  test("watcher keeps previous runtime config after external edit remains invalid", async () => {
    writeConfig(`[notifications]
sound_enabled = false
`);
    expect(getConfig().notifications.sound_enabled).toBe(false);
    const seen: Array<{ enabled: boolean; parseError: boolean; source: string; warnings: number }> = [];
    subscribeConfig((change) =>
      seen.push({
        enabled: change.config.notifications.sound_enabled,
        parseError: change.parseError !== null,
        source: change.source,
        warnings: change.warnings.length,
      }),
    );
    const stop = startConfigWatcher();

    try {
      fs.writeFileSync(configPath(), `[notifications\nsound_enabled = true\n`, "utf-8");
      await waitFor(() => seen.some((entry) => entry.parseError), 1500);

      expect(getConfig().notifications.sound_enabled).toBe(false);
      expect(seen.at(-1)).toEqual({ enabled: false, parseError: true, source: "watch", warnings: 1 });

      fs.writeFileSync(
        configPath(),
        `[meta]\nconfig_version = ${CURRENT_CONFIG_VERSION}\n\n[notifications]\nsound_enabled = true\n`,
        "utf-8",
      );
      await waitFor(() => getConfig().notifications.sound_enabled === true);

      expect(seen.at(-1)).toEqual({ enabled: true, parseError: false, source: "watch", warnings: 0 });
    } finally {
      stop();
    }
  });

  test("watcher treats events as debounced disk reconciliation", async () => {
    writeConfig(`[notifications]
sound_enabled = false
volume = 0.2
`);
    const seen: Array<{ enabled: boolean; volume: number; parseError: boolean; source: string }> = [];
    subscribeConfig((change) =>
      seen.push({
        enabled: change.config.notifications.sound_enabled,
        volume: change.config.notifications.volume,
        parseError: change.parseError !== null,
        source: change.source,
      }),
    );
    const stop = startConfigWatcher();

    try {
      setNotificationSoundsEnabled(true);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(seen).toEqual([{ enabled: true, volume: 0.2, parseError: false, source: "write" }]);

      fs.unlinkSync(configPath());
      replaceConfig(`[notifications]
sound_enabled = true
volume = 0.8
`);
      await waitFor(() => getConfig().notifications.sound_enabled === true && getConfig().notifications.volume === 0.8);

      expect(seen.at(-1)).toEqual({ enabled: true, volume: 0.8, parseError: false, source: "watch" });
    } finally {
      stop();
    }
  });

  test("watcher handles atomic replace, rapid writes, delete recovery, and stop", async () => {
    writeConfig(`[notifications]
sound_enabled = false
volume = 0.2
`);
    expect(getConfig().notifications.sound_enabled).toBe(false);
    const seen: Array<{ enabled: boolean; volume: number; parseError: boolean; source: string }> = [];
    subscribeConfig((change) =>
      seen.push({
        enabled: change.config.notifications.sound_enabled,
        volume: change.config.notifications.volume,
        parseError: change.parseError !== null,
        source: change.source,
      }),
    );
    const stop = startConfigWatcher();
    let stopped = false;
    const stopOnce = () => {
      if (stopped) return;
      stopped = true;
      stop();
    };

    try {
      replaceConfig(`[notifications]
sound_enabled = true
volume = 0.3
`);
      await waitFor(() => getConfig().notifications.sound_enabled === true && getConfig().notifications.volume === 0.3);
      expect(seen.at(-1)).toEqual({ enabled: true, volume: 0.3, parseError: false, source: "watch" });

      fs.writeFileSync(configPath(), `[notifications]\nsound_enabled = false\nvolume = 0.4\n`, "utf-8");
      fs.writeFileSync(configPath(), `[notifications]\nsound_enabled = true\nvolume = 0.6\n`, "utf-8");
      await waitFor(() => getConfig().notifications.sound_enabled === true && getConfig().notifications.volume === 0.6);
      expect(seen.at(-1)).toEqual({ enabled: true, volume: 0.6, parseError: false, source: "watch" });

      fs.unlinkSync(configPath());
      await waitFor(() => seen.some((entry) => entry.parseError), 1500);
      expect(getConfig().notifications.sound_enabled).toBe(true);
      expect(fs.existsSync(configPath())).toBe(false);

      replaceConfig(`[notifications]
sound_enabled = false
volume = 0.7
`);
      await waitFor(
        () => getConfig().notifications.sound_enabled === false && getConfig().notifications.volume === 0.7,
      );
      expect(seen.at(-1)).toEqual({ enabled: false, volume: 0.7, parseError: false, source: "watch" });

      stopOnce();
      fs.writeFileSync(configPath(), `[notifications]\nsound_enabled = true\nvolume = 0.9\n`, "utf-8");
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(getConfig().notifications.sound_enabled).toBe(false);
      expect(getConfig().notifications.volume).toBe(0.7);
    } finally {
      stop();
    }
  });
});

test("addAgentRunner writes a new runner entry to the config file", () => {
  writeConfig(`[agents]
default = "alta"

[agents.runners.alta]
command = "/opt/atlassian/bin/atlas"
args = ["alta", "agent", "run"]
profile = "alta"
`);

  const config = addAgentRunner("my-agent", "atlas", ["alta", "agent", "run", "my-pkg"], "my-agent");
  const text = fs.readFileSync(configPath(), "utf-8");

  expect(config.agents.runners["my-agent"]).toEqual({
    command: "atlas",
    args: ["alta", "agent", "run", "my-pkg"],
    profile: "my-agent",
  });
  expect(text).toContain("[agents.runners.my-agent]");
  expect(text).toContain('command = "atlas"');
  expect(text).toContain('profile = "my-agent"');
  // pre-existing runner preserved
  expect(text).toContain("[agents.runners.alta]");
});

test("addAgentRunner overwrites an existing runner entry", () => {
  writeConfig(`[agents]
default = "faux"

[agents.runners.faux]
command = "old-cmd"
args = []
profile = "default"
`);

  addAgentRunner("faux", "new-cmd", ["--flag"], "default");

  const config = reloadConfig();
  expect(config.agents.runners.faux?.command).toBe("new-cmd");
  expect(config.agents.runners.faux?.args).toEqual(["--flag"]);
});

test("addAgentRunner rejects blank agent name", () => {
  writeConfig(`[agents]\ndefault = "alta"\n`);
  expect(() => addAgentRunner("  ", "atlas", [], "alta")).toThrow("Agent name is required");
});

test("addAgentRunner rejects blank command", () => {
  writeConfig(`[agents]\ndefault = "alta"\n`);
  expect(() => addAgentRunner("my-agent", "   ", [], "my-agent")).toThrow("Command is required");
});

test("addAgentRunner rejects agent names with TOML-unsafe characters", () => {
  writeConfig(`[agents]\ndefault = "alta"\n`);
  expect(() => addAgentRunner("bad name", "atlas", [], "alta")).toThrow("Invalid agent name");
  expect(() => addAgentRunner("bad.with.dots", "atlas", [], "alta")).toThrow("Invalid agent name");
  expect(() => addAgentRunner('with"quote', "atlas", [], "alta")).toThrow("Invalid agent name");
  expect(() => addAgentRunner("[bracket]", "atlas", [], "alta")).toThrow("Invalid agent name");
  expect(() => addAgentRunner("-leading-dash", "atlas", [], "alta")).toThrow("Invalid agent name");
  expect(() => addAgentRunner("ok_name-1", "atlas", [], "alta")).not.toThrow();
});

test("addAgentRunner preserves args containing spaces verbatim", () => {
  writeConfig(`[agents]\ndefault = "alta"\n`);
  addAgentRunner("scripted", "bash", ["-c", "echo hello world"], "scripted");
  const reloaded = reloadConfig();
  expect(reloaded.agents.runners.scripted?.args).toEqual(["-c", "echo hello world"]);
});

describe("plugin settings", () => {
  test("setPluginSettingValue writes under [plugin_settings.{source}_{name}]", () => {
    writeConfig("");
    setPluginSettingValue("global:/path/clock:0", "clock", "format", "%H:%M");
    const text = fs.readFileSync(configPath(), "utf-8");
    expect(text).toContain("[plugin_settings.global_clock]");
    expect(text).toContain('format = "%H:%M"');
  });

  test("getPluginSettingRaw reads the persisted value", () => {
    writeConfig("");
    setPluginSettingValue("global:/path/clock:0", "clock", "format", "%I:%M %p");
    const value = getPluginSettingRaw("global:/path/clock:0", "clock", "format");
    expect(value).toBe("%I:%M %p");
  });

  test("getPluginSettingRaw returns undefined when key is absent", () => {
    writeConfig("");
    const value = getPluginSettingRaw("global:/path/clock:0", "clock", "missing");
    expect(value).toBeUndefined();
  });

  test("plugin_settings section round-trips through reload", () => {
    writeConfig("");
    setPluginSettingValue("bundled:example", "example", "show_badge", true);
    const reloaded = reloadConfig();
    expect(reloaded.plugin_settings["bundled_example"]?.["show_badge"]).toBe(true);
  });

  test("sanitizes plugin name characters that are not TOML-safe bare-key chars", () => {
    writeConfig("");
    setPluginSettingValue("global:/path/my.plugin:0", "my.plugin", "enabled", true);
    const text = fs.readFileSync(configPath(), "utf-8");
    expect(text).toContain("[plugin_settings.global_my_plugin]");
  });

  test("source prefix distinguishes same-named plugins from different sources", () => {
    writeConfig("");
    setPluginSettingValue("global:/path/clock:0", "clock", "format", "global-fmt");
    setPluginSettingValue("workspace:/path/clock:0", "clock", "format", "ws-fmt");
    expect(getPluginSettingRaw("global:/path/clock:0", "clock", "format")).toBe("global-fmt");
    expect(getPluginSettingRaw("workspace:/path/clock:0", "clock", "format")).toBe("ws-fmt");
    const text = fs.readFileSync(configPath(), "utf-8");
    expect(text).toContain("[plugin_settings.global_clock]");
    expect(text).toContain("[plugin_settings.workspace_clock]");
  });

  test("getConfig().plugin_settings is empty object when section absent", () => {
    writeConfig("");
    expect(getConfig().plugin_settings).toEqual({});
  });

  test("multiple keys in the same plugin section are preserved on update", () => {
    writeConfig("");
    setPluginSettingValue("global:/clock:0", "clock", "format", "%H:%M");
    setPluginSettingValue("global:/clock:0", "clock", "show_seconds", true);
    expect(getPluginSettingRaw("global:/clock:0", "clock", "format")).toBe("%H:%M");
    expect(getPluginSettingRaw("global:/clock:0", "clock", "show_seconds")).toBe(true);
  });

  // Without the Atlas CLI the stock runners would point at a binary that is not
  // installed, so a fresh config must default to a built-in agent instead. The
  // host running these tests may or may not have Atlas, so both branches are
  // covered through the pure helpers rather than the detected value.
  describe("default agent selection", () => {
    test("uses the Alta code agent when the Atlas CLI is present", () => {
      expect(defaultAgentNameFor("/opt/atlassian/bin/atlas")).toBe("code-agent");
      expect(Object.keys(defaultAgentRunners("/opt/atlassian/bin/atlas")).sort()).toEqual(["alta", "code-agent"]);
    });

    test("falls back to a built-in agent with no runners when Atlas is absent", () => {
      expect(defaultAgentNameFor(null)).toBe("rovo");
      expect(defaultAgentRunners(null)).toEqual({});
    });

    // Regression: with no stock code-agent runner the migration used to store
    // `undefined`, which made the TOML serializer throw. The migration was then
    // caught and retried on every launch, warning and writing a backup each time.
    test("does not add a code-agent runner when no stock runner exists", () => {
      const data: Record<string, unknown> = {
        agents: { default: "alta", runners: { alta: { command: "/custom/alta", args: ["custom"], profile: "alta" } } },
      };

      const changes = migrateConfigV2ToV3(data, undefined);

      const runners = (data.agents as { runners: Record<string, unknown> }).runners;
      expect("code-agent" in runners).toBe(false);
      expect(changes).not.toContain("added the code-agent runner");
    });

    test("adds the code-agent runner when a stock runner exists", () => {
      const data: Record<string, unknown> = {
        agents: { default: "alta", runners: { alta: { command: "/custom/alta", args: ["custom"], profile: "alta" } } },
      };
      const stock = { command: "/opt/atlassian/bin/atlas", args: ["alta", "agent", "run", "code-agent"] };

      const changes = migrateConfigV2ToV3(data, stock);

      const runners = (data.agents as { runners: Record<string, unknown> }).runners;
      expect(runners["code-agent"]).toEqual(stock);
      expect(changes).toContain("added the code-agent runner");
    });

    // Regression: a built-in fallback has no runner entry, so an unknown default
    // used to collapse to "" and resolve to no agent at all.
    test("accepts a built-in agent as the fallback default", () => {
      const result = validateAgentsConfig({ default: "typo-agent" }, { default: "rovo", runners: {} }, () => {});

      expect(result.default).toBe("rovo");
    });

    test("still prefers a configured runner when the fallback is not built in", () => {
      const configured = { command: "custom-agent", args: ["acp"], profile: "default" };
      const result = validateAgentsConfig(
        { default: "typo-agent", runners: { "custom-agent": configured } },
        { default: "not-an-agent", runners: {} },
        () => {},
      );

      expect(result.default).toBe("custom-agent");
    });

    test("points the stock runners at the detected Atlas command", () => {
      const runners = defaultAgentRunners("/usr/local/bin/atlas");
      expect(runners["code-agent"]).toEqual({
        command: "/usr/local/bin/atlas",
        args: ["alta", "agent", "run", "code-agent"],
        profile: "alta",
      });
      expect(runners.alta?.command).toBe("/usr/local/bin/atlas");
    });
  });
});
