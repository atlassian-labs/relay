import { describe, expect, test } from "bun:test";
import { getTheme } from "../../src/config/themes";
import { RelayPluginSlotRegistry } from "../../src/plugins/slots";
import type { RelayEditorChromeRenderContext, RelayPluginInfo } from "../../src/plugins";

const firstPlugin: RelayPluginInfo = { id: "test:first", name: "first", path: "/first.ts" };
const secondPlugin: RelayPluginInfo = { id: "test:second", name: "second", path: "/second.ts" };

function chromeContext(surface: "header" | "footer"): RelayEditorChromeRenderContext {
  return {
    surface,
    width: 100,
    height: 40,
    colors: getTheme("catppuccin-mocha").colors,
    editorText: "draft",
    state: {
      cwd: "/workspace",
      gitBranch: "main",
      worktreePath: null,
      worktreeBranch: null,
      providerName: "test",
      modeId: "code",
      modelId: "model",
      reasoningLevel: "high",
      connecting: false,
      running: false,
      elapsedSeconds: 0,
      statusText: "",
      queue: [],
      queueFocusIndex: null,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        contextTokens: null,
        contextWindow: null,
      },
      fileChanges: { files: 0, added: 0, removed: 0 },
    },
    invalidate: () => undefined,
  };
}

describe("RelayPluginSlotRegistry editor chrome", () => {
  test("uses the first complete renderer that does not fall back", () => {
    const slots = new RelayPluginSlotRegistry();
    slots.registerEditorHeaderRenderer(firstPlugin, { render: () => null });
    slots.registerEditorHeaderRenderer(secondPlugin, {
      render: (ctx) => [{ text: `${ctx.surface}:${ctx.editorText}` }],
    });

    expect(slots.renderEditorHeader(chromeContext("header"))).toEqual([{ text: "header:draft" }]);
  });

  test("reports renderer failures and continues to the next renderer", () => {
    const slots = new RelayPluginSlotRegistry();
    slots.registerEditorHeaderRenderer(firstPlugin, {
      render: () => {
        throw new Error("broken");
      },
    });
    slots.registerEditorHeaderRenderer(secondPlugin, { render: () => [{ text: "fallback" }] });
    const errors: string[] = [];

    expect(
      slots.renderEditorHeader(chromeContext("header"), (plugin, error) =>
        errors.push(`${plugin.id}:${error instanceof Error ? error.message : String(error)}`),
      ),
    ).toEqual([{ text: "fallback" }]);
    expect(errors).toEqual(["test:first:broken"]);
  });

  test("restores the built-in surface when a complete renderer is disposed", () => {
    const slots = new RelayPluginSlotRegistry();
    const handle = slots.registerEditorFooterRenderer(firstPlugin, { render: () => [{ text: "custom" }] });

    expect(slots.renderEditorFooter(chromeContext("footer"))).toEqual([{ text: "custom" }]);
    handle.dispose();
    expect(slots.renderEditorFooter(chromeContext("footer"))).toBeNull();
  });

  test("chains matching element renderers and clears them with their plugin", () => {
    const slots = new RelayPluginSlotRegistry();
    slots.registerEditorChromeElementRenderer(firstPlugin, {
      elements: ["editorFooter.model"],
      render: (ctx) => ({ ...ctx.line, text: ctx.line.text.toUpperCase() }),
    });
    slots.registerEditorChromeElementRenderer(secondPlugin, {
      render: (ctx) => ({ ...ctx.line, fg: ctx.colors.accent }),
    });
    const context = chromeContext("footer");

    expect(
      slots.renderEditorChromeElement({
        ...context,
        element: "editorFooter.model",
        line: { text: "model" },
        active: true,
      }),
    ).toEqual({ text: "MODEL", fg: context.colors.accent });

    slots.clearPlugin(firstPlugin.id);
    expect(
      slots.renderEditorChromeElement({
        ...context,
        element: "editorFooter.model",
        line: { text: "model" },
        active: true,
      }),
    ).toEqual({ text: "model", fg: context.colors.accent });
  });
});
