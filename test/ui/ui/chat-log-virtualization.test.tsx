import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createMockMouse } from "@opentui/core/testing";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ThreadInfo } from "../../../src/core/threads";
import { Config, resetConfig, setConfig } from "../../../src/config";
import { ChatLog, TRANSCRIPT_PAGE_ID_PREFIX, TRANSCRIPT_SPACER_ID_PREFIX } from "../../../src/ui/component/chat-log";
import { createAppStateValue } from "../../../src/ui/context/app-state";
import { AppContext, type ChatBlock } from "../../../src/ui/state";
import { store } from "../../../src/ui/app/runtime-store";
import type { TranscriptSelectionCoordinator } from "../../../src/ui/util/transcript-selection";
import { TRANSCRIPT_NAV_BLOCK_ID_PREFIX, USER_BLOCK_ID_PREFIX } from "../../../src/ui/util/sticky-prompt";

function thread(id = "windowed-thread"): ThreadInfo {
  return {
    id,
    title: "Windowed",
    sessionId: null,
    cwd: process.cwd(),
    workspaceKind: "local",
    status: "paused",
    archived: false,
  };
}

/**
 * Advances enough render and flush cycles for window measurement and reconciliation to settle.
 *
 * @param app - Test renderer controls used to advance frames and queued work.
 * @param frames - Number of render and flush cycles to execute.
 * @returns A promise that resolves after all requested cycles complete.
 */
async function settleWindowedRender(
  app: { renderOnce: () => Promise<void>; flush: () => Promise<void> },
  frames = 6,
): Promise<void> {
  for (let index = 0; index < frames; index += 1) {
    await app.renderOnce();
    await app.flush();
  }
}

function blocks(count: number): ChatBlock[] {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? ({ type: "user", id: `u-${index}`, content: `prompt ${index}` } as const)
      : ({ type: "content", id: `c-${index}`, content: `answer ${index}`, finalized: true } as const),
  );
}

afterEach(() => {
  resetConfig();
  store.threadTranscriptViews.clear();
});

describe("windowed chat log", () => {
  test("mounts a bounded page window and aggregates off-window spacer runs", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript = blocks(2_000);
    contextValue.setActiveThreadState(thread(), transcript);
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    const indexedPages = view.pageIndex.pages();
    expect(indexedPages.length).toBeGreaterThan(20);

    let scrollBox: ScrollBoxRenderable | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onScrollBoxRef={(value) => {
              scrollBox = value;
            }}
            renderBlock={(block) => (
              <box id={`block:${block.id}`} height={1}>
                <text>{block.id}</text>
              </box>
            )}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      expect(scrollBox).not.toBeNull();
      expect(scrollBox!.content.getChildrenCount()).toBeLessThan(12);
      expect(scrollBox!.content.getChildren().some((child) => child.id.startsWith(TRANSCRIPT_SPACER_ID_PREFIX))).toBe(
        true,
      );
      expect(
        app.renderer.root.findDescendantById(`${TRANSCRIPT_PAGE_ID_PREFIX}${indexedPages.at(-1)!.id}`),
      ).toBeDefined();
      expect(app.renderer.root.findDescendantById("block:c-1999")).toBeDefined();
      expect(view.pageIndex.pages().at(-1)?.measurement).toBeDefined();
      const measurementGeneration = view.measurementGeneration;
      await app.renderOnce();
      await app.renderOnce();
      expect(view.measurementGeneration).toBe(measurementGeneration);
      scrollBox!.scrollTop = 0;
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();

      expect(app.renderer.root.findDescendantById(`${TRANSCRIPT_PAGE_ID_PREFIX}${indexedPages[0].id}`)).toBeDefined();
      expect(app.renderer.root.findDescendantById("block:u-0")).toBeDefined();
      expect(scrollBox!.content.getChildrenCount()).toBeLessThan(12);
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps a streaming tail mounted without pulling a scrolled-away viewport back to the bottom", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript = blocks(200);
    const tail = transcript.at(-1)!;
    if (tail.type !== "content") throw new Error("expected a content tail");
    tail.finalized = false;
    contextValue.setActiveThreadState(thread(), transcript);
    contextValue.setCurrentBlockId(tail.id);
    let scrollBox: ScrollBoxRenderable | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onScrollBoxRef={(value) => {
              scrollBox = value;
            }}
            renderBlock={(block) => (
              <text id={`stream:${block.id}`}>{"content" in block ? block.content : block.id}</text>
            )}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      expect(scrollBox).not.toBeNull();
      scrollBox!.scrollTop = 0;
      await app.renderOnce();
      for (const suffix of [" one", " two", " three"]) {
        contextValue.appendToBlock(tail.id, suffix);
        await app.renderOnce();
        expect(scrollBox!.scrollTop).toBe(0);
        expect(app.renderer.root.findDescendantById(`stream:${tail.id}`)).toBeDefined();
      }
      expect(contextValue.state.blocks.at(-1)).toMatchObject({ content: "answer 199 one two three" });

      scrollBox!.scrollTop = scrollBox!.scrollHeight;
      await app.renderOnce();
      expect(app.captureCharFrame()).toContain("answer 199 one two three");
    } finally {
      app.renderer.destroy();
    }
  });

  test("reopens an off-screen finalized page before rendering its mutation", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript = blocks(200);
    contextValue.setActiveThreadState(thread(), transcript);
    const firstPage = store.threadTranscriptViews.get("windowed-thread")!.pageIndex.pages()[0];
    let historicalMountCount = 0;
    let scrollBox: ScrollBoxRenderable | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onScrollBoxRef={(value) => {
              scrollBox = value;
            }}
            renderBlock={(block) => {
              if (block.id === "u-0") historicalMountCount += 1;
              return <text id={`mutable:${block.id}`}>{"content" in block ? block.content : block.id}</text>;
            }}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      expect(scrollBox).not.toBeNull();
      expect(app.renderer.root.findDescendantById(`${TRANSCRIPT_PAGE_ID_PREFIX}${firstPage.id}`)).toBeUndefined();

      contextValue.updateBlock("u-0", { content: "mutated historical prompt" });
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      expect(historicalMountCount).toBeGreaterThan(0);

      scrollBox!.scrollTop = 0;
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      expect(app.captureCharFrame()).toContain("mutated historical prompt");
    } finally {
      app.renderer.destroy();
    }
  });

  test("keys exact measurements to the scroll viewport width", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    contextValue.setActiveThreadState(thread(), blocks(200));
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            renderBlock={(block) => <text>{"content" in block ? block.content.repeat(8) : block.id}</text>}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      const initialEpoch = view.layoutEpoch;
      expect(initialEpoch).toBe(0);
      expect(view.pageIndex.pages().some((page) => page.measurement?.width === 80)).toBe(true);

      app.renderer.resize(50, 20);
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();

      expect(view.layoutEpoch).toBeGreaterThan(initialEpoch);
      expect(
        view.pageIndex
          .pages()
          .filter((page) => page.measurement)
          .every((page) => page.measurement?.width === 50),
      ).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  });

  test("restores independent bottom and scrolled-up positions across thread switches", async () => {
    const firstThread = thread("thread-one");
    const secondThread = thread("thread-two");
    const firstTranscript = blocks(400);
    const secondTranscript = blocks(80).map((block) => ({ ...block, id: `second-${block.id}` })) as ChatBlock[];
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    contextValue.setActiveThreadState(firstThread, firstTranscript);
    const firstView = store.threadTranscriptViews.get(firstThread.id)!;
    let scrollBox: ScrollBoxRenderable | null = null;
    let coordinator: TranscriptSelectionCoordinator | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onScrollBoxRef={(value) => {
              scrollBox = value;
            }}
            onSelectionCoordinatorChange={(value) => {
              coordinator = value;
            }}
            renderBlock={(block) => (
              <box height={1}>
                <text>{block.id}</text>
              </box>
            )}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      expect(scrollBox).not.toBeNull();
      expect(coordinator).not.toBeNull();
      scrollBox!.scrollTop = Math.floor(scrollBox!.scrollHeight / 2);
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      const savedAnchor = firstView.scrollAnchor();
      const savedScrollTop = scrollBox!.scrollTop;
      expect(savedAnchor).not.toBeNull();

      coordinator!.beforeThreadDeactivate(firstThread.id);
      contextValue.setActiveThreadState(secondThread, secondTranscript);
      coordinator!.afterThreadActivate(secondThread.id);
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      expect(scrollBox!.scrollTop).toBeGreaterThanOrEqual(
        Math.max(0, scrollBox!.scrollHeight - scrollBox!.viewport.height - 1),
      );

      coordinator!.beforeThreadDeactivate(secondThread.id);
      contextValue.setActiveThreadState(firstThread, firstTranscript);
      coordinator!.afterThreadActivate(firstThread.id);
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();

      expect(firstView.scrollAnchor()?.pageId).toBe(savedAnchor!.pageId);
      expect(Math.abs(scrollBox!.scrollTop - savedScrollTop)).toBeLessThanOrEqual(1);
    } finally {
      app.renderer.destroy();
    }
  });

  test("resets geometry and sticky caches when equal-sized thread indexes switch", async () => {
    setConfig(new Config({ ui: { sticky_prompt_header_lines: 2 } }));
    const firstThread = thread("equal-thread-one");
    const secondThread = thread("equal-thread-two");
    const firstTranscript = blocks(200);
    const secondTranscript = blocks(200).map((block) => ({
      ...block,
      id: `second-${block.id}`,
      ...(block.type === "user" ? { content: `second prompt ${block.id}` } : {}),
    })) as ChatBlock[];
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    contextValue.setActiveThreadState(firstThread, firstTranscript);
    let scrollBox: ScrollBoxRenderable | null = null;
    let coordinator: TranscriptSelectionCoordinator | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onScrollBoxRef={(value) => {
              scrollBox = value;
            }}
            onSelectionCoordinatorChange={(value) => {
              coordinator = value;
            }}
            renderBlock={(block) => (
              <box id={block.type === "user" ? `${USER_BLOCK_ID_PREFIX}${block.id}` : undefined} height={1}>
                <text id={`equal:${block.id}`}>{"content" in block ? block.content : block.id}</text>
              </box>
            )}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await settleWindowedRender(app);
      expect(coordinator).not.toBeNull();
      coordinator!.beforeThreadDeactivate(firstThread.id);
      contextValue.setActiveThreadState(secondThread, secondTranscript);
      coordinator!.afterThreadActivate(secondThread.id);
      await settleWindowedRender(app);

      expect(app.renderer.root.findDescendantById("equal:second-c-199")).toBeDefined();
      expect(app.renderer.root.findDescendantById("equal:c-199")).toBeUndefined();
      expect(scrollBox).not.toBeNull();
      scrollBox!.scrollTop = Math.floor(scrollBox!.scrollHeight / 2);
      await settleWindowedRender(app);
      expect(app.captureCharFrame()).toContain("second prompt");
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps composer-owned interaction pages within the bounded transcript window", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript = blocks(2_000);
    const interactionIds: string[] = [];
    for (let index = 0; index < 1_600; index += 40) {
      const interactionIndex = index / 40;
      const id = `interaction-${interactionIndex}`;
      interactionIds.push(id);
      transcript[index] =
        interactionIndex % 2 === 0
          ? {
              type: "tool",
              id,
              toolCallId: `call-${interactionIndex}`,
              toolName: "write",
              display: "write file",
              status: "approval",
            }
          : {
              type: "elicitation",
              id,
              mode: "form",
              message: "Choose",
              status: "pending",
              fields: [],
              currentFieldIndex: 0,
              answers: {},
            };
    }
    contextValue.setActiveThreadState(thread(), transcript);
    let scrollBox: ScrollBoxRenderable | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onScrollBoxRef={(value) => {
              scrollBox = value;
            }}
            renderBlock={(block) => <text id={`interactive:${block.id}`}>{block.id}</text>}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      expect(scrollBox).not.toBeNull();
      expect(scrollBox!.content.getChildrenCount()).toBeLessThan(12);
      expect(
        interactionIds.filter((id) => app.renderer.root.findDescendantById(`interactive:${id}`)).length,
      ).toBeLessThan(10);
      expect(
        contextValue.state.blocks.filter(
          (block) =>
            (block.type === "tool" && block.status === "approval") ||
            (block.type === "elicitation" && block.status === "pending"),
        ),
      ).toHaveLength(interactionIds.length);
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps sticky prompt semantics when the source page is virtualized", async () => {
    setConfig(new Config({ ui: { sticky_prompt_header_lines: 2 } }));
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript = blocks(300);
    contextValue.setActiveThreadState(thread(), transcript);
    let scrollBox: ScrollBoxRenderable | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onScrollBoxRef={(value) => {
              scrollBox = value;
            }}
            renderBlock={(block) =>
              block.type === "user" ? (
                <box id={`${USER_BLOCK_ID_PREFIX}${block.id}`} height={1}>
                  <text>{block.content}</text>
                </box>
              ) : (
                <box height={1}>
                  <text>{block.id}</text>
                </box>
              )
            }
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      expect(scrollBox).not.toBeNull();
      scrollBox!.scrollTop = Math.floor(scrollBox!.scrollHeight / 2);
      await settleWindowedRender(app);

      expect(app.captureCharFrame()).toContain("prompt");
      expect(scrollBox!.content.getChildrenCount()).toBeLessThan(12);
    } finally {
      app.renderer.destroy();
    }
  });

  test("mounts and navigates to an unmounted sticky prompt page before releasing its pin", async () => {
    setConfig(new Config({ ui: { sticky_prompt_header_lines: 2 } }));
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript: ChatBlock[] = [
      { type: "user", id: "sticky-target", content: "Target sticky prompt" },
      ...Array.from(
        { length: 4 },
        (_, index): ChatBlock => ({
          type: "content",
          id: `sticky-tall-${index}`,
          content: Array.from({ length: 120 }, (_, line) => `tall ${index}:${line}`).join("\n"),
          finalized: true,
        }),
      ),
      ...Array.from(
        { length: 3 },
        (_, index): ChatBlock => ({
          type: "content",
          id: `sticky-dynamic-${index}`,
          content: Array.from({ length: 120 }, (_, line) => `dynamic ${index}:${line}`).join("\n"),
          finalized: false,
        }),
      ),
      ...blocks(80).map((block) => ({ ...block, id: `after-sticky-${block.id}` }) as ChatBlock),
    ];
    contextValue.setActiveThreadState(thread(), transcript);
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    const targetPage = view.pageIndex.pageForBlock("sticky-target")!;
    let scrollBox: ScrollBoxRenderable | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onScrollBoxRef={(value) => {
              scrollBox = value;
            }}
            renderBlock={(block) =>
              block.id.startsWith("sticky-tall-") || block.id.startsWith("sticky-dynamic-") ? (
                <box height={120}>
                  <text>{block.id}</text>
                </box>
              ) : block.type === "user" ? (
                <box id={`${USER_BLOCK_ID_PREFIX}${block.id}`} height={1}>
                  <text>{block.content}</text>
                </box>
              ) : (
                <box height={1}>
                  <text>{block.id}</text>
                </box>
              )
            }
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await settleWindowedRender(app);
      expect(scrollBox).not.toBeNull();
      scrollBox!.scrollTop = 300;
      await settleWindowedRender(app);
      expect(app.captureCharFrame()).toContain("Target sticky prompt");
      expect(app.renderer.root.findDescendantById(`${USER_BLOCK_ID_PREFIX}sticky-target`)).toBeUndefined();

      await createMockMouse(app.renderer).click(5, 1);
      await settleWindowedRender(app);

      expect(app.renderer.root.findDescendantById(`${USER_BLOCK_ID_PREFIX}sticky-target`)).toBeDefined();
      expect(view.pageIndex.pageById(targetPage.id)?.pinReasons).not.toContain("navigation");
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps keyboard transcript navigation on the selected page", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    contextValue.setActiveThreadState(thread(), blocks(400));
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    const targetPage = view.pageIndex.pages()[Math.floor(view.pageIndex.pages().length / 2)];
    const [firstBlockId, secondBlockId] = targetPage.blockIds;
    expect(firstBlockId).toBeDefined();
    expect(secondBlockId).toBeDefined();
    let scrollBox: ScrollBoxRenderable | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onScrollBoxRef={(value) => {
              scrollBox = value;
            }}
            renderBlock={(block) => (
              <box id={`${TRANSCRIPT_NAV_BLOCK_ID_PREFIX}${block.id}`} height={1}>
                <text>{block.id}</text>
              </box>
            )}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await settleWindowedRender(app);
      expect(scrollBox).not.toBeNull();

      contextValue.setState("transcriptSelectedBlockId", firstBlockId);
      await settleWindowedRender(app);
      expect(scrollBox!.scrollTop).toBeGreaterThan(0);
      expect(view.pageIndex.pageById(targetPage.id)?.pinReasons).toContain("navigation");

      contextValue.setState("transcriptSelectedBlockId", secondBlockId);
      await settleWindowedRender(app);

      const selected = app.renderer.root.findDescendantById(`${TRANSCRIPT_NAV_BLOCK_ID_PREFIX}${secondBlockId}`);
      expect(selected).toBeDefined();
      expect(scrollBox!.scrollTop).toBeGreaterThan(0);
      expect(selected!.y).toBeGreaterThanOrEqual(scrollBox!.viewport.y);
      expect(selected!.y).toBeLessThan(scrollBox!.viewport.y + scrollBox!.viewport.height);
      expect(view.pageIndex.pageById(targetPage.id)?.pinReasons).toContain("navigation");

      contextValue.setState("transcriptSelectedBlockId", null);
      await settleWindowedRender(app);
      expect(view.pageIndex.pages().every((page) => !page.pinReasons.includes("navigation"))).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  });

  test("preserves the anchored page and scroll position when an insertion splits before its anchor", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript: ChatBlock[] = [
      { type: "user", id: "anchor-user", content: "prompt" },
      ...Array.from({ length: 63 }, (_, index) => ({
        type: "content" as const,
        id: `anchor-content-${index}`,
        content: `answer ${index}`,
        finalized: true,
      })),
    ];
    contextValue.setActiveThreadState(thread(), transcript);
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    const originalPageId = view.pageIndex.pageForBlock("anchor-user")!.id;
    let scrollBox: ScrollBoxRenderable | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onScrollBoxRef={(value) => {
              scrollBox = value;
            }}
            renderBlock={(block) => <text>{block.id}</text>}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await settleWindowedRender(app);
      expect(scrollBox).not.toBeNull();
      scrollBox!.scrollTop = 0;
      await settleWindowedRender(app);
      expect(view.scrollAnchor()?.pageId).toBe(originalPageId);

      contextValue.insertBlock(0, { type: "info", id: "inserted-prefix", content: "note", variant: "info" });
      await settleWindowedRender(app);

      expect(view.pageIndex.pageForBlock("anchor-user")?.id).toBe(originalPageId);
      expect(view.pageIndex.pageForBlock("inserted-prefix")?.id).not.toBe(originalPageId);
      expect(view.scrollAnchor()?.pageId).toBe(originalPageId);
      expect(scrollBox!.scrollTop).toBeGreaterThan(0);
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps the visible block anchored when an earlier block splits its page", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript: ChatBlock[] = [
      { type: "user", id: "split-anchor-user", content: "prompt" },
      ...Array.from({ length: 63 }, (_, index) => ({
        type: "content" as const,
        id: `split-content-${index}`,
        content: `answer ${index}`,
        finalized: true,
      })),
    ];
    contextValue.setActiveThreadState(thread(), transcript);
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    let scrollBox: ScrollBoxRenderable | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onScrollBoxRef={(value) => {
              scrollBox = value;
            }}
            renderBlock={(block) => <text>{block.id}</text>}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await settleWindowedRender(app);
      expect(scrollBox).not.toBeNull();
      scrollBox!.scrollTop = 30;
      await settleWindowedRender(app);
      const beforeAnchor = view.scrollAnchor();
      expect(beforeAnchor?.blockId).toBeDefined();
      expect(beforeAnchor?.blockId).not.toBe("split-content-0");

      contextValue.updateBlock("split-content-0", {
        content: Array.from({ length: 200 }, (_, index) => `expanded ${index}`).join("\n"),
      });
      await settleWindowedRender(app);

      const afterAnchor = view.scrollAnchor();
      expect(afterAnchor?.blockId).toBe(beforeAnchor?.blockId);
      expect(afterAnchor?.pageId).toBe(view.pageIndex.pageForBlock(beforeAnchor!.blockId!)?.id);
    } finally {
      app.renderer.destroy();
    }
  });

  test("preserves a surviving block anchor when an earlier block is removed", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript: ChatBlock[] = [
      { type: "user", id: "remove-anchor-user", content: "prompt" },
      ...Array.from({ length: 63 }, (_, index) => ({
        type: "content" as const,
        id: `remove-anchor-content-${index}`,
        content: `answer ${index}`,
        finalized: true,
      })),
    ];
    contextValue.setActiveThreadState(thread(), transcript);
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    let scrollBox: ScrollBoxRenderable | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onScrollBoxRef={(value) => {
              scrollBox = value;
            }}
            renderBlock={(block) => <text>{block.id}</text>}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await settleWindowedRender(app);
      expect(scrollBox).not.toBeNull();
      scrollBox!.scrollTop = 30;
      await settleWindowedRender(app);
      const beforeAnchor = view.scrollAnchor();
      expect(beforeAnchor?.blockId).toBeDefined();
      const anchoredPage = view.pageIndex.pageForBlock(beforeAnchor!.blockId!)!;
      const removedBlockId = anchoredPage.blockIds.find((blockId) => blockId !== beforeAnchor!.blockId);
      expect(removedBlockId).toBeDefined();

      contextValue.removeBlock(removedBlockId!);
      await settleWindowedRender(app);

      expect(view.pageIndex.pageById(anchoredPage.id)).toBeDefined();
      expect(view.scrollAnchor()?.blockId).toBe(beforeAnchor?.blockId);
      expect(view.scrollAnchor()?.pageId).toBe(view.pageIndex.pageForBlock(beforeAnchor!.blockId!)?.id);
      expect(view.scrollAnchor()?.blockOffset).toBe(beforeAnchor?.blockOffset);
    } finally {
      app.renderer.destroy();
    }
  });

  test("preserves the block-relative scroll anchor across layout epoch changes", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript = blocks(400);
    contextValue.setActiveThreadState(thread(), transcript);
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    let scrollBox: ScrollBoxRenderable | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            layoutRevision={() => (contextValue.state.detailsExpanded ? 1 : 0)}
            onScrollBoxRef={(value) => {
              scrollBox = value;
            }}
            renderBlock={(block) => (
              <box height={contextValue.state.detailsExpanded ? 2 : 1}>
                <text>{block.id}</text>
              </box>
            )}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      expect(scrollBox).not.toBeNull();
      scrollBox!.scrollTop = Math.floor(scrollBox!.scrollHeight / 2);
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      const beforeAnchor = view.scrollAnchor();
      const beforeScrollTop = scrollBox!.scrollTop;
      expect(beforeAnchor).not.toBeNull();

      contextValue.setState("detailsExpanded", true);
      await settleWindowedRender(app);

      expect(view.scrollAnchor()?.pageId).toBe(beforeAnchor!.pageId);
      expect(view.scrollAnchor()?.blockId).toBe(beforeAnchor!.blockId);
      expect(Math.abs((view.scrollAnchor()?.blockOffset ?? 0) - (beforeAnchor!.blockOffset ?? 0))).toBeLessThanOrEqual(
        1,
      );
      expect(scrollBox!.scrollTop).toBeGreaterThan(beforeScrollTop);
    } finally {
      app.renderer.destroy();
    }
  });

  test("clamps a page-relative anchor when exact measurement is much shorter than its estimate", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript: ChatBlock[] = [
      {
        type: "content",
        id: "overestimated-page",
        content: Array.from({ length: 200 }, (_, index) => `estimated ${index}`).join("\n"),
        finalized: true,
      },
      ...(blocks(200).map((block) => ({ ...block, id: `after-${block.id}` })) as ChatBlock[]),
    ];
    contextValue.setActiveThreadState(thread(), transcript);
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    const firstPage = view.pageIndex.pageForBlock("overestimated-page")!;
    let scrollBox: ScrollBoxRenderable | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onScrollBoxRef={(value) => {
              scrollBox = value;
            }}
            renderBlock={(block) => (
              <box height={1}>
                <text>{block.id}</text>
              </box>
            )}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      expect(scrollBox).not.toBeNull();
      scrollBox!.scrollTop = 50;
      await settleWindowedRender(app);

      const measuredPage = view.pageIndex.pageById(firstPage.id)!;
      expect(measuredPage.measurement?.height).toBeLessThan(10);
      expect(view.scrollAnchor()).toMatchObject({
        pageId: firstPage.id,
        offset: 0,
        blockId: "overestimated-page",
        blockOffset: 0,
      });
      expect(scrollBox!.scrollTop).toBeLessThan(10);
    } finally {
      app.renderer.destroy();
    }
  });

  test("does not claim selections outside the transcript viewport", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    contextValue.setActiveThreadState(thread(), blocks(120));
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    let coordinator: TranscriptSelectionCoordinator | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <box width="100%" height="100%" flexDirection="column">
            <ChatLog
              welcomeDismissed={() => true}
              rendererMode="windowed"
              availableWidth={() => 80}
              onSelectionCoordinatorChange={(value) => {
                coordinator = value;
              }}
              renderBlock={(block) => <text>{block.id}</text>}
            />
            <text id="outside-selection">composer text</text>
          </box>
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      expect(coordinator).not.toBeNull();
      const outside = app.renderer.root.findDescendantById("outside-selection");
      expect(outside).toBeDefined();
      app.renderer.startSelection(outside!, outside!.x, outside!.y);
      const selection = app.renderer.getSelection();
      expect(selection).not.toBeNull();
      expect(coordinator!.completeSelection(selection!, () => {})).toBe("not-handled");
      expect(view.pageIndex.pages().every((page) => !page.pinReasons.includes("selection"))).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  });

  test("rejects selections that exceed the page pin limit", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript = blocks(200);
    contextValue.setActiveThreadState(thread(), transcript);
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    const focusBlockId = view.pageIndex.pages().at(-2)!.blockIds[0];
    let coordinator: TranscriptSelectionCoordinator | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            selectionPinPageLimit={1}
            availableWidth={() => 80}
            onSelectionCoordinatorChange={(value) => {
              coordinator = value;
            }}
            renderBlock={(block) => <text id={`selection-limit:${block.id}`}>{block.id}</text>}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await settleWindowedRender(app);
      const anchor = app.renderer.root.findDescendantById("selection-limit:c-199");
      const focus = app.renderer.root.findDescendantById(`selection-limit:${focusBlockId}`);
      expect(anchor).toBeDefined();
      expect(focus).toBeDefined();
      app.renderer.startSelection(anchor!, anchor!.x, anchor!.y);
      app.renderer.updateSelection(focus!, focus!.x, focus!.y);
      const selection = app.renderer.getSelection();
      expect(selection).not.toBeNull();
      let copyCount = 0;

      expect(coordinator!.completeSelection(selection!, () => (copyCount += 1))).toBe("too-large");

      expect(copyCount).toBe(0);
      expect(app.renderer.getSelection()).toBeNull();
      expect(view.pageIndex.pages().every((page) => !page.pinReasons.includes("selection"))).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  });

  test("allows copy after an oversized selection retracts below the pin limit", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript = blocks(200);
    contextValue.setActiveThreadState(thread(), transcript);
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    const oversizedFocusBlockId = view.pageIndex.pages().at(-2)!.blockIds[0];
    let coordinator: TranscriptSelectionCoordinator | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            selectionPinPageLimit={1}
            availableWidth={() => 80}
            onSelectionCoordinatorChange={(value) => {
              coordinator = value;
            }}
            renderBlock={(block) => <text id={`selection-retract:${block.id}`}>{block.id}</text>}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await settleWindowedRender(app);
      const anchor = app.renderer.root.findDescendantById("selection-retract:c-199");
      const oversizedFocus = app.renderer.root.findDescendantById(`selection-retract:${oversizedFocusBlockId}`);
      const validFocus = app.renderer.root.findDescendantById("selection-retract:u-198");
      expect(anchor).toBeDefined();
      expect(oversizedFocus).toBeDefined();
      expect(validFocus).toBeDefined();
      app.renderer.startSelection(anchor!, anchor!.x, anchor!.y);
      app.renderer.updateSelection(oversizedFocus!, oversizedFocus!.x, oversizedFocus!.y);
      await app.renderOnce();

      app.renderer.updateSelection(validFocus!, validFocus!.x, validFocus!.y);
      await app.renderOnce();
      const selection = app.renderer.getSelection();
      expect(selection).not.toBeNull();
      let copyCount = 0;

      expect(coordinator!.completeSelection(selection!, () => (copyCount += 1))).toBe("deferred");
      await settleWindowedRender(app);

      expect(copyCount).toBe(1);
      expect(view.pageIndex.pages().every((page) => !page.pinReasons.includes("selection"))).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  });

  test("pins the final rapid selection range before copying even without a prior render-frame sample", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript = blocks(200);
    contextValue.setActiveThreadState(thread(), transcript);
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    const indexedPages = view.pageIndex.pages();
    const focusBlockId = indexedPages.at(-2)!.blockIds[0];
    let coordinator: TranscriptSelectionCoordinator | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onSelectionCoordinatorChange={(value) => {
              coordinator = value;
            }}
            renderBlock={(block) => (
              <box onMouseDown={(event) => event.stopPropagation?.()}>
                <text id={`rapid:${block.id}`}>{block.id}</text>
              </box>
            )}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      expect(coordinator).not.toBeNull();
      const anchor = app.renderer.root.findDescendantById("rapid:c-199");
      const focus = app.renderer.root.findDescendantById(`rapid:${focusBlockId}`);
      expect(anchor).toBeDefined();
      expect(focus).toBeDefined();
      app.renderer.startSelection(anchor!, anchor!.x, anchor!.y);
      app.renderer.updateSelection(focus!, focus!.x, focus!.y);
      const selection = app.renderer.getSelection();
      expect(selection).not.toBeNull();
      const copyResult: { text: string | null } = { text: null };
      expect(
        coordinator!.completeSelection(selection!, (completed) => (copyResult.text = completed.getSelectedText())),
      ).toBe("deferred");
      expect(copyResult.text).toBeNull();
      expect(view.pageIndex.pageForBlock(focusBlockId)?.pinReasons).toContain("selection");

      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      expect(copyResult.text).toContain(focusBlockId);
      expect(copyResult.text).toContain("u-198");
    } finally {
      app.renderer.destroy();
    }
  });

  test("cancels an older deferred copy when a newer selection reuses its anchor", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript = blocks(200);
    contextValue.setActiveThreadState(thread(), transcript);
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    const focusBlockId = view.pageIndex.pages().at(-2)!.blockIds[0];
    let coordinator: TranscriptSelectionCoordinator | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onSelectionCoordinatorChange={(value) => {
              coordinator = value;
            }}
            renderBlock={(block) => <text id={`generation:${block.id}`}>{block.id}</text>}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      const oldAnchor = app.renderer.root.findDescendantById("generation:c-199");
      const oldFocus = app.renderer.root.findDescendantById(`generation:${focusBlockId}`);
      const newFocus = app.renderer.root.findDescendantById("generation:u-198");
      expect(oldAnchor).toBeDefined();
      expect(oldFocus).toBeDefined();
      expect(newFocus).toBeDefined();
      app.renderer.startSelection(oldAnchor!, oldAnchor!.x, oldAnchor!.y);
      app.renderer.updateSelection(oldFocus!, oldFocus!.x, oldFocus!.y);
      const oldSelection = app.renderer.getSelection();
      let oldCopyCount = 0;
      expect(coordinator!.completeSelection(oldSelection!, () => (oldCopyCount += 1))).toBe("deferred");

      app.renderer.startSelection(oldAnchor!, oldAnchor!.x, oldAnchor!.y);
      app.renderer.updateSelection(newFocus!, newFocus!.x, newFocus!.y);
      await app.renderOnce();
      expect(oldCopyCount).toBe(0);
      expect(view.pageIndex.pageForBlock("u-198")?.pinReasons).toContain("selection");

      const newSelection = app.renderer.getSelection();
      let newCopyCount = 0;
      expect(coordinator!.completeSelection(newSelection!, () => (newCopyCount += 1))).toBe("deferred");
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      expect(newCopyCount).toBe(1);
    } finally {
      app.renderer.destroy();
    }
  });

  test("cancels a deferred copy when the active transcript generation is replaced", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript = blocks(200);
    contextValue.setActiveThreadState(thread(), transcript);
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    const focusBlockId = view.pageIndex.pages().at(-2)!.blockIds[0];
    let coordinator: TranscriptSelectionCoordinator | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onSelectionCoordinatorChange={(value) => {
              coordinator = value;
            }}
            renderBlock={(block) => <text id={`replace-copy:${block.id}`}>{block.id}</text>}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await settleWindowedRender(app);
      const anchor = app.renderer.root.findDescendantById("replace-copy:c-199");
      const focus = app.renderer.root.findDescendantById(`replace-copy:${focusBlockId}`);
      expect(anchor).toBeDefined();
      expect(focus).toBeDefined();
      app.renderer.startSelection(anchor!, anchor!.x, anchor!.y);
      app.renderer.updateSelection(focus!, focus!.x, focus!.y);
      const selection = app.renderer.getSelection();
      expect(selection).not.toBeNull();
      let copyCount = 0;
      expect(coordinator!.completeSelection(selection!, () => (copyCount += 1))).toBe("deferred");

      contextValue.replaceBlocks(blocks(20).map((block) => ({ ...block, id: `replacement-${block.id}` }) as ChatBlock));
      await settleWindowedRender(app);

      expect(copyCount).toBe(0);
      expect(app.renderer.getSelection()).toBeNull();
      expect(view.pageIndex.pages().every((page) => !page.pinReasons.includes("selection"))).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  });

  test("cancels a deferred copy when a selected block is removed from a surviving page", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript = blocks(200);
    contextValue.setActiveThreadState(thread(), transcript);
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    const focusBlockId = view.pageIndex.pages().at(-2)!.blockIds[0];
    const focusPageId = view.pageIndex.pageForBlock(focusBlockId)!.id;
    let coordinator: TranscriptSelectionCoordinator | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onSelectionCoordinatorChange={(value) => {
              coordinator = value;
            }}
            renderBlock={(block) => <text id={`remove-copy:${block.id}`}>{block.id}</text>}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await settleWindowedRender(app);
      const anchor = app.renderer.root.findDescendantById("remove-copy:c-199");
      const focus = app.renderer.root.findDescendantById(`remove-copy:${focusBlockId}`);
      expect(anchor).toBeDefined();
      expect(focus).toBeDefined();
      app.renderer.startSelection(anchor!, anchor!.x, anchor!.y);
      app.renderer.updateSelection(focus!, focus!.x, focus!.y);
      const selection = app.renderer.getSelection();
      expect(selection).not.toBeNull();
      let copyCount = 0;
      expect(coordinator!.completeSelection(selection!, () => (copyCount += 1))).toBe("deferred");

      contextValue.removeBlock(focusBlockId);
      expect(view.pageIndex.pageById(focusPageId)).toBeDefined();
      await settleWindowedRender(app);

      expect(copyCount).toBe(0);
      expect(app.renderer.getSelection()).toBeNull();
      expect(view.pageIndex.pages().every((page) => !page.pinReasons.includes("selection"))).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  });

  test("cancels a deferred copy before thread deactivation", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript = blocks(200);
    contextValue.setActiveThreadState(thread(), transcript);
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    const focusBlockId = view.pageIndex.pages().at(-2)!.blockIds[0];
    let coordinator: TranscriptSelectionCoordinator | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onSelectionCoordinatorChange={(value) => {
              coordinator = value;
            }}
            renderBlock={(block) => <text id={`cancel-copy:${block.id}`}>{block.id}</text>}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      const anchor = app.renderer.root.findDescendantById("cancel-copy:c-199");
      const focus = app.renderer.root.findDescendantById(`cancel-copy:${focusBlockId}`);
      expect(anchor).toBeDefined();
      expect(focus).toBeDefined();
      app.renderer.startSelection(anchor!, anchor!.x, anchor!.y);
      app.renderer.updateSelection(focus!, focus!.x, focus!.y);
      const selection = app.renderer.getSelection();
      expect(selection).not.toBeNull();
      let copyCount = 0;
      expect(coordinator!.completeSelection(selection!, () => (copyCount += 1))).toBe("deferred");

      coordinator!.beforeThreadDeactivate("windowed-thread");
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();

      expect(copyCount).toBe(0);
      expect(app.renderer.getSelection()).toBeNull();
      expect(view.pageIndex.pages().every((page) => !page.pinReasons.includes("selection"))).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  });

  test("releases selection pins on thread deactivation and disposal", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript = blocks(120);
    contextValue.setActiveThreadState(thread(), transcript);
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    let coordinator: TranscriptSelectionCoordinator | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onSelectionCoordinatorChange={(value) => {
              coordinator = value;
            }}
            renderBlock={(block) => <text id={`cleanup:${block.id}`}>{block.id}</text>}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    /**
     * Starts a tail selection and waits for the page pin to become observable.
     *
     * @returns A promise that resolves after the selection page is pinned.
     */
    const startSelection = async () => {
      const tail = app.renderer.root.findDescendantById("cleanup:c-119");
      expect(tail).toBeDefined();
      app.renderer.startSelection(tail!, tail!.x, tail!.y);
      await app.renderOnce();
      expect(view.pageIndex.pages().some((page) => page.pinReasons.includes("selection"))).toBe(true);
    };

    try {
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      expect(coordinator).not.toBeNull();

      await startSelection();
      coordinator!.beforeThreadDeactivate("windowed-thread");
      expect(app.renderer.getSelection()).toBeNull();
      expect(view.pageIndex.pages().every((page) => !page.pinReasons.includes("selection"))).toBe(true);

      await startSelection();
      coordinator!.dispose();
      expect(app.renderer.getSelection()).toBeNull();
      expect(view.pageIndex.pages().every((page) => !page.pinReasons.includes("selection"))).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  });

  test("defers completion until the cross-page selection is refreshed and copied exactly", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const transcript = blocks(200);
    contextValue.setActiveThreadState(thread(), transcript);
    const view = store.threadTranscriptViews.get("windowed-thread")!;
    let scrollBox: ScrollBoxRenderable | null = null;
    let coordinator: TranscriptSelectionCoordinator | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="windowed"
            availableWidth={() => 80}
            onScrollBoxRef={(value) => {
              scrollBox = value;
            }}
            onSelectionCoordinatorChange={(value) => {
              coordinator = value;
            }}
            renderBlock={(block) => <text id={`selectable:${block.id}`}>{block.id}</text>}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      expect(scrollBox).not.toBeNull();
      expect(coordinator).not.toBeNull();
      const tail = app.renderer.root.findDescendantById("selectable:c-199");
      expect(tail).toBeDefined();
      app.renderer.startSelection(tail!, tail!.x, tail!.y);
      await app.renderOnce();

      const tailPage = view.pageIndex.pageForBlock("c-199")!;
      expect(tailPage.pinReasons).toContain("selection");
      expect(scrollBox!.scrollTop).toBeGreaterThan(0);
      while (scrollBox!.scrollTop > 0) {
        scrollBox!.scrollTop = Math.max(0, scrollBox!.scrollTop - 20);
        await app.renderOnce();
        const focusPage = view.pageIndex
          .pages()
          .map((page) => app.renderer.root.findDescendantById(`${TRANSCRIPT_PAGE_ID_PREFIX}${page.id}`))
          .find(
            (renderable) =>
              renderable && scrollBox!.y >= renderable.y && scrollBox!.y < renderable.y + renderable.height,
          );
        app.renderer.updateSelection(focusPage, tail!.x, scrollBox!.y);
        await app.renderOnce();
      }
      expect(view.pageIndex.pages()[0].pinReasons).toContain("selection");

      const selection = app.renderer.getSelection();
      expect(selection).not.toBeNull();
      const copyResult: { text: string | null } = { text: null };
      expect(
        coordinator!.completeSelection(selection!, (completed) => (copyResult.text = completed.getSelectedText())),
      ).toBe("deferred");
      expect(copyResult.text).toBeNull();

      await app.flush();
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      expect(copyResult.text).toBe(
        transcript
          .slice(0, -1)
          .map((block) => block.id)
          .join("\n"),
      );
      expect(view.pageIndex.pages().every((page) => !page.pinReasons.includes("selection"))).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps the legacy direct-child renderer available as the rollback path", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    contextValue.setActiveThreadState(thread(), blocks(40));
    let scrollBox: ScrollBoxRenderable | null = null;
    const app = await testRender(
      () => (
        <AppContext.Provider value={contextValue}>
          <ChatLog
            welcomeDismissed={() => true}
            rendererMode="legacy"
            onScrollBoxRef={(value) => {
              scrollBox = value;
            }}
            renderBlock={(block) => <text>{block.id}</text>}
          />
        </AppContext.Provider>
      ),
      { width: 80, height: 20, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      expect(scrollBox).not.toBeNull();
      expect(scrollBox!.content.getChildrenCount()).toBe(40);
    } finally {
      app.renderer.destroy();
    }
  });
});
