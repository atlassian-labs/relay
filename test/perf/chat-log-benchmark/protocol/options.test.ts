import { describe, expect, test } from "bun:test";
import { parseChildOptions, parseParentOptions } from "../../../../scripts/perf/chat-log-benchmark/protocol/options";

describe("chat log benchmark options", () => {
  test("applies the full protocol defaults", () => {
    const options = parseParentOptions([]);

    expect(options).toMatchObject({
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
    });
    expect(options.scenarios).toHaveLength(7);
  });

  test("keeps scenario and terminal choices while quick mode overrides sample counts", () => {
    const options = parseParentOptions([
      "--scenario",
      "short-blocks-200",
      "--processes",
      "7",
      "--clean-frames",
      "99",
      "--width",
      "90",
      "--child-timeout-ms",
      "1234",
      "--quick",
    ]);

    expect(options.scenarios).toEqual(["short-blocks-200"]);
    expect(options).toMatchObject({
      fixturePreset: "quick",
      processes: 1,
      warmFrames: 2,
      cleanFrames: 5,
      dirtyUpdates: 3,
      inputSamples: 2,
      cpuIntervalMs: 100,
      childTimeoutMs: 1234,
      width: 90,
    });
  });

  test("rejects invalid options", () => {
    expect(() => parseParentOptions(["--scenario", "missing"])).toThrow("Unknown scenario");
    expect(() => parseParentOptions(["--fixture-preset", "missing"])).toThrow("Unknown fixture preset");
    expect(() => parseParentOptions(["--clean-frames", "0"])).toThrow("--clean-frames requires an integer >= 1");
    expect(() => parseParentOptions(["--unknown"])).toThrow("Unknown option");
    expect(() => parseParentOptions(["--run-index", "1"])).toThrow("Unknown option: --run-index");
    expect(() => parseParentOptions(["--child"])).toThrow("Unknown option: --child");
  });

  test("parses exactly one child scenario without parent-only controls", () => {
    const options = parseChildOptions(["--quick", "--scenario", "short-blocks-200", "--run-index", "4"]);

    expect(options).toMatchObject({
      scenario: "short-blocks-200",
      runIndex: 4,
      fixturePreset: "quick",
      warmFrames: 2,
      cleanFrames: 5,
      dirtyUpdates: 3,
      inputSamples: 2,
      cpuIntervalMs: 100,
    });
    expect(() => parseChildOptions([])).toThrow("Child benchmark requires exactly one scenario");
    for (const parentOnlyArgs of [
      ["--processes", "2"],
      ["--child-timeout-ms", "100"],
      ["--output", "/tmp/result.json"],
    ]) {
      expect(() => parseChildOptions(["--scenario", "short-blocks-200", ...parentOnlyArgs])).toThrow(
        `Unknown option: ${parentOnlyArgs[0]}`,
      );
    }
  });
});
