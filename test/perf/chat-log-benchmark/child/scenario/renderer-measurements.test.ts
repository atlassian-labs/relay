import { describe, expect, test } from "bun:test";
import {
  counterDelta,
  createFrameMeasurementController,
} from "../../../../../scripts/perf/chat-log-benchmark/child/scenario/renderer-measurements";
import type { InstrumentationSnapshot } from "../../../../../scripts/perf/chat-log-benchmark/protocol/result";

const EMPTY_COUNTERS: InstrumentationSnapshot = {
  layoutTraversalCalls: 0,
  layoutRefreshCalls: 0,
  yogaLayoutPasses: 0,
  yogaLayoutDurationMs: 0,
  rootTraversalPasses: 0,
  rootTraversalDurationMs: 0,
  renderCommandCount: 0,
  renderableCommandCount: 0,
};

describe("chat log benchmark renderer measurements", () => {
  test("calculates exact phase deltas and per-frame values", () => {
    const end: InstrumentationSnapshot = {
      layoutTraversalCalls: 20,
      layoutRefreshCalls: 40,
      yogaLayoutPasses: 2,
      yogaLayoutDurationMs: 8,
      rootTraversalPasses: 4,
      rootTraversalDurationMs: 12,
      renderCommandCount: 100,
      renderableCommandCount: 80,
    };

    expect(counterDelta(EMPTY_COUNTERS, end, 4)).toEqual({
      ...end,
      layoutTraversalCallsPerFrame: 5,
      layoutRefreshCallsPerFrame: 10,
      yogaLayoutDurationMsPerFrame: 2,
      rootTraversalDurationMsPerFrame: 3,
      renderCommandCountPerFrame: 25,
      renderableCommandCountPerFrame: 20,
    });
    expect(counterDelta(EMPTY_COUNTERS, end, 0)).toMatchObject({
      layoutTraversalCallsPerFrame: 0,
      layoutRefreshCallsPerFrame: 0,
      yogaLayoutDurationMsPerFrame: 0,
      rootTraversalDurationMsPerFrame: 0,
      renderCommandCountPerFrame: 0,
      renderableCommandCountPerFrame: 0,
    });
  });

  test("completes input latency only after a newer matching renderer frame", async () => {
    let now = 100;
    let conditionMet = false;
    const controller = createFrameMeasurementController(() => now);
    const measurement = controller.begin(4, () => conditionMet);
    let resolved = false;
    void measurement.then(() => {
      resolved = true;
    });

    controller.completeFrame(4);
    conditionMet = true;
    controller.completeFrame(4);
    await Promise.resolve();
    expect(resolved).toBe(false);

    now = 112;
    controller.completeFrame(5);
    expect(await measurement).toBe(12);
  });

  test("cancels pending frame measurements without contaminating the next sample", async () => {
    let now = 20;
    const controller = createFrameMeasurementController(() => now);
    const cancelled = controller.begin(1);
    controller.cancel(new Error("timed out"));
    await expect(cancelled).rejects.toThrow("timed out");

    now = 30;
    const next = controller.begin(2);
    now = 37;
    controller.completeFrame(3);
    expect(await next).toBe(7);
  });
});
