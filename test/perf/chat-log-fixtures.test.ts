import { describe, expect, test } from "bun:test";
import {
  applyAcpSessionUpdate,
  finalizeAcpPrompt,
  type AcpConversationAdapter,
} from "../../src/application/acp-mapping";
import { createAppStateValue } from "../../src/ui/context/app-state";
import {
  benchmarkFixtureSeed,
  buildChatLogBenchmarkFixture,
  countRenderableTree,
  measureToolPayloadBytes,
  summarizeChatBlocks,
  type RenderableTreeNode,
} from "../../scripts/perf/chat-log-benchmark/child/scenario/fixtures";
import { CHAT_LOG_BENCHMARK_SCENARIOS } from "../../scripts/perf/chat-log-benchmark/protocol/scenario";
import { nearestRankPercentile } from "../../scripts/perf/chat-log-benchmark/protocol/statistics";

function replayComparableBlock(block: ReturnType<typeof createAppStateValue>["state"]["blocks"][number]) {
  const { id, ...comparable } = block;
  void id;
  return comparable;
}

describe("chat log benchmark fixtures", () => {
  test("covers every required long-session scenario", () => {
    expect(CHAT_LOG_BENCHMARK_SCENARIOS).toEqual([
      "short-blocks-200",
      "short-blocks-2000",
      "successful-tools-500",
      "mixed-blocks-2000",
      "tall-code-and-tools",
      "resumed-session-2000",
      "tail-streaming-and-spinner",
    ]);
  });

  test("keeps the fixture seed identical across fresh-process run identities", () => {
    expect([0, 1, 2].map(() => benchmarkFixtureSeed(17))).toEqual([17, 17, 17]);
  });

  test("builds deterministic fixtures for the same seed", () => {
    for (const scenario of CHAT_LOG_BENCHMARK_SCENARIOS) {
      expect(buildChatLogBenchmarkFixture(scenario, 17)).toEqual(buildChatLogBenchmarkFixture(scenario, 17));
    }
  });

  test("uses the seed to vary deterministic fixture content", () => {
    const first = buildChatLogBenchmarkFixture("mixed-blocks-2000", 17);
    const second = buildChatLogBenchmarkFixture("mixed-blocks-2000", 18);

    expect(first.blocks).not.toEqual(second.blocks);
    expect(summarizeChatBlocks(first.blocks)).toEqual(summarizeChatBlocks(second.blocks));
  });

  test("replays the quick resumed-session fixture into the expected transcript", () => {
    const fixture = buildChatLogBenchmarkFixture("resumed-session-2000", 17, "quick");
    const appState = createAppStateValue("/tmp/relay-chat-log-benchmark");
    const adapter: AcpConversationAdapter = {
      state: appState.state,
      addBlock: appState.addBlock,
      updateBlock: appState.updateBlock,
      appendToBlock: appState.appendToBlock,
      removeBlock: appState.removeBlock,
      setCurrentBlockId: appState.setCurrentBlockId,
      setState: appState.setState as unknown as (...args: unknown[]) => void,
    };

    for (const update of fixture.historyUpdates ?? []) applyAcpSessionUpdate(update, adapter);
    finalizeAcpPrompt(adapter, { stopReason: "end_turn" });

    expect(appState.state.blocks).toHaveLength(fixture.blocks.length);
    expect(appState.state.blocks.map(replayComparableBlock)).toEqual(fixture.blocks.map(replayComparableBlock));
  });

  test("creates the required fixture shapes", () => {
    const short = buildChatLogBenchmarkFixture("short-blocks-2000", 1);
    const tools = buildChatLogBenchmarkFixture("successful-tools-500", 1);
    const mixed = buildChatLogBenchmarkFixture("mixed-blocks-2000", 1);
    const tall = buildChatLogBenchmarkFixture("tall-code-and-tools", 1);
    const resumed = buildChatLogBenchmarkFixture("resumed-session-2000", 1);
    const streaming = buildChatLogBenchmarkFixture("tail-streaming-and-spinner", 1);
    const quickResumed = buildChatLogBenchmarkFixture("resumed-session-2000", 1, "quick");
    const quickStreaming = buildChatLogBenchmarkFixture("tail-streaming-and-spinner", 1, "quick");

    expect(short.blocks).toHaveLength(2_000);
    expect(summarizeChatBlocks(short.blocks)).toMatchObject({ user: 1_000, content: 1_000 });

    expect(tools.blocks).toHaveLength(500);
    expect(summarizeChatBlocks(tools.blocks)).toMatchObject({ tool: 500, successfulTools: 500 });
    expect(tools.blocks.every((block) => block.type === "tool" && block.details?.includes("\n"))).toBe(true);

    expect(mixed.blocks).toHaveLength(2_000);
    expect(summarizeChatBlocks(mixed.blocks)).toMatchObject({
      user: 250,
      thinking: 250,
      content: 250,
      tool: 500,
      plugin: 250,
      info: 250,
      diffTools: 250,
    });

    expect(tall.detailsExpanded).toBe(true);
    expect(
      tall.blocks.filter((block) => block.type === "tool" && (block.details?.split("\n").length ?? 0) >= 200),
    ).toHaveLength(12);

    expect(resumed.blocks).toHaveLength(2_000);
    expect(resumed.historyUpdates).toHaveLength(2_500);
    expect(resumed.modelConstruction).toBe("acp-replay");
    expect(quickResumed.blocks).toHaveLength(100);
    expect(quickResumed.historyUpdates).toHaveLength(125);

    expect(streaming.blocks).toHaveLength(2_000);
    expect(quickStreaming.blocks).toHaveLength(202);
    expect(streaming.modelConstruction).toBe("batch-blocks");
    expect(streaming.blocks.some((block) => block.type === "info" && block.variant === "spinner")).toBe(false);
    expect(streaming.blocks.at(-1)).toMatchObject({ type: "content", finalized: false });
  });
});

describe("chat log benchmark structural helpers", () => {
  test("counts every mounted node in a renderable tree", () => {
    const leaf = (): RenderableTreeNode => ({ getChildren: () => [] });
    const tree: RenderableTreeNode = {
      getChildren: () => [leaf(), { getChildren: () => [leaf()] }],
    };

    expect(countRenderableTree(tree)).toBe(4);
  });

  test("uses the documented nearest-rank percentile method", () => {
    const samples = [4, 1, 3, 2];

    expect(nearestRankPercentile(samples, 0.5)).toBe(2);
    expect(nearestRankPercentile(samples, 0.95)).toBe(4);
    expect(nearestRankPercentile([], 0.95)).toBeNull();
  });

  test("counts multibyte payload values as UTF-8 bytes", () => {
    const value = "é🙂";
    const block = {
      type: "tool" as const,
      id: "tool-utf8",
      toolCallId: "call-utf8",
      toolName: "read",
      display: "read unicode.txt",
      status: "success" as const,
      rawInput: { value },
      rawOutput: value,
      details: value,
      content: [{ type: "text" as const, text: value }],
    };
    const bytes = measureToolPayloadBytes([block]);
    const encodedLength = (input: string) => new TextEncoder().encode(input).byteLength;

    expect(bytes.rawInput).toBe(encodedLength(JSON.stringify(block.rawInput)));
    expect(bytes.rawOutput).toBe(encodedLength(value));
    expect(bytes.details).toBe(encodedLength(value));
    expect(bytes.parsedContent).toBe(encodedLength(JSON.stringify(block.content)));
    expect(bytes.rawOutput).toBeGreaterThan(value.length);
  });

  test("separates canonical and derived retained tool payload bytes", () => {
    const bytes = measureToolPayloadBytes([
      {
        type: "tool",
        id: "tool-1",
        toolCallId: "call-1",
        toolName: "read",
        display: "read file.ts",
        status: "success",
        rawInput: { path: "file.ts" },
        rawOutput: "alpha\nbeta",
        details: "alpha\nbeta",
        content: [{ type: "text", text: "alpha\nbeta" }],
        summary: "read file.ts",
      },
    ]);

    expect(bytes.rawInput).toBeGreaterThan(0);
    expect(bytes.rawOutput).toBeGreaterThan(0);
    expect(bytes.details).toBe(bytes.rawOutput);
    expect(bytes.parsedContent).toBeGreaterThan(bytes.rawOutput);
    expect(bytes.canonical).toBe(bytes.rawInput + bytes.rawOutput);
    expect(bytes.derived).toBe(bytes.details + bytes.parsedContent + bytes.diff);
    expect(bytes.totalFieldBytes).toBe(bytes.canonical + bytes.derived);
  });
});
