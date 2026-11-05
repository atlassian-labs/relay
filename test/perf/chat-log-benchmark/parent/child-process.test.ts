import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildChildProcessArguments,
  buildChildProcessEnvironment,
  collectBenchmarkChildResult,
  terminateChildProcess,
  type BenchmarkChildProcess,
  type TerminableChildProcess,
} from "../../../../scripts/perf/chat-log-benchmark/parent/child-process";
import { parseParentOptions } from "../../../../scripts/perf/chat-log-benchmark/protocol/options";
import { SOURCE_PROVENANCE_ENV } from "../../../../scripts/perf/chat-log-benchmark/protocol/source-provenance";

describe("chat log benchmark child process", () => {
  test("translates every shared parent option into the child process arguments", () => {
    const options = parseParentOptions([
      "--scenario",
      "short-blocks-200",
      "--fixture-preset",
      "quick",
      "--processes",
      "7",
      "--warm-frames",
      "0",
      "--clean-frames",
      "2",
      "--dirty-updates",
      "3",
      "--input-samples",
      "0",
      "--cpu-ms",
      "4",
      "--child-timeout-ms",
      "5",
      "--width",
      "91",
      "--height",
      "27",
      "--seed",
      "12",
      "--output",
      "/tmp/ignored-by-child.json",
    ]);

    const args = buildChildProcessArguments(options, "short-blocks-200", 6);

    expect(args[0]).toEndWith(path.join("scripts", "perf", "chat-log-benchmark", "child", "index.tsx"));
    expect(args.slice(1)).toEqual([
      "--scenario",
      "short-blocks-200",
      "--fixture-preset",
      "quick",
      "--warm-frames",
      "0",
      "--clean-frames",
      "2",
      "--dirty-updates",
      "3",
      "--input-samples",
      "0",
      "--cpu-ms",
      "4",
      "--width",
      "91",
      "--height",
      "27",
      "--seed",
      "12",
      "--run-index",
      "6",
    ]);
  });

  test("serializes source provenance into the child process environment", () => {
    const source = {
      commit: "a".repeat(40),
      trackedDirty: true,
      trackedDiffSha256: "b".repeat(64),
    };

    expect(buildChildProcessEnvironment(source, { EXISTING_VALUE: "preserved" })).toEqual({
      EXISTING_VALUE: "preserved",
      [SOURCE_PROVENANCE_ENV]: JSON.stringify(source),
    });
  });

  test("force-kills a child that does not exit during the termination grace period", async () => {
    const signals: NodeJS.Signals[] = [];
    let exitCode: number | null = null;
    let resolveExit: ((code: number) => void) | undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const child: TerminableChildProcess = {
      get exitCode() {
        return exitCode;
      },
      exited,
      kill(signal) {
        signals.push(signal);
        if (signal === "SIGKILL") {
          exitCode = 137;
          resolveExit?.(exitCode);
        }
      },
    };

    await terminateChildProcess(child, 0);

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(Number(exitCode)).toBe(137);
  });

  test("times out a child, escalates termination, and removes signal handlers", async () => {
    const signals: NodeJS.Signals[] = [];
    let exitCode: number | null = null;
    let resolveExit: ((code: number) => void) | undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const emptyStream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
    const child: BenchmarkChildProcess = {
      get exitCode() {
        return exitCode;
      },
      exited,
      stdout: emptyStream(),
      stderr: emptyStream(),
      kill(signal) {
        signals.push(signal);
        if (signal === "SIGKILL") {
          exitCode = 137;
          resolveExit?.(exitCode);
        }
      },
    };
    const sigintListeners = process.listenerCount("SIGINT");
    const sigtermListeners = process.listenerCount("SIGTERM");

    await expect(collectBenchmarkChildResult(child, "short-blocks-200", 0, 1, 0)).rejects.toThrow(
      "Benchmark child timed out",
    );

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
  });
});
