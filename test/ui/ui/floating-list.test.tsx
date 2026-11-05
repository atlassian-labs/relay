import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Config, resetConfig, setConfig } from "../../../src/config";
import { parseColor } from "@opentui/core";
import { testRender } from "@opentui/solid";
import type { ListItem } from "../../../src/ui/autocomplete";
import { subagentListItems } from "../../../src/ui/app/subagents";
import { FloatingList } from "../../../src/ui/component/floating-list";
import { getColors } from "../../../src/ui/context/theme";
import type { ToolBlock } from "../../../src/ui/state";

describe("FloatingList", () => {
  beforeEach(() => setConfig(new Config({})));
  afterEach(() => resetConfig());

  test("frames top-positioned panels with muted text borders", async () => {
    const colors = getColors();
    const items: ListItem<string>[] = [
      { value: "new", label: "/new", description: "start new thread" },
      { value: "review", label: "/review", description: "review changes" },
    ];
    let app: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      app = await testRender(
        () => (
          <box width="100%" height="100%" backgroundColor={colors.bg}>
            <FloatingList
              visible={() => true}
              items={() => items}
              selectedIndex={() => 1}
              layout={() => ({
                labelMinWidth: 7,
                labelMaxWidth: 20,
                descriptionMaxWidth: 20,
                viewportReservedWidth: 0,
              })}
              maxVisible={3}
              panelPosition="top"
            />
          </box>
        ),
        { width: 60, height: 12, targetFps: 30 },
      );

      await app.renderOnce();
      const frame = app.captureCharFrame();
      const spans = app.captureSpans().lines.flatMap((line) => line.spans);
      const selectedSpan = spans.find((span) => span.text.includes("/review"));
      const footerSpan = spans.find((span) => span.text.includes("(2/2)"));

      const borderSpans = spans.filter((span) => span.text.includes("─"));

      expect(frame).toContain("→ /review");
      expect(frame).not.toContain("━");
      expect(borderSpans).toHaveLength(2);
      expect(borderSpans.every((span) => span.text.length === 60)).toBe(true);
      expect(borderSpans.every((span) => span.fg.toString() === parseColor(colors.textMuted).toString())).toBe(true);
      expect(borderSpans.every((span) => span.bg.toString() === parseColor(colors.panel).toString())).toBe(true);
      expect(frame).toContain("↑/↓ navigate · enter select · esc close");
      expect(footerSpan?.text.startsWith("  (2/2)")).toBe(true);
      expect(footerSpan?.text.startsWith("   (2/2)")).toBe(false);
      expect(selectedSpan).toBeDefined();
      expect(selectedSpan?.fg.toString()).toBe(parseColor(colors.selected).toString());
      expect(selectedSpan?.bg.toString()).toBe(parseColor(colors.panel).toString());
      expect(footerSpan).toBeDefined();
      expect(footerSpan?.fg.toString()).toBe(parseColor(colors.textSubtle).toString());
      expect(footerSpan?.bg.toString()).toBe(parseColor(colors.panel).toString());
    } finally {
      app?.renderer.destroy();
    }
  });

  test("uses the standard selected-row tint for subagent items", async () => {
    const colors = getColors();
    const subagent: ToolBlock = {
      type: "tool",
      id: "invoke-reviewer",
      toolCallId: "invoke-reviewer",
      toolName: "invoke_agent",
      display: "",
      status: "running",
      rawInput: {
        agent: "reviewer",
        message: "Review the selected-row treatment in the subagent picker before approving it.",
      },
      subagent: {
        invokingToolCallId: "invoke-reviewer",
        childSessionId: "subagent-reviewer",
        agentName: "reviewer",
        status: "running",
        progress: [],
        startedAt: 1_000,
      },
    };
    const items = subagentListItems([subagent], 3_000);
    let app: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      app = await testRender(
        () => (
          <box width="100%" height="100%" backgroundColor={colors.bg}>
            <FloatingList
              visible={() => true}
              items={() => items}
              selectedIndex={() => 0}
              layout={() => ({
                labelMinWidth: 20,
                labelMaxWidth: 48,
                descriptionMaxWidth: 80,
                viewportReservedWidth: 4,
              })}
              maxVisible={2}
              panelPosition="top"
            />
          </box>
        ),
        { width: 120, height: 10, targetFps: 30 },
      );

      await app.renderOnce();
      const frame = app.captureCharFrame();
      const spans = app.captureSpans().lines.flatMap((line) => line.spans);
      const reviewerSpan = spans.find((span) => span.text.startsWith("reviewer"));

      expect(items[0]?.label.startsWith("reviewer (Review the selected-row")).toBe(true);
      expect(items[0]?.label.endsWith("…)")).toBe(true);
      expect(frame).toContain("reviewer (Review the selected-row");
      expect(frame).toContain("running · subagent-reviewer · 2s");
      expect(frame).not.toContain("■");
      expect(reviewerSpan?.fg.toString()).toBe(parseColor(colors.selected).toString());
    } finally {
      app?.renderer.destroy();
    }
  });

  test("removes the selected-row and footer prefix when the selection marker is disabled", async () => {
    setConfig(new Config({ ui: { selection_marker: "" } }));
    const colors = getColors();
    const items: ListItem<string>[] = [
      { value: "new", label: "/new", description: "start new thread" },
      { value: "review", label: "/review", description: "review changes" },
    ];
    let app: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      app = await testRender(
        () => (
          <box width="100%" height="100%" backgroundColor={colors.bg}>
            <FloatingList
              visible={() => true}
              items={() => items}
              selectedIndex={() => 1}
              layout={() => ({
                labelMinWidth: 7,
                labelMaxWidth: 20,
                descriptionMaxWidth: 20,
                viewportReservedWidth: 0,
              })}
              maxVisible={2}
              panelPosition="top"
            />
          </box>
        ),
        { width: 60, height: 8, targetFps: 30 },
      );

      await app.renderOnce();
      const spans = app.captureSpans().lines.flatMap((line) => line.spans);
      const footerSpan = spans.find((span) => span.text.includes("(2/2)"));

      expect(app.captureCharFrame()).not.toContain("→ /review");
      expect(footerSpan?.text.startsWith("(2/2)")).toBe(true);
    } finally {
      app?.renderer.destroy();
    }
  });

  test("aligns structured description columns and gives remaining width to labels", async () => {
    const colors = getColors();
    const items: ListItem<string>[] = [
      {
        value: "short",
        label: "short title",
        description: "1m · shortrepo",
        descriptionColumns: ["1m", "shortrepo"],
      },
      {
        value: "long",
        label: "a very long title that should truncate here",
        description: "12h · extremely-long-workspace-name",
        descriptionColumns: ["12h", "extremely-long-workspace-name"],
      },
    ];
    let app: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      app = await testRender(
        () => (
          <box width="100%" height="100%" backgroundColor={colors.bg}>
            <FloatingList
              visible={() => true}
              items={() => items}
              selectedIndex={() => 1}
              layout={() => ({
                labelMinWidth: 0,
                labelMaxWidth: Number.MAX_SAFE_INTEGER,
                descriptionMaxWidth: 80,
                viewportReservedWidth: 0,
                descriptionColumns: [{ align: "left" }, { maxWidth: 18, align: "left" }],
              })}
              maxVisible={2}
            />
          </box>
        ),
        { width: 60, height: 6, targetFps: 30 },
      );

      await app.renderOnce();
      const frame = app.captureCharFrame();

      expect(frame).toContain("12h · extremely-long-...");
      expect(frame).toContain("a very long title that sho...");
    } finally {
      app?.renderer.destroy();
    }
  });

  test("uses theme colors for item tones even when selected", async () => {
    const colors = getColors();
    const items: ListItem<string>[] = [
      { value: "user", label: "• user: message", description: "", tone: "accent", tonePrefixLength: 8 },
      {
        value: "assistant",
        label: "• assistant: message",
        description: "",
        tone: "success",
        tonePrefixLength: 13,
      },
      { value: "tool", label: "tool call", description: "", tone: "muted" },
    ];
    let app: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      app = await testRender(
        () => (
          <box width="100%" height="100%" backgroundColor={colors.bg}>
            <FloatingList
              visible={() => true}
              items={() => items}
              selectedIndex={() => 1}
              layout={() => ({
                labelMinWidth: 0,
                labelMaxWidth: 30,
                descriptionMaxWidth: 0,
                viewportReservedWidth: 0,
              })}
              maxVisible={3}
            />
          </box>
        ),
        { width: 50, height: 6, targetFps: 30 },
      );

      await app.renderOnce();
      const spans = app.captureSpans().lines.flatMap((line) => line.spans);
      expect(spans.find((span) => span.text.includes("• user:"))?.fg.toString()).toBe(
        parseColor(colors.accent).toString(),
      );
      expect(spans.find((span) => span.text.includes("• assistant:"))?.fg.toString()).toBe(
        parseColor(colors.success).toString(),
      );
      expect(spans.filter((span) => span.text.includes("message")).map((span) => span.fg.toString())).toEqual([
        parseColor(colors.fg).toString(),
        parseColor(colors.fg).toString(),
      ]);
      expect(spans.find((span) => span.text.includes("tool call"))?.fg.toString()).toBe(
        parseColor(colors.textSubtle).toString(),
      );
    } finally {
      app?.renderer.destroy();
    }
  });

  test("truncates long labels with an ellipsis", async () => {
    const colors = getColors();
    const items: ListItem<string>[] = [
      { value: "long", label: "abcdefghijklmnop", description: "" },
      { value: "short", label: "short", description: "" },
    ];
    let app: Awaited<ReturnType<typeof testRender>> | undefined;

    try {
      app = await testRender(
        () => (
          <box width="100%" height="100%" backgroundColor={colors.bg}>
            <FloatingList
              visible={() => true}
              items={() => items}
              selectedIndex={() => 0}
              layout={() => ({
                labelMinWidth: 0,
                labelMaxWidth: 8,
                descriptionMaxWidth: 20,
                viewportReservedWidth: 0,
              })}
              maxVisible={2}
            />
          </box>
        ),
        { width: 40, height: 6, targetFps: 30 },
      );

      await app.renderOnce();
      const frame = app.captureCharFrame();

      expect(frame).toContain("abcde...");
    } finally {
      app?.renderer.destroy();
    }
  });
});
