import { describe, expect, test } from "bun:test";
import { findBuiltinSkill } from "../../src/builtin-skills/registry";
import { BUILTIN_SKILL_METADATA } from "../../src/builtin-skills/metadata";
import type { RelayCommandContext } from "../../src/plugins";

const context: RelayCommandContext = {
  cwd: "/tmp/relay-skills",
  sessionId: "session-1",
  threadId: "thread-1",
  userMessageCount: 0,
  running: false,
  waitForIdle: () => Promise.resolve(),
  toast: () => undefined,
};

describe("Relay built-in skills", () => {
  test("declares the fixed Relay-owned command set", () => {
    expect(BUILTIN_SKILL_METADATA).toEqual([
      {
        name: "review",
        description: "Review changes [commit|branch|PR], defaults to uncommitted",
        location: "relay://builtin-skills/review",
      },
      {
        name: "relay-plugins",
        description:
          "Create, modify, debug, and test Relay plugins and extensions. Use when a user asks to add Relay commands, keybindings, widgets, renderers, prompt hooks, settings, MCP integration, local policy, or other plugin behavior, whether as a local user plugin or a bundled plugin shipped through a plugin distribution repository.",
        location: "relay://builtin-skills/relay-plugins",
      },
      {
        name: "relay-themes",
        description:
          "Create, modify, validate, troubleshoot, and install custom Relay terminal themes. Use when a user asks for a Relay color scheme, wants to port an existing palette, needs a theme under ~/.config/relay/themes, or has custom-theme loading or validation warnings.",
        location: "relay://builtin-skills/relay-themes",
      },
    ]);
  });

  test("expands bundled content into virtual Relay skill prompts", async () => {
    const pluginSkill = findBuiltinSkill("relay-plugins");
    const themeSkill = findBuiltinSkill("relay-themes");

    expect(pluginSkill).not.toBeNull();
    expect(themeSkill).not.toBeNull();

    const pluginPrompt = await pluginSkill!.createPrompt("add a command", context);
    const themePrompt = await themeSkill!.createPrompt("midnight", context);

    expect(pluginPrompt).toContain('<skill name="relay-plugins" location="relay://builtin-skills/relay-plugins">');
    expect(pluginPrompt).toContain("# Bundled Relay Extensions Reference");
    expect(pluginPrompt).toContain("replace the widget under the same `relay.ui.setWidget` key");
    expect(pluginPrompt).toContain("do not rely on calling `render()` directly as proof that Relay repaints");
    expect(pluginPrompt).toContain("Prefer canonical TypeScript source");
    expect(pluginPrompt).toContain("### Source and package layouts");
    expect(pluginPrompt).toContain("long-lived processes, sockets, watchers, timers, and servers");
    expect(pluginPrompt).toContain("If interactive validation is unavailable");
    expect(pluginPrompt).toContain("\n\nadd a command");
    expect(themePrompt).toContain('<skill name="relay-themes" location="relay://builtin-skills/relay-themes">');
    expect(themePrompt).toContain("# Bundled Relay Themes Reference");
    expect(themePrompt).toContain("\n\nmidnight");
  });

  test("keeps the public extension docs and bundled skill reference synchronized", async () => {
    const [publicDocs, bundledReference] = await Promise.all([
      Bun.file("docs/extensions.md").text(),
      Bun.file("src/builtin-skills/relay-plugins/references/extensions.md").text(),
    ]);

    expect(bundledReference).toBe(publicDocs);
  });
});
