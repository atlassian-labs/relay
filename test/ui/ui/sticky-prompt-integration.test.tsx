import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createTextAttributes, parseColor, type ScrollBoxRenderable } from "@opentui/core";
import { Config, resetConfig, setConfig } from "../../../src/config";
import { PluginRunner } from "../../../src/plugins";
import type { RelayPluginInfo } from "../../../src/plugins";
import { ChatBlockView } from "../../../src/ui/component/blocks/chat-block";
import { ChatLog } from "../../../src/ui/component/chat-log";
import { createAppStateValue } from "../../../src/ui/context/app-state";
import { getColors } from "../../../src/ui/context/theme";
import { AppContext } from "../../../src/ui/state";
import { ToastProvider } from "../../../src/ui/ui/toast";
import type { ChatBlock, ElicitationBlock, UserBlock } from "../../../src/ui/state";
import { USER_BLOCK_ID_PREFIX } from "../../../src/ui/util/sticky-prompt";

const TEST_PLUGIN: RelayPluginInfo = {
  id: "test-plugin",
  name: "Test plugin",
  path: "/tmp/test-plugin",
};

function makeUserBlock(id: string, content: string): UserBlock {
  return { type: "user", id, content };
}

function makeContentBlock(id: string, lineCount: number): ChatBlock {
  return {
    type: "content",
    id,
    finalized: true,
    content: Array.from({ length: lineCount }, (_, i) => `content ${id} line ${i + 1}`).join("\n"),
  };
}

function renderChatBlock(block: ChatBlock, prevBlock: ChatBlock | undefined, pluginRunner?: PluginRunner | null) {
  return (
    <ChatBlockView
      block={block}
      prevBlock={prevBlock}
      activeProfile="default"
      hideThinking={() => false}
      approvalOptionIndex={() => 0}
      elicitationOptionIndex={() => 0}
      getSpinnerChar={() => "⠋"}
      pluginRunner={() => pluginRunner ?? null}
      selectElicitationChoice={(_app, _block: ElicitationBlock) => {}}
    />
  );
}

afterEach(() => {
  resetConfig();
});

describe("sticky prompt integration", () => {
  test("tags plugin-rendered user messages for sticky prompt lookup", async () => {
    const runner = new PluginRunner({ cwd: process.cwd() });
    runner.renderers.registerMessageRenderer(TEST_PLUGIN, {
      blockTypes: ["user"],
      render: () => ({
        marginTop: 0,
        paddingLeft: 0,
        paddingRight: 0,
        lines: [{ text: "plugin-rendered user prompt" }],
      }),
    });

    const contextValue = createAppStateValue(process.cwd());
    const block = makeUserBlock("u-plugin", "raw user prompt");
    const app = await testRender(
      () => (
        <ToastProvider>
          <AppContext.Provider value={contextValue}>{renderChatBlock(block, undefined, runner)}</AppContext.Provider>
        </ToastProvider>
      ),
      { width: 80, height: 8, targetFps: 30 },
    );

    try {
      await app.renderOnce();

      expect(app.captureCharFrame()).toContain("plugin-rendered user prompt");
      expect(app.renderer.root.findDescendantById(`${USER_BLOCK_ID_PREFIX}${block.id}`)).toBeDefined();
    } finally {
      runner.dispose();
      app.renderer.destroy();
    }
  });

  test("renders plugin message strikethrough as native text attributes", async () => {
    const runner = new PluginRunner({ cwd: process.cwd() });
    runner.renderers.registerMessageRenderer(TEST_PLUGIN, {
      blockTypes: ["user"],
      render: () => ({
        marginTop: 0,
        paddingLeft: 0,
        paddingRight: 0,
        lines: [
          { text: "WHOLE", strikethrough: true },
          {
            text: "DONE OPEN",
            segments: [{ text: "DONE", strikethrough: true }, { text: " OPEN" }],
          },
        ],
      }),
    });

    const contextValue = createAppStateValue(process.cwd());
    const block = makeUserBlock("u-strikethrough", "raw user prompt");
    const app = await testRender(
      () => (
        <ToastProvider>
          <AppContext.Provider value={contextValue}>{renderChatBlock(block, undefined, runner)}</AppContext.Provider>
        </ToastProvider>
      ),
      { width: 80, height: 8, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      const spans = app.captureSpans().lines.flatMap((line) => line.spans);
      const wholeSpan = spans.find((span) => span.text === "WHOLE");
      const doneSpan = spans.find((span) => span.text === "DONE");
      const openSpan = spans.find((span) => span.text === " OPEN");

      expect(wholeSpan?.attributes).toBe(createTextAttributes({ strikethrough: true }));
      expect(doneSpan?.attributes).toBe(createTextAttributes({ strikethrough: true }));
      expect(openSpan?.attributes).toBe(createTextAttributes());
    } finally {
      runner.dispose();
      app.renderer.destroy();
    }
  });

  test("fills remaining column space for short conversations", async () => {
    const contextValue = createAppStateValue(process.cwd());
    contextValue.setState("blocks", [makeUserBlock("u-short", "short prompt")]);

    let scrollBox: ScrollBoxRenderable | null = null;
    const app = await testRender(
      () => (
        <ToastProvider>
          <AppContext.Provider value={contextValue}>
            <box flexDirection="column" width="100%" height="100%">
              <ChatLog
                welcomeDismissed={() => true}
                renderBlock={(block, prevBlock) => renderChatBlock(block, prevBlock)}
                onScrollBoxRef={(ref) => {
                  scrollBox = ref;
                }}
                availableWidth={() => 40}
              />
              <text>{"prompt sentinel"}</text>
            </box>
          </AppContext.Provider>
        </ToastProvider>
      ),
      { width: 40, height: 8, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      expect(scrollBox).not.toBeNull();
      expect(scrollBox!.height).toBe(7);

      const frameLines = app.captureCharFrame().split("\n");
      expect(frameLines[7]).toContain("prompt sentinel");
    } finally {
      app.renderer.destroy();
    }
  });

  test("renders a sticky header for scrolled user prompts", async () => {
    setConfig(
      new Config({
        ui: { sticky_prompt_header_lines: 2 },
      }),
    );

    const contextValue = createAppStateValue(process.cwd());
    const blocks: ChatBlock[] = [
      makeUserBlock("u1", "First sticky prompt\nextra first line"),
      makeContentBlock("c1", 18),
      makeUserBlock("u2", "Second sticky prompt"),
      makeContentBlock("c2", 18),
    ];
    contextValue.setState("blocks", blocks);

    let scrollBox: ScrollBoxRenderable | null = null;
    const app = await testRender(
      () => (
        <ToastProvider>
          <AppContext.Provider value={contextValue}>
            <ChatLog
              welcomeDismissed={() => true}
              renderBlock={(block, prevBlock) => renderChatBlock(block, prevBlock)}
              onScrollBoxRef={(ref) => {
                scrollBox = ref;
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
      expect(scrollBox).not.toBeNull();

      scrollBox!.scrollTop = 6;
      await app.renderOnce();
      await app.flush();

      const stickyPanelBackground = parseColor(getColors().panelAlt).toString();
      const stickyHeaderText = () =>
        app
          .captureSpans()
          .lines.slice(scrollBox!.y, scrollBox!.y + 4)
          .flatMap((line) => line.spans)
          .filter((span) => span.bg.toString() === stickyPanelBackground)
          .map((span) => span.text)
          .join("");
      expect(stickyHeaderText()).toContain("First sticky prompt");
      expect(app.renderer.root.findDescendantById(`${USER_BLOCK_ID_PREFIX}u1`)).toBeDefined();

      // Streaming more blocks must reuse the mounted lookup instead of walking the transcript tree.
      const content = scrollBox!.content;
      const findDescendantById = content.findDescendantById.bind(content);
      let treeWalks = 0;
      content.findDescendantById = (id: string) => (treeWalks++, findDescendantById(id));
      for (let index = 0; index < 3; index++) {
        contextValue.appendBlock(makeContentBlock(`streamed-${index}`, 2));
        await app.renderOnce();
      }
      await app.flush();
      expect(treeWalks).toBe(0);
      expect(stickyHeaderText()).toContain("First sticky prompt");
    } finally {
      app.renderer.destroy();
    }
  });
});
