import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { getTheme } from "../../../src/config/themes";
import { renderToolBlock } from "../../../src/ui/tool-renderers";
import type { ToolRenderHelpers, ToolRendererOutput } from "../../../src/ui/tool-renderers/types";
import type { ToolBlock } from "../../../src/ui/state";
import { CONFIG_SETTINGS } from "../../../src/config/schema";
import { formatSettingValue, SETTING_VALUE_CHOICES } from "../../../src/ui/util/settings";

const helpers: ToolRenderHelpers = {
  formatToolName: (name) => name,
  getToolIcon: () => "→",
  getSyntaxStyle: () => ({}),
  hasMarkup: () => false,
  renderMarkup: (text) => [text],
};

const block: ToolBlock = {
  type: "tool",
  id: "bash-1",
  toolCallId: "bash-1",
  toolName: "bash",
  display: "bash ls",
  status: "success",
  details: "line one\nline two\nline three",
};

async function renderWithPreview(previewLines: number): Promise<{ frame: string; output: ToolRendererOutput }> {
  let output: ToolRendererOutput | undefined;
  const app = await testRender(
    () => {
      output = renderToolBlock(
        { block, colors: getTheme("catppuccin-mocha").colors, helpers, expanded: false, previewLines, cwd: "/w" },
        "default",
      );
      return (
        <box width="100%" flexDirection="column">
          {output.header}
          {output.result}
        </box>
      );
    },
    { width: 80, height: 10, targetFps: 30 },
  );
  try {
    await app.renderOnce();
    return { frame: app.captureCharFrame(), output: output! };
  } finally {
    app.renderer.destroy();
  }
}

describe("tool result preview lines", () => {
  test("0 shows only the header and keeps the result expandable", async () => {
    const { frame, output } = await renderWithPreview(0);
    expect(frame).toContain("→ bash");
    expect(frame).not.toContain("line one");
    expect(frame).not.toContain("hidden");
    expect(output.result).toBeUndefined();
    expect(output.canToggle).toBe(true);
    expect(output.collapsed).toBe(true);
  });

  test("1 shows a single line and a hidden-lines hint", async () => {
    const { frame } = await renderWithPreview(1);
    expect(frame).toContain("line one");
    expect(frame).not.toContain("line two");
    expect(frame).toContain("2 lines hidden");
  });

  test("settings offer Off and 1 alongside the existing choices", () => {
    expect(SETTING_VALUE_CHOICES["ui.tool_result_preview_lines"]?.map((choice) => choice.value)).toEqual([
      0, 1, 5, 10, 15,
    ]);
    const setting = CONFIG_SETTINGS.find((candidate) => candidate.key === "ui.tool_result_preview_lines")!;
    expect(formatSettingValue(setting, 0)).toBe("off");
  });
});
