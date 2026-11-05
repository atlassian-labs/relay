import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { getTheme } from "../../../src/config/themes";
import { renderAltaToolBlock } from "../../../src/ui/tool-renderers/agents/alta";
import { renderRovodevToolBlock } from "../../../src/ui/tool-renderers/agents/rovodev";
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

async function renderBlock(
  block: ToolBlock,
  renderer: AgentRenderer,
): Promise<{ frame: string; output: ToolRendererOutput }> {
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
    { width: 100, height: 10, targetFps: 30 },
  );

  try {
    await app.renderOnce();
    if (!output) throw new Error("Tool renderer did not produce output");
    return { frame: app.captureCharFrame(), output };
  } finally {
    app.renderer.destroy();
  }
}

function questionBlock(): ToolBlock {
  return {
    type: "tool",
    id: "ask-1",
    toolCallId: "ask-1",
    toolName: "ask_user_questions",
    display: "",
    status: "success",
    rawInput: { questions: [{ question: "Which environment?" }] },
    elicitationAnswers: [{ label: "Environment", value: "staging" }],
  };
}

const renderers = [
  { name: "Alta", render: renderAltaToolBlock },
  { name: "Rovo Dev", render: renderRovodevToolBlock },
] as const;

describe("elicitation tool renderers", () => {
  for (const renderer of renderers) {
    test(`${renderer.name} renders one answer beneath the tool header`, async () => {
      const { frame, output } = await renderBlock(questionBlock(), renderer.render);

      expect(output.result).toBeDefined();
      expect(frame).toContain("└ Environment: staging");
    });
  }

  test("Alta keeps unrelated single-line tool results header-only", async () => {
    const { frame, output } = await renderBlock(
      {
        type: "tool",
        id: "skill-1",
        toolCallId: "skill-1",
        toolName: "skill",
        display: "",
        status: "success",
        rawInput: { name: "review" },
        details: "unrelated one-line result",
      },
      renderAltaToolBlock,
    );

    expect(output.result).toBeUndefined();
    expect(frame).not.toContain("unrelated one-line result");
  });
});
