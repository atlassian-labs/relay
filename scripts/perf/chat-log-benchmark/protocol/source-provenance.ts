import { createHash } from "node:crypto";
import type { SourceProvenance } from "./result";

export const SOURCE_PROVENANCE_ENV = "RELAY_BENCHMARK_SOURCE_PROVENANCE";

function gitOutput(args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

export function captureSourceProvenance(): SourceProvenance {
  const commit = gitOutput(["rev-parse", "HEAD"]).trim();
  const trackedDiff = gitOutput(["diff", "--binary", "HEAD", "--"]);
  return {
    commit,
    trackedDirty: trackedDiff.length > 0,
    trackedDiffSha256: createHash("sha256").update(trackedDiff).digest("hex"),
  };
}

export function assertSourceProvenance(expected: SourceProvenance): void {
  const actual = captureSourceProvenance();
  if (
    actual.commit !== expected.commit ||
    actual.trackedDirty !== expected.trackedDirty ||
    actual.trackedDiffSha256 !== expected.trackedDiffSha256
  ) {
    throw new Error(
      `Benchmark source changed during the run: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}
