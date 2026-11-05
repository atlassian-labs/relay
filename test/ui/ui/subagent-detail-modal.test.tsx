import { afterEach, describe, expect, test } from "bun:test";
import { parseColor, type BoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { onMount } from "solid-js";
import { Config, resetConfig, setConfig } from "../../../src/config";
import type { ChatBlock, ToolBlock } from "../../../src/ui/state";
import { AppContext } from "../../../src/ui/state";
import { createAppStateValue } from "../../../src/ui/context/app-state";
import { TerminalDimensionsProvider } from "../../../src/ui/context/terminal-dimensions";
import { SubagentDetailModal } from "../../../src/ui/component/subagent-detail-modal";
import { getColors } from "../../../src/ui/context/theme";
import { TRANSCRIPT_NAV_BLOCK_ID_PREFIX } from "../../../src/ui/util/sticky-prompt";

function content(block: ChatBlock): string {
  return "content" in block && typeof block.content === "string" ? block.content : block.id;
}

afterEach(() => {
  resetConfig();
});

describe("SubagentDetailModal", () => {
  test("keeps child conversation rows mounted while streaming updates", async () => {
    const contextValue = createAppStateValue(process.cwd());
    const childBlock: ChatBlock = {
      type: "content",
      id: "child-answer",
      content: "Inspecting the renderer",
      finalized: false,
    };
    const parent: ToolBlock = {
      type: "tool",
      id: "invoke-scout",
      toolCallId: "invoke-scout",
      toolName: "invoke_agent",
      display: "",
      status: "running",
      subagent: {
        invokingToolCallId: "invoke-scout",
        childSessionId: "subagent-scout",
        agentName: "scout",
        status: "running",
        progress: [],
        blocks: [childBlock],
        currentBlockId: childBlock.id,
      },
    };
    contextValue.addBlock(parent);
    contextValue.setState("selectedSubagentToolCallId", parent.toolCallId);

    let mounts = 0;
    const StableBlock = (props: { block: ChatBlock }) => {
      onMount(() => {
        mounts += 1;
      });
      return <text>{content(props.block)}</text>;
    };

    const app = await testRender(
      () => (
        <TerminalDimensionsProvider>
          <AppContext.Provider value={contextValue}>
            <SubagentDetailModal
              open={() => true}
              onClose={() => {}}
              renderBlock={(block) => <StableBlock block={block} />}
            />
          </AppContext.Provider>
        </TerminalDimensionsProvider>
      ),
      { width: 80, height: 16, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      const frame = app.captureCharFrame();
      const lines = frame.split("\n");
      const headerRow = lines.findIndex((line) => line.includes("Subagents / scout"));
      const contentRow = lines.findIndex((line) => line.includes("Inspecting the renderer"));
      const spans = app.captureSpans().lines.flatMap((line) => line.spans);
      const escSpan = spans.find((span) => span.text === "esc");
      const backSpan = spans.find((span) => span.text.includes(" back"));

      expect(frame).toContain("Inspecting the renderer");
      expect(contentRow).toBe(headerRow + 2);
      expect(escSpan?.fg.toString()).toBe(parseColor(getColors().textLabel).toString());
      expect(backSpan?.fg.toString()).toBe(parseColor(getColors().textSubtle).toString());
      expect(mounts).toBe(1);

      contextValue.updateBlock(parent.id, {
        subagent: {
          ...parent.subagent!,
          blocks: [{ ...childBlock, content: "Inspecting the renderer and preserving the row" }],
        },
      });
      await app.renderOnce();
      await app.flush();

      expect(app.captureCharFrame()).toContain("Inspecting the renderer and preserving the row");
      expect(mounts).toBe(1);
    } finally {
      app.renderer.destroy();
    }
  });

  test("groups child tool calls without mounting a nested chat log", async () => {
    setConfig(
      new Config({
        ui: {
          tool_call_groups: {
            enabled: true,
            rules: [
              {
                tool_names: ["grep"],
                singular: "Searched {count} pattern",
                plural: "Searched {count} patterns",
              },
            ],
          },
        },
      }),
    );
    const contextValue = createAppStateValue(process.cwd());
    const childBlocks: ChatBlock[] = [
      {
        type: "tool",
        id: "child-grep-1",
        toolCallId: "child-grep-call-1",
        toolName: "grep",
        display: "first pattern",
        status: "success",
      },
      {
        type: "tool",
        id: "child-grep-2",
        toolCallId: "child-grep-call-2",
        toolName: "grep",
        display: "second pattern",
        status: "success",
      },
      { type: "content", id: "child-answer", content: "Scout complete", finalized: true },
    ];
    const parent: ToolBlock = {
      type: "tool",
      id: "invoke-scout",
      toolCallId: "invoke-scout",
      toolName: "invoke_agent",
      display: "",
      status: "running",
      subagent: {
        invokingToolCallId: "invoke-scout",
        childSessionId: "subagent-scout",
        agentName: "scout",
        status: "running",
        progress: [],
        blocks: childBlocks,
        currentBlockId: null,
      },
    };
    contextValue.addBlock(parent);
    contextValue.setState("selectedSubagentToolCallId", parent.toolCallId);

    const app = await testRender(
      () => (
        <TerminalDimensionsProvider>
          <AppContext.Provider value={contextValue}>
            <SubagentDetailModal
              open={() => true}
              onClose={() => {}}
              renderBlock={(block) => <text>{block.type === "tool" ? `tool ${block.id}` : content(block)}</text>}
            />
          </AppContext.Provider>
        </TerminalDimensionsProvider>
      ),
      { width: 80, height: 16, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      const collapsedFrame = app.captureCharFrame();
      const groupId = "tool-call-group:child-grep-1";
      expect(collapsedFrame).toContain("Searched 2 patterns");
      expect(collapsedFrame).not.toContain("tool child-grep-1");
      expect(collapsedFrame).not.toContain("tool child-grep-2");
      expect(collapsedFrame).toContain("Scout complete");

      const groupRow = app.renderer.root.findDescendantById(
        `${TRANSCRIPT_NAV_BLOCK_ID_PREFIX}${groupId}`,
      ) as BoxRenderable | null;
      expect(groupRow).not.toBeNull();
      await app.mockMouse.doubleClick(groupRow!.x + 1, groupRow!.y);
      await app.flush();

      expect(contextValue.state.expandedToolCallGroups[groupId]).toBe(true);
      const expandedFrame = app.captureCharFrame();
      expect(expandedFrame).toContain("tool child-grep-1");
      expect(expandedFrame).toContain("tool child-grep-2");
    } finally {
      app.renderer.destroy();
    }
  });
});
