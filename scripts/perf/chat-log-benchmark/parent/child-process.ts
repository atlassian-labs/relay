import * as path from "node:path";
import type { ChatLogBenchmarkScenario } from "../protocol/scenario";
import type { ParentBenchmarkOptions } from "../protocol/options";
import { parseBenchmarkRunResult } from "../protocol/parse-run-result";
import type { BenchmarkRunResult, SourceProvenance } from "../protocol/result";
import { SOURCE_PROVENANCE_ENV } from "../protocol/source-provenance";

const CHILD_ENTRYPOINT = path.resolve(import.meta.dir, "../child/index.tsx");

export function buildChildProcessArguments(
  options: ParentBenchmarkOptions,
  scenario: ChatLogBenchmarkScenario,
  runIndex: number,
): string[] {
  return [
    CHILD_ENTRYPOINT,
    "--scenario",
    scenario,
    "--fixture-preset",
    options.fixturePreset,
    "--warm-frames",
    String(options.warmFrames),
    "--clean-frames",
    String(options.cleanFrames),
    "--dirty-updates",
    String(options.dirtyUpdates),
    "--input-samples",
    String(options.inputSamples),
    "--cpu-ms",
    String(options.cpuIntervalMs),
    "--width",
    String(options.width),
    "--height",
    String(options.height),
    "--seed",
    String(options.seed),
    "--run-index",
    String(runIndex),
  ];
}

export function buildChildProcessEnvironment(
  source: SourceProvenance,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...environment, [SOURCE_PROVENANCE_ENV]: JSON.stringify(source) };
}

export interface TerminableChildProcess {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal: NodeJS.Signals): void;
}

export async function terminateChildProcess(child: TerminableChildProcess, graceMs = 1_000): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exitedDuringGrace = await Promise.race([child.exited.then(() => true), Bun.sleep(graceMs).then(() => false)]);
  if (exitedDuringGrace || child.exitCode !== null) return;
  child.kill("SIGKILL");
  await child.exited;
}

export interface BenchmarkChildProcess extends TerminableChildProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
}

export async function collectBenchmarkChildResult(
  child: BenchmarkChildProcess,
  scenario: ChatLogBenchmarkScenario,
  runIndex: number,
  timeoutMs: number,
  terminationGraceMs = 1_000,
): Promise<BenchmarkRunResult> {
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal);
  const forwardInterrupt = () => forwardSignal("SIGINT");
  const forwardTermination = () => forwardSignal("SIGTERM");
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);

  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Benchmark child timed out after ${timeoutMs} ms for ${scenario}`));
      }, timeoutMs);
    });
    const exitCode = await Promise.race([child.exited, timeoutPromise]);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (exitCode !== 0) throw new Error(`Benchmark child failed for ${scenario}:\n${stderr || stdout}`);
    return parseBenchmarkRunResult(JSON.parse(stdout), scenario, runIndex);
  } finally {
    if (timeout) clearTimeout(timeout);
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTermination);
    await terminateChildProcess(child, terminationGraceMs);
  }
}

export async function runFreshProcess(
  options: ParentBenchmarkOptions,
  scenario: ChatLogBenchmarkScenario,
  runIndex: number,
  source: SourceProvenance,
): Promise<BenchmarkRunResult> {
  const child = Bun.spawn([process.execPath, ...buildChildProcessArguments(options, scenario, runIndex)], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: buildChildProcessEnvironment(source),
  });
  return collectBenchmarkChildResult(child, scenario, runIndex, options.childTimeoutMs);
}
