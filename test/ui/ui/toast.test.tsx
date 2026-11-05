import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { parseColor } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { getTheme } from "../../../src/config/themes";
import {
  createToastValue,
  Toast,
  ToastContext,
  type ToastContextValue,
  type ToastMessage,
} from "../../../src/ui/ui/toast";
import { setShowToast, showToast } from "../../../src/ui/app/toast-controller";

function staticToastValue(initialMessage: ToastMessage): ToastContextValue {
  const [message, setMessage] = createSignal<ToastMessage | null>(initialMessage);
  return {
    message,
    show: (text, variant = "info") => setMessage({ text, variant }),
    clear: () => setMessage(null),
  };
}

async function captureToastRows(initialMessage: ToastMessage, width: number): Promise<string[]> {
  const colors = getTheme("github-dark").colors;
  const toastValue = staticToastValue(initialMessage);
  const app = await testRender(
    () => (
      <ToastContext.Context.Provider value={toastValue}>
        <box width="100%" height="100%">
          <Toast colors={colors} />
        </box>
      </ToastContext.Context.Provider>
    ),
    { width, height: 8, targetFps: 30 },
  );

  try {
    await app.renderOnce();
    return app.captureCharFrame().split("\n");
  } finally {
    app.renderer.destroy();
  }
}

describe("toast controller", () => {
  test("an older registration cleanup does not clear the active toast callback", () => {
    const messages: string[] = [];
    const clearFirst = setShowToast((text) => messages.push(`first:${text}`));
    const clearSecond = setShowToast((text) => messages.push(`second:${text}`));

    clearFirst();
    showToast("still active");
    expect(messages).toEqual(["second:still active"]);

    clearSecond();
    showToast("ignored");
    expect(messages).toEqual(["second:still active"]);
  });

  test("tracks registration ownership when the same callback is registered twice", () => {
    const messages: string[] = [];
    const callback = (text: string) => messages.push(text);
    const clearFirst = setShowToast(callback);
    const clearSecond = setShowToast(callback);

    clearFirst();
    showToast("still active");
    expect(messages).toEqual(["still active"]);

    clearSecond();
    showToast("ignored");
    expect(messages).toEqual(["still active"]);
  });
});

describe("createToastValue", () => {
  test("show replaces current message and clear removes it", () => {
    createRoot((dispose) => {
      const toast = createToastValue();
      toast.show("one");
      expect(toast.message()).toEqual({ text: "one", variant: "info" });
      toast.show("two", "warning");
      expect(toast.message()).toEqual({ text: "two", variant: "warning" });
      toast.clear();
      expect(toast.message()).toBeNull();
      dispose();
    });
  });

  test("auto-dismisses after duration", async () => {
    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const toast = createToastValue();
        toast.show("short", "info", 1);
        expect(toast.message()?.text).toBe("short");
        setTimeout(() => {
          expect(toast.message()).toBeNull();
          dispose();
          resolve();
        }, 5);
      });
    });
  });
});

describe("Toast", () => {
  test("renders info as a one-row status pill", async () => {
    const rows = await captureToastRows({ text: "Saved changes", variant: "info" }, 50);

    expect(rows[1]).toContain("※ Saved changes");
    expect(rows[2]).not.toContain("Saved changes");
    expect(rows.join("\n")).not.toContain("┌");
  });

  test("uses an app-background cutout surface over user-message panels", async () => {
    const colors = getTheme("github-dark").colors;
    const toastValue = staticToastValue({ text: "Cutout toast", variant: "info" });
    const app = await testRender(
      () => (
        <ToastContext.Context.Provider value={toastValue}>
          <box width="100%" height="100%" backgroundColor={colors.panelUser}>
            <Toast colors={colors} />
          </box>
        </ToastContext.Context.Provider>
      ),
      { width: 50, height: 8, targetFps: 30 },
    );

    try {
      await app.renderOnce();
      const toastSpan = app
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text.includes("Cutout toast"));
      expect(toastSpan).toBeDefined();
      expect(toastSpan?.bg.toString()).toBe(parseColor(colors.bg).toString());
      expect(toastSpan?.bg.toString()).not.toBe(parseColor(colors.panelUser).toString());
    } finally {
      app.renderer.destroy();
    }
  });

  test("labels warnings without expanding vertically", async () => {
    const rows = await captureToastRows({ text: "Preference was not saved", variant: "warning" }, 54);

    expect(rows[1]).toContain("⚠ Warning  Preference was not saved");
    expect(rows[2]).not.toContain("Preference was not saved");
  });

  test("renders errors with a square symbol", async () => {
    const rows = await captureToastRows({ text: "Install failed", variant: "error" }, 54);

    expect(rows[1]).toContain("■ Error  Install failed");
  });

  test("wraps long messages inside the available corner width", async () => {
    const rows = await captureToastRows(
      {
        text: "Opening https://example.com/really/long/path/that/should/not/wrap",
        variant: "info",
      },
      34,
    );

    expect(rows[1]).toContain("Opening https://");
    expect(rows.join("\n")).toContain("really/long");
  });

  test("keeps important warning guidance readable on normal-width terminals", async () => {
    const rows = await captureToastRows(
      { text: "Only ordinary prompts can be added to the current turn", variant: "warning" },
      100,
    );

    expect(rows[1]).toContain("Only ordinary prompts can be added to the current turn");
  });

  test("prioritizes message text over labels in very narrow terminals", async () => {
    const rows = await captureToastRows({ text: "abcdef", variant: "warning" }, 12);

    expect(rows[1]).toContain("⚠ abcd");
    expect(rows.join("\n")).toContain("ef");
    expect(rows[1]).not.toContain("War");
  });
});
