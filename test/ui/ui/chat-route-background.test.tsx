import { describe, expect, test, afterEach } from "bun:test";
import {
  createTextAttributes,
  parseColor,
  ScrollBoxRenderable,
  type CapturedFrame,
  type Renderable,
} from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { Config, resetConfig, setConfig } from "../../../src/config";
import { createAppStateValue, type AppStateContextValue } from "../../../src/ui/context/app-state";
import { getColors } from "../../../src/ui/context/theme";
import { SelectionMode } from "../../../src/ui/autocomplete";
import { ChatRoute, type ChatRouteProps } from "../../../src/ui/routes/chat";
import { createToastValue } from "../../../src/ui/ui/toast";
import { PluginRunner } from "../../../src/plugins";
import type { ChatBlock, ElicitationBlock } from "../../../src/ui/state";
import type { ThreadInfo } from "../../../src/core/threads";
import { userMessageBackgroundColor } from "../../../src/ui/util/user-message-style";
import { store } from "../../../src/ui/app/runtime-store";
import { TRANSCRIPT_NAV_BLOCK_ID_PREFIX } from "../../../src/ui/util/sticky-prompt";

const WIDTH = 50;
const HEIGHT = 16;
const TEST_THEME = "github-dark";

function noOp(): void {}

/**
 * Advances render and flush cycles until route layout and background updates settle.
 *
 * @param app - Test renderer controls used to advance frames and queued work.
 * @param frames - Number of render and flush cycles to execute.
 * @returns A promise that resolves after all requested cycles complete.
 */
async function settleRouteRender(
  app: { renderOnce: () => Promise<void>; flush: () => Promise<void> },
  frames = 6,
): Promise<void> {
  for (let index = 0; index < frames; index += 1) {
    await app.renderOnce();
    await app.flush();
  }
}

/**
 * Recursively finds the scroll box within a rendered route tree.
 *
 * @param renderable - Root renderable whose descendants should be searched.
 * @returns The first scroll box found, or `null` when the subtree contains none.
 */
function findScrollBox(renderable: Renderable): ScrollBoxRenderable | null {
  if (renderable instanceof ScrollBoxRenderable) return renderable;
  for (const child of renderable.getChildren()) {
    const found = findScrollBox(child);
    if (found) return found;
  }
  return null;
}

function chatRouteProps(contextValue: AppStateContextValue): ChatRouteProps {
  return {
    contextValue,
    toastValue: createToastValue(),
    fileChangesModalOpen: () => false,
    setFileChangesModalOpen: noOp,
    diffOverlayCommand: () => null,
    diffOverlayRequest: () => null,
    nativeModal: () => null,
    openNativeModal: noOp,
    closeNativeModal: noOp,
    toggleNativeModal: noOp,
    tips: () => [],
    welcomeDismissed: () => false,
    hideThinking: () => false,
    activeAgentProfile: () => "default",
    approvalOptionIndex: () => 0,
    elicitationOptionIndex: () => 0,
    getSpinnerChar: () => "⠋",
    selectElicitationChoice: noOp,
    overlayItems: () => [],
    overlayIndex: () => 0,
    overlayLayout: () => ({
      labelMinWidth: 0,
      labelMaxWidth: 42,
      descriptionMaxWidth: 60,
      viewportReservedWidth: 12,
    }),
    maxOverlayVisible: 8,
    slashPanelPosition: () => "bottom",
    selectionMode: () => null,
    filterOverlayItems: noOp,
    showOverlay: noOp,
    hideOverlay: noOp,
    isOverlayVisible: () => false,
    selectOverlayItem: noOp,
    getVisibleSlashCommands: () => [],
    setActiveCompletion: noOp,
    setTabCompleting: noOp,
    consumeInputUpdateSource: () => null,
    onPromptTextChanged: noOp,
    setTextareaRef: noOp,
    setCompletedTextSubmitter: noOp,
    textareaRef: () => null,
    composerText: () => "",
    resetDoublePressState: noOp,
    currentSessionId: () => null,
    queueMaxSize: 10,
    composerInputOwner: () => "composer",
    handleSubmit: noOp,
    threads: () => [],
    activeThreadId: () => "",
    showSidebar: () => false,
    sidebarFocused: () => false,
    sidebarFocusedIndex: () => 0,
    sidebarExpanded: () => false,
    sidebarWidth: () => 30,
    sidebarListOffset: () => 0,
    getThreadPreview: () => "",
    selectThread: noOp,
    createLocalThread: noOp,
    createWorktreeThread: noOp,
    createExistingWorktreeThread: noOp,
    archiveThread: noOp,
    onRootMouseDown: noOp,
    onRootMouseUp: noOp,
  };
}

function cellBackgroundAlpha(frame: CapturedFrame, rowIndex: number, columnIndex: number): number {
  const line = frame.lines[rowIndex];
  if (!line) throw new Error(`Missing captured row ${rowIndex}`);

  let column = 0;
  for (const span of line.spans) {
    const nextColumn = column + span.width;
    if (columnIndex < nextColumn) return span.bg.a;
    column = nextColumn;
  }

  throw new Error(`Missing captured cell ${rowIndex}:${columnIndex}`);
}

afterEach(() => {
  resetConfig();
  store.threadTranscriptViews.clear();
});

describe("ChatRoute sidebar footer", () => {
  test("shares one renderer resize listener across the route", async () => {
    const contextValue = createAppStateValue(process.cwd());
    const app = await testRender(() => <ChatRoute {...chatRouteProps(contextValue)} />, {
      width: WIDTH,
      height: HEIGHT,
      targetFps: 30,
    });

    try {
      expect(app.renderer.listenerCount("resize")).toBe(1);
    } finally {
      app.renderer.destroy();
    }
  });

  test("shows compact sidebar shortcuts without a clipped trailing separator", async () => {
    const contextValue = createAppStateValue(process.cwd());
    const app = await testRender(
      () => <ChatRoute {...chatRouteProps(contextValue)} showSidebar={() => true} sidebarWidth={() => 30} />,
      {
        width: WIDTH,
        height: HEIGHT,
        targetFps: 30,
      },
    );

    try {
      await app.renderOnce();
      const frame = app.captureCharFrame();
      expect(frame).toContain("ctrl+b focus · ctrl+g agents");
      expect(frame).not.toContain("ctrl+g agents ·");
      expect(frame).not.toContain("del archive");
    } finally {
      app.renderer.destroy();
    }
  });

  test("remeasures a windowed transcript at the sidebar-adjusted viewport width", async () => {
    const contextValue = createAppStateValue(process.cwd(), { transcriptPagingEnabled: true });
    const activeThread: ThreadInfo = {
      id: "sidebar-thread",
      title: "Sidebar",
      sessionId: null,
      cwd: process.cwd(),
      workspaceKind: "local",
      status: "paused",
      archived: false,
    };
    const transcript: ChatBlock[] = Array.from({ length: 240 }, (_, index) =>
      index % 2 === 0
        ? { type: "user", id: `u-${index}`, content: `prompt ${index} `.repeat(6) }
        : { type: "content", id: `c-${index}`, content: `answer ${index} `.repeat(8), finalized: true },
    );
    contextValue.setState("threads", [activeThread]);
    contextValue.setActiveThreadState(activeThread, transcript);
    const view = store.threadTranscriptViews.get(activeThread.id)!;
    const sidebarWidth = 20;
    const [showSidebar, setShowSidebar] = createSignal(false);
    const app = await testRender(
      () => (
        <ChatRoute
          {...chatRouteProps(contextValue)}
          welcomeDismissed={() => true}
          transcriptRendererMode="windowed"
          threads={() => [activeThread]}
          activeThreadId={() => activeThread.id}
          showSidebar={showSidebar}
          sidebarWidth={() => sidebarWidth}
        />
      ),
      { width: WIDTH, height: HEIGHT, targetFps: 30 },
    );

    try {
      await settleRouteRender(app);
      const scrollBox = findScrollBox(app.renderer.root);
      expect(scrollBox).not.toBeNull();
      expect(view.pageIndex.pages().some((page) => page.measurement?.width === WIDTH)).toBe(true);
      scrollBox!.scrollTop = Math.floor(scrollBox!.scrollHeight / 2);
      await app.renderOnce();
      await app.flush();
      await app.renderOnce();
      const anchor = view.scrollAnchor();
      const epoch = view.layoutEpoch;
      expect(anchor).not.toBeNull();

      setShowSidebar(true);
      await settleRouteRender(app);

      const measurements = view.pageIndex.pages().flatMap((page) => page.measurement ?? []);
      expect(measurements.length).toBeGreaterThan(0);
      expect(measurements.every((measurement) => measurement.width === WIDTH - sidebarWidth)).toBe(true);
      expect(view.layoutEpoch).toBeGreaterThan(epoch);
      expect(view.scrollAnchor()?.pageId).toBe(anchor!.pageId);
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps slash command popup inside the main pane when sidebar is visible", async () => {
    const contextValue = createAppStateValue(process.cwd());
    const sidebarWidth = 20;
    const app = await testRender(
      () => (
        <ChatRoute
          {...chatRouteProps(contextValue)}
          showSidebar={() => true}
          sidebarWidth={() => sidebarWidth}
          isOverlayVisible={() => true}
          selectionMode={() => SelectionMode.THEME}
          overlayItems={() => [{ value: "dark", label: "slash", description: "description" }]}
          overlayLayout={() => ({
            labelMinWidth: 0,
            labelMaxWidth: 42,
            descriptionMaxWidth: 60,
            viewportReservedWidth: 12,
          })}
          maxOverlayVisible={1}
        />
      ),
      {
        width: WIDTH,
        height: HEIGHT,
        targetFps: 30,
      },
    );

    try {
      await app.renderOnce();
      const popupLine = app
        .captureCharFrame()
        .split("\n")
        .find((line) => line.includes("slash"));
      expect(popupLine).toBeDefined();
      expect(popupLine).toContain("description");
      expect(popupLine?.indexOf("slash")).toBeGreaterThanOrEqual(sidebarWidth);
    } finally {
      app.renderer.destroy();
    }
  });
});

describe("ChatRoute interaction panels", () => {
  test("keeps one blank row below the shortcuts on the borderless elicitation surface", async () => {
    const contextValue = createAppStateValue(process.cwd());
    const elicitation: ElicitationBlock = {
      type: "elicitation",
      id: "elicitation-bottom",
      mode: "form",
      message: "Choose a release strategy",
      status: "pending",
      fields: [
        {
          key: "strategy",
          type: "string",
          title: "Release strategy",
          choices: [
            { value: "canary", title: "Canary" },
            { value: "rolling", title: "Rolling" },
          ],
        },
      ],
      currentFieldIndex: 0,
      answers: {},
      allowCustomEnumInput: false,
      respond: noOp,
    };
    contextValue.setState("blocks", [elicitation]);
    const app = await testRender(() => <ChatRoute {...chatRouteProps(contextValue)} welcomeDismissed={() => true} />, {
      width: WIDTH,
      height: HEIGHT,
      targetFps: 30,
    });

    try {
      await settleRouteRender(app);
      const frame = app.captureSpans();
      const shortcutLine = frame.lines.at(-2);
      const bottomLine = frame.lines.at(-1);
      expect(shortcutLine?.spans.map((span) => span.text).join("")).toContain("esc cancel");
      expect(
        bottomLine?.spans
          .map((span) => span.text)
          .join("")
          .trim(),
      ).toBe("");
      expect(frame.lines.some((line) => line.spans.some((span) => span.text.includes("━")))).toBe(false);
      expect(bottomLine?.spans[0]?.bg.toString()).toBe(parseColor(userMessageBackgroundColor(getColors())).toString());
    } finally {
      app.renderer.destroy();
    }
  });

  test("dismisses the composer overlay when a transcript row is clicked", async () => {
    const contextValue = createAppStateValue(process.cwd());
    contextValue.addBlock({
      type: "tool",
      id: "tool-overlay-dismiss",
      toolCallId: "call-overlay-dismiss",
      toolName: "read",
      display: "path: example.ts",
      details: "contents",
      status: "success",
    });
    const [overlayVisible, setOverlayVisible] = createSignal(true);
    let hideOverlayCalls = 0;
    const app = await testRender(
      () => (
        <ChatRoute
          {...chatRouteProps(contextValue)}
          welcomeDismissed={() => true}
          overlayItems={() => [{ label: "Session", description: "", value: { sessionId: "session-1" } }]}
          selectionMode={() => SelectionMode.SESSION}
          isOverlayVisible={overlayVisible}
          hideOverlay={() => {
            hideOverlayCalls += 1;
            setOverlayVisible(false);
          }}
          composerInputOwner={() => (overlayVisible() ? "overlay" : "transcript")}
        />
      ),
      { width: WIDTH, height: HEIGHT, targetFps: 30 },
    );

    try {
      await settleRouteRender(app);
      const row = app.renderer.root.findDescendantById(`${TRANSCRIPT_NAV_BLOCK_ID_PREFIX}tool-overlay-dismiss`);
      expect(row).not.toBeNull();

      await app.mockMouse.click(row!.x + 1, row!.y);
      await app.flush();

      expect(hideOverlayCalls).toBe(1);
      expect(overlayVisible()).toBe(false);
      expect(contextValue.state.transcriptSelectedBlockId).toBe("tool-overlay-dismiss");
    } finally {
      app.renderer.destroy();
    }
  });
});

describe("ChatRoute editor header widgets", () => {
  test("renders plugin panels full width with one empty line above", async () => {
    const contextValue = createAppStateValue(process.cwd());
    const blocks: ChatBlock[] = [{ type: "user", id: "latest", content: "LAST_MESSAGE" }];
    contextValue.setState("blocks", blocks);

    const renderedWidths: number[] = [];
    const runner = new PluginRunner({ cwd: process.cwd() });
    runner.slots.setWidget({ id: "test", name: "test", path: "test" }, "panel", {
      placement: "editorHeader",
      height: 1,
      render(ctx) {
        const width = ctx?.width ?? 1;
        renderedWidths.push(width);
        return [{ text: "B".repeat(width), bg: "#123456" }];
      },
    });

    const app = await testRender(
      () => (
        <ChatRoute
          {...chatRouteProps(contextValue)}
          welcomeDismissed={() => true}
          pluginRunner={() => runner}
          pluginRevision={() => 0}
        />
      ),
      {
        width: WIDTH,
        height: HEIGHT,
        targetFps: 30,
      },
    );

    try {
      await app.renderOnce();
      await app.flush();
      const lines = app.captureCharFrame().split("\n");
      const panelLineIndex = lines.findIndex((line) => line === "B".repeat(WIDTH));

      expect(panelLineIndex).toBeGreaterThan(0);
      expect(renderedWidths.at(-1)).toBe(WIDTH);
      expect(lines[panelLineIndex - 1]).toBe(" ".repeat(WIDTH));
      expect(lines.slice(0, panelLineIndex - 1).some((line) => line.includes("LAST_MESSAGE"))).toBe(true);
    } finally {
      app.renderer.destroy();
    }
  });

  test("shows the editor-focus hint at the right while a transcript block is selected", async () => {
    const contextValue = createAppStateValue(process.cwd());
    contextValue.setState("blocks", [
      { type: "content", id: "selected-block", content: "Selected response", finalized: true },
    ]);
    contextValue.setState("transcriptSelectedRows", "selected-block", true);
    contextValue.setState("transcriptSelectedBlockId", "selected-block");
    const app = await testRender(() => <ChatRoute {...chatRouteProps(contextValue)} welcomeDismissed={() => true} />, {
      width: WIDTH,
      height: HEIGHT,
      targetFps: 30,
    });

    try {
      await app.renderOnce();
      await app.flush();
      const hintLine = app
        .captureCharFrame()
        .split("\n")
        .find((line) => line.includes("esc to focus editor"));
      expect(hintLine?.trimEnd().endsWith("esc to focus editor")).toBe(true);

      const spans = app.captureSpans().lines.flatMap((line) => line.spans);
      const keySpan = spans.find((span) => span.text === "esc");
      const labelSpan = spans.find((span) => span.text === " to focus editor");
      expect(keySpan?.fg.toString()).toBe(parseColor(getColors().textLabel).toString());
      expect(labelSpan?.fg.toString()).toBe(parseColor(getColors().textSubtle).toString());

      contextValue.setState("transcriptSelectedRows", "selected-block", false);
      contextValue.setState("transcriptSelectedBlockId", null);
      await app.renderOnce();
      await app.flush();
      expect(app.captureCharFrame()).not.toContain("esc to focus editor");
    } finally {
      app.renderer.destroy();
    }
  });

  test("renders plugin line and segment strikethrough as native text attributes", async () => {
    const contextValue = createAppStateValue(process.cwd());
    const runner = new PluginRunner({ cwd: process.cwd() });
    const plugin = { id: "test:strikethrough", name: "strikethrough", path: "/strikethrough.ts" };
    runner.slots.setWidget(plugin, "panel", {
      placement: "editorHeader",
      height: 2,
      render: () => [
        { text: "WHOLE", strikethrough: true },
        {
          text: "DONE OPEN",
          segments: [{ text: "DONE", strikethrough: true }, { text: " OPEN" }],
        },
      ],
    });
    runner.slots.setEditorStatusSegment(plugin, "whole-status", {
      render: () => ({ text: "WHOLESTATUS", strikethrough: true }),
    });
    runner.slots.setEditorStatusSegment(plugin, "segment-status", {
      render: () => ({
        text: "STATUS OPENSTATUS",
        segments: [{ text: "STATUS", strikethrough: true }, { text: " OPENSTATUS" }],
      }),
    });

    const app = await testRender(
      () => (
        <ChatRoute
          {...chatRouteProps(contextValue)}
          welcomeDismissed={() => true}
          pluginRunner={() => runner}
          pluginRevision={() => 0}
        />
      ),
      { width: WIDTH, height: HEIGHT, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      await app.flush();
      const spanLines = app.captureSpans().lines;
      const wholeSpan = spanLines.flatMap((line) => line.spans).find((span) => span.text === "WHOLE");
      const doneSpan = spanLines.flatMap((line) => line.spans).find((span) => span.text === "DONE");
      const openSpan = spanLines.flatMap((line) => line.spans).find((span) => span.text === " OPEN");
      const wholeStatusSpan = spanLines.flatMap((line) => line.spans).find((span) => span.text === "WHOLESTATUS");
      const statusSpan = spanLines.flatMap((line) => line.spans).find((span) => span.text === "STATUS");
      const openStatusSpan = spanLines.flatMap((line) => line.spans).find((span) => span.text === " OPENSTATUS");

      expect(wholeSpan?.attributes).toBe(createTextAttributes({ strikethrough: true }));
      expect(doneSpan?.attributes).toBe(createTextAttributes({ strikethrough: true }));
      expect(openSpan?.attributes).toBe(createTextAttributes());
      expect(wholeStatusSpan?.attributes).toBe(createTextAttributes({ strikethrough: true }));
      expect(statusSpan?.attributes).toBe(createTextAttributes({ strikethrough: true }));
      expect(openStatusSpan?.attributes).toBe(createTextAttributes());
    } finally {
      app.renderer.destroy();
    }
  });
});

describe("ChatRoute editor chrome renderers", () => {
  test("completely replaces the editor header and footer", async () => {
    const contextValue = createAppStateValue(process.cwd());
    contextValue.setState("modelId", "built-in-model");
    contextValue.setState("pendingQueue", [{ id: "queued", text: "built-in queue item" }]);
    const runner = new PluginRunner({ cwd: process.cwd() });
    const plugin = { id: "test:chrome", name: "chrome", path: "/chrome.ts" };
    runner.slots.setWidget(plugin, "shadowed", {
      placement: "editorHeader",
      render: () => [{ text: "BUILT_IN_HEADER_WIDGET" }],
    });
    runner.slots.registerEditorHeaderRenderer(plugin, { render: () => [{ text: "CUSTOM_HEADER" }] });
    runner.slots.registerEditorFooterRenderer(plugin, {
      render: (ctx) => [{ text: `CUSTOM_FOOTER:${ctx.state.modelId}` }],
    });

    const app = await testRender(
      () => (
        <ChatRoute
          {...chatRouteProps(contextValue)}
          welcomeDismissed={() => true}
          pluginRunner={() => runner}
          pluginChromeRevision={() => 0}
        />
      ),
      { width: WIDTH, height: HEIGHT, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const frame = app.captureCharFrame();
      expect(frame).toContain("CUSTOM_HEADER");
      expect(frame).toContain("CUSTOM_FOOTER:built-in-model");
      expect(frame).not.toContain("BUILT_IN_HEADER_WIDGET");
      expect(frame).not.toContain("built-in queue item");

      contextValue.setState("modelId", "next-model");
      await app.renderOnce();
      expect(app.captureCharFrame()).toContain("CUSTOM_FOOTER:next-model");
    } finally {
      app.renderer.destroy();
    }
  });

  test("modifies named elements while preserving the built-in footer", async () => {
    const contextValue = createAppStateValue(process.cwd());
    contextValue.setState("modelId", "built-in-model");
    contextValue.setState("thinkingLevel", "high");
    contextValue.setState("contextTokens", 10);
    contextValue.setState("contextWindow", 100);
    const runner = new PluginRunner({ cwd: process.cwd() });
    runner.slots.registerEditorChromeElementRenderer(
      { id: "test:elements", name: "elements", path: "/elements.ts" },
      {
        elements: ["editorFooter.model", "editorFooter.reasoning"],
        render: (ctx) => ({ ...ctx.line, text: `active:${ctx.line.text}` }),
      },
    );

    const app = await testRender(
      () => <ChatRoute {...chatRouteProps(contextValue)} pluginRunner={() => runner} pluginChromeRevision={() => 0} />,
      { width: 100, height: HEIGHT, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const frame = app.captureCharFrame();
      expect(frame).toContain("active:built-in-model");
      expect(frame).toContain("active: • high");
      expect(frame).toContain("10/100");
    } finally {
      app.renderer.destroy();
    }
  });
});

describe("ChatRoute background fill", () => {
  test("paints sampled terminal cells with non-transparent backgrounds so removed glyphs are cleared", async () => {
    setConfig(
      new Config({
        ui: { theme: TEST_THEME },
        notifications: { sound_enabled: false },
      }),
    );
    const contextValue = createAppStateValue(process.cwd());
    const app = await testRender(() => <ChatRoute {...chatRouteProps(contextValue)} />, {
      width: WIDTH,
      height: HEIGHT,
      targetFps: 30,
    });

    try {
      await app.renderOnce();
      const frame = app.captureSpans();
      const sampledColumns = [0, Math.floor(WIDTH / 2), WIDTH - 1];

      for (let rowIndex = 0; rowIndex < HEIGHT; rowIndex += 1) {
        for (const columnIndex of sampledColumns) {
          expect(cellBackgroundAlpha(frame, rowIndex, columnIndex)).toBeGreaterThan(0);
        }
      }
    } finally {
      app.renderer.destroy();
    }
  });
});
