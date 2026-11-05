import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SPINNER_INTERVAL_MS } from "../../../../../src/ui/util/spinner-frames";
import type { ParentBenchmarkOptions } from "../../protocol/options";
import type { BenchmarkMetadata, SourceProvenance } from "../../protocol/result";
import {
  BENCHMARK_PROFILE,
  BENCHMARK_TARGET_FPS,
  BENCHMARK_UI_SETTINGS,
  FORCED_GC_AVAILABLE,
} from "../../protocol/settings";

function packageVersion(packageName: "@opentui/core" | "@opentui/solid"): string {
  const packagePath = path.join(process.cwd(), "node_modules", ...packageName.split("/"), "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string") throw new Error(`Missing version in ${packagePath}`);
  return packageJson.version;
}

export function benchmarkMetadata(options: ParentBenchmarkOptions, source: SourceProvenance): BenchmarkMetadata {
  const metadata: BenchmarkMetadata = {
    source,
    bunVersion: Bun.version,
    opentuiCoreVersion: packageVersion("@opentui/core"),
    opentuiSolidVersion: packageVersion("@opentui/solid"),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    terminal: { width: options.width, height: options.height },
    fixtureSeed: options.seed,
    fixturePreset: options.fixturePreset,
    activeProfile: BENCHMARK_PROFILE,
    activeConfig: {
      toolResultPreviewLines: BENCHMARK_UI_SETTINGS.toolResultPreviewLines,
      thinkingPreviewLines: BENCHMARK_UI_SETTINGS.thinkingPreviewLines,
      showThinking: BENCHMARK_UI_SETTINGS.showThinking,
      succinctToolResults: BENCHMARK_UI_SETTINGS.succinctToolResults,
      stickyPromptHeaderLines: BENCHMARK_UI_SETTINGS.stickyPromptHeaderLines,
    },
    inputMeasurementMode: {
      keyAndMouse: "synthetic-focus-target",
      scroll: "chat-log-scrollbox",
    },
    payloadByteAccounting: {
      method: "utf8-serialized-field-bytes",
      sharedValuesCountedPerField: true,
      heapUsageEstimate: false,
    },
    parameters: {
      targetFps: BENCHMARK_TARGET_FPS,
      spinnerIntervalMs: SPINNER_INTERVAL_MS,
      instrumentationMode: "separate-diagnostic-pass",
      processes: options.processes,
      warmFrames: options.warmFrames,
      cleanFrames: options.cleanFrames,
      dirtyUpdates: options.dirtyUpdates,
      inputSamples: options.inputSamples,
      cpuIntervalMs: options.cpuIntervalMs,
      childTimeoutMs: options.childTimeoutMs,
      percentileMethod: "nearest-rank",
    },
    forcedGc: {
      available: FORCED_GC_AVAILABLE,
      mechanism: "Bun.gc(true)",
      verification: "availability-only",
      rssNormalized: false,
    },
  };
  return metadata;
}
