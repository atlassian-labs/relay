import { describe, expect, test } from "bun:test";
import {
  growthSummary,
  summarizeRuns,
  type BenchmarkSummaryRun,
} from "../../../../../scripts/perf/chat-log-benchmark/parent/report/summarize-runs";
import type {
  DistributionSummary,
  ScenarioSummary,
} from "../../../../../scripts/perf/chat-log-benchmark/protocol/result";

function distributionSummary(
  p50: number | null,
  p95: number | null,
  sampleCount = 0,
  unit: DistributionSummary["unit"] = "process",
  aggregation: DistributionSummary["aggregation"] = "across-processes",
): DistributionSummary {
  return { p50, p95, sampleCount, unit, aggregation };
}

function scenarioSummary(
  scenario: ScenarioSummary["scenario"],
  cleanFrameP95: number,
  mountedRenderableP95: number,
  rssAfterMountP95: number,
): ScenarioSummary {
  const empty = distributionSummary(null, null);
  return {
    scenario,
    runCount: 3,
    initialMountMs: empty,
    cleanFrameMs: distributionSummary(cleanFrameP95 / 2, cleanFrameP95, 3, "frame", "pooled-samples"),
    dirtyFrameMs: empty,
    syntheticKeyDispatchToFrameMs: empty,
    syntheticMouseDispatchToFrameMs: empty,
    chatLogScrollToFrameMs: empty,
    spinnerOnlyCpuPercent: empty,
    tailStreamingCpuPercent: empty,
    mountedRenderableCount: distributionSummary(mountedRenderableP95, mountedRenderableP95),
    directScrollContentChildCount: empty,
    rssAfterMountBytes: distributionSummary(rssAfterMountP95, rssAfterMountP95),
    payloadCanonicalBytes: empty,
    payloadDerivedBytes: empty,
  };
}

interface SummaryRunValues {
  readonly initialMountMs: number;
  readonly cleanFrames: number[];
  readonly dirtyFrames: number[];
  readonly keyDispatch: number;
  readonly mouseDispatch: number;
  readonly scroll: number;
  readonly spinnerCpuPercent: number;
  readonly streamingCpuPercent: number;
  readonly mountedRenderableCount: number;
  readonly directScrollContentChildCount: number;
  readonly rssAfterMount: number;
  readonly payloadCanonicalBytes: number;
  readonly payloadDerivedBytes: number;
}

function benchmarkSummaryRun(values: SummaryRunValues): BenchmarkSummaryRun {
  return {
    scenario: "tail-streaming-and-spinner",
    initialMountMs: values.initialMountMs,
    cleanFrames: { samplesMs: values.cleanFrames },
    dirtyFrames: { samplesMs: values.dirtyFrames },
    inputToFrame: {
      syntheticKeyDispatch: { samplesMs: [values.keyDispatch] },
      syntheticMouseDispatch: { samplesMs: [values.mouseDispatch] },
      chatLogScroll: { samplesMs: [values.scroll] },
    },
    cpuIntervals: {
      spinnerOnly: { processCpuPercent: values.spinnerCpuPercent },
      tailStreaming: { processCpuPercent: values.streamingCpuPercent },
    },
    mountedRenderableCount: values.mountedRenderableCount,
    directScrollContentChildCount: values.directScrollContentChildCount,
    rssBytes: { afterMount: values.rssAfterMount },
    payloadBytes: { canonical: values.payloadCanonicalBytes, derived: values.payloadDerivedBytes },
  };
}

describe("chat log benchmark result summaries", () => {
  test("summarizes process, frame, and input distributions with their correct units", () => {
    const summary = summarizeRuns([
      benchmarkSummaryRun({
        initialMountMs: 10,
        cleanFrames: [1, 2],
        dirtyFrames: [3, 4],
        keyDispatch: 5,
        mouseDispatch: 6,
        scroll: 7,
        spinnerCpuPercent: 8,
        streamingCpuPercent: 9,
        mountedRenderableCount: 10,
        directScrollContentChildCount: 11,
        rssAfterMount: 12,
        payloadCanonicalBytes: 13,
        payloadDerivedBytes: 14,
      }),
      benchmarkSummaryRun({
        initialMountMs: 20,
        cleanFrames: [21, 22],
        dirtyFrames: [23, 24],
        keyDispatch: 25,
        mouseDispatch: 26,
        scroll: 27,
        spinnerCpuPercent: 28,
        streamingCpuPercent: 29,
        mountedRenderableCount: 30,
        directScrollContentChildCount: 31,
        rssAfterMount: 32,
        payloadCanonicalBytes: 33,
        payloadDerivedBytes: 34,
      }),
    ]);

    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ scenario: "tail-streaming-and-spinner", runCount: 2 });
    const summaryContracts: Array<
      [
        keyof Omit<ScenarioSummary, "scenario" | "runCount">,
        number,
        number,
        DistributionSummary["unit"],
        DistributionSummary["aggregation"],
        number,
      ]
    > = [
      ["initialMountMs", 10, 20, "process", "across-processes", 2],
      ["cleanFrameMs", 2, 22, "frame", "pooled-samples", 4],
      ["dirtyFrameMs", 4, 24, "frame", "pooled-samples", 4],
      ["syntheticKeyDispatchToFrameMs", 5, 25, "input-event", "pooled-samples", 2],
      ["syntheticMouseDispatchToFrameMs", 6, 26, "input-event", "pooled-samples", 2],
      ["chatLogScrollToFrameMs", 7, 27, "input-event", "pooled-samples", 2],
      ["spinnerOnlyCpuPercent", 8, 28, "process", "across-processes", 2],
      ["tailStreamingCpuPercent", 9, 29, "process", "across-processes", 2],
      ["mountedRenderableCount", 10, 30, "process", "across-processes", 2],
      ["directScrollContentChildCount", 11, 31, "process", "across-processes", 2],
      ["rssAfterMountBytes", 12, 32, "process", "across-processes", 2],
      ["payloadCanonicalBytes", 13, 33, "process", "across-processes", 2],
      ["payloadDerivedBytes", 14, 34, "process", "across-processes", 2],
    ];
    for (const [field, p50, p95, unit, aggregation, sampleCount] of summaryContracts) {
      expect(summary[0]?.[field]).toEqual({ p50, p95, unit, aggregation, sampleCount });
    }
  });

  test("calculates the 200-to-2000 growth ratios from scenario summaries", () => {
    const growth = growthSummary([
      scenarioSummary("short-blocks-200", 2, 500, 100),
      scenarioSummary("short-blocks-2000", 5, 5_000, 150),
    ]);

    expect(growth.shortBlocks200To2000).toEqual({
      cleanFrameP95Ratio: 2.5,
      mountedRenderableP95Ratio: 10,
      rssAfterMountP95Ratio: 1.5,
    });
    expect(growthSummary([]).shortBlocks200To2000).toBeNull();
  });
});
