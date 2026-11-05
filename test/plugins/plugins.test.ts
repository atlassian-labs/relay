import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Config, getConfigDir, getPluginSettingRaw, resetConfig } from "../../src/config";
import {
  defineRelayPlugin as defineRelayPackagePlugin,
  relayLine as relayPackageLine,
  type RelayPluginApi as RelayPackagePluginApi,
} from "@atlassian/relay-plugin-sdk";
import {
  combineRelayDisposables,
  createRelayDisposable,
  defineRelayCommand,
  defineRelayPlugin as defineRelaySdkPlugin,
  defineRelayToolRenderer,
  relayCard,
  relayInlineInputLine,
  relayLine,
  relayLines,
} from "../../src/plugin";
import { getTheme } from "../../src/config/themes";
import {
  discoverRelayPlugins,
  listRelayPlugins,
  loadRelayPluginsEffect,
  normalizePluginKeybinding,
  PluginRunner,
  type RelayCommandContext,
  type RelayMcpStatus,
  type RelayPluginApi,
  type RelayWidgetHandle,
} from "../../src/plugins";
import { BUNDLED_RELAY_PLUGINS, type BundledRelayPlugin } from "../../src/plugins/bundled";
import { persistentPluginStorageFilePath } from "../../src/plugins/storage";
import { buildPluginItems } from "../../src/ui/util/plugins";
import { runTestEffect } from "../lib/effect";
import {
  FAUX_BUNDLED_PLUGIN,
  FAUX_BUNDLED_PLUGIN_AUTHOR,
  FAUX_BUNDLED_PLUGIN_COMMAND,
  FAUX_BUNDLED_PLUGIN_COMMAND_DESCRIPTION,
  FAUX_BUNDLED_PLUGIN_DESCRIPTION,
  FAUX_BUNDLED_PLUGIN_ENTRY_ID,
  FAUX_BUNDLED_PLUGIN_KEYBINDING,
  FAUX_BUNDLED_PLUGIN_KEYBINDING_DESCRIPTION,
  FAUX_BUNDLED_PLUGIN_NAME,
  FAUX_BUNDLED_PLUGIN_PATH,
  FAUX_BUNDLED_PLUGIN_SETTING_DEFAULT,
  FAUX_BUNDLED_PLUGIN_SETTING_DESCRIPTION,
  FAUX_BUNDLED_PLUGIN_SETTING_KEY,
  FAUX_BUNDLED_PLUGIN_SETTING_TITLE,
  startFauxBundledPluginEventCapture,
  stopFauxBundledPluginEventCapture,
} from "../lib/faux-bundled-plugin";

type PluginTestGlobal = typeof globalThis & {
  __relayPluginEvents?: string[];
};

const tempRoots: string[] = [];
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalBundledRelayPlugins = [...BUNDLED_RELAY_PLUGINS];
const REAL_BUNDLED_PLUGIN_IDS = originalBundledRelayPlugins.map((plugin) => `bundled:${plugin.id}`);

function mutableBundledRelayPlugins(): BundledRelayPlugin[] {
  return BUNDLED_RELAY_PLUGINS as unknown as BundledRelayPlugin[];
}

function restoreBundledRelayPlugins(): void {
  const plugins = mutableBundledRelayPlugins();
  plugins.splice(0, plugins.length, ...originalBundledRelayPlugins);
}

function installFauxBundledPlugin(): void {
  const plugins = mutableBundledRelayPlugins();
  if (!plugins.some((plugin) => plugin.id === FAUX_BUNDLED_PLUGIN.id)) plugins.push(FAUX_BUNDLED_PLUGIN);
}

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-plugins-test-"));
  tempRoots.push(root);
  return root;
}

function writePlugin(filePath: string, source: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, "utf-8");
}

function pluginConfig(options: {
  enabled?: boolean;
  allowProjectPlugins?: boolean;
  paths?: string[];
  trustedWorkspaces?: string[];
  disabled?: string[];
}): Config {
  return new Config({
    plugins: {
      enabled: options.enabled ?? true,
      allow_project_plugins: options.allowProjectPlugins ?? false,
      paths: options.paths ?? [],
      trusted_workspaces: options.trustedWorkspaces ?? [],
      disabled: options.disabled ?? REAL_BUNDLED_PLUGIN_IDS,
    },
  });
}

function testCommandContext(cwd: string, sessionId: string | null = null): RelayCommandContext {
  return {
    cwd,
    sessionId,
    threadId: null,
    userMessageCount: 0,
    running: false,
    waitForIdle: async () => undefined,
    toast: () => undefined,
  };
}

afterEach(() => {
  const testGlobal = globalThis as PluginTestGlobal;
  delete testGlobal.__relayPluginEvents;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  resetConfig();
  restoreBundledRelayPlugins();
  stopFauxBundledPluginEventCapture();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Relay plugin discovery", () => {
  test("loads enabled bundled and global plugins by default", () => {
    installFauxBundledPlugin();
    const root = makeTempRoot();
    process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
    resetConfig();
    writePlugin(path.join(getConfigDir(), "plugins", "global.mjs"), "export default function plugin() {}\n");

    const result = discoverRelayPlugins({ cwd: root, config: new Config({}) });
    const fauxEntry = result.entries.find((entry) => entry.id === FAUX_BUNDLED_PLUGIN_ENTRY_ID);
    const globalEntry = result.entries.find((entry) => entry.path.endsWith("/plugins/global.mjs"));

    expect(fauxEntry).toMatchObject({
      id: FAUX_BUNDLED_PLUGIN_ENTRY_ID,
      name: FAUX_BUNDLED_PLUGIN_NAME,
      path: FAUX_BUNDLED_PLUGIN_PATH,
      source: "bundled",
    });
    expect(globalEntry).toBeDefined();
    expect(result.warnings).toEqual([]);
  });

  test("lists disabled plugins without loading them", () => {
    const root = makeTempRoot();
    const configuredPlugin = path.join(root, "configured.mjs");
    writePlugin(configuredPlugin, "export default function plugin() {}\n");
    const disabledId = `config:${path.resolve(configuredPlugin)}`;

    const listed = listRelayPlugins({
      cwd: root,
      config: pluginConfig({
        paths: [configuredPlugin],
        disabled: [disabledId, ...REAL_BUNDLED_PLUGIN_IDS],
      }),
    });
    const discovered = discoverRelayPlugins({
      cwd: root,
      config: pluginConfig({
        paths: [configuredPlugin],
        disabled: [disabledId, ...REAL_BUNDLED_PLUGIN_IDS],
      }),
    });

    expect(listed.entries.find((entry) => entry.id === disabledId)?.enabled).toBe(false);
    expect(discovered.entries).toEqual([]);
  });

  test("lists faux bundled plugins and only loads them when enabled", () => {
    installFauxBundledPlugin();
    const root = makeTempRoot();
    const enabledConfig = pluginConfig({ disabled: REAL_BUNDLED_PLUGIN_IDS });
    const disabledConfig = pluginConfig({ disabled: [...REAL_BUNDLED_PLUGIN_IDS, FAUX_BUNDLED_PLUGIN_ENTRY_ID] });
    const listed = listRelayPlugins({ cwd: root, config: disabledConfig });
    const discoveredDisabled = discoverRelayPlugins({ cwd: root, config: disabledConfig });
    const discoveredEnabled = discoverRelayPlugins({ cwd: root, config: enabledConfig });
    const fauxEntry = listed.entries.find((entry) => entry.id === FAUX_BUNDLED_PLUGIN_ENTRY_ID);

    expect(fauxEntry).toMatchObject({
      id: FAUX_BUNDLED_PLUGIN_ENTRY_ID,
      name: FAUX_BUNDLED_PLUGIN_NAME,
      path: FAUX_BUNDLED_PLUGIN_PATH,
      source: "bundled",
      author: FAUX_BUNDLED_PLUGIN_AUTHOR,
      description: FAUX_BUNDLED_PLUGIN_DESCRIPTION,
      enabled: false,
    });
    expect(discoveredDisabled.entries.map((entry) => entry.id)).not.toContain(FAUX_BUNDLED_PLUGIN_ENTRY_ID);
    expect(discoveredEnabled.entries.map((entry) => entry.id)).toEqual([FAUX_BUNDLED_PLUGIN_ENTRY_ID]);

    const fauxItem = buildPluginItems(root, disabledConfig).find(
      (item) => item.label === `${FAUX_BUNDLED_PLUGIN_NAME}: off`,
    );
    expect(fauxItem?.description).toBe(
      `${FAUX_BUNDLED_PLUGIN_AUTHOR} · ${FAUX_BUNDLED_PLUGIN_DESCRIPTION}`.toLowerCase(),
    );
  });

  test("discovers global, configured, and allowed workspace plugins", () => {
    const root = makeTempRoot();
    const cwd = path.join(root, "workspace");
    process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
    resetConfig();
    const globalPlugin = path.join(getConfigDir(), "plugins", "global.mjs");
    const configuredPlugin = path.join(root, "configured.mjs");
    const workspacePlugin = path.join(cwd, ".relay", "plugins", "workspace.mjs");
    writePlugin(globalPlugin, "export default function plugin() {}\n");
    writePlugin(configuredPlugin, "export default function plugin() {}\n");
    writePlugin(workspacePlugin, "export default function plugin() {}\n");

    const result = discoverRelayPlugins({
      cwd,
      config: pluginConfig({ allowProjectPlugins: true, paths: [configuredPlugin] }),
    });

    expect(result.warnings).toEqual([]);
    expect(result.entries.map((entry) => entry.path).toSorted()).toEqual(
      [configuredPlugin, globalPlugin, workspacePlugin].map((item) => path.resolve(item)).toSorted(),
    );
  });

  test("warns instead of loading workspace plugins without project opt-in", () => {
    const root = makeTempRoot();
    const cwd = path.join(root, "workspace");
    process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
    resetConfig();
    writePlugin(path.join(cwd, ".relay", "plugins", "workspace.mjs"), "export default function plugin() {}\n");

    const result = discoverRelayPlugins({ cwd, config: pluginConfig({ allowProjectPlugins: false }) });

    expect(result.entries).toEqual([]);
    expect(result.warnings).toEqual([
      `Workspace plugins found at ${path.join(cwd, ".relay", "plugins")}, but project plugins are not enabled.`,
    ]);
  });

  test("discovers package-declared plugin entries and prefers package metadata over index files", () => {
    const root = makeTempRoot();
    const packagePluginRoot = path.join(root, "package-plugin");
    writePlugin(path.join(packagePluginRoot, "index.mjs"), "export default function indexPlugin() {}\n");
    writePlugin(path.join(packagePluginRoot, "src", "main.mjs"), "export default function mainPlugin() {}\n");
    fs.writeFileSync(
      path.join(packagePluginRoot, "package.json"),
      JSON.stringify({
        description: "package metadata description",
        author: { name: "Package Author" },
        relay: { plugin: "./src/main.mjs" },
      }),
      "utf-8",
    );

    const result = discoverRelayPlugins({ cwd: root, config: pluginConfig({ paths: [packagePluginRoot] }) });

    expect(result.warnings).toEqual([]);
    expect(result.entries.map((entry) => entry.path)).toEqual([path.join(packagePluginRoot, "src", "main.mjs")]);
    expect(result.entries[0]?.author).toBe("Package Author");
    expect(result.entries[0]?.description).toBe("package metadata description");
  });

  test("discovers multiple package-declared plugin entries", () => {
    const root = makeTempRoot();
    const packagePluginRoot = path.join(root, "package-plugin");
    const first = path.join(packagePluginRoot, "first.mjs");
    const second = path.join(packagePluginRoot, "second.mjs");
    writePlugin(first, "export default function firstPlugin() {}\n");
    writePlugin(second, "export default function secondPlugin() {}\n");
    fs.writeFileSync(
      path.join(packagePluginRoot, "package.json"),
      JSON.stringify({ "relay.plugins": ["./first.mjs", "./second.mjs"] }),
      "utf-8",
    );

    const result = discoverRelayPlugins({ cwd: root, config: pluginConfig({ paths: [packagePluginRoot] }) });

    expect(result.entries.map((entry) => entry.path)).toEqual([first, second]);
  });

  test("loads workspace plugins from trusted workspaces without project-wide opt-in", () => {
    const root = makeTempRoot();
    const cwd = path.join(root, "workspace");
    const workspacePlugin = path.join(cwd, ".relay", "plugins", "workspace.mjs");
    writePlugin(workspacePlugin, "export default function plugin() {}\n");

    const result = discoverRelayPlugins({
      cwd,
      config: pluginConfig({ allowProjectPlugins: false, trustedWorkspaces: [cwd] }),
    });

    expect(result.warnings).toEqual([]);
    expect(result.entries.map((entry) => entry.path)).toEqual([workspacePlugin]);
  });
});

describe("Relay plugin loading and runner", () => {
  test("exposes image attachment through the editor API", async () => {
    const attachedPaths: string[] = [];
    let attached = false;
    const runner = new PluginRunner({
      cwd: "/workspace",
      editor: {
        getText: () => "",
        setText: () => undefined,
        insertText: () => undefined,
        attachImage: (imagePath) => {
          attachedPaths.push(imagePath);
          return true;
        },
        submit: async () => undefined,
      },
    });

    await runner.register({
      info: { id: "image-plugin", name: "image-plugin", path: "/image-plugin" },
      factory: (relay) => {
        attached = relay.editor.attachImage("/tmp/sketch.png");
      },
    });

    expect(attached).toBe(true);
    expect(attachedPaths).toEqual(["/tmp/sketch.png"]);
  });

  test("loads a default factory and dispatches events", async () => {
    const root = makeTempRoot();
    const pluginPath = path.join(root, "plugin.mjs");
    const testGlobal = globalThis as PluginTestGlobal;
    testGlobal.__relayPluginEvents = [];
    writePlugin(
      pluginPath,
      `
export default function plugin(relay) {
  globalThis.__relayPluginEvents.push("setup:" + relay.cwd);
  relay.ui.toast("loaded", "info", 5);
  relay.on("ui:mount", () => globalThis.__relayPluginEvents.push("mount:" + relay.plugin.name));
  relay.on("session:update", (event) => globalThis.__relayPluginEvents.push("update:" + event.update.sessionUpdate));
}
`,
    );

    const discovered = discoverRelayPlugins({ cwd: root, config: pluginConfig({ paths: [pluginPath] }) });
    const loaded = await runTestEffect(loadRelayPluginsEffect(discovered.entries));
    const toasts: string[] = [];
    const runner = new PluginRunner({ cwd: root, toast: (message) => toasts.push(message) });
    for (const plugin of loaded.plugins) await runner.register(plugin);
    await runner.emit({ type: "ui:mount" });
    await runner.emit({ type: "session:update", update: { sessionUpdate: "agent_message_chunk" } });

    expect(loaded.diagnostics).toEqual([]);
    expect(toasts).toEqual(["loaded"]);
    expect(testGlobal.__relayPluginEvents).toEqual([`setup:${root}`, "mount:plugin", "update:agent_message_chunk"]);
  });

  test("reloads changes from transitive plugin modules", async () => {
    const root = makeTempRoot();
    const pluginPath = path.join(root, "plugin.mjs");
    const helperPath = path.join(root, "helper.mjs");
    writePlugin(helperPath, 'export const message = "first";\n');
    writePlugin(
      pluginPath,
      'import { message } from "./helper.mjs"; export default (relay) => relay.ui.toast(message);\n',
    );
    const entries = discoverRelayPlugins({ cwd: root, config: pluginConfig({ paths: [pluginPath] }) }).entries;

    const first = await runTestEffect(loadRelayPluginsEffect(entries));
    const messages: string[] = [];
    const firstRunner = new PluginRunner({ cwd: root, toast: (message) => messages.push(message) });
    await firstRunner.register(first.plugins[0]!);
    firstRunner.dispose();

    writePlugin(helperPath, 'export const message = "second";\n');
    const second = await runTestEffect(loadRelayPluginsEffect(entries));
    const secondRunner = new PluginRunner({ cwd: root, toast: (message) => messages.push(message) });
    await secondRunner.register(second.plugins[0]!);

    expect(first.diagnostics).toEqual([]);
    expect(second.diagnostics).toEqual([]);
    expect(messages).toEqual(["first", "second"]);
  });

  test("rejects API calls captured from a disposed plugin runtime", async () => {
    const root = makeTempRoot();
    let capturedApi: RelayPluginApi | null = null;
    let capturedToast: RelayPluginApi["ui"]["toast"] | null = null;
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        capturedApi = relay;
        capturedToast = relay.ui.toast;
      },
    });

    runner.dispose();

    expect(() => capturedApi!.storage.get("key")).toThrow("context is stale");
    expect(() => capturedToast!("late call")).toThrow("context is stale");
  });

  test("bounds blocking plugin lifecycle handlers", async () => {
    const root = makeTempRoot();
    const runner = new PluginRunner({ cwd: root, lifecycleTimeoutMs: 10 });
    await runner.register({
      info: { id: "blocking", name: "blocking", path: "/blocking" },
      factory: (relay) => {
        relay.on("ui:unmount", () => new Promise<void>(() => undefined));
      },
    });

    await runner.emitLifecycleSequenceByPlugin([{ type: "ui:unmount" }]);

    expect(runner.diagnostics.at(-1)?.message).toContain("timed out after 10ms");
    runner.dispose();
  });

  test("reports invalid plugin modules as load diagnostics", async () => {
    const root = makeTempRoot();
    const pluginPath = path.join(root, "invalid.mjs");
    writePlugin(pluginPath, "export const notDefault = true;\n");

    const discovered = discoverRelayPlugins({ cwd: root, config: pluginConfig({ paths: [pluginPath] }) });
    const loaded = await runTestEffect(loadRelayPluginsEffect(discovered.entries));

    expect(loaded.plugins).toEqual([]);
    expect(loaded.diagnostics).toHaveLength(1);
    expect(loaded.diagnostics[0]?.message).toBe("Failed to load plugin invalid");
  });

  test("isolates throwing handlers and continues dispatch", async () => {
    const root = makeTempRoot();
    const events: string[] = [];
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "one", name: "one", path: "/one" },
      factory: (relay) => {
        relay.on("ui:mount", () => {
          events.push("before-throw");
          throw new Error("boom");
        });
      },
    });
    await runner.register({
      info: { id: "two", name: "two", path: "/two" },
      factory: (relay) => {
        relay.on("ui:mount", () => {
          events.push("after-throw");
        });
      },
    });

    await runner.emit({ type: "ui:mount" });

    expect(events).toEqual(["before-throw", "after-throw"]);
    expect(runner.diagnostics).toHaveLength(1);
    expect(runner.diagnostics[0]?.message).toContain("Plugin handler failed for ui:mount");
  });

  test("continues lifecycle dispatch when diagnostic toast reporting fails", async () => {
    const root = makeTempRoot();
    const events: string[] = [];
    const runner = new PluginRunner({
      cwd: root,
      toast: () => {
        throw new Error("plugin host is shutting down");
      },
    });
    await runner.register({
      info: { id: "one", name: "one", path: "/one" },
      factory: (relay) => {
        relay.on("ui:unmount", () => {
          events.push("unmount");
          throw new Error("cleanup failed");
        });
        relay.on("relay:shutdown", () => {
          events.push("shutdown");
        });
      },
    });

    await runner.emitLifecycleSequenceByPlugin([{ type: "ui:unmount" }, { type: "relay:shutdown", reason: "quit" }]);

    expect(events).toEqual(["unmount", "shutdown"]);
    expect(runner.diagnostics).toHaveLength(1);
    expect(runner.diagnostics[0]?.message).toContain("Plugin handler failed for ui:unmount");
    runner.dispose();
  });

  test("dispatches ordered lifecycle hooks independently for each plugin", async () => {
    const root = makeTempRoot();
    const events: string[] = [];
    let releaseBlockingUnmount!: () => void;
    const blockingUnmount = new Promise<void>((resolve) => {
      releaseBlockingUnmount = resolve;
    });
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "blocking", name: "blocking", path: "/blocking" },
      factory: (relay) => {
        relay.on("ui:unmount", async () => {
          events.push("blocking:unmount");
          await blockingUnmount;
        });
        relay.on("relay:shutdown", () => {
          events.push("blocking:shutdown");
        });
      },
    });
    await runner.register({
      info: { id: "observing", name: "observing", path: "/observing" },
      factory: (relay) => {
        relay.on("ui:unmount", () => {
          events.push("observing:unmount");
        });
        relay.on("relay:shutdown", () => {
          events.push("observing:shutdown");
        });
      },
    });

    const lifecycle = runner.emitLifecycleSequenceByPlugin([
      { type: "ui:unmount" },
      { type: "relay:shutdown", reason: "quit" },
    ]);
    await Bun.sleep(0);

    expect(events).toEqual(["blocking:unmount", "observing:unmount", "observing:shutdown"]);
    releaseBlockingUnmount();
    await lifecycle;
    expect(events).toEqual(["blocking:unmount", "observing:unmount", "observing:shutdown", "blocking:shutdown"]);
    runner.dispose();
  });

  test("does not recursively emit plugin error handler failures", async () => {
    const root = makeTempRoot();
    const toasts: string[] = [];
    const runner = new PluginRunner({ cwd: root, toast: (message) => toasts.push(message) });
    await runner.register({
      info: { id: "one", name: "one", path: "/one" },
      factory: (relay) => {
        relay.on("plugin:error", () => {
          throw new Error("error handler failed");
        });
      },
    });

    runner.recordError({ id: "source", name: "source", path: "/source" }, "Original plugin failure");
    await Promise.resolve();

    expect(runner.diagnostics).toHaveLength(2);
    expect(runner.diagnostics[0]?.message).toBe("Original plugin failure");
    expect(runner.diagnostics[1]?.message).toContain("Plugin handler failed for plugin:error");
    expect(toasts).toHaveLength(2);
  });

  test("status slot updates invalidate chrome only when the value changes", async () => {
    const root = makeTempRoot();
    const invalidations: string[] = [];
    const runner = new PluginRunner({
      cwd: root,
      invalidate: () => invalidations.push("full"),
      invalidateChrome: () => invalidations.push("chrome"),
    });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.ui.setEditorStatus("activity", "streaming");
        relay.ui.setEditorStatus("activity", "streaming");
        relay.ui.setEditorStatus("activity", "reasoning");
        relay.ui.setEditorStatus("activity", undefined);
        relay.ui.setEditorStatus("activity", undefined);
      },
    });

    expect(invalidations).toEqual(["chrome", "chrome", "chrome"]);
  });

  test("status slot preserves spinner status metadata", async () => {
    const root = makeTempRoot();
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.ui.setEditorStatus("activity", { text: "Inserting...", spinner: true });
      },
    });

    expect(runner.slots.editorStatusSegments()).toEqual([{ text: "Inserting...", spinner: true }]);
  });

  test("does not expose legacy plugin UI aliases", async () => {
    const root = makeTempRoot();
    const legacyValues: unknown[] = [];
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        const ui = relay.ui as unknown as Record<string, unknown>;
        legacyValues.push(ui.setStatus, ui.setHeader, ui.setStatusLineSegment, ui.setFooterSegment);
      },
    });

    expect(legacyValues).toEqual([undefined, undefined, undefined, undefined]);
  });

  test("exposes the resolved active theme palette", async () => {
    const root = makeTempRoot();
    let theme: ReturnType<RelayPackagePluginApi["ui"]["getTheme"]> | undefined;
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        theme = relay.ui.getTheme();
      },
    });

    expect(theme?.id).toBeString();
    expect(theme?.colors.bg).toMatch(/^#[0-9a-f]{6}$/iu);
    expect(theme?.colors.accent).toMatch(/^#[0-9a-f]{6}$/iu);
    expect(theme?.colors.toolBg.success).toMatch(/^#[0-9a-f]{6}$/iu);
  });

  test("widget handles manage focus, visibility, invalidation, and disposal", async () => {
    const root = makeTempRoot();
    const invalidations: string[] = [];
    const widgetInvalidations: string[] = [];
    let interactionInvalidations = 0;
    let handle: RelayWidgetHandle | undefined;
    const runner = new PluginRunner({
      cwd: root,
      invalidate: () => invalidations.push("full"),
      invalidateWidget: (placement) => widgetInvalidations.push(placement),
      invalidateWidgetInteraction: () => interactionInvalidations++,
    });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        handle = relay.ui.showOverlay("picker", {
          title: "Picker",
          render: (ctx) => [{ text: `focused:${ctx?.focused === true}` }],
        });
      },
    });

    expect(handle).toBeDefined();
    expect(handle?.focused).toBe(true);
    expect(handle?.hidden).toBe(false);
    expect(runner.slots.focusedKeyboardWidget()?.key).toBe("picker");
    expect(runner.slots.widgets("overlay")).toHaveLength(1);
    expect(
      runner.slots.widgets("overlay")[0]?.widget.render({
        placement: "overlay",
        width: 10,
        height: 5,
        focused: runner.slots.widgets("overlay")[0]?.focused === true,
      })[0]?.text,
    ).toBe("focused:true");

    handle?.unfocus();
    expect(handle?.focused).toBe(false);
    expect(runner.slots.focusedKeyboardWidget()).toBeNull();
    expect(runner.slots.widgets("overlay")).toHaveLength(1);

    handle?.focus();
    expect(handle?.focused).toBe(true);
    handle?.setHidden(true);
    expect(handle?.hidden).toBe(true);
    expect(handle?.focused).toBe(false);
    expect(runner.slots.widgets("overlay")).toEqual([]);
    expect(runner.slots.focusedKeyboardWidget()).toBeNull();

    handle?.setHidden(false);
    expect(handle?.hidden).toBe(false);
    expect(handle?.focused).toBe(false);
    expect(runner.slots.widgets("overlay")).toHaveLength(1);

    const fullInvalidationCount = invalidations.length;
    const widgetInvalidationCount = widgetInvalidations.length;
    const interactionInvalidationCount = interactionInvalidations;
    handle?.invalidate();
    expect(invalidations).toHaveLength(fullInvalidationCount);
    expect(widgetInvalidations.slice(widgetInvalidationCount)).toEqual(["overlay"]);
    expect(interactionInvalidations).toBe(interactionInvalidationCount);

    handle?.dispose();
    expect(handle?.hidden).toBe(true);
    expect(runner.slots.widgets("overlay")).toEqual([]);
  });

  test("welcome widget refreshes do not invalidate unrelated plugin UI", async () => {
    const root = makeTempRoot();
    const invalidations: string[] = [];
    const widgetInvalidations: string[] = [];
    let interactionInvalidations = 0;
    let refreshWelcome = () => undefined;
    let handle: RelayWidgetHandle | undefined;
    const runner = new PluginRunner({
      cwd: root,
      invalidate: () => invalidations.push("full"),
      invalidateWidget: (placement) => widgetInvalidations.push(placement),
      invalidateWidgetInteraction: () => interactionInvalidations++,
    });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        refreshWelcome = () => {
          handle = relay.ui.setWidget("home", {
            placement: "welcome",
            render: () => [{ text: "home" }],
          });
        };
        refreshWelcome();
      },
    });

    invalidations.length = 0;
    widgetInvalidations.length = 0;
    interactionInvalidations = 0;
    refreshWelcome();
    handle?.invalidate();

    expect(invalidations).toEqual([]);
    expect(widgetInvalidations).toEqual(["welcome", "welcome"]);
    expect(interactionInvalidations).toBe(0);
  });

  test("relay.ui dialog methods delegate to the UI host", async () => {
    const root = makeTempRoot();
    const values: unknown[] = [];
    const runner = new PluginRunner({
      cwd: root,
      dialogs: {
        confirm: async (plugin, title, message) => `${plugin.name}:${title}:${message}` === "plugin:Confirm:Continue?",
        select: async (_plugin, title, options) =>
          `${title}:${typeof options[1] === "string" ? options[1] : options[1]?.value}`,
        input: async (_plugin, title, placeholder) => `${title}:${placeholder ?? ""}`,
        editor: async (_plugin, title, prefill) => `${title}:${prefill ?? ""}`,
        clearPlugin: () => undefined,
      },
    });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.commands.register("dialogs", {
          async run() {
            values.push(await relay.ui.confirm("Confirm", "Continue?"));
            values.push(await relay.ui.select("Pick", ["dev", { value: "prod", label: "Production" }]));
            values.push(await relay.ui.input("Env", "prod"));
            values.push(await relay.ui.editor("Notes", "hello"));
          },
        });
      },
    });

    await runner.commands.find("dialogs")?.command.run("", testCommandContext(root));

    expect(values).toEqual([true, "Pick:prod", "Env:prod", "Notes:hello"]);
  });

  test("stable plugin SDK defineRelayPlugin returns the factory", () => {
    const factory = () => undefined;

    expect(defineRelaySdkPlugin(factory)).toBe(factory);
  });

  test("published plugin SDK package entrypoint exposes helpers and types", () => {
    const factory = defineRelayPackagePlugin((relay: RelayPackagePluginApi) => {
      relay.ui.toast("typed");
    });

    expect(typeof factory).toBe("function");
    expect(relayPackageLine("package")).toEqual({ text: "package" });
  });

  test("stable plugin SDK helpers preserve plugin definitions and build renderables", () => {
    const events: string[] = [];
    const command = defineRelayCommand({
      description: "Do work",
      run(args) {
        events.push(args);
      },
    });
    const renderer = defineRelayToolRenderer({
      toolNames: ["example"],
      renderResult: () => relayCard({ title: "Result", border: "single", lines: ["done", { text: "ok", bold: true }] }),
    });
    const disposable = combineRelayDisposables(
      createRelayDisposable(() => events.push("first")),
      createRelayDisposable(() => events.push("second")),
    );

    command.run("args");
    disposable.dispose();

    expect(events).toEqual(["args", "second", "first"]);
    expect(relayLine("hello", { fg: "#fff" })).toEqual({ text: "hello", fg: "#fff" });
    const inputColors = { accent: "#accent", bg: "#bg", fg: "#fg", textMuted: "#muted" };
    expect(relayInlineInputLine({ value: "", placeholder: "Search", width: 10, colors: inputColors })).toEqual({
      text: "Search",
      segments: [
        { text: "S", fg: "#bg", bg: "#accent" },
        { text: "earch", fg: "#muted" },
      ],
    });
    expect(relayInlineInputLine({ value: "long query", placeholder: "Search", width: 6, colors: inputColors })).toEqual(
      {
        text: "long… ",
        segments: [
          { text: "long…", fg: "#fg" },
          { text: " ", bg: "#accent" },
        ],
      },
    );
    expect(relayLines("one", { text: "two", bold: true })).toEqual({
      kind: "lines",
      lines: [{ text: "one" }, { text: "two", bold: true }],
    });
    expect(renderer.renderResult?.()).toEqual({
      kind: "card",
      title: "Result",
      border: "single",
      lines: [{ text: "done" }, { text: "ok", bold: true }],
    });
  });

  test("relay.commands.list exposes registered command metadata", async () => {
    const root = makeTempRoot();
    const listed: unknown[] = [];
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.commands.register("deploy", {
          description: "Deploy somewhere",
          argumentPlaceholder: "<env>",
          getArgumentCompletions: () => [{ label: "prod" }],
          run() {},
        });
        listed.push(...relay.commands.list());
      },
    });

    expect(listed).toEqual([
      {
        plugin: { id: "plugin", name: "plugin", path: "/plugin" },
        name: "deploy",
        invocationName: "deploy",
        description: "Deploy somewhere",
        argumentPlaceholder: "<env>",
      },
    ]);
  });

  test("relay.tools.registerRenderer registers rich renderer metadata", async () => {
    const root = makeTempRoot();
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.tools.registerRenderer({
          toolNames: ["ask_user_questions"],
          renderCall: (ctx) => ({ kind: "lines", lines: [{ text: `call:${ctx.blockId}:${ctx.threadId ?? "none"}` }] }),
          renderResult: () => ({
            kind: "card",
            title: "Question",
            border: "single",
            lines: [{ text: "What should Relay do?" }],
          }),
        });
      },
    });

    const output = runner.renderers.render({
      toolName: "ask_user_questions",
      toolCallId: "tool-1",
      blockId: "block-1",
      threadId: "thread-1",
      sessionId: "session-1",
      status: "success",
      input: undefined,
      output: undefined,
      display: "ask user",
      cwd: root,
      isPartial: false,
      expanded: false,
      colors: getTheme("catppuccin-mocha").colors,
      invalidate: () => undefined,
    });

    expect(output).toEqual({
      call: { kind: "lines", lines: [{ text: "call:block-1:thread-1" }] },
      result: {
        kind: "card",
        title: "Question",
        border: "single",
        lines: [{ text: "What should Relay do?" }],
      },
    });
  });

  test("relay.editor.addAutocompleteProvider registers provider metadata", async () => {
    const root = makeTempRoot();
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.editor.addAutocompleteProvider({
          trigger: "#",
          provide: (ctx) => ({ items: [{ label: `${ctx.token}-issue` }] }),
        });
      },
    });

    const entry = runner.editor.listAutocompleteProviders()[0];
    expect(entry?.plugin.id).toBe("plugin");
    expect(runner.editor.state().autocompleteProviders).toHaveLength(1);
    expect(
      entry?.provider.provide({
        text: "fix #12",
        lines: ["fix #12"],
        cursorOffset: 7,
        cursorLine: 0,
        cursorColumn: 7,
        cwd: root,
        token: "#12",
        tokenStart: 4,
      }),
    ).toEqual({ items: [{ label: "#12-issue" }] });
  });

  test("relay.agent and relay.thread expose active host state", async () => {
    const root = makeTempRoot();
    const events: string[] = [];
    const values: unknown[] = [];
    const observed = {
      selectedThreadId: null as string | null,
      archivedThreadId: null as string | null,
      activeTurnText: null as string | null,
    };
    const currentThread = {
      id: "thread-1",
      title: "Main thread",
      sessionId: "session-1",
      cwd: root,
      workspaceKind: "local" as const,
      status: "running" as const,
      archived: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const createdThread = {
      ...currentThread,
      id: "thread-2",
      title: "Created thread",
      sessionId: null,
      status: "paused" as const,
    };
    const runner = new PluginRunner({
      cwd: root,
      agent: {
        name: () => "faux",
        profile: () => "default",
        sessionId: () => "session-1",
        isRunning: () => true,
        waitForIdle: async () => {
          events.push("waited");
        },
        hasQueuedPrompts: () => true,
        supportsActiveTurnInput: () => true,
        supportsSessionFork: () => true,
        supportsSessionDelete: () => true,
        supportsSessionClose: () => true,
        addToCurrentTurn: async (text) => {
          observed.activeTurnText = text;
          return { accepted: true };
        },
        forkSession: async (options) => {
          events.push(`fork:${options?.sessionId ?? ""}:${options?.cwd ?? ""}`);
          return { sessionId: "forked-session" };
        },
        runHiddenPrompt: async (sessionId, text) => {
          events.push(`hidden:${sessionId}:${text}`);
          return `hidden response:${text}`;
        },
        deleteSession: async (sessionId) => {
          events.push(`delete:${sessionId}`);
        },
        closeSession: async (sessionId) => {
          events.push(`close:${sessionId}`);
        },
        availableModes: () => [{ id: "architect", name: "Architect" }],
        availableModels: () => [{ modelId: "model-a", name: "Model A" }],
        availableThinkingLevels: () => ["low", "high"],
        prompt: async (text) => {
          events.push(`prompt:${text}`);
        },
        cancel: async () => {
          events.push("cancel");
        },
        restart: async () => {
          events.push("restart");
        },
        newSession: async (cwd) => {
          events.push(`new:${cwd ?? ""}`);
        },
        loadSession: async (sessionId, cwd) => {
          events.push(`load:${sessionId}:${cwd ?? ""}`);
        },
        setMode: async (modeId) => {
          events.push(`mode:${modeId}`);
        },
        setModel: async (modelId) => {
          events.push(`model:${modelId}`);
        },
        setThinkingLevel: async (level) => {
          events.push(`thinking:${level}`);
        },
        setSessionModel: async (sessionId, modelId) => {
          events.push(`session-model:${sessionId}:${modelId}`);
        },
        setSessionThinkingLevel: async (sessionId, level) => {
          events.push(`session-thinking:${sessionId}:${level}`);
        },
      },
      thread: {
        current: () => currentThread,
        list: () => [currentThread],
        conversationMarkdown: (threadId) => `markdown:${threadId ?? "current"}`,
        create: async (options) => {
          events.push(`create:${options?.cwd ?? ""}:${options?.worktree === true}`);
          return createdThread;
        },
        ensureSession: async (threadId) => {
          events.push(`ensure:${threadId ?? ""}`);
          return { thread: currentThread, sessionId: "session-1" };
        },
        select: async (threadId) => {
          observed.selectedThreadId = threadId;
        },
        archive: async (threadId) => {
          observed.archivedThreadId = threadId;
        },
      },
    });

    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.commands.register("inspect-agent", {
          async run() {
            values.push({
              name: relay.agent.name,
              profile: relay.agent.profile,
              sessionId: relay.agent.sessionId,
              isRunning: relay.agent.isRunning(),
              hasQueuedPrompts: relay.agent.hasQueuedPrompts(),
              supportsActiveTurnInput: relay.agent.supportsActiveTurnInput(),
              supportsSessionFork: relay.agent.supportsSessionFork(),
              supportsSessionDelete: relay.agent.supportsSessionDelete(),
              supportsSessionClose: relay.agent.supportsSessionClose(),
              modes: relay.agent.availableModes(),
              models: relay.agent.availableModels(),
              thinkingLevels: relay.agent.availableThinkingLevels(),
              currentThread: relay.thread.current(),
              threads: relay.thread.list(),
              markdown: relay.thread.conversationMarkdown("thread-1"),
            });
            await relay.agent.waitForIdle();
            values.push(await relay.agent.addToCurrentTurn("additional context"));
            values.push(await relay.agent.forkSession({ sessionId: "session-1", cwd: root }));
            values.push(await relay.agent.runHiddenPrompt("session-1", "hidden prompt"));
            await relay.agent.deleteSession("scratch-session");
            await relay.agent.closeSession("scratch-session");
            values.push(await relay.thread.create({ cwd: `${root}/new`, snapshotCurrent: false }));
            values.push(await relay.thread.ensureSession("thread-1"));
            await relay.agent.setMode("architect");
            await relay.agent.setModel("model-a");
            await relay.agent.setThinkingLevel("high");
            await relay.agent.setSessionModel("scratch-session", "model-a");
            await relay.agent.setSessionThinkingLevel("scratch-session", "low");
            await relay.thread.select("thread-2");
            await relay.thread.archive("thread-1");
          },
        });
      },
    });

    await runner.commands.find("inspect-agent")?.command.run("", testCommandContext(root, "session-1"));

    expect(values).toEqual([
      {
        name: "faux",
        profile: "default",
        sessionId: "session-1",
        isRunning: true,
        hasQueuedPrompts: true,
        supportsActiveTurnInput: true,
        supportsSessionFork: true,
        supportsSessionDelete: true,
        supportsSessionClose: true,
        modes: [{ id: "architect", name: "Architect" }],
        models: [{ modelId: "model-a", name: "Model A" }],
        thinkingLevels: ["low", "high"],
        currentThread,
        threads: [currentThread],
        markdown: "markdown:thread-1",
      },
      { accepted: true },
      { sessionId: "forked-session" },
      "hidden response:hidden prompt",
      createdThread,
      { thread: currentThread, sessionId: "session-1" },
    ]);
    expect(events).toEqual([
      "waited",
      `fork:session-1:${root}`,
      "hidden:session-1:hidden prompt",
      "delete:scratch-session",
      "close:scratch-session",
      `create:${root}/new:false`,
      "ensure:thread-1",
      "mode:architect",
      "model:model-a",
      "thinking:high",
      "session-model:scratch-session:model-a",
      "session-thinking:scratch-session:low",
    ]);
    expect(observed.activeTurnText).toBe("additional context");
    expect(observed.selectedThreadId).toBe("thread-2");
    expect(observed.archivedThreadId).toBe("thread-1");
  });

  test("command registry reports duplicate and native conflicts", async () => {
    const root = makeTempRoot();
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "one", name: "one", path: "/one" },
      factory: (relay) => {
        relay.commands.register("settings", { run() {} });
      },
    });
    await runner.register({
      info: { id: "two", name: "two", path: "/two" },
      factory: (relay) => {
        relay.commands.register("settings", { run() {} });
      },
    });

    const diagnostics = runner.commands
      .list({ nativeCommandNames: new Set(["settings"]) })
      .flatMap((entry) => entry.diagnostics ?? []);

    expect(diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
      "duplicate",
      "native-conflict",
      "duplicate",
      "native-conflict",
    ]);
  });

  test("relay.mcp.status reports restart-needed changes after applied snapshot", async () => {
    const root = makeTempRoot();
    const plugin = { id: "plugin", name: "plugin", path: "/plugin" };
    const statuses: RelayMcpStatus[] = [];
    const toasts: string[] = [];
    const runner = new PluginRunner({ cwd: root, toast: (message) => toasts.push(message) });

    await runner.register({
      info: plugin,
      factory: (relay) => {
        relay.mcp.addServer({ name: "docs", command: "docs-mcp", args: ["--stdio"] });
        statuses.push(relay.mcp.status());
        relay.commands.register("remove-docs-mcp", {
          run() {
            const removed = relay.mcp.removeServer("docs", { apply: "promptRestart" });
            relay.storage.set("removed", removed);
            statuses.push(relay.mcp.status());
          },
        });
      },
    });

    expect(statuses[0]).toMatchObject({
      applied: false,
      restartNeeded: false,
      activeServers: [],
      pendingServers: [{ name: "docs", command: "docs-mcp", args: ["--stdio"] }],
    });

    runner.mcp.markApplied();
    await runner.commands.find("remove-docs-mcp")?.command.run("", testCommandContext(root));

    expect(runner.storageFor(plugin).get("removed")).toBe(true);
    expect(statuses.at(-1)).toMatchObject({
      applied: true,
      restartNeeded: true,
      activeServers: [{ name: "docs", command: "docs-mcp", args: ["--stdio"] }],
      pendingServers: [],
    });
    expect(toasts).toEqual(["MCP changes will apply after restarting the agent"]);
  });

  test("relay.mcp.addServer restartNow invokes agent restart and clears restart-needed status", async () => {
    const root = makeTempRoot();
    const statuses: RelayMcpStatus[] = [];
    const toasts: string[] = [];
    let restartCount = 0;
    const runner = new PluginRunner({
      cwd: root,
      toast: (message) => toasts.push(message),
      agent: {
        name: () => "faux",
        profile: () => "default",
        sessionId: () => null,
        isRunning: () => false,
        waitForIdle: async () => undefined,
        hasQueuedPrompts: () => false,
        supportsActiveTurnInput: () => false,
        addToCurrentTurn: async () => ({ accepted: false, reason: "unsupported" }),
        availableModes: () => [],
        availableModels: () => [],
        availableThinkingLevels: () => [],
        prompt: async () => undefined,
        cancel: async () => undefined,
        restart: async () => {
          restartCount += 1;
        },
        newSession: async () => undefined,
        loadSession: async () => undefined,
        setMode: async () => undefined,
        setModel: async () => undefined,
        setThinkingLevel: async () => undefined,
      },
    });

    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.mcp.addServer({ name: "base", command: "base-mcp" });
        relay.commands.register("add-late-mcp", {
          run() {
            relay.mcp.addServer({ name: "late", command: "late-mcp" }, { apply: "restartNow" });
            statuses.push(relay.mcp.status());
          },
        });
      },
    });

    runner.mcp.markApplied();
    await runner.commands.find("add-late-mcp")?.command.run("", testCommandContext(root));
    await Promise.resolve();

    expect(statuses[0]?.restartNeeded).toBe(true);
    expect(restartCount).toBe(1);
    expect(runner.mcp.status().restartNeeded).toBe(false);
    expect(toasts).toEqual(["MCP changes applied after agent restart"]);
  });

  test("loads a faux bundled plugin and registers common plugin behaviours", async () => {
    installFauxBundledPlugin();
    const root = makeTempRoot();
    process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
    resetConfig();
    const fauxEvents = startFauxBundledPluginEventCapture();
    const hostEvents: string[] = [];
    const toasts: string[] = [];
    const config = pluginConfig({ disabled: REAL_BUNDLED_PLUGIN_IDS });
    const discovered = discoverRelayPlugins({ cwd: root, config });
    const loaded = await runTestEffect(loadRelayPluginsEffect(discovered.entries));
    const runner = new PluginRunner({
      cwd: root,
      toast: (message) => toasts.push(message),
      diffOverlay: {
        open: (plugin, options) => {
          hostEvents.push(`diff:${plugin.name}:${options.title ?? ""}:${options.diffText ?? ""}`);
          return { dispose: () => hostEvents.push(`diff-dispose:${plugin.name}`) };
        },
        clearPlugin: (plugin) => {
          hostEvents.push(`diff-clear:${plugin.name}`);
        },
      },
    });

    expect(discovered.entries.map((entry) => entry.id)).toEqual([FAUX_BUNDLED_PLUGIN_ENTRY_ID]);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.plugins.map((plugin) => plugin.info)).toEqual([
      {
        id: FAUX_BUNDLED_PLUGIN_ENTRY_ID,
        name: FAUX_BUNDLED_PLUGIN_NAME,
        path: FAUX_BUNDLED_PLUGIN_PATH,
        description: FAUX_BUNDLED_PLUGIN_DESCRIPTION,
        author: FAUX_BUNDLED_PLUGIN_AUTHOR,
      },
    ]);

    for (const plugin of loaded.plugins) await runner.register(plugin);
    await runner.emit({ type: "ui:mount" });
    await runner.emit({ type: "session:update", update: { sessionUpdate: "agent_message_chunk" } });
    await runner.commands.find(FAUX_BUNDLED_PLUGIN_COMMAND)?.command.run("world", testCommandContext(root, "s1"));
    await runner.keybindings.match({ name: "k", ctrl: true, shift: true })?.binding.run();

    expect(toasts).toEqual(["faux loaded"]);
    expect(runner.keybindings.match({ name: "k", ctrl: true, shift: true })).toBeUndefined();
    expect(runner.keybindings.list().map((entry) => entry.key)).toEqual([FAUX_BUNDLED_PLUGIN_KEYBINDING]);
    expect(normalizePluginKeybinding("shift+ctrl+k")).toBe(FAUX_BUNDLED_PLUGIN_KEYBINDING);
    await expect(runner.beforeSubmit("prompt", "user")).resolves.toEqual({ text: "prompt faux", handled: false });
    expect(fauxEvents).toEqual([
      `setup:${FAUX_BUNDLED_PLUGIN_ENTRY_ID}:${root}`,
      `setting:${FAUX_BUNDLED_PLUGIN_SETTING_DEFAULT}`,
      "storage:true",
      `mount:${FAUX_BUNDLED_PLUGIN_NAME}`,
      "session:agent_message_chunk",
      "command:world",
      "keybinding",
    ]);
    expect(hostEvents).toEqual([
      `diff:${FAUX_BUNDLED_PLUGIN_NAME}:Faux Diff:diff --git a/faux.txt b/faux.txt`,
      `diff-dispose:${FAUX_BUNDLED_PLUGIN_NAME}`,
    ]);
    expect(runner.slots.editorStatusSegments()).toEqual([{ text: "ready" }]);
    expect(runner.slots.editorStatusSegmentContents()).toEqual(["faux status line"]);
    expect(runner.slots.editorFooterSegmentContents()).toEqual(["faux footer"]);
    expect(runner.slots.widgets("aboveEditor").map((entry) => entry.widget.render()[0]?.text)).toEqual(["faux widget"]);
    expect(runner.editor.state().options.minHeight).toBe(4);
    expect(runner.editor.state().theme.borderColor).toBe("#fff");
    const autocompleteResult = await runner.editor.state().autocompleteProviders[0]?.provide({
      text: "@",
      lines: ["@"],
      cursorOffset: 1,
      cursorLine: 0,
      cursorColumn: 1,
      cwd: root,
      token: "@",
      tokenStart: 0,
    });
    let autocompleteItems: readonly { readonly label: string }[] = [];
    if (autocompleteResult) {
      if (Array.isArray(autocompleteResult)) autocompleteItems = autocompleteResult;
      else if ("items" in autocompleteResult) autocompleteItems = autocompleteResult.items;
    }
    expect(autocompleteItems[0]?.label).toBe("@faux");
    expect(runner.editor.listAutocompleteProviders()[0]?.plugin.id).toBe(FAUX_BUNDLED_PLUGIN_ENTRY_ID);
    expect(runner.renderers.policyFor("bash")?.header).toBe("shell");
    expect(runner.renderers.hasMessageRenderer("user")).toBe(true);
    expect(runner.renderers.hasMessageRenderer("content")).toBe(false);
    expect(
      runner.renderers.render({
        toolName: "faux-tool",
        toolCallId: "tool",
        blockId: "block",
        threadId: null,
        sessionId: null,
        status: "success",
        input: undefined,
        output: undefined,
        display: "",
        cwd: root,
        isPartial: false,
        expanded: false,
        colors: getTheme("catppuccin-mocha").colors,
        invalidate: () => undefined,
      })?.result,
    ).toEqual({ kind: "lines", lines: [{ text: "ok" }] });
    expect(
      runner.renderers.renderMessage({
        blockType: "user",
        content: "hello",
        cwd: root,
        colors: getTheme("catppuccin-mocha").colors,
        startsAgentTurn: false,
      })?.lines?.[0],
    ).toEqual({ text: "hello", fg: "#fff", bold: true });
    expect(runner.mcpServers()).toEqual([{ name: "faux-mcp", command: "faux-mcp", args: ["--stdio"] }]);

    const fauxItem = buildPluginItems(root, config, runner).find(
      (item) => item.value.type === "plugin" && item.value.id === FAUX_BUNDLED_PLUGIN_ENTRY_ID,
    );
    if (fauxItem?.value.type !== "plugin") throw new Error("Expected faux bundled plugin item");
    expect(fauxItem.value.commands).toEqual([
      {
        name: FAUX_BUNDLED_PLUGIN_COMMAND,
        invocationName: FAUX_BUNDLED_PLUGIN_COMMAND,
        description: FAUX_BUNDLED_PLUGIN_COMMAND_DESCRIPTION,
      },
    ]);
    expect(fauxItem.value.shortcuts).toEqual([
      {
        key: FAUX_BUNDLED_PLUGIN_KEYBINDING,
        description: FAUX_BUNDLED_PLUGIN_KEYBINDING_DESCRIPTION,
        enabled: false,
        kind: "keybinding",
      },
      { key: "@", description: "autocomplete trigger", enabled: true, kind: "autocomplete" },
    ]);
    expect(fauxItem.value.settings).toEqual([
      {
        key: FAUX_BUNDLED_PLUGIN_SETTING_KEY,
        title: FAUX_BUNDLED_PLUGIN_SETTING_TITLE,
        description: FAUX_BUNDLED_PLUGIN_SETTING_DESCRIPTION,
        value: FAUX_BUNDLED_PLUGIN_SETTING_DEFAULT,
      },
    ]);
    expect(fauxItem.value.mcpServers).toEqual([{ name: "faux-mcp", command: "faux-mcp", args: ["--stdio"] }]);
    expect(fauxItem.value.mcpRestartNeeded).toBe(false);

    runner.dispose();
    expect(hostEvents.slice(-1)).toEqual([`diff-clear:${FAUX_BUNDLED_PLUGIN_NAME}`]);
  });

  test("suffixes duplicate plugin slash commands so each remains invocable", async () => {
    const root = makeTempRoot();
    const events: string[] = [];
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "one", name: "one", path: "/one" },
      factory: (relay) => {
        relay.commands.register("shared", {
          run: () => {
            events.push("one");
          },
        });
      },
    });
    await runner.register({
      info: { id: "two", name: "two", path: "/two" },
      factory: (relay) => {
        relay.commands.register("shared", {
          run: () => {
            events.push("two");
          },
        });
      },
    });

    expect(runner.commands.list().map((entry) => entry.invocationName)).toEqual(["shared:1", "shared:2"]);
    expect(runner.commands.find("shared")).toBeUndefined();
    await runner.commands.find("shared:2")?.command.run("", testCommandContext(root));
    expect(events).toEqual(["two"]);
  });

  test("uses the latest plugin keybinding registration for duplicate keys", async () => {
    const root = makeTempRoot();
    const events: string[] = [];
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "one", name: "one", path: "/one" },
      factory: (relay) => {
        relay.keybindings.register("ctrl+k", {
          run: () => {
            events.push("one");
          },
        });
      },
    });
    await runner.register({
      info: { id: "two", name: "two", path: "/two" },
      factory: (relay) => {
        relay.keybindings.register("ctrl+k", {
          run: () => {
            events.push("two");
          },
        });
      },
    });

    await runner.keybindings.match({ name: "k", ctrl: true })?.binding.run();
    expect(events).toEqual(["two"]);
  });

  test("matches printable keybinding events without key names", async () => {
    const root = makeTempRoot();
    const events: string[] = [];
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.keybindings.register("a", {
          run: () => {
            events.push("approve");
          },
        });
        relay.keybindings.register("?", {
          run: () => {
            events.push("help");
          },
        });
      },
    });

    await runner.keybindings.match({ sequence: "a" })?.binding.run();
    await runner.keybindings.match({ sequence: "?", shift: true })?.binding.run();
    expect(events).toEqual(["approve", "help"]);
  });

  test("runs prompt interceptors in order", async () => {
    const root = makeTempRoot();
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "one", name: "one", path: "/one" },
      factory: (relay) => {
        relay.input.onBeforeSubmit(({ text }) => `${text} one`);
      },
    });
    await runner.register({
      info: { id: "two", name: "two", path: "/two" },
      factory: (relay) => {
        relay.input.onBeforeSubmit(({ text }) => ({ text: `${text} two`, handled: true }));
      },
    });

    await expect(runner.beforeSubmit("prompt", "user")).resolves.toEqual({ text: "prompt one two", handled: true });
  });

  test("collects plugin system reminders", async () => {
    const root = makeTempRoot();
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "one", name: "one", path: "/one" },
      factory: (relay) => {
        relay.input.addSystemReminder("static reminder");
        relay.input.addSystemReminder(({ text, source, threadId }) => [`from ${source} ${threadId}: ${text}`, "  "]);
      },
    });

    await expect(
      runner.systemReminders({
        text: "prompt",
        source: "user",
        threadId: "thread-1",
        sessionId: "session-1",
        cwd: root,
      }),
    ).resolves.toEqual(["static reminder", "from user thread-1: prompt"]);
  });

  test("user bash hooks rewrite commands and can replace execution", async () => {
    const root = makeTempRoot();
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.userBash.onBeforeRun((event) => ({
          command: `wrapped ${event.command}`,
          cwd: `${event.cwd}/subdir`,
          env: { ...event.env, RELAY_TEST: "1" },
        }));
        relay.userBash.onRun((event) => ({
          output: `${event.command}:${event.cwd}:${event.env.RELAY_TEST}:${event.sendToAgent}`,
          exitCode: 0,
        }));
      },
    });

    const prepared = await runner.beforeUserBashRun({
      command: "echo hi",
      cwd: root,
      env: { PATH: "/bin" },
      sendToAgent: true,
      excludeFromContext: false,
    });
    const result = await runner.runUserBash({ ...prepared, signal: new AbortController().signal });

    expect(prepared).toEqual({
      command: "wrapped echo hi",
      cwd: `${root}/subdir`,
      env: { PATH: "/bin", RELAY_TEST: "1" },
      sendToAgent: true,
      excludeFromContext: false,
    });
    expect(result).toEqual({ output: `wrapped echo hi:${root}/subdir:1:true`, exitCode: 0 });
  });

  test("permission request hooks run in order and short-circuit on policy decisions", async () => {
    const root = makeTempRoot();
    const seen: string[] = [];
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "one", name: "one", path: "/one" },
      factory: (relay) => {
        relay.permissions.onRequest((request) => {
          seen.push(`one:${request.threadId}:${request.toolName}:${request.options[0]?.optionId}`);
          return { action: "continue" };
        });
      },
    });
    await runner.register({
      info: { id: "two", name: "two", path: "/two" },
      factory: (relay) => {
        relay.permissions.onRequest((request) => {
          seen.push(`two:${request.cwd}:${request.preview ?? ""}`);
          return { action: "select", optionId: "allow_once" };
        });
      },
    });
    await runner.register({
      info: { id: "three", name: "three", path: "/three" },
      factory: (relay) => {
        relay.permissions.onRequest(() => {
          seen.push("three");
          return { action: "deny" };
        });
      },
    });

    const decision = await runner.handlePermissionRequest({
      threadId: "thread-one",
      sessionId: "session-one",
      cwd: root,
      toolName: "bash",
      toolCallId: "tool-1",
      preview: "rm -rf tmp",
      options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
    });

    expect(seen).toEqual([`one:thread-one:bash:allow_once`, `two:${root}:rm -rf tmp`]);
    expect(decision).toMatchObject({ plugin: { id: "two" }, result: { action: "select", optionId: "allow_once" } });
  });

  test("permission and elicitation hooks are disposed with the runner", async () => {
    const root = makeTempRoot();
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.permissions.onRequest(() => ({ action: "deny", reason: "blocked" }));
        relay.elicitation.onRequest(() => ({ action: "respond", response: { action: "decline" } }));
      },
    });

    expect(
      await runner.handlePermissionRequest({
        threadId: "thread-one",
        sessionId: null,
        cwd: root,
        toolName: "bash",
        toolCallId: "tool-1",
        options: [],
      }),
    ).toMatchObject({ result: { action: "deny", reason: "blocked" } });
    expect(
      await runner.handleElicitationRequest({
        threadId: "thread-one",
        sessionId: null,
        cwd: root,
        mode: "form",
        message: "Question?",
        fields: [],
      }),
    ).toMatchObject({ result: { response: { action: "decline" } } });

    runner.dispose();

    expect(
      await runner.handlePermissionRequest({
        threadId: "thread-one",
        sessionId: null,
        cwd: root,
        toolName: "bash",
        toolCallId: "tool-1",
        options: [],
      }),
    ).toBeNull();
    expect(
      await runner.handleElicitationRequest({
        threadId: "thread-one",
        sessionId: null,
        cwd: root,
        mode: "form",
        message: "Question?",
        fields: [],
      }),
    ).toBeNull();
  });

  test("elicitation hooks can respond with form content", async () => {
    const root = makeTempRoot();
    const seen: string[] = [];
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.elicitation.onRequest((request) => {
          seen.push(`${request.threadId}:${request.message}:${request.fields[0]?.key}`);
          return { action: "respond", response: { action: "accept", content: { env: "dev" } } };
        });
      },
    });

    const decision = await runner.handleElicitationRequest({
      threadId: "thread-one",
      sessionId: "session-one",
      cwd: root,
      mode: "form",
      message: "Pick env",
      fields: [{ key: "env", title: "Environment", choices: [{ value: "dev", title: "Dev" }] }],
    });

    expect(seen).toEqual(["thread-one:Pick env:env"]);
    expect(decision).toMatchObject({
      plugin: { id: "plugin" },
      result: { action: "respond", response: { action: "accept", content: { env: "dev" } } },
    });
  });
});

describe("plugin persistent storage API", () => {
  test("relay.storage.persisted values survive runner reload", async () => {
    process.env.XDG_CONFIG_HOME = path.join(makeTempRoot(), "xdg");
    resetConfig();
    const root = makeTempRoot();
    const plugin = { id: "global:/counter:0", name: "counter", path: "/counter" };
    const values: unknown[] = [];

    const first = new PluginRunner({ cwd: root });
    await first.register({
      info: plugin,
      factory: (relay) => {
        relay.storage.persisted.set("count", 2);
      },
    });
    first.dispose();

    const second = new PluginRunner({ cwd: root });
    await second.register({
      info: plugin,
      factory: (relay) => {
        values.push(relay.storage.persisted.get("count"));
      },
    });

    expect(values).toEqual([2]);
  });

  test("bundled relay.storage.persisted writes under bundled plugin data", async () => {
    process.env.XDG_CONFIG_HOME = path.join(makeTempRoot(), "xdg");
    resetConfig();
    const root = makeTempRoot();
    const plugin = { id: "bundled:handoff", name: "handoff", path: "bundled/handoff/index.mjs" };
    const storageFile = persistentPluginStorageFilePath(plugin);

    expect(storageFile).toBe(path.join(getConfigDir(), "bundled", "handoff", "data", "storage.json"));

    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: plugin,
      factory: (relay) => {
        relay.storage.persisted.set("value", "stored");
      },
    });

    expect(JSON.parse(fs.readFileSync(storageFile, "utf-8"))).toEqual({ value: "stored" });
  });

  test("relay.storage.persisted values are scoped by plugin id", async () => {
    process.env.XDG_CONFIG_HOME = path.join(makeTempRoot(), "xdg");
    resetConfig();
    const root = makeTempRoot();
    const firstPlugin = { id: "global:/one:0", name: "shared", path: "/one" };
    const secondPlugin = { id: "global:/two:0", name: "shared", path: "/two" };
    const values: unknown[] = [];
    const writer = new PluginRunner({ cwd: root });

    await writer.register({
      info: firstPlugin,
      factory: (relay) => {
        relay.storage.persisted.set("value", "one");
      },
    });
    await writer.register({
      info: secondPlugin,
      factory: (relay) => {
        relay.storage.persisted.set("value", "two");
      },
    });
    writer.dispose();

    const reader = new PluginRunner({ cwd: root });
    await reader.register({
      info: firstPlugin,
      factory: (relay) => {
        values.push(relay.storage.persisted.get("value"));
      },
    });
    await reader.register({
      info: secondPlugin,
      factory: (relay) => {
        values.push(relay.storage.persisted.get("value"));
      },
    });

    expect(values).toEqual(["one", "two"]);
  });

  test("corrupt persisted storage records a diagnostic and returns undefined", async () => {
    process.env.XDG_CONFIG_HOME = path.join(makeTempRoot(), "xdg");
    resetConfig();
    const root = makeTempRoot();
    const plugin = { id: "global:/broken:0", name: "broken", path: "/broken" };
    const storageFile = persistentPluginStorageFilePath(plugin);
    const values: unknown[] = [];
    fs.mkdirSync(path.dirname(storageFile), { recursive: true });
    fs.writeFileSync(storageFile, "{not-json", "utf-8");

    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: plugin,
      factory: (relay) => {
        values.push(relay.storage.persisted.get("count"));
      },
    });

    expect(values).toEqual([undefined]);
    expect(runner.diagnostics).toHaveLength(1);
    expect(runner.diagnostics[0]?.message).toContain("Failed to read persisted plugin storage");
  });
});

describe("plugin settings API", () => {
  test("define registers a setting definition on the runner", async () => {
    const root = makeTempRoot();
    const runner = new PluginRunner({ cwd: root });
    const plugin = { id: "global:/p:0", name: "p", path: "/p" };
    await runner.register({
      info: plugin,
      factory: (relay) => {
        relay.settings.define("format", {
          title: "Format",
          description: "Clock format string",
          type: "choice",
          default: "%H:%M",
          choices: () => ["%H:%M", "%I:%M %p"],
        });
      },
    });

    const defn = runner.getSettingDef(plugin, "format");
    expect(defn).toBeDefined();
    expect(defn?.title).toBe("Format");
    expect(defn?.type).toBe("choice");
    expect(defn?.default).toBe("%H:%M");
  });

  test("allPluginSettings returns definitions across all registered plugins", async () => {
    const root = makeTempRoot();
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "global:/a:0", name: "a", path: "/a" },
      factory: (relay) => {
        relay.settings.define("enabled", { title: "Enabled", description: "", type: "boolean", default: true });
      },
    });
    await runner.register({
      info: { id: "global:/b:0", name: "b", path: "/b" },
      factory: (relay) => {
        relay.settings.define("count", { title: "Count", description: "", type: "integer", default: 5, min: 1 });
      },
    });

    const all = runner.allPluginSettings();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.key)).toContain("enabled");
    expect(all.map((e) => e.key)).toContain("count");
  });

  test("relay.settings.get returns the declared default when no config value exists", async () => {
    process.env.XDG_CONFIG_HOME = path.join(makeTempRoot(), "xdg");
    resetConfig();
    const root = makeTempRoot();
    const values: Array<boolean | number | string> = [];
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "global:/clock:0", name: "clock", path: "/clock" },
      factory: (relay) => {
        relay.settings.define("format", {
          title: "Format",
          description: "",
          type: "choice",
          default: "%H:%M",
          choices: () => ["%H:%M", "%I:%M %p"],
        });
        values.push(relay.settings.get("format"));
      },
    });

    expect(values).toEqual(["%H:%M"]);
  });

  test("relay.settings.set persists to config and relay.settings.get reads it back", async () => {
    process.env.XDG_CONFIG_HOME = path.join(makeTempRoot(), "xdg");
    resetConfig();
    const root = makeTempRoot();
    const runner = new PluginRunner({ cwd: root });
    const plugin = { id: "global:/clock:0", name: "clock", path: "/clock" };
    await runner.register({
      info: plugin,
      factory: (relay) => {
        relay.settings.define("format", {
          title: "Format",
          description: "",
          type: "choice",
          default: "%H:%M",
          choices: () => ["%H:%M", "%I:%M %p"],
        });
        relay.settings.set("format", "%I:%M %p");
      },
    });

    const api = runner.getSettingDef(plugin, "format");
    expect(api).toBeDefined();
    // Value should be persisted: the runner can retrieve it through the config
    const raw = getPluginSettingRaw(plugin.id, plugin.name, "format");
    expect(raw).toBe("%I:%M %p");
  });

  test("relay.settings.get returns empty string and records error if define was not called", async () => {
    const root = makeTempRoot();
    const errors: string[] = [];
    const runner = new PluginRunner({
      cwd: root,
      toast: (message) => errors.push(message),
    });
    const values: Array<boolean | number | string> = [];
    await runner.register({
      info: { id: "global:/p:0", name: "p", path: "/p" },
      factory: (relay) => {
        values.push(relay.settings.get("undefined-key"));
      },
    });

    expect(values).toEqual([""]);
    expect(runner.diagnostics).toHaveLength(1);
    expect(runner.diagnostics[0]?.message).toContain('relay.settings.get("undefined-key")');
  });

  test("setting definitions are cleared when the runner is disposed", async () => {
    const root = makeTempRoot();
    const runner = new PluginRunner({ cwd: root });
    const plugin = { id: "global:/p:0", name: "p", path: "/p" };
    await runner.register({
      info: plugin,
      factory: (relay) => {
        relay.settings.define("x", { title: "X", description: "", type: "boolean", default: false });
      },
    });

    expect(runner.allPluginSettings()).toHaveLength(1);
    runner.dispose();
    expect(runner.allPluginSettings()).toHaveLength(0);
  });
});
