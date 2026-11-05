import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { getTheme } from "../../../src/config/themes";
import { renderRovodevToolBlock } from "../../../src/ui/tool-renderers/agents/rovodev";
import type { ToolRenderHelpers, ToolRendererOutput } from "../../../src/ui/tool-renderers/types";
import type { ToolBlock } from "../../../src/ui/state";

const helpers: ToolRenderHelpers = {
  formatToolName: (name) => name.replaceAll("_", "-"),
  getToolIcon: () => "→",
  getSyntaxStyle: () => ({}),
  hasMarkup: () => false,
  renderMarkup: (text) => [text],
};

function todoBlock(overrides: Partial<ToolBlock> = {}): ToolBlock {
  return {
    type: "tool",
    id: "todo-1",
    toolCallId: "todo-1",
    toolName: "update_todo",
    display: "",
    status: "running",
    ...overrides,
  };
}

function openBlock(overrides: Partial<ToolBlock> = {}): ToolBlock {
  return {
    type: "tool",
    id: "open-1",
    toolCallId: "open-1",
    toolName: "open_files",
    display: "",
    status: "running",
    rawInput: { tool_name: "open_files", tool_call_part: { file_paths: ["src/a.ts"] } },
    ...overrides,
  };
}

async function renderBlock(
  block: ToolBlock,
  options: { expanded?: boolean; previewLines?: number } = {},
): Promise<{ frame: string; output: ToolRendererOutput }> {
  const colors = getTheme("catppuccin-mocha").colors;
  let output: ToolRendererOutput | undefined;
  const app = await testRender(
    () => {
      output = renderRovodevToolBlock({
        block,
        colors,
        helpers,
        expanded: options.expanded ?? false,
        previewLines: options.previewLines ?? 10,
        cwd: "/workspace",
      });
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
    if (!output) throw new Error("Rovo renderer did not produce output");
    return { frame: app.captureCharFrame(), output };
  } finally {
    app.renderer.destroy();
  }
}

const liveInput = {
  tool_name: "update_todo",
  tool_call_part: {
    _intent: "Setting up the initial task list.",
    merge: false,
    todos: [
      { content: "inspect renderer", status: "completed", id: 1 },
      { active_form: "implementing renderer", id: 2, content: "implement renderer", status: "in_progress" },
      { content: "verify renderer", status: "pending", id: 3 },
    ],
  },
};

const liveOutput = [
  "Successfully replaced existing todos. Total: 3 tasks (1 completed, 1 in_progress, 1 pending).",
  "",
  "<todo>",
  '{"id":1,"content":"inspect renderer","active_form":null,"status":"completed"}',
  '{"id":2,"content":"implement renderer","active_form":"implementing renderer","status":"in_progress"}',
  '{"id":3,"content":"verify renderer","active_form":null,"status":"pending"}',
  "</todo>",
].join("\n");

describe("Rovo Dev tool renderer", () => {
  test("keeps single-file and multi-file open names consistent with the file count", async () => {
    const pending = await renderBlock(openBlock({ status: "pending" }));
    expect(pending.frame).toContain("→ open src/a.ts (1 file)");

    const firstResult = "Successfully opened src/a.ts:\n\n````ts\n   0 first\n   1 second\n````";
    const secondResult = "Successfully opened src/b.ts:\n\n````ts\n   0 third\n````";
    const completed = await renderBlock(
      openBlock({
        status: "success",
        rawInput: {
          tool_name: "open_files",
          tool_call_part: { file_paths: ["src/a.ts", "src/b.ts"], _intent: "Inspect both files." },
        },
        rawOutput: [firstResult, secondResult],
        // Real Rovo completion content repeats the formatted input before the
        // per-file results. It must not inflate the visible result.
        details: [`TRANSPORT INPUT: src/a.ts src/b.ts`, firstResult, secondResult].join("\n"),
      }),
    );

    expect(completed.frame).toContain("→ open src/a.ts, src/b.ts (2 files)");
    expect(completed.frame).not.toContain("TRANSPORT INPUT");

    const malformed = await renderBlock(
      openBlock({
        toolName: "2 files",
        rawInput: { tool_name: "open_files", tool_call_part: { file_paths: "src/a.ts" } },
      }),
    );
    expect(malformed.frame).toContain("→ open-files");
  });

  test("renders the live update_todo JSONL result as a compact status list", async () => {
    const { frame, output } = await renderBlock(
      todoBlock({
        status: "success",
        rawInput: liveInput,
        rawOutput: liveOutput,
        // Rovo's completed ACP content repeats inputs before the result. The raw
        // output must remain authoritative so this transport text is not shown.
        details: `merge: False\n\ntodos: [...]\n\n${liveOutput}`,
      }),
    );

    expect(frame).toContain("☑ todos (1/3 done)");
    expect(frame).toContain("└ ● inspect renderer");
    expect(frame).toContain("◉ implementing renderer");
    expect(frame).toContain("○ verify renderer");
    expect(frame).not.toContain("Successfully replaced");
    expect(frame).not.toContain("<todo>");
    expect(frame).not.toContain("active_form");
    expect(output.canToggle).toBe(false);
  });
});
