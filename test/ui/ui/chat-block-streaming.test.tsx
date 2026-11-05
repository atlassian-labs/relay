import { describe, expect, test } from "bun:test";
import { MarkdownRenderable, parseColor, Renderable, type BaseRenderable, type BoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { For } from "solid-js";
import { blendHexColors } from "../../../src/config/themes";
import { ChatBlockView } from "../../../src/ui/component/blocks/chat-block";
import { ToolCallGroupHeader } from "../../../src/ui/component/tool-call-group";
import { createAppStateValue } from "../../../src/ui/context/app-state";
import { getColors } from "../../../src/ui/context/theme";
import { AppContext, type ElicitationBlock, type ToolBlock } from "../../../src/ui/state";
import { ToastProvider } from "../../../src/ui/ui/toast";
import { TRANSCRIPT_NAV_BLOCK_ID_PREFIX } from "../../../src/ui/util/sticky-prompt";
import type { ToolCallGroup } from "../../../src/ui/util/tool-call-groups";

function findMarkdownRenderable(root: BaseRenderable): MarkdownRenderable | null {
  if (root instanceof MarkdownRenderable) return root;
  for (const child of root.getChildren()) {
    const markdown = findMarkdownRenderable(child);
    if (markdown) return markdown;
  }
  return null;
}

async function renderContentBlock(finalized: boolean, content = "Streaming **markdown** content", width = 80) {
  const appState = createAppStateValue(process.cwd());
  appState.addBlock({
    type: "content",
    id: "content-1",
    content,
    finalized,
  });

  const app = await testRender(
    () => (
      <ToastProvider>
        <AppContext.Provider value={appState}>
          <box paddingTop={1} paddingBottom={1}>
            <ChatBlockView
              block={appState.state.blocks[0]}
              activeProfile="default"
              hideThinking={() => false}
              approvalOptionIndex={() => 0}
              elicitationOptionIndex={() => 0}
              getSpinnerChar={() => "⠋"}
              pluginRunner={() => null}
              selectElicitationChoice={(_app, _block: ElicitationBlock) => {}}
            />
          </box>
        </AppContext.Provider>
      </ToastProvider>
    ),
    { width, height: 8 },
  );

  await app.renderOnce();
  await app.flush();
  return { app, appState };
}

describe("chat block markdown streaming lifecycle", () => {
  test("keeps incremental Markdown enabled for content that is already finalized", async () => {
    const { app } = await renderContentBlock(true);

    try {
      expect(findMarkdownRenderable(app.renderer.root)?.streaming).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  });

  test("renders fitting Mermaid blocks and preserves source in a narrow viewport", async () => {
    const markdown = "```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```";
    const { app: wideApp } = await renderContentBlock(true, markdown);
    const { app: narrowApp } = await renderContentBlock(true, markdown, 20);

    try {
      const wideFrame = wideApp.captureCharFrame();
      expect(wideFrame).toContain("┌───────┐");
      expect(wideFrame).toContain("Start");
      expect(wideFrame).toContain("Done");
      expect(wideFrame).not.toContain("flowchart LR");

      const narrowContent = findMarkdownRenderable(narrowApp.renderer.root)?.content;
      expect(narrowContent).toContain("flowchart LR");
      expect(narrowContent).not.toContain("┌───────┐");
    } finally {
      wideApp.renderer.destroy();
      narrowApp.renderer.destroy();
    }
  });

  test("draws muted thin borders on both edges without changing the selected block background", async () => {
    const { app, appState } = await renderContentBlock(true);

    try {
      const frameId = `${TRANSCRIPT_NAV_BLOCK_ID_PREFIX}content-1`;
      const backgroundBefore = (
        app.renderer.root.findDescendantById(frameId) as BoxRenderable | null
      )?.backgroundColor.toInts();
      appState.setState("transcriptSelectedRows", "content-1", true);
      appState.setState("transcriptSelectedBlockId", "content-1");
      await app.renderOnce();
      await app.flush();

      const frame = app.renderer.root.findDescendantById(frameId) as BoxRenderable | null;
      expect(frame?.height).toBe(1);
      expect(frame?.backgroundColor.toInts()).toEqual(backgroundBefore);
      const rows = app.captureCharFrame().split("\n");
      expect(rows[frame!.y]?.[frame!.x]).toBe("▏");
      expect(rows[frame!.y]?.[frame!.x + frame!.width - 1]).toBe("▕");
    } finally {
      app.renderer.destroy();
    }
  });

  test("selects a tool transcript row when clicked", async () => {
    const appState = createAppStateValue(process.cwd());
    appState.addBlock({
      type: "tool",
      id: "tool-1",
      toolCallId: "call-1",
      toolName: "read",
      display: "path: example.ts",
      details: "contents",
      status: "success",
    });
    const app = await testRender(
      () => (
        <ToastProvider>
          <AppContext.Provider value={appState}>
            <ChatBlockView
              block={appState.state.blocks[0]}
              activeProfile="default"
              hideThinking={() => false}
              approvalOptionIndex={() => 0}
              elicitationOptionIndex={() => 0}
              getSpinnerChar={() => "⠋"}
              pluginRunner={() => null}
              selectElicitationChoice={(_app, _block: ElicitationBlock) => {}}
            />
          </AppContext.Provider>
        </ToastProvider>
      ),
      { width: 80, height: 8 },
    );

    try {
      await app.renderOnce();
      const row = app.renderer.root.findDescendantById(
        `${TRANSCRIPT_NAV_BLOCK_ID_PREFIX}tool-1`,
      ) as BoxRenderable | null;
      expect(row).not.toBeNull();
      const backgroundBefore = row!.backgroundColor.toString();
      await app.mockMouse.click(row!.x + 1, row!.y);
      await app.flush();
      expect(appState.state.transcriptSelectedBlockId).toBe("tool-1");
      expect(row!.backgroundColor.toString()).toBe(
        parseColor(blendHexColors(getColors().bg, getColors().fg, 0.05)).toString(),
      );
      expect(row!.backgroundColor.toString()).not.toBe(backgroundBefore);
    } finally {
      app.renderer.destroy();
    }
  });

  test("opens transcript details when a block is double-clicked", async () => {
    const appState = createAppStateValue(process.cwd());
    appState.addBlock({
      type: "tool",
      id: "tool-double-click",
      toolCallId: "call-double-click",
      toolName: "read",
      display: "path: example.ts",
      details: "contents",
      status: "success",
    });
    const app = await testRender(
      () => (
        <ToastProvider>
          <AppContext.Provider value={appState}>
            <ChatBlockView
              block={appState.state.blocks[0]}
              activeProfile="default"
              hideThinking={() => false}
              approvalOptionIndex={() => 0}
              elicitationOptionIndex={() => 0}
              getSpinnerChar={() => "⠋"}
              pluginRunner={() => null}
              selectElicitationChoice={(_app, _block: ElicitationBlock) => {}}
            />
          </AppContext.Provider>
        </ToastProvider>
      ),
      { width: 80, height: 8 },
    );

    try {
      await app.renderOnce();
      const row = app.renderer.root.findDescendantById(
        `${TRANSCRIPT_NAV_BLOCK_ID_PREFIX}tool-double-click`,
      ) as BoxRenderable | null;
      expect(row).not.toBeNull();

      await app.mockMouse.doubleClick(row!.x + 1, row!.y);
      await app.flush();

      expect(appState.state.transcriptSelectedBlockId).toBe("tool-double-click");
      expect(appState.state.transcriptDetailBlockId).toBe("tool-double-click");
    } finally {
      app.renderer.destroy();
    }
  });

  test("toggles a tool-call group when its header is double-clicked", async () => {
    const appState = createAppStateValue(process.cwd());
    const firstBlock: ToolBlock = {
      type: "tool",
      id: "grouped-tool-1",
      toolCallId: "grouped-call-1",
      toolName: "read",
      display: "first",
      status: "success",
    };
    const secondBlock: ToolBlock = {
      type: "tool",
      id: "grouped-tool-2",
      toolCallId: "grouped-call-2",
      toolName: "read",
      display: "second",
      status: "success",
    };
    const group: ToolCallGroup = {
      id: "tool-call-group:grouped-tool-1",
      firstBlockId: firstBlock.id,
      memberIds: [firstBlock.id, secondBlock.id],
      members: [firstBlock, secondBlock],
      summary: "Read 2 files",
    };
    const app = await testRender(
      () => (
        <ToastProvider>
          <AppContext.Provider value={appState}>
            <ToolCallGroupHeader
              group={group}
              firstBlock={firstBlock}
              expanded={() => appState.state.expandedToolCallGroups[group.id] === true}
            />
          </AppContext.Provider>
        </ToastProvider>
      ),
      { width: 80, height: 8 },
    );

    try {
      await app.renderOnce();
      const row = app.renderer.root.findDescendantById(
        `${TRANSCRIPT_NAV_BLOCK_ID_PREFIX}${group.id}`,
      ) as BoxRenderable | null;
      expect(row).not.toBeNull();

      await app.mockMouse.doubleClick(row!.x + 1, row!.y);
      await app.flush();

      expect(appState.state.expandedToolCallGroups[group.id]).toBe(true);
      expect(appState.state.transcriptDetailBlockId).toBeNull();
    } finally {
      app.renderer.destroy();
    }
  });

  test("uses one shared gap between user and assistant blocks", async () => {
    const appState = createAppStateValue(process.cwd());
    appState.addBlock({ type: "user", id: "user-1", content: "question" });
    appState.addBlock({ type: "content", id: "content-1", content: "answer", finalized: true });
    const app = await testRender(
      () => (
        <ToastProvider>
          <AppContext.Provider value={appState}>
            <box flexDirection="column">
              <ChatBlockView
                block={appState.state.blocks[0]}
                activeProfile="default"
                hideThinking={() => false}
                approvalOptionIndex={() => 0}
                elicitationOptionIndex={() => 0}
                getSpinnerChar={() => "⠋"}
                pluginRunner={() => null}
                selectElicitationChoice={(_app, _block: ElicitationBlock) => {}}
              />
              <ChatBlockView
                block={appState.state.blocks[1]}
                prevBlock={appState.state.blocks[0]}
                activeProfile="default"
                hideThinking={() => false}
                approvalOptionIndex={() => 0}
                elicitationOptionIndex={() => 0}
                getSpinnerChar={() => "⠋"}
                pluginRunner={() => null}
                selectElicitationChoice={(_app, _block: ElicitationBlock) => {}}
              />
            </box>
          </AppContext.Provider>
        </ToastProvider>
      ),
      { width: 80, height: 12 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      const userFrame = app.renderer.root.findDescendantById(`${TRANSCRIPT_NAV_BLOCK_ID_PREFIX}user-1`);
      const contentFrame = app.renderer.root.findDescendantById(`${TRANSCRIPT_NAV_BLOCK_ID_PREFIX}content-1`);
      const markdown = findMarkdownRenderable(contentFrame!);
      expect(userFrame).not.toBeNull();
      expect(contentFrame).not.toBeNull();
      expect(contentFrame!.y).toBe(userFrame!.y + userFrame!.height + 1);
      expect(markdown?.y).toBe(contentFrame!.y);
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps header-only tools compact and spaces multiline tool output", async () => {
    const appState = createAppStateValue(process.cwd());
    appState.addBlock({
      type: "tool",
      id: "compact-1",
      toolCallId: "compact-call-1",
      toolName: "custom",
      display: "first",
      status: "success",
    });
    appState.addBlock({
      type: "tool",
      id: "compact-2",
      toolCallId: "compact-call-2",
      toolName: "custom",
      display: "second",
      status: "success",
    });
    appState.addBlock({
      type: "tool",
      id: "multiline",
      toolCallId: "multiline-call",
      toolName: "custom",
      display: "multiline",
      details: "line one\nline two",
      status: "success",
    });
    appState.addBlock({
      type: "tool",
      id: "compact-3",
      toolCallId: "compact-call-3",
      toolName: "custom",
      display: "third",
      status: "success",
    });
    appState.addBlock({ type: "content", id: "content-after-tools", content: "answer", finalized: true });
    const view = (index: number) => (
      <ChatBlockView
        block={appState.state.blocks[index]}
        prevBlock={appState.state.blocks[index - 1]}
        activeProfile="default"
        hideThinking={() => false}
        approvalOptionIndex={() => 0}
        elicitationOptionIndex={() => 0}
        getSpinnerChar={() => "⠋"}
        pluginRunner={() => null}
        selectElicitationChoice={(_app, _block: ElicitationBlock) => {}}
      />
    );
    const app = await testRender(
      () => (
        <ToastProvider>
          <AppContext.Provider value={appState}>
            <box flexDirection="column">
              {view(0)}
              {view(1)}
              {view(2)}
              {view(3)}
              {view(4)}
            </box>
          </AppContext.Provider>
        </ToastProvider>
      ),
      { width: 80, height: 20 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      const frame = (id: string) => app.renderer.root.findDescendantById(`${TRANSCRIPT_NAV_BLOCK_ID_PREFIX}${id}`)!;
      const first = frame("compact-1");
      const second = frame("compact-2");
      const multiline = frame("multiline");
      const third = frame("compact-3");
      const content = frame("content-after-tools");
      expect(second.y).toBe(first.y + first.height);
      expect(multiline.y).toBe(second.y + second.height + 1);
      expect(third.y).toBe(multiline.y + multiline.height + 1);
      expect(content.y).toBe(third.y + third.height + 1);

      appState.updateBlock("multiline", { details: "one\ntwo\nthree" });
      await app.renderer.idle();
      await app.flush();

      expect(frame("multiline")).toBe(multiline);
      const detached = [...Renderable.renderablesByNumber.values()].filter(
        (renderable) => renderable.ctx === app.renderer && !renderable.parent && renderable !== app.renderer.root,
      );
      expect(detached).toEqual([]);
    } finally {
      app.renderer.destroy();
    }
  });

  test("recomputes compact spacing when a tool row is inserted and removed", async () => {
    const appState = createAppStateValue(process.cwd());
    const tool = (id: string, details?: string): ToolBlock => ({
      type: "tool",
      id,
      toolCallId: id,
      toolName: "custom",
      display: id,
      status: "success",
      details,
    });
    appState.addBlock(tool("first"));
    appState.addBlock(tool("last"));
    const app = await testRender(
      () => (
        <ToastProvider>
          <AppContext.Provider value={appState}>
            <box flexDirection="column">
              <For each={appState.state.blocks}>
                {(block, index) => (
                  <ChatBlockView
                    block={block}
                    prevBlock={appState.state.blocks[index() - 1]}
                    activeProfile="default"
                    hideThinking={() => false}
                    approvalOptionIndex={() => 0}
                    elicitationOptionIndex={() => 0}
                    getSpinnerChar={() => "⠋"}
                    pluginRunner={() => null}
                    selectElicitationChoice={(_app, _block: ElicitationBlock) => {}}
                  />
                )}
              </For>
            </box>
          </AppContext.Provider>
        </ToastProvider>
      ),
      { width: 80, height: 20 },
    );
    const frame = (id: string) => app.renderer.root.findDescendantById(`${TRANSCRIPT_NAV_BLOCK_ID_PREFIX}${id}`)!;
    const gapAfter = (above: string, below: string) => frame(below).y - frame(above).y - frame(above).height;

    try {
      await app.renderOnce();
      expect(gapAfter("first", "last")).toBe(0);

      appState.insertBlock(1, tool("middle", "line one\nline two"));
      await app.renderer.idle();
      expect(gapAfter("first", "middle")).toBe(1);
      expect(gapAfter("middle", "last")).toBe(1);

      appState.removeBlock("middle");
      await app.renderer.idle();
      expect(gapAfter("first", "last")).toBe(0);

      // Same child count, different children: the cached sibling index must not be reused.
      appState.replaceBlocks([tool("first"), tool("swapped", "line one\nline two")]);
      await app.renderOnce();
      appState.replaceBlocks([tool("first"), tool("last")]);
      await app.renderOnce();
      expect(gapAfter("first", "last")).toBe(0);

      // One sibling index per parent per frame, not one getChildren() copy per row.
      for (let index = 0; index < 20; index++) appState.addBlock(tool(`row-${index}`));
      await app.renderOnce();
      const parent = frame("first").parent!;
      const getChildren = parent.getChildren.bind(parent);
      let copies = 0;
      parent.getChildren = () => (copies++, getChildren());
      await app.renderOnce();
      expect(copies).toBe(1);
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps finalized thinking collapsed when a row is selected", async () => {
    const appState = createAppStateValue(process.cwd());
    appState.addBlock({ type: "thinking", id: "thinking-1", content: "", finalized: false });
    const app = await testRender(
      () => (
        <ToastProvider>
          <AppContext.Provider value={appState}>
            <box paddingTop={1} paddingBottom={1}>
              <ChatBlockView
                block={appState.state.blocks[0]}
                activeProfile="default"
                hideThinking={() => false}
                approvalOptionIndex={() => 0}
                elicitationOptionIndex={() => 0}
                getSpinnerChar={() => "⠋"}
                pluginRunner={() => null}
                selectElicitationChoice={(_app, _block: ElicitationBlock) => {}}
              />
            </box>
          </AppContext.Provider>
        </ToastProvider>
      ),
      { width: 80, height: 8 },
    );

    try {
      await app.renderOnce();
      expect(findMarkdownRenderable(app.renderer.root)).toBeNull();

      appState.updateBlock("thinking-1", {
        content: "First thought\nSecond thought\nThird thought",
        finalized: true,
      });
      await app.renderOnce();
      await app.flush();

      expect(findMarkdownRenderable(app.renderer.root)?.content).toContain("First thought");

      const frameId = `${TRANSCRIPT_NAV_BLOCK_ID_PREFIX}thinking-1`;
      const frame = app.renderer.root.findDescendantById(frameId);
      expect(frame).toBeDefined();
      appState.setState("transcriptSelectedRows", "thinking-1", true);
      appState.setState("transcriptSelectedBlockId", "thinking-1");
      await app.renderOnce();
      await app.flush();
      expect(app.renderer.root.findDescendantById(frameId)).toBe(frame);
      expect(frame!.height).toBe(1);
      const rows = app.captureCharFrame().split("\n");
      expect(rows[frame!.y]?.[frame!.x]).toBe("▏");
    } finally {
      app.renderer.destroy();
    }
  });

  test("does not rebuild Markdown when an active content block is finalized", async () => {
    const { app, appState } = await renderContentBlock(false);

    try {
      const markdown = findMarkdownRenderable(app.renderer.root);
      const children = markdown?.getChildren();
      expect(markdown?.streaming).toBe(true);

      appState.updateBlock("content-1", { finalized: true });
      await app.renderOnce();
      await app.flush();

      expect(findMarkdownRenderable(app.renderer.root)).toBe(markdown);
      expect(markdown?.getChildren()).toEqual(children);
      expect(markdown?.streaming).toBe(true);
      expect(markdown?.internalBlockMode).toBe("top-level");
    } finally {
      app.renderer.destroy();
    }
  });
});
