import { describe, expect, test } from "bun:test";
import mcpManagerPlugin from "../../examples/plugins/mcp-manager";

const EXAMPLE_FILES = [
  "permission-safety-policy.ts",
  "code-review-helper.ts",
  "mcp-manager.ts",
  "fff-path-autocomplete.ts",
] as const;

describe("plugin examples", () => {
  test("use the public Relay plugin SDK entrypoint", async () => {
    for (const filename of EXAMPLE_FILES) {
      const source = await Bun.file(`examples/plugins/${filename}`).text();
      expect(source).toContain('from "@atlassian/relay-plugin-sdk"');
      expect(source).not.toContain('from "relay/plugin"');
    }
  });

  test("replaces the MCP overlay after state changes", async () => {
    let status = {
      restartNeeded: false,
      applied: false,
      activeServers: [] as Array<{ name: string; command: string }>,
      pendingServers: [{ name: "docs-search", command: "docs-mcp-server" }],
    };
    const widgets: unknown[] = [];
    const keybindings = new Map<string, { enabled?: () => boolean; run: () => void | Promise<void> }>();
    let command: { run: () => void | Promise<void> } | undefined;

    await mcpManagerPlugin({
      mcp: {
        addServer() {},
        status: () => status,
      },
      ui: {
        confirm: async () => false,
        toast() {},
        setWidget(_key: string, widget: unknown) {
          widgets.push(widget);
        },
      },
      agent: {
        async restart() {
          status = { ...status, applied: true, pendingServers: [], activeServers: status.pendingServers };
        },
      },
      keybindings: {
        register(key: string, binding: { enabled?: () => boolean; run: () => void | Promise<void> }) {
          keybindings.set(key, binding);
        },
      },
      commands: {
        register(_name: string, registered: { run: () => void | Promise<void> }) {
          command = registered;
        },
      },
    } as never);

    await command?.run();
    expect(widgets).toHaveLength(1);
    expect(keybindings.get("r")?.enabled?.()).toBeTrue();

    await keybindings.get("r")?.run();
    expect(widgets).toHaveLength(2);
    expect((widgets.at(-1) as { render: () => Array<{ text: string }> }).render()).toContainEqual({
      text: "applied to current agent: yes",
    });

    await keybindings.get("q")?.run();
    expect(widgets.at(-1)).toBeUndefined();
    expect(keybindings.get("r")?.enabled?.()).toBeFalse();
  });
});
