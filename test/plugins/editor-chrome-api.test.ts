import { describe, expect, test } from "bun:test";
import { getTheme } from "../../src/config/themes";
import { PluginRunner, type RelayEditorChromeRenderContext } from "../../src/plugins";

function context(surface: "header" | "footer"): RelayEditorChromeRenderContext {
  return {
    surface,
    width: 80,
    height: 24,
    colors: getTheme("catppuccin-mocha").colors,
    editorText: "",
    state: {
      cwd: "/workspace",
      gitBranch: null,
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

describe("editor chrome plugin API", () => {
  test("registers complete and element renderers through the public API", async () => {
    let invalidations = 0;
    const runner = new PluginRunner({ cwd: process.cwd(), invalidateChrome: () => invalidations++ });

    await runner.register({
      info: { id: "test:chrome-api", name: "chrome api", path: "/chrome-api.ts" },
      factory(relay) {
        relay.ui.registerEditorHeaderRenderer({ render: () => [{ text: "header" }] });
        relay.ui.registerEditorFooterRenderer({ render: () => [{ text: "footer" }] });
        relay.ui.registerEditorChromeElementRenderer({
          elements: ["editorFooter.model"],
          render: (ctx) => ({ ...ctx.line, fg: ctx.colors.accent }),
        });
      },
    });

    expect(runner.slots.renderEditorHeader(context("header"))).toEqual([{ text: "header" }]);
    expect(runner.slots.renderEditorFooter(context("footer"))).toEqual([{ text: "footer" }]);
    expect(
      runner.slots.renderEditorChromeElement({
        ...context("footer"),
        element: "editorFooter.model",
        line: { text: "model" },
      }),
    ).toEqual({ text: "model", fg: getTheme("catppuccin-mocha").colors.accent });
    expect(invalidations).toBe(3);
  });
});
