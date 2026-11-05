import { describe, expect, test } from "bun:test";
import { createTextAttributes, parseColor } from "@opentui/core";
import { testRender } from "@opentui/solid";
import type { ThreadInfo } from "../../../src/core/threads";
import type { RelayWidgetEntry } from "../../../src/plugins/slots";
import type { RelayWidgetRenderContext } from "../../../src/plugins/types";
import { ThreadSidebar } from "../../../src/ui/component/thread-sidebar";
import { getColors } from "../../../src/ui/context/theme";

function noOp(): void {}

function thread(id: string, title: string, overrides: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id,
    title,
    sessionId: null,
    cwd: process.cwd(),
    workspaceKind: "local",
    status: "paused",
    archived: false,
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("ThreadSidebar compact thread rows", () => {
  test("renders icon rows with one space before the thread title", async () => {
    const app = await testRender(
      () => (
        <box width="100%" height="100%">
          <ThreadSidebar
            threads={() => [
              thread("draft", "New thread", { updatedAt: "2026-07-02T00:00:03.000Z" }),
              thread("export", "Export markdown", { updatedAt: "2026-07-02T00:00:01.000Z" }),
              thread("fix-duplicate", "Fix auth flow duplicate", {
                sessionId: "session-fix",
                updatedAt: "2026-07-02T00:00:01.500Z",
              }),
              thread("fix", "Fix auth flow", {
                sessionId: "session-fix",
                workspaceKind: "worktree",
                worktreeBranch: "feat/acp-refactor",
                status: "running",
                updatedAt: "2026-07-02T00:00:02.000Z",
              }),
            ]}
            activeThreadId={() => "fix"}
            focused={() => false}
            focusedIndex={() => 0}
            expanded={() => false}
            width={() => 32}
            listOffset={() => 0}
            spinnerChar={() => "⠋"}
            getPreview={() => ""}
            onSelect={noOp}
            onCreateLocal={noOp}
            onCreateWorktree={noOp}
            onCreateExistingWorktree={noOp}
            onArchive={noOp}
          />
        </box>
      ),
      { width: 50, height: 16, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const frame = app.captureCharFrame();
      expect(frame).toContain("Threads");
      expect(frame.indexOf("Threads")).toBeLessThan(frame.indexOf("+ local"));
      const lines = frame.split("\n");
      const threadsLineIndex = lines.findIndex((line) => line.includes("Threads"));
      expect(lines[threadsLineIndex + 1]).not.toContain("+ local");
      expect(lines[threadsLineIndex + 2]).toContain("+ local");
      expect(frame).not.toContain("New thread");
      expect(frame).not.toContain("Fix auth flow duplicate");
      expect(frame).toContain("⠋ Fix auth flow");
      expect(frame).not.toContain("⠋  Fix auth flow");
      expect(frame).toContain("running · feat/acp-refacto");
      expect(frame).toContain("• Export markdown");
      expect(frame).not.toContain("•  Export markdown");
      expect(frame).toContain("input · local");
    } finally {
      app.renderer.destroy();
    }
  });

  test("styles only the focused action row like a turn-update label", async () => {
    const app = await testRender(
      () => (
        <box width="100%" height="100%">
          <ThreadSidebar
            threads={() => []}
            activeThreadId={() => ""}
            focused={() => true}
            focusedIndex={() => -2}
            expanded={() => false}
            width={() => 32}
            listOffset={() => 0}
            spinnerChar={() => "⠋"}
            getPreview={() => ""}
            onSelect={noOp}
            onCreateLocal={noOp}
            onCreateWorktree={noOp}
            onCreateExistingWorktree={noOp}
            onArchive={noOp}
          />
        </box>
      ),
      { width: 50, height: 12, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const spans = app.captureSpans().lines.flatMap((line) => line.spans);
      const localSpan = spans.find((span) => span.text.includes("+ local"));
      const newWorktreeSpan = spans.find((span) => span.text.includes("+ new worktree"));
      const existingWorktreeSpan = spans.find((span) => span.text.includes("+ existing worktree"));
      const colors = getColors();
      const bold = createTextAttributes({ bold: true });

      expect(localSpan?.fg.toString()).toBe(parseColor(colors.badge.label).toString());
      expect(localSpan?.attributes).toBe(bold);
      expect(newWorktreeSpan?.fg.toString()).toBe(parseColor(colors.textMuted).toString());
      expect(newWorktreeSpan?.attributes).not.toBe(bold);
      expect(existingWorktreeSpan?.fg.toString()).toBe(parseColor(colors.textMuted).toString());
      expect(existingWorktreeSpan?.attributes).not.toBe(bold);
      expect(localSpan?.bg.toString()).toBe(newWorktreeSpan?.bg.toString());
    } finally {
      app.renderer.destroy();
    }
  });

  test("styles only the focused compact thread marker, title, and caption like a turn-update label", async () => {
    const app = await testRender(
      () => (
        <box width="100%" height="100%">
          <ThreadSidebar
            threads={() => [
              thread("selected", "Selected thread", { updatedAt: "2026-07-02T00:00:02.000Z" }),
              thread("active", "Active thread", { updatedAt: "2026-07-02T00:00:01.000Z" }),
            ]}
            activeThreadId={() => "active"}
            focused={() => true}
            focusedIndex={() => 0}
            expanded={() => false}
            width={() => 32}
            listOffset={() => 0}
            spinnerChar={() => "⠋"}
            getPreview={() => ""}
            onSelect={noOp}
            onCreateLocal={noOp}
            onCreateWorktree={noOp}
            onCreateExistingWorktree={noOp}
            onArchive={noOp}
          />
        </box>
      ),
      { width: 50, height: 12, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const spans = app.captureSpans().lines.flatMap((line) => line.spans);
      const selectedMarkerSpan = spans.find((span) => span.text.includes("•"));
      const selectedSpan = spans.find((span) => span.text.includes("Selected thread"));
      const selectedCaptionSpan = spans.find((span) => span.text.includes("input · local"));
      const activeSpan = spans.find((span) => span.text.includes("Active thread"));
      const colors = getColors();
      const bold = createTextAttributes({ bold: true });
      const selectedColor = parseColor(colors.badge.label).toString();

      expect(selectedMarkerSpan?.fg.toString()).toBe(selectedColor);
      expect(selectedSpan?.fg.toString()).toBe(selectedColor);
      expect(selectedCaptionSpan?.fg.toString()).toBe(selectedColor);
      expect(selectedSpan?.attributes).toBe(bold);
      expect(activeSpan?.fg.toString()).toBe(parseColor(colors.textLabel).toString());
      expect(activeSpan?.attributes).not.toBe(bold);
      expect(selectedSpan?.bg.toString()).toBe(activeSpan?.bg.toString());
    } finally {
      app.renderer.destroy();
    }
  });

  test("colors the active paused tick like the active row status", async () => {
    const app = await testRender(
      () => (
        <box width="100%" height="100%">
          <ThreadSidebar
            threads={() => [thread("active", "Active thread")]}
            activeThreadId={() => "active"}
            focused={() => false}
            focusedIndex={() => 0}
            expanded={() => false}
            width={() => 32}
            listOffset={() => 0}
            spinnerChar={() => "⠋"}
            getPreview={() => ""}
            onSelect={noOp}
            onCreateLocal={noOp}
            onCreateWorktree={noOp}
            onCreateExistingWorktree={noOp}
            onArchive={noOp}
          />
        </box>
      ),
      { width: 50, height: 12, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const spans = app.captureSpans().lines.flatMap((line) => line.spans);
      const tickSpan = spans.find((span) => span.text.includes("✓"));
      const statusSpan = spans.find((span) => span.text.includes("paused · local"));
      expect(tickSpan).toBeDefined();
      expect(statusSpan).toBeDefined();
      expect(tickSpan?.fg.toString()).toBe(statusSpan?.fg.toString());
    } finally {
      app.renderer.destroy();
    }
  });

  test("colors inactive row dots like their row title", async () => {
    const app = await testRender(
      () => (
        <box width="100%" height="100%">
          <ThreadSidebar
            threads={() => [thread("inactive", "Inactive thread")]}
            activeThreadId={() => "other"}
            focused={() => false}
            focusedIndex={() => 0}
            expanded={() => false}
            width={() => 32}
            listOffset={() => 0}
            spinnerChar={() => "⠋"}
            getPreview={() => ""}
            onSelect={noOp}
            onCreateLocal={noOp}
            onCreateWorktree={noOp}
            onCreateExistingWorktree={noOp}
            onArchive={noOp}
          />
        </box>
      ),
      { width: 50, height: 12, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const spans = app.captureSpans().lines.flatMap((line) => line.spans);
      const dotSpan = spans.find((span) => span.text.includes("•"));
      const titleSpan = spans.find((span) => span.text.includes("Inactive thread"));
      expect(dotSpan).toBeDefined();
      expect(titleSpan).toBeDefined();
      expect(dotSpan?.fg.toString()).toBe(titleSpan?.fg.toString());
    } finally {
      app.renderer.destroy();
    }
  });
});

describe("ThreadSidebar expanded thread cards", () => {
  test("uses the same status icons and short labels as compact rows", async () => {
    const app = await testRender(
      () => (
        <box width="100%" height="100%">
          <ThreadSidebar
            threads={() => [
              thread("active", "Active thread", { updatedAt: "2026-07-02T00:00:02.000Z" }),
              thread("waiting", "Waiting thread", { updatedAt: "2026-07-02T00:00:01.000Z" }),
            ]}
            activeThreadId={() => "active"}
            focused={() => true}
            focusedIndex={() => 1}
            expanded={() => true}
            width={() => 70}
            listOffset={() => 0}
            spinnerChar={() => "⠋"}
            getPreview={() => ""}
            onSelect={noOp}
            onCreateLocal={noOp}
            onCreateWorktree={noOp}
            onCreateExistingWorktree={noOp}
            onArchive={noOp}
          />
        </box>
      ),
      { width: 90, height: 18, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const frame = app.captureCharFrame();
      const spans = app.captureSpans().lines.flatMap((line) => line.spans);
      const activeSpan = spans.find((span) => span.text.includes("Active thread"));
      const waitingSpan = spans.find((span) => span.text.includes("Waiting thread"));
      const bold = createTextAttributes({ bold: true });
      expect(frame).toContain("Agents");
      expect(frame).toContain("✓ Active thread");
      expect(frame).toContain("• Waiting thread");
      expect(frame).toContain("input");
      expect(frame).not.toContain("› Active thread");
      expect(frame).not.toContain("● awaiting input");
      expect(frame).not.toContain("awaiting input");
      expect(waitingSpan?.fg.toString()).toBe(parseColor(getColors().badge.label).toString());
      expect(waitingSpan?.attributes).toBe(bold);
      expect(activeSpan?.fg.toString()).toBe(parseColor(getColors().fg).toString());
      expect(activeSpan?.attributes).not.toBe(bold);
    } finally {
      app.renderer.destroy();
    }
  });
});

describe("ThreadSidebar plugin widgets", () => {
  test("renders sidebar widgets and passes sidebar render context", async () => {
    let seenContext: RelayWidgetRenderContext | undefined;
    const widgets: RelayWidgetEntry[] = [
      {
        plugin: { id: "plugin:sidebar", name: "Sidebar", path: "sidebar.ts" },
        key: "panel",
        order: 1,
        focused: false,
        hidden: false,
        widget: {
          placement: "sidebar",
          title: "Plugin panel",
          height: 2,
          render(ctx) {
            seenContext = ctx;
            return [{ text: "plugin sidebar line" }, { text: "second sidebar line" }, { text: "hidden sidebar line" }];
          },
        },
      },
    ];

    const app = await testRender(
      () => (
        <box width="100%" height="100%">
          <ThreadSidebar
            threads={() => [thread("thread-1", "Active thread")]}
            activeThreadId={() => "thread-1"}
            focused={() => false}
            focusedIndex={() => 0}
            expanded={() => false}
            width={() => 32}
            listOffset={() => 0}
            spinnerChar={() => "⠋"}
            getPreview={() => ""}
            onSelect={noOp}
            onCreateLocal={noOp}
            onCreateWorktree={noOp}
            onCreateExistingWorktree={noOp}
            onArchive={noOp}
            pluginWidgets={() => widgets}
          />
        </box>
      ),
      { width: 50, height: 14, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const frame = app.captureCharFrame();
      expect(frame).toContain("Plugin panel");
      expect(frame).toContain("plugin sidebar line");
      expect(frame).toContain("second sidebar line");
      expect(frame).not.toContain("hidden sidebar line");
      expect(seenContext).toMatchObject({ placement: "sidebar", width: 30, height: 2 });
      expect(seenContext?.colors).toBeDefined();
    } finally {
      app.renderer.destroy();
    }
  });
});
