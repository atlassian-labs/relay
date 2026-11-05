import { describe, expect, test } from "bun:test";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS, spinnerFrameAt } from "../../../src/ui/util/spinner-frames";

describe("spinner frames", () => {
  test("returns the shared frame by index and falls back to the first frame", () => {
    expect(SPINNER_INTERVAL_MS).toBe(80);
    expect(SPINNER_FRAMES.length).toBeGreaterThan(1);
    expect(spinnerFrameAt(1)).toBe(SPINNER_FRAMES[1]);
    expect(spinnerFrameAt(-1)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrameAt(SPINNER_FRAMES.length)).toBe(SPINNER_FRAMES[0]);
  });
});
