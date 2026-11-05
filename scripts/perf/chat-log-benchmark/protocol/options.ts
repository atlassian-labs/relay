import {
  CHAT_LOG_BENCHMARK_SCENARIOS,
  type ChatLogBenchmarkFixturePreset,
  type ChatLogBenchmarkScenario,
} from "./scenario";

export interface BenchmarkMeasurementOptions {
  readonly fixturePreset: ChatLogBenchmarkFixturePreset;
  readonly warmFrames: number;
  readonly cleanFrames: number;
  readonly dirtyUpdates: number;
  readonly inputSamples: number;
  readonly cpuIntervalMs: number;
  readonly width: number;
  readonly height: number;
  readonly seed: number;
}

export interface ParentBenchmarkOptions extends BenchmarkMeasurementOptions {
  readonly scenarios: readonly ChatLogBenchmarkScenario[];
  readonly processes: number;
  readonly childTimeoutMs: number;
  readonly outputPath?: string;
}

export interface ChildBenchmarkOptions extends BenchmarkMeasurementOptions {
  readonly scenario: ChatLogBenchmarkScenario;
  readonly runIndex: number;
}

type ParseMode = "parent" | "child";

interface MutableBenchmarkArguments {
  fixturePreset: ChatLogBenchmarkFixturePreset;
  processes: number;
  warmFrames: number;
  cleanFrames: number;
  dirtyUpdates: number;
  inputSamples: number;
  cpuIntervalMs: number;
  childTimeoutMs: number;
  width: number;
  height: number;
  seed: number;
  runIndex: number;
  outputPath?: string;
  scenarios: ChatLogBenchmarkScenario[];
  quick: boolean;
}

function usage(mode: ParseMode): string {
  const parentOnly =
    mode === "parent"
      ? `  --processes <count>     Fresh processes per scenario (default: 3)
  --child-timeout-ms <ms> Kill a stuck scenario process (default: 300000)
  --output <path>         Write raw JSON to a file instead of stdout
`
      : `  --run-index <index>     Parent-assigned run index (default: 0)
`;
  return `Usage: bun run ${mode === "parent" ? "bench:chat-log" : "scripts/perf/chat-log-benchmark/child/index.tsx"} [options]

Options:
  --scenario <name>       ${mode === "parent" ? "Run only one scenario; may be repeated" : "Run exactly one scenario"}
  --fixture-preset <name> Use full or quick fixture sizes (default: full)
${parentOnly}  --warm-frames <count>   Explicit warm-up frames (default: 100)
  --clean-frames <count>  Explicit clean frames to record (default: 1000)
  --dirty-updates <count> Dirty/streaming updates to record (default: 250)
  --input-samples <count> Samples per synthetic key/mouse dispatch and chat-log scroll (default: 50)
  --cpu-ms <milliseconds> Duration of each CPU activity interval (default: 10000)
  --width <columns>       Renderer width (default: 120)
  --height <rows>         Renderer height (default: 40)
  --seed <integer>        Deterministic fixture seed (default: 1)
  --quick                 One-process smoke protocol with small sample counts
  --help                  Show this help

Scenarios:
  ${CHAT_LOG_BENCHMARK_SCENARIOS.join("\n  ")}`;
}

function parsePositiveInteger(value: string | undefined, option: string, allowZero = false): number {
  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${option} requires an integer >= ${minimum}`);
  return parsed;
}

function isScenario(value: string): value is ChatLogBenchmarkScenario {
  return (CHAT_LOG_BENCHMARK_SCENARIOS as readonly string[]).includes(value);
}

function defaultArguments(): MutableBenchmarkArguments {
  return {
    fixturePreset: "full",
    processes: 3,
    warmFrames: 100,
    cleanFrames: 1_000,
    dirtyUpdates: 250,
    inputSamples: 50,
    cpuIntervalMs: 10_000,
    childTimeoutMs: 300_000,
    width: 120,
    height: 40,
    seed: 1,
    runIndex: 0,
    scenarios: [],
    quick: false,
  };
}

function parseArguments(args: readonly string[], mode: ParseMode): MutableBenchmarkArguments {
  const parsed = defaultArguments();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    switch (arg) {
      case "--quick":
        parsed.quick = true;
        break;
      case "--scenario": {
        const value = args[++index];
        if (!value || !isScenario(value)) throw new Error(`Unknown scenario: ${value ?? "<missing>"}`);
        parsed.scenarios.push(value);
        break;
      }
      case "--fixture-preset": {
        const value = args[++index];
        if (value !== "full" && value !== "quick") throw new Error(`Unknown fixture preset: ${value ?? "<missing>"}`);
        parsed.fixturePreset = value;
        break;
      }
      case "--processes":
        if (mode !== "parent") throw new Error(`Unknown option: ${arg}`);
        parsed.processes = parsePositiveInteger(args[++index], arg);
        break;
      case "--warm-frames":
        parsed.warmFrames = parsePositiveInteger(args[++index], arg, true);
        break;
      case "--clean-frames":
        parsed.cleanFrames = parsePositiveInteger(args[++index], arg);
        break;
      case "--dirty-updates":
        parsed.dirtyUpdates = parsePositiveInteger(args[++index], arg);
        break;
      case "--input-samples":
        parsed.inputSamples = parsePositiveInteger(args[++index], arg, true);
        break;
      case "--cpu-ms":
        parsed.cpuIntervalMs = parsePositiveInteger(args[++index], arg);
        break;
      case "--child-timeout-ms":
        if (mode !== "parent") throw new Error(`Unknown option: ${arg}`);
        parsed.childTimeoutMs = parsePositiveInteger(args[++index], arg);
        break;
      case "--width":
        parsed.width = parsePositiveInteger(args[++index], arg);
        break;
      case "--height":
        parsed.height = parsePositiveInteger(args[++index], arg);
        break;
      case "--seed":
        parsed.seed = parsePositiveInteger(args[++index], arg, true);
        break;
      case "--run-index":
        if (mode !== "child") throw new Error(`Unknown option: ${arg}`);
        parsed.runIndex = parsePositiveInteger(args[++index], arg, true);
        break;
      case "--output":
        if (mode !== "parent") throw new Error(`Unknown option: ${arg}`);
        parsed.outputPath = args[++index];
        if (!parsed.outputPath) throw new Error("--output requires a path");
        break;
      case "--help":
        console.log(usage(mode));
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (parsed.quick) {
    parsed.fixturePreset = "quick";
    parsed.processes = 1;
    parsed.warmFrames = 2;
    parsed.cleanFrames = 5;
    parsed.dirtyUpdates = 3;
    parsed.inputSamples = 2;
    parsed.cpuIntervalMs = 100;
  }
  return parsed;
}

function measurementOptions(parsed: MutableBenchmarkArguments): BenchmarkMeasurementOptions {
  return {
    fixturePreset: parsed.fixturePreset,
    warmFrames: parsed.warmFrames,
    cleanFrames: parsed.cleanFrames,
    dirtyUpdates: parsed.dirtyUpdates,
    inputSamples: parsed.inputSamples,
    cpuIntervalMs: parsed.cpuIntervalMs,
    width: parsed.width,
    height: parsed.height,
    seed: parsed.seed,
  };
}

export function parseParentOptions(args: readonly string[]): ParentBenchmarkOptions {
  const parsed = parseArguments(args, "parent");
  return {
    ...measurementOptions(parsed),
    scenarios: parsed.scenarios.length > 0 ? parsed.scenarios : [...CHAT_LOG_BENCHMARK_SCENARIOS],
    processes: parsed.processes,
    childTimeoutMs: parsed.childTimeoutMs,
    outputPath: parsed.outputPath,
  };
}

export function parseChildOptions(args: readonly string[]): ChildBenchmarkOptions {
  const parsed = parseArguments(args, "child");
  if (parsed.scenarios.length !== 1) throw new Error("Child benchmark requires exactly one scenario");
  return {
    ...measurementOptions(parsed),
    scenario: parsed.scenarios[0],
    runIndex: parsed.runIndex,
  };
}
