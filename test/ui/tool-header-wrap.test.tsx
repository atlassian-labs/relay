import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { Config, resetConfig } from "../../src/config";
import { renderHeader } from "../../src/ui/tool-renderers/core";
import type { ToolRenderContext } from "../../src/ui/tool-renderers/types";

function headerContext(): ToolRenderContext {
  const config = new Config({});
  return {
    block: {
      type: "tool",
      id: "tool-1",
      toolCallId: "tool-1",
      toolName: "bash",
      display: "",
      status: "success",
    },
    colors: config.colors,
    helpers: {
      formatToolName: (name) => name,
      getToolIcon: () => "$",
      getSyntaxStyle: () => ({}),
      hasMarkup: () => false,
      renderMarkup: (text) => text,
    },
    expanded: false,
    previewLines: 5,
    cwd: "/tmp",
  };
}

const longDetail = "alpha beta gamma delta epsilon zeta eta theta";

afterEach(() => {
  resetConfig();
});

describe("tool header wrapping", () => {
  test("wraps long tool headers by default", async () => {
    const app = await testRender(
      () => (
        <box width={28} flexDirection="column">
          {renderHeader(headerContext(), "$", "Bash", longDetail)}
        </box>
      ),
      { width: 28, height: 4, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const frame = app.captureCharFrame();
      expect(frame).toContain("$ bash alpha beta gamma");
      expect(frame).toContain("epsilon");
    } finally {
      app.renderer.destroy();
    }
  });
});
