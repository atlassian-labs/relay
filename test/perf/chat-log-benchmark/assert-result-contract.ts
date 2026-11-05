import { z } from "zod";
import { benchmarkRunResultSchema } from "../../../scripts/perf/chat-log-benchmark/protocol/parse-run-result";
import type { BenchmarkOutput, BenchmarkRunResult } from "../../../scripts/perf/chat-log-benchmark/protocol/result";

const numberOrNull = z.number().nullable();
const distributionSummarySchema = z
  .object({
    p50: numberOrNull,
    p95: numberOrNull,
    sampleCount: z.number(),
    unit: z.enum(["process", "frame", "input-event"]),
    aggregation: z.enum(["across-processes", "pooled-samples"]),
  })
  .strict();
const scenarioSummarySchema = z
  .object({
    scenario: benchmarkRunResultSchema.shape.scenario,
    runCount: z.number(),
    initialMountMs: distributionSummarySchema,
    cleanFrameMs: distributionSummarySchema,
    dirtyFrameMs: distributionSummarySchema,
    syntheticKeyDispatchToFrameMs: distributionSummarySchema,
    syntheticMouseDispatchToFrameMs: distributionSummarySchema,
    chatLogScrollToFrameMs: distributionSummarySchema,
    spinnerOnlyCpuPercent: distributionSummarySchema,
    tailStreamingCpuPercent: distributionSummarySchema,
    mountedRenderableCount: distributionSummarySchema,
    directScrollContentChildCount: distributionSummarySchema,
    rssAfterMountBytes: distributionSummarySchema,
    payloadCanonicalBytes: distributionSummarySchema,
    payloadDerivedBytes: distributionSummarySchema,
  })
  .strict();
const benchmarkOutputSchema = z
  .object({
    schemaVersion: z.number(),
    generatedAt: z.string(),
    metadata: z
      .object({
        source: z
          .object({
            commit: z.string(),
            trackedDirty: z.boolean(),
            trackedDiffSha256: z.string(),
          })
          .strict(),
        bunVersion: z.string(),
        opentuiCoreVersion: z.string(),
        opentuiSolidVersion: z.string(),
        os: z.string(),
        cpuModel: z.string(),
        terminal: z.object({ width: z.number(), height: z.number() }).strict(),
        fixtureSeed: z.number(),
        fixturePreset: z.enum(["full", "quick"]),
        activeProfile: z.string(),
        activeConfig: z
          .object({
            toolResultPreviewLines: z.number(),
            thinkingPreviewLines: z.number(),
            showThinking: z.boolean(),
            succinctToolResults: z.boolean(),
            stickyPromptHeaderLines: z.number(),
          })
          .strict(),
        inputMeasurementMode: z
          .object({
            keyAndMouse: z.literal("synthetic-focus-target"),
            scroll: z.literal("chat-log-scrollbox"),
          })
          .strict(),
        payloadByteAccounting: z
          .object({
            method: z.literal("utf8-serialized-field-bytes"),
            sharedValuesCountedPerField: z.literal(true),
            heapUsageEstimate: z.literal(false),
          })
          .strict(),
        parameters: z
          .object({
            targetFps: z.number(),
            spinnerIntervalMs: z.number(),
            instrumentationMode: z.literal("separate-diagnostic-pass"),
            processes: z.number(),
            warmFrames: z.number(),
            cleanFrames: z.number(),
            dirtyUpdates: z.number(),
            inputSamples: z.number(),
            cpuIntervalMs: z.number(),
            childTimeoutMs: z.number(),
            percentileMethod: z.literal("nearest-rank"),
          })
          .strict(),
        forcedGc: z
          .object({
            available: z.boolean(),
            mechanism: z.literal("Bun.gc(true)"),
            verification: z.literal("availability-only"),
            rssNormalized: z.literal(false),
          })
          .strict(),
      })
      .strict(),
    runs: z.array(benchmarkRunResultSchema),
    summaries: z.array(scenarioSummarySchema),
    growth: z
      .object({
        shortBlocks200To2000: z
          .object({
            cleanFrameP95Ratio: numberOrNull,
            mountedRenderableP95Ratio: numberOrNull,
            rssAfterMountP95Ratio: numberOrNull,
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();

export function expectBenchmarkRunResultContract(value: unknown): BenchmarkRunResult {
  return benchmarkRunResultSchema.parse(value);
}

export function expectBenchmarkOutputContract(value: unknown): BenchmarkOutput {
  return benchmarkOutputSchema.parse(value);
}
