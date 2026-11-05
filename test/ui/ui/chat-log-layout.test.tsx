import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { getConfig, resetConfig } from "../../../src/config";
import { ChatBlockView } from "../../../src/ui/component/blocks/chat-block";
import { ChatLog } from "../../../src/ui/component/chat-log";
import { WelcomeScreen } from "../../../src/ui/component/welcome-screen";
import { createAppStateValue } from "../../../src/ui/context/app-state";
import { AppContext } from "../../../src/ui/state";
import { ToastProvider } from "../../../src/ui/ui/toast";
import type { ChatBlock, ElicitationBlock, UserBlock } from "../../../src/ui/state";
import type { ThreadInfo } from "../../../src/core/threads";
import { store } from "../../../src/ui/app/runtime-store";

const PROMPT_MARKER = "PROMPT_MARKER";

function makeUserBlock(id: string, content: string): UserBlock {
  return { type: "user", id, content };
}

function thread(id: string): ThreadInfo {
  return {
    id,
    title: id,
    sessionId: null,
    cwd: process.cwd(),
    workspaceKind: "local",
    status: "paused",
    archived: false,
  };
}

function renderChatBlock(block: ChatBlock, prevBlock: ChatBlock | undefined) {
  return (
    <ChatBlockView
      block={block}
      prevBlock={prevBlock}
      activeProfile="default"
      hideThinking={() => false}
      approvalOptionIndex={() => 0}
      elicitationOptionIndex={() => 0}
      getSpinnerChar={() => "⠋"}
      pluginRunner={() => null}
      selectElicitationChoice={(_app, _block: ElicitationBlock) => {}}
    />
  );
}

afterEach(() => {
  resetConfig();
  store.threadTranscriptViews.clear();
});

describe("chat log layout", () => {
  test("renders generic plugin warning blocks as warnings", async () => {
    const contextValue = createAppStateValue(process.cwd());
    const block: ChatBlock = {
      type: "plugin",
      id: "plugin-warning",
      pluginId: "bundled:example",
      pluginName: "example",
      blockType: "warning",
      content: "Cannot run the example action while the agent is running.",
    };

    const app = await testRender(
      () => (
        <ToastProvider>
          <AppContext.Provider value={contextValue}>{renderChatBlock(block, undefined)}</AppContext.Provider>
        </ToastProvider>
      ),
      { width: 70, height: 5, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();

      expect(app.captureCharFrame()).toContain("⚠ Cannot run the example action while the agent is running.");
    } finally {
      app.renderer.destroy();
    }
  });

  // Regression: ChatLog's root box must absorb the slack in chat.tsx's flex
  // filler column so a sibling prompt stays pinned to the bottom, even when the
  // transcript is far shorter than the viewport. See chat.tsx where ChatLog and
  // Prompt are siblings inside a single flexGrow column.
  test("pins a sibling prompt to the bottom with a near-empty transcript", async () => {
    const height = 20;
    const contextValue = createAppStateValue(process.cwd());
    contextValue.setState("blocks", [makeUserBlock("u1", "hello")]);

    const app = await testRender(
      () => (
        <ToastProvider>
          <AppContext.Provider value={contextValue}>
            <box flexDirection="column" width={40} height={height} minHeight={0}>
              <box flexDirection="column" flexGrow={1} flexShrink={1}>
                <ChatLog
                  welcomeDismissed={() => true}
                  renderBlock={(block, prevBlock) => renderChatBlock(block, prevBlock)}
                  availableWidth={() => 40}
                />
                <box height={1}>
                  <text>{PROMPT_MARKER}</text>
                </box>
              </box>
            </box>
          </AppContext.Provider>
        </ToastProvider>
      ),
      { width: 40, height, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();

      const rows = app.captureCharFrame().split("\n");
      const promptRow = rows.findIndex((row) => row.includes(PROMPT_MARKER));
      expect(promptRow).toBe(height - 1);
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps welcome content clipped below the editor chrome", async () => {
    const height = 14;
    const contextValue = createAppStateValue(process.cwd());

    const app = await testRender(
      () => (
        <ToastProvider>
          <AppContext.Provider value={contextValue}>
            <box flexDirection="column" width={40} height={height} minHeight={0}>
              <WelcomeScreen />
              <box height={2} flexShrink={0}>
                <text>EDITOR_HEADER</text>
              </box>
              <box height={2} flexShrink={0}>
                <text>COMPOSER</text>
              </box>
              <box height={2} flexShrink={0}>
                <text>EDITOR_FOOTER</text>
              </box>
            </box>
          </AppContext.Provider>
        </ToastProvider>
      ),
      { width: 40, height, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();

      const rows = app.captureCharFrame().split("\n");
      expect(rows.findIndex((row) => row.includes("EDITOR_HEADER"))).toBe(height - 6);
      expect(rows.findIndex((row) => row.includes("COMPOSER"))).toBe(height - 4);
      expect(rows.findIndex((row) => row.includes("EDITOR_FOOTER"))).toBe(height - 2);
      expect(rows.slice(height - 6).join("\n")).not.toContain("░");
    } finally {
      app.renderer.destroy();
    }
  });

  test("expands grouped tools as normal icon-bearing rows without extra indentation", async () => {
    const grouping = getConfig().ui.tool_call_groups;
    grouping.enabled = true;
    grouping.rules = [{ tool_names: ["read"], singular: "Read {count} file", plural: "Read {count} files" }];
    const contextValue = createAppStateValue(process.cwd());
    const blocks: ChatBlock[] = [
      {
        type: "tool",
        id: "read-1",
        toolCallId: "call-read-1",
        toolName: "read",
        display: "read one",
        status: "success",
        rawInput: { path: "one.ts" },
      },
      {
        type: "tool",
        id: "read-2",
        toolCallId: "call-read-2",
        toolName: "read",
        display: "read two",
        status: "success",
        rawInput: { path: "two.ts" },
      },
    ];
    const answer: ChatBlock = { type: "content", id: "answer", content: "done", finalized: true };
    contextValue.setState("blocks", [blocks[0]]);

    const app = await testRender(
      () => (
        <ToastProvider>
          <AppContext.Provider value={contextValue}>
            <ChatLog
              welcomeDismissed={() => true}
              renderBlock={(block, prevBlock) => renderChatBlock(block, prevBlock)}
              availableWidth={() => 70}
            />
          </AppContext.Provider>
        </ToastProvider>
      ),
      { width: 70, height: 10, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      expect(app.captureCharFrame()).toContain("→ read one.ts");
      expect(app.captureCharFrame()).not.toContain("Read 2 files");

      contextValue.setState("running", true);
      contextValue.setState("blocks", blocks);
      await app.renderOnce();
      await app.flush();
      expect(app.captureCharFrame()).toContain("→ read one.ts");
      expect(app.captureCharFrame()).toContain("→ read two.ts");
      expect(app.captureCharFrame()).not.toContain("Read 2 files");

      contextValue.setState("running", false);
      await app.renderOnce();
      await app.flush();
      expect(app.captureCharFrame()).toContain("→ read one.ts");
      expect(app.captureCharFrame()).toContain("→ read two.ts");
      expect(app.captureCharFrame()).not.toContain("Read 2 files");

      contextValue.setState("blocks", [...blocks, answer]);
      await app.renderOnce();
      await app.flush();
      expect(app.captureCharFrame()).toContain("⊞ Read 2 files");
      expect(app.captureCharFrame()).not.toContain("→ read");

      contextValue.setState("expandedToolCallGroups", "tool-call-group:read-1", true);
      await app.renderOnce();
      await app.flush();
      const rows = app.captureCharFrame().split("\n");
      const summary = rows.find((row) => row.includes("Read 2 files"));
      const tools = rows.filter((row) => row.includes("→ read"));
      expect(summary).toBeDefined();
      expect(tools).toHaveLength(2);
      expect(tools.every((row) => row.indexOf("→") === summary!.indexOf("⊟"))).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  });

  test("preserves canonical prevBlock across indexed page boundaries on the legacy renderer", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const blocks: ChatBlock[] = Array.from({ length: 40 }, (_, index) =>
      index % 2 === 0
        ? makeUserBlock(`u-${index}`, `prompt ${index}`)
        : { type: "content", id: `c-${index}`, content: `answer ${index}`, finalized: true },
    );
    contextValue.setActiveThreadState(thread("thread-paged"), blocks);
    const pages = store.threadTranscriptViews.get("thread-paged")?.pageIndex.pages() ?? [];
    expect(pages.length).toBeGreaterThan(1);
    const secondPageFirstId = pages[1].blockIds[0];
    const secondPageFirstIndex = blocks.findIndex((block) => block.id === secondPageFirstId);
    const expectedPreviousId = blocks[secondPageFirstIndex - 1]?.id;
    const renderedPairs: string[] = [];

    const app = await testRender(
      () => (
        <ToastProvider>
          <AppContext.Provider value={contextValue}>
            <ChatLog
              welcomeDismissed={() => true}
              renderBlock={(block, prevBlock) => {
                renderedPairs.push(`${block.id}|prev:${prevBlock?.id ?? "none"}`);
                return <text>{block.id}</text>;
              }}
              availableWidth={() => 80}
            />
          </AppContext.Provider>
        </ToastProvider>
      ),
      { width: 80, height: 12, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();

      expect(renderedPairs).toContain(`${secondPageFirstId}|prev:${expectedPreviousId}`);
    } finally {
      app.renderer.destroy();
    }
  });
});
