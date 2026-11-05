import { describe, expect, test } from "bun:test";
import {
  resolveTranscriptRendererMode,
  type TranscriptRendererMode,
} from "../../../src/ui/util/transcript-renderer-mode";

describe("resolveTranscriptRendererMode", () => {
  const cases: Array<[string, Record<string, string | undefined>, TranscriptRendererMode, TranscriptRendererMode]> = [
    ["uses the legacy rollout default when unset", {}, "legacy", "legacy"],
    ["uses a windowed rollout default when unset", {}, "windowed", "windowed"],
    ["accepts legacy", { RELAY_TRANSCRIPT_RENDERER: "legacy" }, "windowed", "legacy"],
    ["accepts windowed", { RELAY_TRANSCRIPT_RENDERER: "windowed" }, "legacy", "windowed"],
  ];

  for (const [name, env, rolloutDefault, expected] of cases) {
    test(name, () => {
      expect(resolveTranscriptRendererMode(env, rolloutDefault)).toBe(expected);
    });
  }

  test("warns once and uses the rollout default for an invalid value", () => {
    const warnings: string[] = [];
    expect(
      resolveTranscriptRendererMode({ RELAY_TRANSCRIPT_RENDERER: "invalid" }, "legacy", (message) =>
        warnings.push(message),
      ),
    ).toBe("legacy");
    expect(warnings).toEqual([expect.stringContaining('Invalid RELAY_TRANSCRIPT_RENDERER="invalid"')]);
  });

  test("returns an immutable startup decision after the environment changes", () => {
    const env: Record<string, string | undefined> = { RELAY_TRANSCRIPT_RENDERER: "windowed" };
    const resolved = resolveTranscriptRendererMode(env, "legacy");
    env.RELAY_TRANSCRIPT_RENDERER = "legacy";
    expect(resolved).toBe("windowed");
  });
});
