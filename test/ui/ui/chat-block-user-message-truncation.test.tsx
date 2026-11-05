import { describe, expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { ChatBlockView } from "../../../src/ui/component/blocks/chat-block";
import { blendHexColors } from "../../../src/config/themes";
import { getColors } from "../../../src/ui/context/theme";
import { createAppStateValue } from "../../../src/ui/context/app-state";
import { AppContext } from "../../../src/ui/state";
import { ToastContext, type ToastContextValue } from "../../../src/ui/ui/toast";
import { setClipboardOscWriter } from "../../../src/ui/util/clipboard";
import type { ElicitationBlock, MessageContentItem } from "../../../src/ui/state";

type RenderedUserBlock = Awaited<ReturnType<typeof testRender>>;
type AppStateValue = ReturnType<typeof createAppStateValue>;

async function renderUserBlock(
  content: string,
  options: { width?: number; height?: number; contentItems?: MessageContentItem[] } = {},
): Promise<{ app: RenderedUserBlock; appState: AppStateValue; toasts: string[] }> {
  const width = options.width ?? 72;
  const height = options.height ?? 24;
  const appState = createAppStateValue(process.cwd());
  const toasts: string[] = [];
  const toastValue: ToastContextValue = {
    message: () => null,
    show: (text) => {
      toasts.push(text);
    },
    clear: () => {},
  };
  const app = await testRender(
    () => (
      <ToastContext.Context.Provider value={toastValue}>
        <AppContext.Provider value={appState}>
          <box width={width} height={height} flexDirection="column">
            <ChatBlockView
              block={{
                type: "user",
                id: "u1",
                content,
                ...(options.contentItems ? { contentItems: options.contentItems } : {}),
              }}
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
      </ToastContext.Context.Provider>
    ),
    { width, height },
  );

  await app.renderOnce();
  await app.flush();
  return { app, appState, toasts };
}

function numberedLines(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `USER-LINE-${String(index + 1).padStart(2, "0")}`);
}

type CapturedSpan = ReturnType<RenderedUserBlock["captureSpans"]>["lines"][number]["spans"][number];

function spanForText(app: RenderedUserBlock, text: string): { span: CapturedSpan; x: number; y: number } {
  const lines = app.captureSpans().lines;
  for (const [lineIndex, line] of lines.entries()) {
    let column = 0;
    for (const span of line.spans) {
      const textOffset = span.text.indexOf(text);
      if (textOffset >= 0) return { span, x: column + textOffset, y: lineIndex };
      column += span.width;
    }
  }
  throw new Error(`Missing span for ${text}`);
}

describe("chat block user message truncation", () => {
  test("keeps submitted user messages truncated without a global expansion shortcut", async () => {
    const content = numberedLines(14).join("\n");
    const { app } = await renderUserBlock(content);

    try {
      const frame = app.captureCharFrame();
      expect(frame).toContain("USER-LINE-01");
      expect(frame).toContain("USER-LINE-10");
      expect(frame).toContain("... (4 lines hidden)");
      expect(frame).not.toContain("USER-LINE-11");
      expect(frame).not.toContain("USER-LINE-14");
      expect(frame).not.toContain("ctrl+o");
    } finally {
      app.renderer.destroy();
    }
  });

  test("does not truncate submitted user messages at ten lines", async () => {
    const content = numberedLines(10).join("\n");
    const { app } = await renderUserBlock(content, { height: 18 });

    try {
      const frame = app.captureCharFrame();
      expect(frame).toContain("USER-LINE-10");
      expect(frame).not.toContain("lines hidden");
      expect(frame).not.toContain("ctrl+o to collapse");
    } finally {
      app.renderer.destroy();
    }
  });

  test("renders submitted user messages with dimmed background until hover", async () => {
    const content = "hover target";
    const colors = getColors();
    const { app } = await renderUserBlock(content, { height: 8 });

    try {
      const dimmed = spanForText(app, content);
      expect(dimmed.span.bg.toString()).toBe(parseColor(blendHexColors(colors.panelUser, colors.bg, 0.25)).toString());
      expect(dimmed.span.bg.toString()).not.toBe(
        parseColor(blendHexColors(colors.panelUser, colors.bg, 0.2)).toString(),
      );

      await app.mockMouse.moveTo(dimmed.x, dimmed.y);
      await app.renderOnce();
      await app.flush();

      expect(spanForText(app, content).span.bg.toString()).toBe(parseColor(colors.panelUser).toString());
    } finally {
      app.renderer.destroy();
    }
  });

  test("copies submitted user message text on click without copying drags", async () => {
    const content = "copy first line\ncopy second line";
    const { app, toasts } = await renderUserBlock(content, { height: 8 });
    const clipboardWrites: string[] = [];
    setClipboardOscWriter((data) => clipboardWrites.push(data));

    try {
      const { x, y } = spanForText(app, "copy first line");
      let copyPoint: { x: number; y: number } | null = null;
      for (let yOffset = -1; yOffset <= 2 && clipboardWrites.length === 0; yOffset += 1) {
        for (let xOffset = -1; xOffset <= 20 && clipboardWrites.length === 0; xOffset += 1) {
          const target = { x: Math.max(0, x + xOffset), y: Math.max(0, y + yOffset) };
          await app.mockMouse.moveTo(target.x, target.y);
          await app.renderOnce();
          await app.flush();
          await app.mockMouse.click(target.x, target.y);
          await app.renderOnce();
          await app.flush();
          if (clipboardWrites.length > 0) copyPoint = target;
        }
      }

      expect(copyPoint).not.toBeNull();
      if (copyPoint === null) throw new Error("copy target not found");
      expect(clipboardWrites).toHaveLength(1);
      expect(clipboardWrites.at(-1)).toContain(Buffer.from(content).toString("base64"));
      expect(toasts.filter((text) => text === "Copied to clipboard")).toHaveLength(1);

      clipboardWrites.length = 0;
      toasts.length = 0;
      await app.mockMouse.click(copyPoint.x, copyPoint.y, 0, { modifiers: { ctrl: true } });
      await app.renderOnce();
      await app.flush();

      expect(clipboardWrites).toEqual([]);
      expect(toasts).toEqual([]);

      await app.mockMouse.drag(2, y, 16, y);
      await app.renderOnce();
      await app.flush();

      expect(clipboardWrites).toEqual([]);
      expect(toasts).toEqual([]);
    } finally {
      setClipboardOscWriter(null);
      app.renderer.destroy();
    }
  });

  test("renders image attachments in their original inline positions", async () => {
    const content = "please compare [image #4 screen.png] with this\nthen inspect [image #5 clipboard.png]";
    const colors = getColors();
    const { app } = await renderUserBlock(content, { height: 12, width: 96 });

    try {
      const frame = app.captureCharFrame();
      const lines = frame.split("\n");
      const firstMarkerLineIndex = lines.findIndex((line) => line.includes("[image #4 screen.png]"));
      const secondMarkerLineIndex = lines.findIndex((line) => line.includes("[image #5 clipboard.png]"));
      const firstMarkerLine = lines[firstMarkerLineIndex] ?? "";
      const secondMarkerLine = lines[secondMarkerLineIndex] ?? "";

      expect(frame).toContain("please compare [image #4 screen.png] with this");
      expect(frame).toContain("then inspect [image #5 clipboard.png]");
      expect(frame.match(/\[image #/g)).toHaveLength(2);
      expect(firstMarkerLine).toContain("please compare [image #4 screen.png] with this");
      expect(secondMarkerLine).toContain("then inspect [image #5 clipboard.png]");
      expect(firstMarkerLine).not.toContain("[image #5 clipboard.png]");
      expect(secondMarkerLineIndex).toBe(firstMarkerLineIndex + 1);

      const spans = app.captureSpans().lines.flatMap((line) => line.spans);
      const attachmentSpan = spans.find((span) => span.text.includes("[image #4 screen.png]"));
      expect(attachmentSpan?.fg.toString()).toBe(parseColor(colors.bg).toString());
      expect(attachmentSpan?.bg.toString()).toBe(parseColor(colors.notice).toString());
    } finally {
      app.renderer.destroy();
    }
  });

  test("keeps system reminders collapsed without a global expansion shortcut", async () => {
    const content = "continue till the goal is complete";
    const { app } = await renderUserBlock(content, {
      height: 16,
      contentItems: [
        { type: "text", text: content },
        { type: "text", text: "system-reminder: REMINDER-LINE-1\nREMINDER-LINE-2" },
      ],
    });

    try {
      const frame = app.captureCharFrame();
      expect(frame).toContain(content);
      expect(frame).toContain("[system-reminder]");
      expect(frame).toContain("... (2 lines hidden)");
      expect(frame).not.toContain("REMINDER-LINE-1");
      expect(frame).not.toContain("REMINDER-LINE-2");
      expect(frame).not.toContain("ctrl+o");
    } finally {
      app.renderer.destroy();
    }
  });
});
