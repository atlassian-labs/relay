import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { getTheme } from "../../../src/config/themes";
import { renderAltaToolBlock } from "../../../src/ui/tool-renderers/agents/alta";
import { renderRovodevToolBlock } from "../../../src/ui/tool-renderers/agents/rovodev";
import { renderToolBlock } from "../../../src/ui/tool-renderers";
import type { ToolRenderContext, ToolRenderHelpers, ToolRendererOutput } from "../../../src/ui/tool-renderers/types";
import type { ToolBlock } from "../../../src/ui/state";

const helpers: ToolRenderHelpers = {
  formatToolName: (name) => name,
  getToolIcon: () => "→",
  getSyntaxStyle: () => ({}),
  hasMarkup: () => false,
  renderMarkup: (text) => [text],
};

type AgentRenderer = (ctx: ToolRenderContext) => ToolRendererOutput;

async function renderEdit(block: ToolBlock, renderer: AgentRenderer): Promise<string> {
  const colors = getTheme("catppuccin-mocha").colors;
  let output: ToolRendererOutput | undefined;
  const app = await testRender(
    () => {
      output = renderer({ block, colors, helpers, expanded: false, previewLines: 10, cwd: "/workspace" });
      return (
        <box width="100%" flexDirection="column">
          {output.header}
          {output.result}
        </box>
      );
    },
    { width: 100, height: 20, targetFps: 30 },
  );
  try {
    await app.renderOnce();
    return app.captureCharFrame();
  } finally {
    app.renderer.destroy();
  }
}

function editBlock(rawInput: unknown, status: ToolBlock["status"]): ToolBlock {
  return {
    type: "tool",
    id: "edit-1",
    toolCallId: "edit-1",
    toolName: "find_and_replace_code",
    display: "",
    status,
    rawInput,
    ...(status === "success"
      ? {
          // Some completion payloads contain only diff headers in their text.
          // The renderer must retain its input preview or use this structured diff.
          details: "Edit completed\n--- before\n+++ after",
          diff: {
            path: "/workspace/src/example.ts",
            oldText: "const value = 1;\n",
            newText: "const value = 2;\n",
          },
        }
      : {}),
  };
}

const cases = [
  {
    name: "Alta",
    renderer: renderAltaToolBlock,
    input: { file_path: "/workspace/src/example.ts", old_string: "const value = 1;", new_string: "const value = 2;" },
  },
  {
    name: "Rovo Dev",
    renderer: renderRovodevToolBlock,
    input: {
      tool_name: "find_and_replace_code",
      tool_call_part: {
        file_path: "/workspace/src/example.ts",
        find: "const value = 1;",
        replace: "const value = 2;",
      },
    },
  },
] as const;

describe("edit tool renderers", () => {
  for (const testCase of cases) {
    test(`${testCase.name} keeps the diff visible when the tool completes`, async () => {
      const running = await renderEdit(editBlock(testCase.input, "running"), testCase.renderer);
      const completed = await renderEdit(editBlock(testCase.input, "success"), testCase.renderer);

      for (const frame of [running, completed]) {
        expect(frame).toContain("~ edit src/example.ts +1 -1");
        expect(frame).toContain("- const value = 1;");
        expect(frame).toContain("+ const value = 2;");
      }
    });
  }

  test("uses the shared full params and result body when a specialized tool is expanded", async () => {
    const block = editBlock(
      { file_path: "/workspace/src/example.ts", old_string: "before-value", new_string: "after-value" },
      "success",
    );
    const colors = getTheme("catppuccin-mocha").colors;
    let output: ToolRendererOutput | undefined;
    const app = await testRender(
      () => {
        output = renderToolBlock(
          { block, colors, helpers, expanded: true, previewLines: 1, cwd: "/workspace" },
          "alta",
        );
        return (
          <box width="100%" flexDirection="column">
            {output.header}
            {output.result}
          </box>
        );
      },
      { width: 100, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const frame = app.captureCharFrame();
      expect(frame).toContain("~ edit src/example.ts +1 -1");
      expect(frame).toContain("Params");
      expect(frame).toContain("before-value");
      expect(frame).toContain("after-value");
      expect(frame).toContain("---");
      expect(frame).toContain("Result");
      expect(frame).toContain("Edit completed");
    } finally {
      app.renderer.destroy();
    }
  });
});
