import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { parseBenchmarkRunResult } from "../../../scripts/perf/chat-log-benchmark/protocol/parse-run-result";
import { SOURCE_PROVENANCE_ENV } from "../../../scripts/perf/chat-log-benchmark/protocol/source-provenance";
import { expectBenchmarkOutputContract, expectBenchmarkRunResultContract } from "./assert-result-contract";

describe("chat log benchmark executable protocol", () => {
  test("runs the quick child protocol and emits structurally complete raw results", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "scripts/perf/chat-log-benchmark/child/index.tsx",
        "--quick",
        "--scenario",
        "tail-streaming-and-spinner",
        "--seed",
        "17",
        "--run-index",
        "2",
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const run = expectBenchmarkRunResultContract(JSON.parse(stdout));
    expect(parseBenchmarkRunResult(run, "tail-streaming-and-spinner", 2)).toEqual(run);
    expect(() => parseBenchmarkRunResult(run, "short-blocks-200", 2)).toThrow(
      "Benchmark child returned scenario tail-streaming-and-spinner; expected short-blocks-200",
    );
    expect(() => parseBenchmarkRunResult(run, "tail-streaming-and-spinner", 3)).toThrow(
      "Benchmark child returned run index 2; expected 3",
    );
    expect(() => parseBenchmarkRunResult({}, "tail-streaming-and-spinner", 2)).toThrow();
    expect(() =>
      parseBenchmarkRunResult(
        { ...run, cleanNativeStats: { ...run.cleanNativeStats, unexpectedStat: 1 } },
        "tail-streaming-and-spinner",
        2,
      ),
    ).toThrow();
    expect(run).toMatchObject({
      scenario: "tail-streaming-and-spinner",
      runIndex: 2,
      seed: 17,
      blockSummary: { total: 202 },
      modelConstruction: "batch-blocks",
      modelState: {
        currentBlockId: "streaming-tail",
        running: true,
        spinnerActive: true,
      },
    });
    expect(run.cleanFrames.samplesMs).toHaveLength(5);
    expect(run.dirtyFrames.samplesMs).toHaveLength(3);
    expect(run.inputToFrame.syntheticKeyDispatch.samplesMs).toHaveLength(2);
    expect(run.inputToFrame.syntheticMouseDispatch.samplesMs).toHaveLength(2);
    expect(run.inputToFrame.chatLogScroll.samplesMs).toHaveLength(2);
    expect(run.mountedReplayMs).toBeNull();
    expect(run.diagnostics.firstFrameCounters.yogaLayoutPasses).toBeGreaterThan(0);
    expect(run.diagnostics.firstFrameCounters.layoutRefreshCalls).toBeGreaterThan(0);
    expect(run.diagnostics.firstFrameCounters.renderableCommandCount).toBeGreaterThan(0);
    expect(run.cpuIntervals.spinnerOnly?.activity).toBe("spinner-only");
    expect(run.cpuIntervals.tailStreaming?.activity).toBe("tail-streaming");
  }, 30_000);

  test("keeps large-history windowed benchmark rendering bounded", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "scripts/perf/chat-log-benchmark/child/index.tsx",
        "--quick",
        "--scenario",
        "short-blocks-2000",
        "--seed",
        "17",
        "--run-index",
        "0",
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const run = expectBenchmarkRunResultContract(JSON.parse(stdout));
    expect(run.blockSummary.total).toBe(2_000);
    expect(run.directScrollContentChildCount).toBeLessThan(10);
    expect(run.mountedRenderableCount).toBeLessThan(500);
  }, 30_000);

  test("rejects a child process when the parent-provided source provenance does not match", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "scripts/perf/chat-log-benchmark/child/index.tsx",
        "--quick",
        "--scenario",
        "short-blocks-200",
      ],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          [SOURCE_PROVENANCE_ENV]: JSON.stringify({
            commit: "0".repeat(40),
            trackedDirty: false,
            trackedDiffSha256: "0".repeat(64),
          }),
        },
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Benchmark source changed during the run");
  });

  test("replays resumed-session history into the mounted benchmark UI", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "scripts/perf/chat-log-benchmark/child/index.tsx",
        "--quick",
        "--scenario",
        "resumed-session-2000",
        "--seed",
        "17",
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stderr || stdout).toBe(0);

    const run = expectBenchmarkRunResultContract(JSON.parse(stdout));
    expect(run).toMatchObject({
      scenario: "resumed-session-2000",
      blockSummary: { total: 100 },
      modelConstruction: "acp-replay",
      modelState: { currentBlockId: null, running: false, spinnerActive: false },
      cpuIntervals: { spinnerOnly: null, tailStreaming: null },
    });
    expect(run.mountedReplayMs).toBeGreaterThan(0);
    expect(run.mountedReplayToStableMs).toBeGreaterThan(run.mountedReplayMs!);
    expect(run.diagnostics.firstFrameCounters.renderableCommandCount).toBeGreaterThan(0);
  }, 30_000);

  test("runs the parent protocol across two fresh child processes", async () => {
    const outputPath = path.join(process.env.RELAY_TEST_ROOT ?? "/tmp", "chat-log-parent-protocol.json");
    const child = Bun.spawn(
      [
        process.execPath,
        "scripts/perf/chat-log-benchmark/index.ts",
        "--scenario",
        "short-blocks-200",
        "--processes",
        "2",
        "--warm-frames",
        "0",
        "--clean-frames",
        "1",
        "--dirty-updates",
        "1",
        "--input-samples",
        "0",
        "--cpu-ms",
        "1",
        "--child-timeout-ms",
        "30000",
        "--seed",
        "23",
        "--output",
        outputPath,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    try {
      expect(exitCode, stderr || stdout).toBe(0);
      const output = expectBenchmarkOutputContract(await Bun.file(outputPath).json());
      expect(output.schemaVersion).toBe(2);
      expect(output.metadata.source.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(output.metadata.source.trackedDiffSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(output.metadata.inputMeasurementMode).toEqual({
        keyAndMouse: "synthetic-focus-target",
        scroll: "chat-log-scrollbox",
      });
      expect(output.metadata.parameters).toMatchObject({
        instrumentationMode: "separate-diagnostic-pass",
        spinnerIntervalMs: 80,
      });
      expect(output.runs).toHaveLength(2);
      expect(output.runs.map((run) => run.runIndex)).toEqual([0, 1]);
      expect(output.runs.map((run) => run.seed)).toEqual([23, 23]);
      expect(output.runs.every((run) => run.scenario === "short-blocks-200")).toBe(true);
      expect(output.runs.every((run) => run.cpuIntervals.spinnerOnly === null)).toBe(true);
      expect(output.runs.every((run) => run.cpuIntervals.tailStreaming === null)).toBe(true);
      expect(output.summaries).toHaveLength(1);
      expect(output.summaries[0]).toMatchObject({
        scenario: "short-blocks-200",
        runCount: 2,
        spinnerOnlyCpuPercent: { p50: null, p95: null, sampleCount: 0 },
        tailStreamingCpuPercent: { p50: null, p95: null, sampleCount: 0 },
      });
    } finally {
      fs.rmSync(outputPath, { force: true });
    }
  }, 30_000);

  test("runs through the public package script", async () => {
    const outputPath = path.join(process.env.RELAY_TEST_ROOT ?? "/tmp", "chat-log-package-script.json");
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "bench:chat-log",
        "--scenario",
        "short-blocks-200",
        "--processes",
        "1",
        "--warm-frames",
        "0",
        "--clean-frames",
        "1",
        "--dirty-updates",
        "1",
        "--input-samples",
        "0",
        "--cpu-ms",
        "1",
        "--output",
        outputPath,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    try {
      expect(exitCode, stderr || stdout).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toContain("benchmark short-blocks-200 process 1/1");
      expect(stderr).toContain(`wrote ${outputPath}`);
      const output = expectBenchmarkOutputContract(await Bun.file(outputPath).json());
      expect(output.schemaVersion).toBe(2);
      expect(output.runs).toHaveLength(1);
    } finally {
      fs.rmSync(outputPath, { force: true });
    }
  }, 30_000);
});
