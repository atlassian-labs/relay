import type { ParentBenchmarkOptions } from "../protocol/options";
import { BENCHMARK_SCHEMA_VERSION, type BenchmarkOutput, type BenchmarkRunResult } from "../protocol/result";
import { assertSourceProvenance, captureSourceProvenance } from "../protocol/source-provenance";
import { runFreshProcess } from "./child-process";
import { benchmarkMetadata } from "./report/benchmark-metadata";
import { growthSummary, summarizeRuns } from "./report/summarize-runs";

export async function runParent(options: ParentBenchmarkOptions): Promise<BenchmarkOutput> {
  const source = captureSourceProvenance();
  const runs: BenchmarkRunResult[] = [];
  for (const scenario of options.scenarios) {
    for (let runIndex = 0; runIndex < options.processes; runIndex++) {
      console.error(`benchmark ${scenario} process ${runIndex + 1}/${options.processes}`);
      runs.push(await runFreshProcess(options, scenario, runIndex, source));
    }
  }
  assertSourceProvenance(source);

  const summaries = summarizeRuns(runs);
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    metadata: benchmarkMetadata(options, source),
    runs,
    summaries,
    growth: growthSummary(summaries),
  };
}
