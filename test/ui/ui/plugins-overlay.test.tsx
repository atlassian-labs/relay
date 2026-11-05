import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { ListItem } from "../../../src/ui/autocomplete";
import { PluginsOverlay } from "../../../src/ui/component/plugins-overlay";
import { getColors } from "../../../src/ui/context/theme";
import type { PluginSettingsItem } from "../../../src/ui/util/plugins";
import {
  FAUX_BUNDLED_PLUGIN_AUTHOR,
  FAUX_BUNDLED_PLUGIN_COMMAND,
  FAUX_BUNDLED_PLUGIN_COMMAND_DESCRIPTION,
  FAUX_BUNDLED_PLUGIN_DESCRIPTION,
  FAUX_BUNDLED_PLUGIN_ENTRY_ID,
  FAUX_BUNDLED_PLUGIN_KEYBINDING,
  FAUX_BUNDLED_PLUGIN_KEYBINDING_DESCRIPTION,
  FAUX_BUNDLED_PLUGIN_NAME,
  FAUX_BUNDLED_PLUGIN_PATH,
  FAUX_BUNDLED_PLUGIN_SETTING_DESCRIPTION,
  FAUX_BUNDLED_PLUGIN_SETTING_KEY,
  FAUX_BUNDLED_PLUGIN_SETTING_TITLE,
} from "../../lib/faux-bundled-plugin";

const pluginItems: ListItem<PluginSettingsItem>[] = [
  {
    value: { type: "system", enabled: true },
    label: "plugins: on",
    description: "load local relay plugins",
    active: true,
  },
  {
    value: {
      type: "plugin",
      id: FAUX_BUNDLED_PLUGIN_ENTRY_ID,
      name: FAUX_BUNDLED_PLUGIN_NAME,
      path: FAUX_BUNDLED_PLUGIN_PATH,
      source: "bundled",
      author: FAUX_BUNDLED_PLUGIN_AUTHOR,
      description: FAUX_BUNDLED_PLUGIN_DESCRIPTION,
      enabled: true,
      disabledByGlobal: false,
      commands: [
        {
          name: FAUX_BUNDLED_PLUGIN_COMMAND,
          invocationName: FAUX_BUNDLED_PLUGIN_COMMAND,
          description: FAUX_BUNDLED_PLUGIN_COMMAND_DESCRIPTION,
          argumentPlaceholder: "<env>",
          diagnostics: [{ kind: "agent-conflict", message: "Conflicts with ACP-advertised command." }],
        },
      ],
      shortcuts: [
        {
          key: FAUX_BUNDLED_PLUGIN_KEYBINDING,
          description: `${FAUX_BUNDLED_PLUGIN_NAME}: ${FAUX_BUNDLED_PLUGIN_KEYBINDING_DESCRIPTION}`,
          enabled: true,
        },
        { key: "@", description: "autocomplete trigger", enabled: true, kind: "autocomplete" },
      ],
      settings: [
        {
          key: FAUX_BUNDLED_PLUGIN_SETTING_KEY,
          title: FAUX_BUNDLED_PLUGIN_SETTING_TITLE,
          description: FAUX_BUNDLED_PLUGIN_SETTING_DESCRIPTION,
          value: "quiet",
        },
      ],
      mcpServers: [{ name: "faux-mcp", command: "faux-mcp", args: ["--stdio"] }],
      mcpRestartNeeded: true,
    },
    label: `${FAUX_BUNDLED_PLUGIN_NAME}: on`,
    description: `${FAUX_BUNDLED_PLUGIN_AUTHOR} · ${FAUX_BUNDLED_PLUGIN_DESCRIPTION}`.toLowerCase(),
    active: true,
  },
  {
    value: {
      type: "plugin",
      id: "global:/relay/plugins/local.mjs",
      name: "local",
      path: "/relay/plugins/local.mjs",
      source: "global",
      description: "Local plugin",
      enabled: false,
      disabledByGlobal: false,
      commands: [],
      shortcuts: [],
      settings: [],
      mcpServers: [],
      mcpRestartNeeded: false,
    },
    label: "local: off",
    description: "local plugin",
    active: false,
  },
];

describe("PluginsOverlay", () => {
  test("renders the full-screen plugin list with toggle and detail hints", async () => {
    const colors = getColors();
    let app: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      app = await testRender(
        () => (
          <box width="100%" height="100%" backgroundColor={colors.bg}>
            <PluginsOverlay
              visible={() => true}
              items={() => pluginItems}
              selectedIndex={() => 1}
              detailsOpen={() => false}
            />
          </box>
        ),
        { width: 100, height: 16, targetFps: 30 },
      );

      await app.renderOnce();
      const frame = app.captureCharFrame();

      expect(frame).toContain("Plugins");
      expect(frame).toContain("Browse local and bundled Relay plugins.");
      expect(frame).toContain(`[*] ${FAUX_BUNDLED_PLUGIN_NAME}`);
      expect(frame).toContain("Space to disable; Enter view details.");
      expect(frame).toContain("space enable/disable");
      expect(frame).not.toContain("[All Plugins]");
      expect(frame).not.toContain("Type to search plugins");
      expect(frame).not.toContain("type to search");
    } finally {
      app?.renderer.destroy();
    }
  });

  test("renders plugin detail metadata, shortcuts, commands, settings, and MCP servers", async () => {
    const colors = getColors();
    let app: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      app = await testRender(
        () => (
          <box width="100%" height="100%" backgroundColor={colors.bg}>
            <PluginsOverlay
              visible={() => true}
              items={() => pluginItems}
              selectedIndex={() => 1}
              detailsOpen={() => true}
            />
          </box>
        ),
        { width: 100, height: 32, targetFps: 30 },
      );

      await app.renderOnce();
      const frame = app.captureCharFrame();

      expect(frame).toContain(`Plugins / ${FAUX_BUNDLED_PLUGIN_NAME}`);
      expect(frame).toContain("Authors:");
      expect(frame).toContain("Source:       bundled");
      expect(frame).toContain("    Key                 Description");
      expect(frame).toContain(FAUX_BUNDLED_PLUGIN_KEYBINDING);
      expect(frame).toContain(FAUX_BUNDLED_PLUGIN_KEYBINDING_DESCRIPTION);
      expect(frame).not.toContain(`${FAUX_BUNDLED_PLUGIN_NAME}: ${FAUX_BUNDLED_PLUGIN_KEYBINDING_DESCRIPTION}`);
      expect(frame).toContain("@                   autocomplete trigger");
      expect(frame).toContain("    Command             Description");
      expect(frame).toContain(`/${FAUX_BUNDLED_PLUGIN_COMMAND}`);
      expect(frame).toContain("args: <env>");
      expect(frame).toContain("warning: Conflicts with ACP-advertised command.");
      expect(frame).toContain(FAUX_BUNDLED_PLUGIN_SETTING_TITLE);
      expect(frame).toContain("MCP servers");
      expect(frame).toContain("warning: MCP changes require an agent restart");
      expect(frame).toContain("faux-mcp");
      expect(frame).toContain("faux-mcp --stdio");
      expect(frame).toContain("enter/esc/backspace back");
    } finally {
      app?.renderer.destroy();
    }
  });
});
