import { z } from "zod";
import type { BenchmarkRunResult } from "./result";
import { CHAT_LOG_BENCHMARK_SCENARIOS, type ChatLogBenchmarkScenario } from "./scenario";

const number = z.number();
const numberOrNull = number.nullable();
const frameDistributionSchema = z
  .object({
    samplesMs: z.array(number),
    p50Ms: numberOrNull,
    p95Ms: numberOrNull,
  })
  .strict();
const phaseCountersSchema = z
  .object({
    layoutTraversalCalls: number,
    layoutRefreshCalls: number,
    yogaLayoutPasses: number,
    yogaLayoutDurationMs: number,
    rootTraversalPasses: number,
    rootTraversalDurationMs: number,
    renderCommandCount: number,
    renderableCommandCount: number,
    layoutTraversalCallsPerFrame: number,
    layoutRefreshCallsPerFrame: number,
    yogaLayoutDurationMsPerFrame: number,
    rootTraversalDurationMsPerFrame: number,
    renderCommandCountPerFrame: number,
    renderableCommandCountPerFrame: number,
  })
  .strict();
const nativeStatsSchema = z
  .object({
    nativeLastFrameTime: number,
    nativeAverageFrameTime: number,
    nativeFrameCount: number,
    cellsUpdated: number,
    averageCellsUpdated: number,
    nativeRenderTime: number.optional(),
    nativeStdoutWriteTime: number.optional(),
  })
  .strict();
const rendererStatsSchema = nativeStatsSchema
  .extend({
    fps: number,
    frameCount: number,
    frameTimes: z.array(number),
    averageFrameTime: number,
    minFrameTime: number,
    maxFrameTime: number,
    frameCallbackTime: number,
  })
  .strict();
const cpuIntervalSchema = z
  .object({
    activity: z.enum(["spinner-only", "tail-streaming"]),
    durationMs: number,
    processCpuPercent: number,
    userCpuMicros: number,
    systemCpuMicros: number,
    frames: number,
    nativeStats: nativeStatsSchema,
    rendererStats: rendererStatsSchema,
  })
  .strict();

export const benchmarkRunResultSchema = z
  .object({
    scenario: z.enum(CHAT_LOG_BENCHMARK_SCENARIOS),
    runIndex: z.number().int().nonnegative(),
    seed: z.number().int().nonnegative(),
    blockSummary: z
      .object({
        total: number,
        thinking: number,
        content: number,
        user: number,
        tool: number,
        userBash: number,
        elicitation: number,
        info: number,
        plugin: number,
        successfulTools: number,
        diffTools: number,
      })
      .strict(),
    modelState: z
      .object({
        currentBlockId: z.string().nullable(),
        running: z.boolean(),
        spinnerActive: z.boolean(),
      })
      .strict(),
    modelConstruction: z.enum(["direct-blocks", "batch-blocks", "acp-replay"]),
    fixtureConstructionMs: number,
    modelConstructionMs: number,
    mountedReplayMs: numberOrNull,
    mountedReplayToStableMs: numberOrNull,
    rendererSetupMs: number,
    renderableConstructionMs: number,
    firstFrameMs: number,
    firstInteractiveFrameMs: number,
    stabilizationMs: number,
    stabilizationFrameCount: number,
    initialMountMs: number,
    mountedRenderableCount: number,
    directScrollContentChildCount: number,
    scrollHeight: number,
    diagnostics: z
      .object({
        firstFrameCounters: phaseCountersSchema,
        cleanFrameCounters: phaseCountersSchema,
        dirtyFrameCounters: phaseCountersSchema,
      })
      .strict(),
    cleanFrames: frameDistributionSchema,
    cleanNativeStats: nativeStatsSchema,
    dirtyFrames: frameDistributionSchema,
    dirtyNativeStats: nativeStatsSchema,
    inputToFrame: z
      .object({
        syntheticKeyDispatch: frameDistributionSchema,
        syntheticMouseDispatch: frameDistributionSchema,
        chatLogScroll: frameDistributionSchema,
      })
      .strict(),
    cpuIntervals: z
      .object({
        spinnerOnly: cpuIntervalSchema.nullable(),
        tailStreaming: cpuIntervalSchema.nullable(),
      })
      .strict(),
    rssBytes: z
      .object({
        beforeModel: number,
        beforeMount: number,
        afterMount: number,
        afterCleanup: number,
        forcedGcRequested: z.boolean(),
        comparisonMode: z.literal("fresh-process-non-gc-normalized"),
      })
      .strict(),
    payloadBytes: z
      .object({
        rawInput: number,
        rawOutput: number,
        details: number,
        parsedContent: number,
        diff: number,
        rendererPreviewEstimate: number,
        canonical: number,
        derived: number,
        totalFieldBytes: number,
      })
      .strict(),
    capturedFrameBytes: number,
  })
  .strict();

export function parseBenchmarkRunResult(
  value: unknown,
  expectedScenario: ChatLogBenchmarkScenario,
  expectedRunIndex: number,
): BenchmarkRunResult {
  const result = benchmarkRunResultSchema.parse(value);
  if (result.scenario !== expectedScenario) {
    throw new Error(`Benchmark child returned scenario ${result.scenario}; expected ${expectedScenario}`);
  }
  if (result.runIndex !== expectedRunIndex) {
    throw new Error(`Benchmark child returned run index ${result.runIndex}; expected ${expectedRunIndex}`);
  }
  return result;
}
