import { describe, expect, test } from "bun:test";
import { flushTelemetryBeforeExit, flushTelemetryWithinBudget } from "../src/telemetry-shutdown";

describe("flushTelemetryBeforeExit", () => {
  test("waits for the telemetry transport beyond the former shutdown budget", async () => {
    let flushed = false;

    await flushTelemetryBeforeExit(async () => {
      await Bun.sleep(80);
      flushed = true;
    });

    expect(flushed).toBe(true);
  });

  test("ignores telemetry flush failures", async () => {
    await expect(
      flushTelemetryBeforeExit(async () => {
        throw new Error("flush failed");
      }),
    ).resolves.toBeUndefined();
  });
});

describe("flushTelemetryWithinBudget", () => {
  test("returns when telemetry flush completes", async () => {
    let flushed = false;

    await flushTelemetryWithinBudget({
      flush: async () => {
        await Bun.sleep(20);
        flushed = true;
      },
      timeoutMs: 100,
    });

    expect(flushed).toBe(true);
  });

  test("ignores telemetry flush failures", async () => {
    await expect(
      flushTelemetryWithinBudget({
        flush: async () => {
          throw new Error("flush failed");
        },
        timeoutMs: 100,
      }),
    ).resolves.toBeUndefined();
  });

  test("returns after the shutdown budget when telemetry never settles", async () => {
    const startedAt = performance.now();

    await flushTelemetryWithinBudget({
      flush: () => new Promise<void>(() => undefined),
      timeoutMs: 20,
    });

    expect(performance.now() - startedAt).toBeLessThan(200);
  });
});
