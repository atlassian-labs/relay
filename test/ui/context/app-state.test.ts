import { afterEach, describe, expect, test } from "bun:test";
import { createComputed, createEffect, createRoot } from "solid-js";
import { createAppStateValue } from "../../../src/ui/context/app-state";
import type { ThreadInfo } from "../../../src/core/threads";
import type { QueuedPrompt, ToolBlock } from "../../../src/ui/state";
import { promptTitleIntentFromText } from "../../../src/ui/util/user-message";
import { store } from "../../../src/ui/app/runtime-store";

function thread(id: string): ThreadInfo {
  return {
    id,
    title: "Thread",
    sessionId: null,
    cwd: "/tmp/project",
    workspaceKind: "local",
    status: "paused",
    archived: false,
  };
}

afterEach(() => {
  store.threadTranscriptViews.clear();
});

describe("createAppStateValue", () => {
  test("block actions mutate state", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");
      app.addBlock({ type: "content", id: "a", content: "hi", finalized: false });
      app.appendToBlock("a", " there");
      expect(app.state.blocks[0]).toMatchObject({ content: "hi there" });
      app.updateBlock("a", { finalized: true } as any);
      expect(app.state.blocks[0]).toMatchObject({ finalized: true });
      app.clearBlocks();
      expect(app.state.blocks).toEqual([]);
      dispose();
    });
  });

  test("subagent streaming updates preserve child nodes and do not invalidate hidden parent progress", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project", { transcriptPagingEnabled: true });
      app.setActiveThreadState(thread("thread-one"), [], []);
      const child = { type: "content", id: "child-answer", content: "start", finalized: false } as const;
      const parent: ToolBlock = {
        type: "tool",
        id: "invoke-scout",
        toolCallId: "invoke-scout",
        toolName: "invoke_agent",
        display: "",
        status: "running",
        subagent: {
          invokingToolCallId: "invoke-scout",
          childSessionId: "child-scout",
          status: "running",
          progress: [{ kind: "message", text: "start" }],
          blocks: [child],
          currentBlockId: child.id,
        },
      };
      app.addBlock(parent);
      const view = store.threadTranscriptViews.get("thread-one")!;
      const initialLayoutRevision = view.pageIndex.pageForBlock(parent.id)!.layoutRevision;

      const storedParent = app.state.blocks[0] as ToolBlock;
      const storedState = storedParent.subagent!;
      const storedBlocks = storedState.blocks!;
      const storedChild = storedBlocks[0];
      let parentProjectionRuns = 0;
      createComputed(() => {
        const block = app.state.blocks[0];
        if (block?.type !== "tool" || !block.subagent) return;
        void block.subagent.status;
        for (const item of block.subagent.progress) {
          if (item.kind !== "tool") continue;
          void item.text;
          void item.status;
        }
        parentProjectionRuns += 1;
      });
      expect(parentProjectionRuns).toBe(1);

      app.updateBlock(parent.id, {
        subagent: {
          ...storedState,
          progress: [{ kind: "message", text: "start continued" }],
          blocks: [{ ...child, content: "start continued" }],
        },
      });

      const updated = app.state.blocks[0] as ToolBlock;
      expect(updated).toBe(storedParent);
      expect(updated.subagent).toBe(storedState);
      expect(updated.subagent?.blocks).toBe(storedBlocks);
      expect(updated.subagent?.blocks?.[0]).toBe(storedChild);
      expect(updated.subagent?.blocks?.[0]).toMatchObject({ content: "start continued" });
      expect(parentProjectionRuns).toBe(1);
      expect(view.pageIndex.pageForBlock(parent.id)?.layoutRevision).toBe(initialLayoutRevision);

      app.updateBlock(parent.id, {
        subagent: {
          ...storedState,
          progress: [
            { kind: "message", text: "start continued" },
            { kind: "tool", text: "read", status: "running", toolCallId: "child-read" },
          ],
        },
      });
      expect(parentProjectionRuns).toBe(2);
      expect(view.pageIndex.pageForBlock(parent.id)?.layoutRevision).toBeGreaterThan(initialLayoutRevision);
      dispose();
    });
  });

  test("structural block actions keep the canonical lookup synchronized", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");
      app.appendBlock({ type: "user", id: "u1", content: "first" });
      app.appendBlock({ type: "content", id: "c1", content: "draft", finalized: false });
      app.insertBlock(1, { type: "info", id: "i1", content: "note", variant: "info" });

      expect(app.blockEntry("c1")).toMatchObject({ index: 2, block: { id: "c1" } });
      app.removeBlock("i1");
      expect(app.blockEntry("c1")).toMatchObject({ index: 1, block: { id: "c1" } });

      app.replaceBlocks([
        { type: "content", id: "c1", content: "replacement", finalized: false },
        { type: "info", id: "i2", content: "new", variant: "info" },
      ]);
      app.appendToBlock("c1", " streamed");

      expect(app.state.blocks).toEqual([
        { type: "content", id: "c1", content: "replacement streamed", finalized: false },
        { type: "info", id: "i2", content: "new", variant: "info" },
      ]);
      expect(app.blockEntry("c1")).toMatchObject({ index: 0, block: { content: "replacement streamed" } });
      dispose();
    });
  });

  test("setActiveThreadState installs the selected thread's prompt queue", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");
      app.setState("pendingQueue", [{ id: "old", text: "old queued prompt" }]);

      app.setActiveThreadState(thread("thread-two"), [], [{ id: "new", text: "thread two queued prompt" }]);

      expect(app.state.activeThreadId).toBe("thread-two");
      expect(app.state.pendingQueue).toEqual([{ id: "new", text: "thread two queued prompt" }]);
      dispose();
    });
  });

  test("setActiveThreadState clears the latest prompt title intent from the previous thread", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");
      app.setState("latestPromptTitleIntent", promptTitleIntentFromText("first thread task", null));

      app.setActiveThreadState(thread("thread-two"), [], []);

      expect(app.state.latestPromptTitleIntent).toBeNull();
      dispose();
    });
  });

  test("setActiveThreadState clears stale thinking capability state", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");
      app.setState("thinkingConfigId", "thought_level");
      app.setState("thinkingLevel", "high");
      app.setState("availableThinkingLevels", [{ id: "high", name: "High" }]);
      app.setState("sessionConfigOptions", [
        {
          id: "thought_level",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [{ value: "high", name: "High" }],
          raw: {},
        },
      ]);

      app.setActiveThreadState(thread("thread-two"), [], []);

      expect(app.state.thinkingConfigId).toBe("");
      expect(app.state.thinkingLevel).toBe("");
      expect(app.state.availableThinkingLevels).toEqual([]);
      expect(app.state.sessionConfigOptions).toEqual([]);
      dispose();
    });
  });

  test("setActiveThreadState clones structured skill queue metadata", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");
      const pendingQueue: QueuedPrompt[] = [
        {
          id: "skill-queued",
          kind: "skill",
          text: "expanded skill prompt",
          skill: {
            name: "git-publish",
            location: "/tmp/SKILL.md",
            content: "Publish branches.",
            blockText: "<skill>Publish branches.</skill>",
            userMessage: "main branch",
          },
        },
      ];

      app.setActiveThreadState(thread("thread-two"), [], pendingQueue);
      pendingQueue[0].skill!.userMessage = "mutated outside app state";

      expect(app.state.pendingQueue[0].skill?.userMessage).toBe("main branch");
      dispose();
    });
  });

  test("does not construct transcript paging state unless explicitly enabled", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");
      app.setActiveThreadState(thread("legacy-thread"), [], []);
      app.appendBlock({ type: "content", id: "stream", content: "", finalized: false });
      app.appendToBlock("stream", "one\ntwo");

      expect(app.state.blocks[0]).toMatchObject({ content: "one\ntwo" });
      expect(store.threadTranscriptViews.has("legacy-thread")).toBe(false);
      dispose();
    });
  });

  test("canonical block actions keep the active page index synchronized", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project", { transcriptPagingEnabled: true });
      app.setActiveThreadState(thread("thread-one"), [], []);
      app.appendBlock({ type: "user", id: "u1", content: "hello" });
      app.appendBlock({ type: "content", id: "c1", content: "draft", finalized: false });
      app.setCurrentBlockId("c1");
      app.appendToBlock("c1", " streamed");
      app.updateBlock("c1", { finalized: true });
      app.setCurrentBlockId(null);
      app.insertBlock(1, { type: "info", id: "i1", content: "note", variant: "info" });
      app.removeBlock("i1");

      const view = store.threadTranscriptViews.get("thread-one");
      expect(app.state.blocks[1]).toMatchObject({ content: "draft streamed", finalized: true });
      expect(view?.pageIndex.pages().flatMap((page) => page.blockIds)).toEqual(["u1", "c1"]);
      expect(view?.pageIndex.pageForBlock("c1")?.layoutRevision).toBeGreaterThan(0);

      const generation = view?.transcriptGeneration;
      app.replaceBlocks([{ type: "user", id: "u2", content: "replacement" }]);
      expect(view?.transcriptGeneration).toBe((generation ?? 0) + 1);
      expect(view?.pageIndex.pages().flatMap((page) => page.blockIds)).toEqual(["u2"]);
      dispose();
    });
  });

  test("keeps independent transcript view state across thread switches and resets it on replacement", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project", { transcriptPagingEnabled: true });
      const firstBlocks = [{ type: "user", id: "u1", content: "first" } as const];
      app.setActiveThreadState(thread("thread-one"), [...firstBlocks], []);
      const firstView = store.threadTranscriptViews.get("thread-one")!;
      firstView.setWindow({
        startPageId: firstView.pageIndex.pages()[0].id,
        endPageId: firstView.pageIndex.pages()[0].id,
      });
      firstView.setScrollAnchor({ pageId: firstView.pageIndex.pages()[0].id, offset: 2 });

      app.setActiveThreadState(thread("thread-two"), [{ type: "user", id: "u2", content: "second" }], []);
      const secondView = store.threadTranscriptViews.get("thread-two")!;
      expect(secondView).not.toBe(firstView);
      expect(firstView.window()).not.toBeNull();
      expect(firstView.scrollAnchor()).not.toBeNull();

      app.setActiveThreadState(thread("thread-one"), [...firstBlocks], []);
      expect(store.threadTranscriptViews.get("thread-one")).toBe(firstView);
      expect(firstView.window()).not.toBeNull();

      const generation = firstView.transcriptGeneration;
      app.replaceBlocks([{ type: "user", id: "replacement", content: "new session" }]);
      expect(firstView.transcriptGeneration).toBe(generation + 1);
      expect(firstView.window()).toBeNull();
      expect(firstView.scrollAnchor()).toBeNull();
      dispose();
    });
  });

  test("observers do not see mismatched canonical blocks and page membership", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project", { transcriptPagingEnabled: true });
      app.setActiveThreadState(thread("thread-one"), [], []);
      const snapshots: Array<{ blocks: string[]; indexed: string[] }> = [];
      createEffect(() => {
        const blocks = app.state.blocks.map((block) => block.id);
        const indexed =
          store.threadTranscriptViews
            .get("thread-one")
            ?.pageIndex.pages()
            .flatMap((page) => page.blockIds) ?? [];
        snapshots.push({ blocks, indexed });
      });

      app.appendBlock({ type: "user", id: "u1", content: "hello" });
      app.insertBlock(0, { type: "info", id: "i1", content: "note", variant: "info" });
      app.removeBlock("u1");

      expect(snapshots.every((snapshot) => snapshot.blocks.join() === snapshot.indexed.join())).toBe(true);
      dispose();
    });
  });

  test("appendBlock appends in place and notifies observers", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");
      app.appendBlock({ type: "user", id: "u1", content: "hello" });
      const first = app.state.blocks[0];
      const observed: string[][] = [];
      createComputed(() => observed.push(app.state.blocks.map((block) => block.id)));

      app.appendBlock({ type: "content", id: "c1", content: "reply", finalized: false });
      app.appendToBlock("c1", " more");

      expect(observed.at(-1)).toEqual(["u1", "c1"]);
      expect(app.state.blocks[0]).toBe(first);
      expect(app.state.blocks[1]).toMatchObject({ content: "reply more" });
      dispose();
    });
  });
  test("findToolBlock tracks the last tool block per call across every mutation", () => {
    createRoot((dispose) => {
      const app = createAppStateValue("/tmp/project");
      const tool = (id: string, toolCallId: string): ToolBlock => ({
        type: "tool",
        id,
        toolCallId,
        toolName: "bash",
        display: "",
        status: "running",
      });
      app.appendBlock({ type: "user", id: "u1", content: "hello" });
      app.appendBlock(tool("approval", "call-1"));
      app.appendBlock(tool("t1", "call-1"));
      expect(app.findToolBlock("call-1")?.id).toBe("t1");

      app.insertBlock(0, tool("t0", "call-0"));
      expect(app.findToolBlock("call-1")?.id).toBe("t1");
      app.updateBlock("t1", { toolCallId: "call-2" });
      expect(app.findToolBlock("call-2")?.id).toBe("t1");
      expect(app.findToolBlock("call-1")?.id).toBe("approval");
      app.removeBlock("approval");
      expect(app.findToolBlock("call-1")).toBeUndefined();
      app.replaceBlocks([tool("t9", "call-9")]);
      expect(app.findToolBlock("call-0")).toBeUndefined();
      expect(app.findToolBlock("call-9")?.id).toBe("t9");
      dispose();
    });
  });
});
