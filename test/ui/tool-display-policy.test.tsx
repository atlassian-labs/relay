import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { PluginRunner } from "../../src/plugins";
import { getTheme } from "../../src/config/themes";
import { renderToolBlock } from "../../src/ui/tool-renderers";
import type { ToolRenderHelpers, ToolRendererOutput } from "../../src/ui/tool-renderers";
import type { ToolBlock } from "../../src/ui/state";

const helpers: ToolRenderHelpers = {
  formatToolName: (name) => name,
  getToolIcon: () => "→",
  getSyntaxStyle: () => ({}),
  hasMarkup: () => false,
  renderMarkup: (text) => [text],
};

function bashBlock(): ToolBlock {
  return {
    type: "tool",
    id: "tool-1",
    toolCallId: "tool-1",
    toolName: "bash",
    display: "bash",
    status: "success",
    rawInput: { command: "printf lines" },
    rawOutput: "one\ntwo\nthree",
    details: "one\ntwo\nthree",
  };
}

describe("tool display policies", () => {
  test("collapsedByDefault hides tool result until details are expanded", async () => {
    const root = "/workspace";
    const colors = getTheme("catppuccin-mocha").colors;
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.tools.setDisplayPolicy("bash", { collapsedByDefault: true });
      },
    });

    let collapsed: ToolRendererOutput | undefined;
    let expanded: ToolRendererOutput | undefined;
    const app = await testRender(
      () => {
        collapsed = renderToolBlock(
          { block: bashBlock(), colors, helpers, expanded: false, previewLines: 10, cwd: root },
          "default",
          runner,
        );
        expanded = renderToolBlock(
          { block: bashBlock(), colors, helpers, expanded: true, previewLines: 10, cwd: root },
          "default",
          runner,
        );
        return <box />;
      },
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      expect(collapsed?.result).toBeUndefined();
      expect(collapsed?.collapsed).toBe(true);
      expect(collapsed?.canToggle).toBe(true);
      expect(expanded?.result).toBeDefined();
      expect(expanded?.collapsed).toBe(false);
    } finally {
      app.renderer.destroy();
    }
  });

  test("previews off still marks policy-handled tools collapsed and honours previewLines: 0", async () => {
    const root = "/workspace";
    const colors = getTheme("catppuccin-mocha").colors;
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.tools.setDisplayPolicy("bash", { header: "shell" });
      },
    });
    const zeroRunner = new PluginRunner({ cwd: root });
    await zeroRunner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.tools.setDisplayPolicy("bash", { previewLines: 0 });
      },
    });

    const render = (previewLines: number, r: PluginRunner) =>
      renderToolBlock({ block: bashBlock(), colors, helpers, expanded: false, previewLines, cwd: root }, "default", r);
    let off: ToolRendererOutput | undefined;
    let shown: ToolRendererOutput | undefined;
    let policyZero: ToolRendererOutput | undefined;
    const app = await testRender(
      () => {
        off = render(0, runner);
        shown = render(5, runner);
        policyZero = render(5, zeroRunner);
        return <box />;
      },
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      expect(off?.result).toBeUndefined();
      expect(off?.collapsed).toBe(true);
      expect(shown?.collapsed).toBeFalsy();
      expect(policyZero?.result).toBeUndefined();
      expect(policyZero?.collapsed).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  });

  test("plugin renderer displays line and card renderables", async () => {
    const root = "/workspace";
    const colors = getTheme("catppuccin-mocha").colors;
    const runner = new PluginRunner({ cwd: root });
    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        relay.tools.registerRenderer({
          toolNames: ["bash"],
          renderCall: (ctx) => ({ kind: "lines", lines: [{ text: `plugin call ${ctx.blockId}` }] }),
          renderResult: () => ({
            kind: "card",
            title: "Plugin Card",
            border: "single",
            lines: [{ text: "card body line" }],
          }),
        });
      },
    });

    let output: ToolRendererOutput | undefined;
    const app = await testRender(
      () => {
        output = renderToolBlock(
          {
            block: bashBlock(),
            colors,
            helpers,
            expanded: false,
            previewLines: 10,
            cwd: root,
            threadId: "thread-1",
            sessionId: "session-1",
          },
          "default",
          runner,
        );
        return (
          <box width="100%" flexDirection="column">
            {output.header}
            {output.result}
          </box>
        );
      },
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const frame = app.captureCharFrame();
      expect(frame).toContain("plugin call tool-1");
      expect(frame).toContain("Plugin Card");
      expect(frame).toContain("card body line");
    } finally {
      app.renderer.destroy();
    }
  });
});
