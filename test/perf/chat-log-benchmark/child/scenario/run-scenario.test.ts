import { afterEach, describe, expect, test } from "bun:test";
import { createAppStateValue } from "../../../../../src/ui/context/app-state";
import { applyTailStreamingUpdate } from "../../../../../scripts/perf/chat-log-benchmark/child/scenario/run-scenario";
import { store } from "../../../../../src/ui/app/runtime-store";

afterEach(() => {
  store.threadTranscriptViews.clear();
});

describe("chat log benchmark scenario runner", () => {
  test("streams tail chunks through ACP mapping and retains content items", () => {
    const appState = createAppStateValue("/tmp/relay-chat-log-benchmark", { transcriptPagingEnabled: true });
    appState.setState("activeThreadId", "benchmark-thread");
    appState.replaceBlocks([{ type: "content", id: "tail", content: "start", finalized: false }]);
    appState.setCurrentBlockId("tail");
    appState.setState("running", true);
    appState.setState("spinnerActive", true);

    applyTailStreamingUpdate(appState, 3);

    const tail = appState.state.blocks.at(-1);
    expect(tail).toBeDefined();
    expect(tail?.type).toBe("content");
    if (tail?.type !== "content") throw new Error("Expected a content tail block");
    expect(tail.content).toBe("start 3");
    expect(tail.finalized).toBe(false);
    expect([...tail.contentItems!]).toEqual([{ type: "text", text: " 3" }]);

    const view = store.threadTranscriptViews.get("benchmark-thread");
    expect(view?.pageIndex.pages().flatMap((page) => page.blockIds)).toEqual(["tail"]);
    expect(view?.pageIndex.pageForBlock("tail")).toMatchObject({ dynamic: true, finalized: false });
  });
});
