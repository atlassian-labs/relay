export const CHAT_LOG_BENCHMARK_SCENARIOS = [
  "short-blocks-200",
  "short-blocks-2000",
  "successful-tools-500",
  "mixed-blocks-2000",
  "tall-code-and-tools",
  "resumed-session-2000",
  "tail-streaming-and-spinner",
] as const;

export type ChatLogBenchmarkScenario = (typeof CHAT_LOG_BENCHMARK_SCENARIOS)[number];
export type ChatLogBenchmarkFixturePreset = "full" | "quick";
export type ModelConstructionKind = "direct-blocks" | "batch-blocks" | "acp-replay";

export interface ChatBlockSummary {
  readonly total: number;
  readonly thinking: number;
  readonly content: number;
  readonly user: number;
  readonly tool: number;
  readonly userBash: number;
  readonly elicitation: number;
  readonly info: number;
  readonly plugin: number;
  readonly successfulTools: number;
  readonly diffTools: number;
}

export interface ToolPayloadByteCounts {
  readonly rawInput: number;
  readonly rawOutput: number;
  readonly details: number;
  readonly parsedContent: number;
  readonly diff: number;
  readonly rendererPreviewEstimate: number;
  readonly canonical: number;
  readonly derived: number;
  readonly totalFieldBytes: number;
}
