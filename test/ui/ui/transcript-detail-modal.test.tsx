import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createAppStateValue } from "../../../src/ui/context/app-state";
import { TranscriptDetailModal } from "../../../src/ui/component/transcript-detail-modal";
import { AppContext } from "../../../src/ui/state";
import { ToastProvider } from "../../../src/ui/ui/toast";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("transcript detail modal", () => {
  test("shows full tool parameters and results", async () => {
    const appState = createAppStateValue(process.cwd());
    appState.addBlock({
      id: "tool-detail",
      type: "tool",
      toolName: "grep",
      toolCallId: "call-detail",
      display: "",
      status: "success",
      rawInput: { query: "selected text" },
      rawOutput: "full result text",
    });
    appState.setState("transcriptSelectedBlockId", "tool-detail");
    appState.setState("transcriptDetailBlockId", "tool-detail");
    let closeCount = 0;
    const rendered = await testRender(
      () => (
        <ToastProvider>
          <AppContext.Provider value={appState}>
            <TranscriptDetailModal
              activeProfile={() => "default"}
              open={() => true}
              onClose={() => {
                closeCount += 1;
              }}
            />
          </AppContext.Provider>
        </ToastProvider>
      ),
      { width: 100, height: 30 },
    );
    await flush();

    const frame = rendered.captureCharFrame();
    expect(frame).toContain("Grep");
    expect(frame).toContain("Params");
    expect(frame).toContain("selected text");
    expect(frame).toContain("Result");
    expect(frame).toContain("full result text");
    expect(frame).toContain("← close · ↑/↓ scroll · pgup/pgdn scroll · ctrl+c copy");

    rendered.renderer.keyInput.emit("keypress", {
      name: "left",
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      alt: false,
      preventDefault() {},
      stopPropagation() {},
    } as Parameters<typeof rendered.renderer.keyInput.emit>[1]);
    expect(closeCount).toBe(1);

    rendered.renderer.destroy();
  });

  test("shows system reminders attached to expanded user messages", async () => {
    const appState = createAppStateValue(process.cwd());
    appState.addBlock({
      id: "user-detail",
      type: "user",
      content: "Please inspect the changed files",
      contentItems: [
        { type: "text", text: "Please inspect the changed files" },
        { type: "text", text: "system-reminder: Check the git diff before responding." },
      ],
    });
    appState.setState("transcriptSelectedBlockId", "user-detail");
    appState.setState("transcriptDetailBlockId", "user-detail");
    const rendered = await testRender(
      () => (
        <ToastProvider>
          <AppContext.Provider value={appState}>
            <TranscriptDetailModal activeProfile={() => "default"} open={() => true} onClose={() => {}} />
          </AppContext.Provider>
        </ToastProvider>
      ),
      { width: 100, height: 30 },
    );
    await flush();

    const frame = rendered.captureCharFrame();
    expect(frame).toContain("Please inspect the changed files");
    expect(frame).toContain("[system-reminder]");
    expect(frame).toContain("Check the git diff before responding.");

    rendered.renderer.destroy();
  });
});
