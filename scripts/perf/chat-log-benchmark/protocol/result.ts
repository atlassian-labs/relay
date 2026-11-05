import type { CliRendererStats, NativeRenderStats } from "@opentui/core";
import type {
  ChatBlockSummary,
  ChatLogBenchmarkFixturePreset,
  ChatLogBenchmarkScenario,
  ModelConstructionKind,
  ToolPayloadByteCounts,
} from "./scenario";

export const BENCHMARK_SCHEMA_VERSION = 2;

export interface InstrumentationSnapshot {
  readonly layoutTraversalCalls: number;
  readonly layoutRefreshCalls: number;
  readonly yogaLayoutPasses: number;
  readonly yogaLayoutDurationMs: number;
  readonly rootTraversalPasses: number;
  readonly rootTraversalDurationMs: number;
  readonly renderCommandCount: number;
  readonly renderableCommandCount: number;
}

export interface PhaseCounters extends InstrumentationSnapshot {
  readonly layoutTraversalCallsPerFrame: number;
  readonly layoutRefreshCallsPerFrame: number;
  readonly yogaLayoutDurationMsPerFrame: number;
  readonly rootTraversalDurationMsPerFrame: number;
  readonly renderCommandCountPerFrame: number;
  readonly renderableCommandCountPerFrame: number;
}

export interface FrameDistribution {
  readonly samplesMs: number[];
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
}

export type CpuActivity = "spinner-only" | "tail-streaming";

export interface CpuIntervalResult {
  readonly activity: CpuActivity;
  readonly durationMs: number;
  readonly processCpuPercent: number;
  readonly userCpuMicros: number;
  readonly systemCpuMicros: number;
  readonly frames: number;
  readonly nativeStats: NativeRenderStats;
  readonly rendererStats: CliRendererStats;
}

export interface RssMeasurements {
  readonly beforeModel: number;
  readonly beforeMount: number;
  readonly afterMount: number;
  readonly afterCleanup: number;
  readonly forcedGcRequested: boolean;
  readonly comparisonMode: "fresh-process-non-gc-normalized";
}

export interface BenchmarkRunResult {
  readonly scenario: ChatLogBenchmarkScenario;
  readonly runIndex: number;
  readonly seed: number;
  readonly blockSummary: ChatBlockSummary;
  readonly modelState: {
    readonly currentBlockId: string | null;
    readonly running: boolean;
    readonly spinnerActive: boolean;
  };
  readonly modelConstruction: ModelConstructionKind;
  readonly fixtureConstructionMs: number;
  readonly modelConstructionMs: number;
  readonly mountedReplayMs: number | null;
  readonly mountedReplayToStableMs: number | null;
  readonly rendererSetupMs: number;
  readonly renderableConstructionMs: number;
  readonly firstFrameMs: number;
  readonly firstInteractiveFrameMs: number;
  readonly stabilizationMs: number;
  readonly stabilizationFrameCount: number;
  readonly initialMountMs: number;
  readonly mountedRenderableCount: number;
  readonly directScrollContentChildCount: number;
  readonly scrollHeight: number;
  readonly diagnostics: {
    readonly firstFrameCounters: PhaseCounters;
    readonly cleanFrameCounters: PhaseCounters;
    readonly dirtyFrameCounters: PhaseCounters;
  };
  readonly cleanFrames: FrameDistribution;
  readonly cleanNativeStats: NativeRenderStats;
  readonly dirtyFrames: FrameDistribution;
  readonly dirtyNativeStats: NativeRenderStats;
  readonly inputToFrame: {
    readonly syntheticKeyDispatch: FrameDistribution;
    readonly syntheticMouseDispatch: FrameDistribution;
    readonly chatLogScroll: FrameDistribution;
  };
  readonly cpuIntervals: {
    readonly spinnerOnly: CpuIntervalResult | null;
    readonly tailStreaming: CpuIntervalResult | null;
  };
  readonly rssBytes: RssMeasurements;
  readonly payloadBytes: ToolPayloadByteCounts;
  readonly capturedFrameBytes: number;
}

export interface ScenarioSummary {
  readonly scenario: ChatLogBenchmarkScenario;
  readonly runCount: number;
  readonly initialMountMs: DistributionSummary;
  readonly cleanFrameMs: DistributionSummary;
  readonly dirtyFrameMs: DistributionSummary;
  readonly syntheticKeyDispatchToFrameMs: DistributionSummary;
  readonly syntheticMouseDispatchToFrameMs: DistributionSummary;
  readonly chatLogScrollToFrameMs: DistributionSummary;
  readonly spinnerOnlyCpuPercent: DistributionSummary;
  readonly tailStreamingCpuPercent: DistributionSummary;
  readonly mountedRenderableCount: DistributionSummary;
  readonly directScrollContentChildCount: DistributionSummary;
  readonly rssAfterMountBytes: DistributionSummary;
  readonly payloadCanonicalBytes: DistributionSummary;
  readonly payloadDerivedBytes: DistributionSummary;
}

export type DistributionUnit = "process" | "frame" | "input-event";
export type DistributionAggregation = "across-processes" | "pooled-samples";

export interface DistributionSummary {
  readonly p50: number | null;
  readonly p95: number | null;
  readonly sampleCount: number;
  readonly unit: DistributionUnit;
  readonly aggregation: DistributionAggregation;
}

export interface SourceProvenance {
  readonly commit: string;
  readonly trackedDirty: boolean;
  readonly trackedDiffSha256: string;
}

export interface BenchmarkMetadata {
  readonly source: SourceProvenance;
  readonly bunVersion: string;
  readonly opentuiCoreVersion: string;
  readonly opentuiSolidVersion: string;
  readonly os: string;
  readonly cpuModel: string;
  readonly terminal: { readonly width: number; readonly height: number };
  readonly fixtureSeed: number;
  readonly fixturePreset: ChatLogBenchmarkFixturePreset;
  readonly activeProfile: string;
  readonly activeConfig: {
    readonly toolResultPreviewLines: number;
    readonly thinkingPreviewLines: number;
    readonly showThinking: boolean;
    readonly succinctToolResults: boolean;
    readonly stickyPromptHeaderLines: number;
  };
  readonly inputMeasurementMode: {
    readonly keyAndMouse: "synthetic-focus-target";
    readonly scroll: "chat-log-scrollbox";
  };
  readonly payloadByteAccounting: {
    readonly method: "utf8-serialized-field-bytes";
    readonly sharedValuesCountedPerField: true;
    readonly heapUsageEstimate: false;
  };
  readonly parameters: {
    readonly targetFps: number;
    readonly spinnerIntervalMs: number;
    readonly instrumentationMode: "separate-diagnostic-pass";
    readonly processes: number;
    readonly warmFrames: number;
    readonly cleanFrames: number;
    readonly dirtyUpdates: number;
    readonly inputSamples: number;
    readonly cpuIntervalMs: number;
    readonly childTimeoutMs: number;
    readonly percentileMethod: "nearest-rank";
  };
  readonly forcedGc: {
    readonly available: boolean;
    readonly mechanism: "Bun.gc(true)";
    readonly verification: "availability-only";
    readonly rssNormalized: false;
  };
}

export interface BenchmarkOutput {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly metadata: BenchmarkMetadata;
  readonly runs: BenchmarkRunResult[];
  readonly summaries: ScenarioSummary[];
  readonly growth: {
    readonly shortBlocks200To2000: {
      readonly cleanFrameP95Ratio: number | null;
      readonly mountedRenderableP95Ratio: number | null;
      readonly rssAfterMountP95Ratio: number | null;
    } | null;
  };
}
