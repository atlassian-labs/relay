import { CHAT_LOG_BENCHMARK_SCENARIOS, type ChatLogBenchmarkScenario } from "../../protocol/scenario";
import { nearestRankPercentile } from "../../protocol/statistics";
import type {
  BenchmarkOutput,
  DistributionAggregation,
  DistributionSummary,
  DistributionUnit,
  ScenarioSummary,
} from "../../protocol/result";

export interface BenchmarkSummaryRun {
  readonly scenario: ChatLogBenchmarkScenario;
  readonly initialMountMs: number;
  readonly cleanFrames: { readonly samplesMs: readonly number[] };
  readonly dirtyFrames: { readonly samplesMs: readonly number[] };
  readonly inputToFrame: {
    readonly syntheticKeyDispatch: { readonly samplesMs: readonly number[] };
    readonly syntheticMouseDispatch: { readonly samplesMs: readonly number[] };
    readonly chatLogScroll: { readonly samplesMs: readonly number[] };
  };
  readonly cpuIntervals: {
    readonly spinnerOnly: { readonly processCpuPercent: number } | null;
    readonly tailStreaming: { readonly processCpuPercent: number } | null;
  };
  readonly mountedRenderableCount: number;
  readonly directScrollContentChildCount: number;
  readonly rssBytes: { readonly afterMount: number };
  readonly payloadBytes: { readonly canonical: number; readonly derived: number };
}

function summarize(
  values: readonly number[],
  unit: DistributionUnit,
  aggregation: DistributionAggregation,
): DistributionSummary {
  return {
    p50: nearestRankPercentile(values, 0.5),
    p95: nearestRankPercentile(values, 0.95),
    sampleCount: values.length,
    unit,
    aggregation,
  };
}

export function summarizeRuns(runs: readonly BenchmarkSummaryRun[]): ScenarioSummary[] {
  return CHAT_LOG_BENCHMARK_SCENARIOS.filter((scenario) => runs.some((run) => run.scenario === scenario)).map(
    (scenario) => {
      const scenarioRuns = runs.filter((run) => run.scenario === scenario);
      const processSummary = (values: readonly number[]) => summarize(values, "process", "across-processes");
      const frameSummary = (values: readonly number[]) => summarize(values, "frame", "pooled-samples");
      const inputSummary = (values: readonly number[]) => summarize(values, "input-event", "pooled-samples");
      return {
        scenario,
        runCount: scenarioRuns.length,
        initialMountMs: processSummary(scenarioRuns.map((run) => run.initialMountMs)),
        cleanFrameMs: frameSummary(scenarioRuns.flatMap((run) => run.cleanFrames.samplesMs)),
        dirtyFrameMs: frameSummary(scenarioRuns.flatMap((run) => run.dirtyFrames.samplesMs)),
        syntheticKeyDispatchToFrameMs: inputSummary(
          scenarioRuns.flatMap((run) => run.inputToFrame.syntheticKeyDispatch.samplesMs),
        ),
        syntheticMouseDispatchToFrameMs: inputSummary(
          scenarioRuns.flatMap((run) => run.inputToFrame.syntheticMouseDispatch.samplesMs),
        ),
        chatLogScrollToFrameMs: inputSummary(scenarioRuns.flatMap((run) => run.inputToFrame.chatLogScroll.samplesMs)),
        spinnerOnlyCpuPercent: processSummary(
          scenarioRuns.flatMap((run) =>
            run.cpuIntervals.spinnerOnly ? [run.cpuIntervals.spinnerOnly.processCpuPercent] : [],
          ),
        ),
        tailStreamingCpuPercent: processSummary(
          scenarioRuns.flatMap((run) =>
            run.cpuIntervals.tailStreaming ? [run.cpuIntervals.tailStreaming.processCpuPercent] : [],
          ),
        ),
        mountedRenderableCount: processSummary(scenarioRuns.map((run) => run.mountedRenderableCount)),
        directScrollContentChildCount: processSummary(scenarioRuns.map((run) => run.directScrollContentChildCount)),
        rssAfterMountBytes: processSummary(scenarioRuns.map((run) => run.rssBytes.afterMount)),
        payloadCanonicalBytes: processSummary(scenarioRuns.map((run) => run.payloadBytes.canonical)),
        payloadDerivedBytes: processSummary(scenarioRuns.map((run) => run.payloadBytes.derived)),
      };
    },
  );
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator;
}

export function growthSummary(summaries: readonly ScenarioSummary[]): BenchmarkOutput["growth"] {
  const short200 = summaries.find((summary) => summary.scenario === "short-blocks-200");
  const short2000 = summaries.find((summary) => summary.scenario === "short-blocks-2000");
  if (!short200 || !short2000) return { shortBlocks200To2000: null };

  return {
    shortBlocks200To2000: {
      cleanFrameP95Ratio: ratio(short2000.cleanFrameMs.p95, short200.cleanFrameMs.p95),
      mountedRenderableP95Ratio: ratio(short2000.mountedRenderableCount.p95, short200.mountedRenderableCount.p95),
      rssAfterMountP95Ratio: ratio(short2000.rssAfterMountBytes.p95, short200.rssAfterMountBytes.p95),
    },
  };
}
