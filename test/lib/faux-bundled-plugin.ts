import type { BundledRelayPlugin } from "../../src/plugins/bundled";

export const FAUX_BUNDLED_PLUGIN_ID = "relay-test-faux";
export const FAUX_BUNDLED_PLUGIN_NAME = "faux-bundled";
export const FAUX_BUNDLED_PLUGIN_ENTRY_ID = `bundled:${FAUX_BUNDLED_PLUGIN_ID}`;
export const FAUX_BUNDLED_PLUGIN_SCRIPT = "index.ts";
export const FAUX_BUNDLED_PLUGIN_PATH = `bundled/${FAUX_BUNDLED_PLUGIN_ID}/${FAUX_BUNDLED_PLUGIN_SCRIPT}`;
export const FAUX_BUNDLED_PLUGIN_AUTHOR = "Relay Tests";
export const FAUX_BUNDLED_PLUGIN_DESCRIPTION = "Faux bundled plugin used by Relay plugin integration tests";
export const FAUX_BUNDLED_PLUGIN_COMMAND = "faux";
export const FAUX_BUNDLED_PLUGIN_COMMAND_DESCRIPTION = "Run faux command";
export const FAUX_BUNDLED_PLUGIN_KEYBINDING = "ctrl+shift+k";
export const FAUX_BUNDLED_PLUGIN_KEYBINDING_DESCRIPTION = "Run faux keybinding";
export const FAUX_BUNDLED_PLUGIN_SETTING_KEY = "mode";
export const FAUX_BUNDLED_PLUGIN_SETTING_TITLE = "Faux mode";
export const FAUX_BUNDLED_PLUGIN_SETTING_DESCRIPTION = "Mode used by the faux bundled plugin";
export const FAUX_BUNDLED_PLUGIN_SETTING_DEFAULT = "quiet";

let fauxBundledPluginEvents: string[] | null = null;

export function startFauxBundledPluginEventCapture(): string[] {
  fauxBundledPluginEvents = [];
  return fauxBundledPluginEvents;
}

export function stopFauxBundledPluginEventCapture(): void {
  fauxBundledPluginEvents = null;
}

function recordFauxBundledPluginEvent(event: string): void {
  fauxBundledPluginEvents?.push(event);
}

function sessionUpdateLabel(update: unknown): string {
  if (update !== null && typeof update === "object" && "sessionUpdate" in update) {
    return String((update as { readonly sessionUpdate?: unknown }).sessionUpdate);
  }
  return "unknown";
}

export const FAUX_BUNDLED_PLUGIN: BundledRelayPlugin = {
  id: FAUX_BUNDLED_PLUGIN_ID,
  name: FAUX_BUNDLED_PLUGIN_NAME,
  script: FAUX_BUNDLED_PLUGIN_SCRIPT,
  author: FAUX_BUNDLED_PLUGIN_AUTHOR,
  description: FAUX_BUNDLED_PLUGIN_DESCRIPTION,
  factory: (relay) => {
    recordFauxBundledPluginEvent(`setup:${relay.plugin.id}:${relay.cwd}`);
    relay.ui.toast("faux loaded", "info", 5);
    relay.on("ui:mount", () => recordFauxBundledPluginEvent(`mount:${relay.plugin.name}`));
    relay.on("session:update", (event) => recordFauxBundledPluginEvent(`session:${sessionUpdateLabel(event.update)}`));

    relay.commands.register(FAUX_BUNDLED_PLUGIN_COMMAND, {
      description: FAUX_BUNDLED_PLUGIN_COMMAND_DESCRIPTION,
      run: (args) => {
        recordFauxBundledPluginEvent(`command:${args}`);
        const diff = relay.ui.openDiff({ title: "Faux Diff", diffText: "diff --git a/faux.txt b/faux.txt" });
        diff.dispose();
      },
    });

    let keybindingEnabled = true;
    relay.keybindings.register("shift+ctrl+k", {
      description: FAUX_BUNDLED_PLUGIN_KEYBINDING_DESCRIPTION,
      enabled: () => keybindingEnabled,
      run: () => {
        recordFauxBundledPluginEvent("keybinding");
        keybindingEnabled = false;
      },
    });

    relay.ui.setEditorStatus("activity", "ready");
    relay.ui.setEditorStatusSegment("status-line", { render: () => "faux status line" });
    relay.ui.setEditorFooterSegment("footer", { render: () => "faux footer" });
    relay.ui.setWidget("widget", {
      placement: "aboveEditor",
      render: () => [{ text: "faux widget" }],
    });
    relay.editor.configure({ minHeight: 4 });
    relay.editor.setTheme({ borderColor: "#fff" });
    relay.editor.addAutocompleteProvider({ trigger: "@", provide: () => [{ label: "@faux" }] });

    relay.tools.setDisplayPolicy("bash", { header: "shell", previewLines: 3 });
    relay.tools.registerRenderer({
      toolNames: ["faux-tool"],
      renderCall: () => ({ kind: "lines", lines: [{ text: "faux" }] }),
      renderResult: () => ({ kind: "lines", lines: [{ text: "ok" }] }),
    });
    relay.ui.registerMessageRenderer({
      blockTypes: ["user"],
      render: (ctx) => ({ header: "faux-message", lines: [{ text: ctx.content, fg: "#fff", bold: true }] }),
    });

    relay.mcp.addServer({ name: "faux-mcp", command: "faux-mcp", args: ["--stdio"] });
    relay.settings.define(FAUX_BUNDLED_PLUGIN_SETTING_KEY, {
      title: FAUX_BUNDLED_PLUGIN_SETTING_TITLE,
      description: FAUX_BUNDLED_PLUGIN_SETTING_DESCRIPTION,
      type: "choice",
      default: FAUX_BUNDLED_PLUGIN_SETTING_DEFAULT,
      choices: () => [FAUX_BUNDLED_PLUGIN_SETTING_DEFAULT, "loud"],
    });
    recordFauxBundledPluginEvent(`setting:${relay.settings.get(FAUX_BUNDLED_PLUGIN_SETTING_KEY)}`);

    relay.storage.set("seen", true);
    recordFauxBundledPluginEvent(`storage:${relay.storage.get("seen") === true}`);
    relay.input.onBeforeSubmit(({ text }) => `${text} faux`);
  },
};
