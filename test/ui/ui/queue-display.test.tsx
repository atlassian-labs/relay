import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { AppContext, type QueuedPrompt } from "../../../src/ui/state";
import { QueueDisplay } from "../../../src/ui/component/queue-display";
import { createAppStateValue } from "../../../src/ui/context/app-state";
import { moveQueuedPrompt } from "../../../src/ui/util/prompt-queue";
import { getColors } from "../../../src/ui/context/theme";
import type { RelayLine } from "../../../src/plugins";

function queue(...texts: string[]): QueuedPrompt[] {
  return texts.map((text, index) => ({ id: `q${index + 1}`, text }));
}

function expectNoSelfAnchorWarnings(warnings: string[]): void {
  expect(
    warnings.filter(
      (message) =>
        message.includes("Anchor is the same as the node") || message.includes("being inserted, skipping insertBefore"),
    ),
  ).toEqual([]);
}

describe("QueueDisplay", () => {
  test("truncates long previews within the row label", async () => {
    const contextValue = createAppStateValue(process.cwd());
    contextValue.setState(
      "pendingQueue",
      queue("focus on regressions and compatibility across queue rendering surfaces"),
    );
    let app: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      app = await testRender(
        () => (
          <AppContext.Provider value={contextValue}>
            <box width="100%" height="100%" flexDirection="column">
              <QueueDisplay focusedIndex={() => null} maxSize={10} />
            </box>
          </AppContext.Provider>
        ),
        { width: 48, height: 8, targetFps: 30 },
      );

      await app.renderOnce();
      const frame = app.captureCharFrame();
      expect(frame).toMatch(/Queued prompt #1 · .*\.\.\./);
      expect(frame).not.toContain("compatibility across queue rendering surfaces");
    } finally {
      app?.renderer.destroy();
    }
  });

  test("keeps the queue title stable while browsing and editing", async () => {
    const contextValue = createAppStateValue(process.cwd());
    const queued = queue("queued one", "queued two");
    contextValue.setState("pendingQueue", queued);
    const [focusedIndex, setFocusedIndex] = createSignal<number | null>(null);
    const [editingItem, setEditingItem] = createSignal<QueuedPrompt | null>(null);
    let renderedHint: RelayLine | null = null;
    const currentRenderedHint = (): RelayLine | null => renderedHint;
    let app: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      app = await testRender(
        () => (
          <AppContext.Provider value={contextValue}>
            <box width="100%" height="100%" flexDirection="column">
              <QueueDisplay
                focusedIndex={focusedIndex}
                editingItem={editingItem}
                maxSize={10}
                resolveElement={(input) => {
                  if (input.element === "editorHeader.queueHint") renderedHint = input.line;
                  return input.line;
                }}
              />
            </box>
          </AppContext.Provider>
        ),
        { width: 100, height: 10, targetFps: 30 },
      );

      await app.renderOnce();
      expect(app.captureCharFrame()).toContain("◷ Queue (2/10)");
      expect(currentRenderedHint()?.segments).toContainEqual({ text: "⌥↑/⌥↓", fg: getColors().textLabel });
      expect(currentRenderedHint()?.segments).toContainEqual({
        text: " browse queued prompts",
        fg: getColors().textSubtle,
      });

      setFocusedIndex(0);
      await app.renderOnce();
      let frame = app.captureCharFrame();
      expect(frame).toContain("⏸ Queue (2/10)");
      expect(frame).not.toContain("Queue selection");
      expect(frame).not.toContain("— #");
      expect(currentRenderedHint()?.segments).toContainEqual({ text: "↑/↓", fg: getColors().textLabel });
      expect(currentRenderedHint()?.segments).toContainEqual({ text: " select", fg: getColors().textSubtle });

      setFocusedIndex(null);
      contextValue.setState("pendingQueue", [queued[1]]);
      setEditingItem({ ...queued[0], originalIndex: 0 });
      await app.renderOnce();
      frame = app.captureCharFrame();
      expect(frame).toContain("⏸ Queue (2/10)");
      expect(frame).not.toContain("Queue editing");
      expect(frame).not.toContain("— #");
      expect(currentRenderedHint()?.segments).toContainEqual({ text: "shift+enter", fg: getColors().textLabel });
      expect(currentRenderedHint()?.segments).toContainEqual({ text: " newline", fg: getColors().textSubtle });
    } finally {
      app?.renderer.destroy();
    }
  });

  test("reorders queued prompts without an OpenTUI self-anchor insert warning", async () => {
    const contextValue = createAppStateValue(process.cwd());
    contextValue.setState("pendingQueue", queue("queued one", "queued two", "queued three"));
    let focusedIndex: number | null = 2;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    let app: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      app = await testRender(
        () => (
          <AppContext.Provider value={contextValue}>
            <box width="100%" height="100%" flexDirection="column">
              <QueueDisplay focusedIndex={() => focusedIndex} maxSize={10} />
            </box>
          </AppContext.Provider>
        ),
        { width: 100, height: 12, targetFps: 30 },
      );

      await app.renderOnce();
      expect(app.captureCharFrame()).toContain("Queued prompt #3 · queued three");

      const result = moveQueuedPrompt(contextValue.state.pendingQueue, 2, -1);
      expect(result.moved).toBe(true);
      focusedIndex = result.focusIndex;
      contextValue.setState("pendingQueue", result.queue);
      await app.renderOnce();

      let frame = app.captureCharFrame();
      expect(frame).toContain("Queued prompt #1 · queued one");
      expect(frame).toContain("Queued prompt #2 · queued three");
      expect(frame).toContain("Queued prompt #3 · queued two");

      if (focusedIndex === null) throw new Error("Expected moved queued prompt to remain focused");
      const reverseResult = moveQueuedPrompt(contextValue.state.pendingQueue, focusedIndex, 1);
      expect(reverseResult.moved).toBe(true);
      focusedIndex = reverseResult.focusIndex;
      contextValue.setState("pendingQueue", reverseResult.queue);
      await app.renderOnce();

      frame = app.captureCharFrame();
      expect(frame).toContain("Queued prompt #1 · queued one");
      expect(frame).toContain("Queued prompt #2 · queued two");
      expect(frame).toContain("Queued prompt #3 · queued three");
      expectNoSelfAnchorWarnings(warnings);
    } finally {
      console.warn = originalWarn;
      app?.renderer.destroy();
    }
  });
});
