import { describe, expect, test } from "bun:test";
import {
  assertSourceProvenance,
  captureSourceProvenance,
} from "../../../../scripts/perf/chat-log-benchmark/protocol/source-provenance";

describe("chat log benchmark source provenance", () => {
  test("captures tracked source provenance and rejects mismatches", () => {
    const source = captureSourceProvenance();
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(source.trackedDiffSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => assertSourceProvenance(source)).not.toThrow();
    expect(() => assertSourceProvenance({ ...source, commit: "0".repeat(40) })).toThrow(
      "Benchmark source changed during the run",
    );
    expect(() => assertSourceProvenance({ ...source, trackedDirty: !source.trackedDirty })).toThrow(
      "Benchmark source changed during the run",
    );
    expect(() => assertSourceProvenance({ ...source, trackedDiffSha256: "0".repeat(64) })).toThrow(
      "Benchmark source changed during the run",
    );
  });
});
