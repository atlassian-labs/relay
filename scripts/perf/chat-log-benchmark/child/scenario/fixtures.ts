import type { RelaySessionUpdate } from "../../../../../src/acp/sdk";
import type { ChatBlock, ToolBlock } from "../../../../../src/ui/state";
import type {
  ChatBlockSummary,
  ChatLogBenchmarkFixturePreset,
  ChatLogBenchmarkScenario,
  ModelConstructionKind,
  ToolPayloadByteCounts,
} from "../../protocol/scenario";

export function benchmarkFixtureSeed(seed: number): number {
  return seed;
}

export interface ChatLogBenchmarkFixture {
  readonly name: ChatLogBenchmarkScenario;
  readonly blocks: ChatBlock[];
  readonly historyUpdates?: RelaySessionUpdate[];
  readonly modelConstruction: ModelConstructionKind;
  readonly detailsExpanded: boolean;
}

export interface RenderableTreeNode {
  getChildren(): readonly RenderableTreeNode[];
}

interface SeededRandom {
  nextInt(maxExclusive: number): number;
  token(prefix: string): string;
}

function createSeededRandom(seed: number): SeededRandom {
  let state = (seed || 1) >>> 0;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  return {
    nextInt(maxExclusive: number) {
      if (maxExclusive <= 0) return 0;
      return next() % maxExclusive;
    },
    token(prefix: string) {
      return `${prefix}-${next().toString(36)}`;
    },
  };
}

function lineSeries(prefix: string, count: number, random: SeededRandom): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1} ${random.token("value")}`).join("\n");
}

function buildShortBlocks(count: number, random: SeededRandom): ChatBlock[] {
  return Array.from({ length: count }, (_, index): ChatBlock => {
    const turn = Math.floor(index / 2);
    if (index % 2 === 0) {
      return {
        type: "user",
        id: `short-user-${turn}`,
        content: `Prompt ${turn + 1}: ${random.token("request")}`,
      };
    }
    return {
      type: "content",
      id: `short-content-${turn}`,
      content: `Response ${turn + 1}: ${random.token("answer")}`,
      finalized: true,
    };
  });
}

function successfulTool(index: number, random: SeededRandom): ToolBlock {
  const output = lineSeries(`tool ${index + 1} output`, 8, random);
  return {
    type: "tool",
    id: `tool-${index}`,
    toolCallId: `tool-call-${index}`,
    toolName: "read",
    toolKind: "read",
    display: `Read src/example-${index}.ts`,
    status: "success",
    summary: `Read example-${index}.ts`,
    rawInput: { path: `src/example-${index}.ts` },
    rawOutput: output,
    details: output,
    content: [{ type: "text", text: output }],
  };
}

function buildSuccessfulTools(random: SeededRandom): ChatBlock[] {
  return Array.from({ length: 500 }, (_, index) => successfulTool(index, random));
}

function buildMixedBlocks(random: SeededRandom): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  for (let turn = 0; turn < 250; turn++) {
    const diff = {
      path: `src/mixed-${turn}.ts`,
      oldText: `const value = ${turn};\n`,
      newText: `const value = ${turn + 1};\n`,
    };
    const toolOutput = lineSeries(`search result ${turn + 1}`, 6, random);
    blocks.push(
      {
        type: "user",
        id: `mixed-user-${turn}`,
        content: `Investigate ${random.token("topic")} and update the implementation.`,
      },
      {
        type: "thinking",
        id: `mixed-thinking-${turn}`,
        content: `I will inspect ${random.token("area")} before editing.`,
        finalized: true,
      },
      {
        type: "content",
        id: `mixed-content-${turn}`,
        content: `## Result ${turn + 1}\n\nUpdated **${random.token("component")}** with a focused change.`,
        finalized: true,
      },
      {
        type: "tool",
        id: `mixed-tool-${turn}`,
        toolCallId: `mixed-call-${turn}`,
        toolName: "search_code",
        toolKind: "search",
        display: `Search for ${random.token("symbol")}`,
        status: "success",
        rawInput: { query: random.token("query") },
        rawOutput: toolOutput,
        details: toolOutput,
        content: [{ type: "text", text: toolOutput }],
      },
      {
        type: "plugin",
        id: `mixed-plugin-${turn}`,
        pluginId: "benchmark:fixture",
        pluginName: "benchmark-fixture",
        blockType: "notice",
        content: `Plugin observation ${turn + 1}: ${random.token("plugin")}`,
      },
      {
        type: "info",
        id: `mixed-info-${turn}`,
        variant: turn % 5 === 0 ? "warning" : "info",
        content: `Status ${turn + 1}: ${random.token("status")}`,
      },
      {
        type: "tool",
        id: `mixed-diff-${turn}`,
        toolCallId: `mixed-diff-call-${turn}`,
        toolName: "edit",
        toolKind: "edit",
        display: `Edit ${diff.path}`,
        status: "success",
        rawInput: { path: diff.path },
        rawOutput: diff,
        details: diff.newText,
        content: [{ type: "diff", diff }],
        diff,
      },
      {
        type: "user-bash",
        id: `mixed-bash-${turn}`,
        command: `printf '${turn}'`,
        output: `${turn}\n`,
        exitCode: 0,
        status: "done",
        excludeFromContext: false,
      },
    );
  }
  return blocks;
}

function buildTallBlocks(random: SeededRandom): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  for (let index = 0; index < 12; index++) {
    blocks.push(
      {
        type: "user",
        id: `tall-user-${index}`,
        content: `Inspect the large artifact ${index + 1}.`,
      },
      {
        type: "tool",
        id: `tall-tool-${index}`,
        toolCallId: `tall-call-${index}`,
        toolName: index % 2 === 0 ? "read" : "execute",
        toolKind: index % 2 === 0 ? "read" : "execute",
        display: `Large tool output ${index + 1}`,
        status: "success",
        rawInput: { artifact: index + 1 },
        rawOutput: lineSeries(`artifact ${index + 1}`, 240 + random.nextInt(20), random),
        details: lineSeries(`rendered artifact ${index + 1}`, 240 + random.nextInt(20), random),
      },
      {
        type: "content",
        id: `tall-content-${index}`,
        content: `\`\`\`ts\n${lineSeries(`const item${index}`, 120, random)}\n\`\`\``,
        finalized: true,
      },
    );
  }
  return blocks;
}

function buildResumedFixture(
  random: SeededRandom,
  turnCount: number,
): Pick<ChatLogBenchmarkFixture, "blocks" | "historyUpdates"> {
  const blocks: ChatBlock[] = [];
  const historyUpdates: RelaySessionUpdate[] = [];

  for (let turn = 0; turn < turnCount; turn++) {
    const userText = `Resume prompt ${turn + 1}: ${random.token("request")}`;
    const thinkingText = `Resume thought ${turn + 1}: ${random.token("reason")}`;
    const toolText = lineSeries(`resume tool ${turn + 1}`, 4, random);
    const contentText = `Resume answer ${turn + 1}: ${random.token("answer")}`;
    const toolCallId = `resume-call-${turn}`;

    blocks.push(
      {
        type: "user",
        id: `resume-user-${turn}`,
        content: userText,
        origin: "acp",
        contentItems: [{ type: "text", text: userText }],
      },
      {
        type: "thinking",
        id: `resume-thinking-${turn}`,
        content: thinkingText,
        finalized: true,
        contentItems: [{ type: "text", text: thinkingText }],
      },
      {
        type: "tool",
        id: `resume-tool-${turn}`,
        toolCallId,
        toolName: "read",
        toolKind: "read",
        display: `path: resume-${turn}.ts`,
        status: "success",
        rawInput: { path: `resume-${turn}.ts` },
        rawOutput: toolText,
        details: toolText,
        content: [{ type: "text", text: toolText }],
        diff: undefined,
        fileChanges: undefined,
      },
      {
        type: "content",
        id: `resume-content-${turn}`,
        content: contentText,
        finalized: true,
        contentItems: [{ type: "text", text: contentText }],
      },
    );

    historyUpdates.push(
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: userText } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: thinkingText } },
      {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "read",
        kind: "read",
        rawInput: { path: `resume-${turn}.ts` },
        status: "in_progress",
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title: "read",
        kind: "read",
        rawInput: { path: `resume-${turn}.ts` },
        rawOutput: toolText,
        content: [{ type: "content", content: { type: "text", text: toolText } }],
        status: "completed",
      },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: contentText } },
    );
  }

  return { blocks, historyUpdates };
}

function buildStreamingBlocks(random: SeededRandom, historicalBlockCount: number): ChatBlock[] {
  return [
    ...buildShortBlocks(historicalBlockCount, random),
    {
      type: "content",
      id: "streaming-tail",
      content: `Streaming response ${random.token("tail")}`,
      finalized: false,
    },
  ];
}

export function buildChatLogBenchmarkFixture(
  name: ChatLogBenchmarkScenario,
  seed: number,
  preset: ChatLogBenchmarkFixturePreset = "full",
): ChatLogBenchmarkFixture {
  const random = createSeededRandom(seed);

  switch (name) {
    case "short-blocks-200":
      return {
        name,
        blocks: buildShortBlocks(200, random),
        modelConstruction: "direct-blocks",
        detailsExpanded: false,
      };
    case "short-blocks-2000":
      return {
        name,
        blocks: buildShortBlocks(2_000, random),
        modelConstruction: "direct-blocks",
        detailsExpanded: false,
      };
    case "successful-tools-500":
      return { name, blocks: buildSuccessfulTools(random), modelConstruction: "direct-blocks", detailsExpanded: false };
    case "mixed-blocks-2000":
      return { name, blocks: buildMixedBlocks(random), modelConstruction: "direct-blocks", detailsExpanded: false };
    case "tall-code-and-tools":
      return { name, blocks: buildTallBlocks(random), modelConstruction: "direct-blocks", detailsExpanded: true };
    case "resumed-session-2000": {
      const resumed = buildResumedFixture(random, preset === "quick" ? 25 : 500);
      return {
        name,
        blocks: resumed.blocks,
        historyUpdates: resumed.historyUpdates,
        modelConstruction: "acp-replay",
        detailsExpanded: false,
      };
    }
    case "tail-streaming-and-spinner":
      return {
        name,
        blocks: buildStreamingBlocks(random, preset === "quick" ? 201 : 1_999),
        modelConstruction: "batch-blocks",
        detailsExpanded: false,
      };
  }
}

export function summarizeChatBlocks(blocks: readonly ChatBlock[]): ChatBlockSummary {
  const counts: ChatBlockSummary = {
    total: blocks.length,
    thinking: 0,
    content: 0,
    user: 0,
    tool: 0,
    userBash: 0,
    elicitation: 0,
    info: 0,
    plugin: 0,
    successfulTools: 0,
    diffTools: 0,
  };
  const mutable = counts as { -readonly [Key in keyof ChatBlockSummary]: ChatBlockSummary[Key] };

  for (const block of blocks) {
    switch (block.type) {
      case "thinking":
        mutable.thinking++;
        break;
      case "content":
        mutable.content++;
        break;
      case "user":
        mutable.user++;
        break;
      case "tool":
        mutable.tool++;
        if (block.status === "success") mutable.successfulTools++;
        if (block.diff) mutable.diffTools++;
        break;
      case "user-bash":
        mutable.userBash++;
        break;
      case "elicitation":
        mutable.elicitation++;
        break;
      case "info":
        mutable.info++;
        break;
      case "plugin":
        mutable.plugin++;
        break;
    }
  }

  return counts;
}

function encodedBytes(value: unknown): number {
  if (value === undefined) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return new TextEncoder().encode(text).byteLength;
}

function estimateRendererPreview(block: ToolBlock): string {
  const firstDetailLine = block.details?.split("\n", 1)[0] ?? "";
  return [block.summary ?? block.display, firstDetailLine].filter(Boolean).join("\n");
}

export function measureToolPayloadBytes(blocks: readonly ChatBlock[]): ToolPayloadByteCounts {
  let rawInput = 0;
  let rawOutput = 0;
  let details = 0;
  let parsedContent = 0;
  let diff = 0;
  let rendererPreviewEstimate = 0;

  for (const block of blocks) {
    if (block.type !== "tool") continue;
    rawInput += encodedBytes(block.rawInput);
    rawOutput += encodedBytes(block.rawOutput);
    details += encodedBytes(block.details);
    parsedContent += encodedBytes(block.content);
    diff += encodedBytes(block.diff);
    rendererPreviewEstimate += encodedBytes(estimateRendererPreview(block));
  }

  const canonical = rawInput + rawOutput;
  const derived = details + parsedContent + diff;
  return {
    rawInput,
    rawOutput,
    details,
    parsedContent,
    diff,
    rendererPreviewEstimate,
    canonical,
    derived,
    totalFieldBytes: canonical + derived,
  };
}

export function countRenderableTree(root: RenderableTreeNode): number {
  let count = 1;
  for (const child of root.getChildren()) count += countRenderableTree(child);
  return count;
}
