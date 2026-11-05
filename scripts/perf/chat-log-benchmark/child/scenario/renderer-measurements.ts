import { performance } from "node:perf_hooks";
import { Renderable, RootRenderable, type RenderCommand } from "@opentui/core";
import { nearestRankPercentile } from "../../protocol/statistics";
import type { FrameDistribution, InstrumentationSnapshot, PhaseCounters } from "../../protocol/result";
import { FORCED_GC_AVAILABLE } from "../../protocol/settings";

let renderableInstrumentationActive = false;

export interface FrameMeasurementController {
  begin(startFrameId: number, condition?: () => boolean): Promise<number>;
  completeFrame(frameId: number): void;
  cancel(error: Error): void;
}

export function createFrameMeasurementController(
  now: () => number = () => performance.now(),
): FrameMeasurementController {
  let pending:
    | {
        readonly startFrameId: number;
        readonly startTime: number;
        readonly condition: () => boolean;
        readonly resolve: (durationMs: number) => void;
        readonly reject: (error: Error) => void;
      }
    | undefined;

  return {
    begin(startFrameId, condition = () => true) {
      if (pending) throw new Error("A frame measurement is already pending");
      return new Promise<number>((resolve, reject) => {
        pending = { startFrameId, startTime: now(), condition, resolve, reject };
      });
    },
    completeFrame(frameId) {
      const current = pending;
      if (!current || frameId <= current.startFrameId || !current.condition()) return;
      pending = undefined;
      current.resolve(now() - current.startTime);
    },
    cancel(error) {
      const current = pending;
      if (!current) return;
      pending = undefined;
      current.reject(error);
    },
  };
}

export function installRenderableInstrumentation(): {
  readonly snapshot: () => InstrumentationSnapshot;
  readonly restore: () => void;
} {
  if (renderableInstrumentationActive) throw new Error("Renderable instrumentation is already installed");
  renderableInstrumentationActive = true;
  const originalUpdateLayout = Renderable.prototype.updateLayout;
  const originalUpdateFromLayout = Renderable.prototype.updateFromLayout;
  const originalCalculateLayout = RootRenderable.prototype.calculateLayout;
  let layoutTraversalCalls = 0;
  let layoutRefreshCalls = 0;
  let yogaLayoutPasses = 0;
  let yogaLayoutDurationMs = 0;
  let rootTraversalPasses = 0;
  let rootTraversalDurationMs = 0;
  let renderCommandCount = 0;
  let renderableCommandCount = 0;
  let restored = false;

  Renderable.prototype.updateLayout = function (
    this: Renderable,
    deltaTime: number,
    renderList?: RenderCommand[],
  ): void {
    layoutTraversalCalls++;
    const isRoot = this instanceof RootRenderable;
    const renderCommandStart = renderList?.length ?? 0;
    const traversalStart = isRoot ? performance.now() : 0;
    originalUpdateLayout.call(this, deltaTime, renderList);
    if (isRoot) {
      const renderCommandEnd = renderList?.length ?? renderCommandStart;
      rootTraversalPasses++;
      rootTraversalDurationMs += performance.now() - traversalStart;
      renderCommandCount += Math.max(0, renderCommandEnd - renderCommandStart);
      for (let index = renderCommandStart; index < renderCommandEnd; index++) {
        if (renderList?.[index]?.action === "render") renderableCommandCount++;
      }
    }
  };
  Renderable.prototype.updateFromLayout = function (this: Renderable): void {
    layoutRefreshCalls++;
    originalUpdateFromLayout.call(this);
  };
  RootRenderable.prototype.calculateLayout = function (this: RootRenderable): void {
    const start = performance.now();
    originalCalculateLayout.call(this);
    yogaLayoutPasses++;
    yogaLayoutDurationMs += performance.now() - start;
  };

  return {
    snapshot: () => ({
      layoutTraversalCalls,
      layoutRefreshCalls,
      yogaLayoutPasses,
      yogaLayoutDurationMs,
      rootTraversalPasses,
      rootTraversalDurationMs,
      renderCommandCount,
      renderableCommandCount,
    }),
    restore() {
      if (restored) return;
      restored = true;
      Renderable.prototype.updateLayout = originalUpdateLayout;
      Renderable.prototype.updateFromLayout = originalUpdateFromLayout;
      RootRenderable.prototype.calculateLayout = originalCalculateLayout;
      renderableInstrumentationActive = false;
    },
  };
}

export function assertRenderableInstrumentationInactive(phase: string): void {
  if (renderableInstrumentationActive) {
    throw new Error(`Renderable instrumentation contaminated the ${phase} measurement phase`);
  }
}

export function counterDelta(
  start: InstrumentationSnapshot,
  end: InstrumentationSnapshot,
  frameCount: number,
): PhaseCounters {
  const layoutTraversalCalls = end.layoutTraversalCalls - start.layoutTraversalCalls;
  const layoutRefreshCalls = end.layoutRefreshCalls - start.layoutRefreshCalls;
  const yogaLayoutPasses = end.yogaLayoutPasses - start.yogaLayoutPasses;
  const yogaLayoutDurationMs = end.yogaLayoutDurationMs - start.yogaLayoutDurationMs;
  const rootTraversalPasses = end.rootTraversalPasses - start.rootTraversalPasses;
  const rootTraversalDurationMs = end.rootTraversalDurationMs - start.rootTraversalDurationMs;
  const renderCommandCount = end.renderCommandCount - start.renderCommandCount;
  const renderableCommandCount = end.renderableCommandCount - start.renderableCommandCount;
  return {
    layoutTraversalCalls,
    layoutRefreshCalls,
    yogaLayoutPasses,
    yogaLayoutDurationMs,
    rootTraversalPasses,
    rootTraversalDurationMs,
    renderCommandCount,
    renderableCommandCount,
    layoutTraversalCallsPerFrame: frameCount > 0 ? layoutTraversalCalls / frameCount : 0,
    layoutRefreshCallsPerFrame: frameCount > 0 ? layoutRefreshCalls / frameCount : 0,
    yogaLayoutDurationMsPerFrame: frameCount > 0 ? yogaLayoutDurationMs / frameCount : 0,
    rootTraversalDurationMsPerFrame: frameCount > 0 ? rootTraversalDurationMs / frameCount : 0,
    renderCommandCountPerFrame: frameCount > 0 ? renderCommandCount / frameCount : 0,
    renderableCommandCountPerFrame: frameCount > 0 ? renderableCommandCount / frameCount : 0,
  };
}

export function distribution(samplesMs: number[]): FrameDistribution {
  return {
    samplesMs,
    p50Ms: nearestRankPercentile(samplesMs, 0.5),
    p95Ms: nearestRankPercentile(samplesMs, 0.95),
  };
}

export async function collectExplicitFrames(count: number, renderOnce: () => Promise<void>): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < count; index++) {
    const start = performance.now();
    await renderOnce();
    samples.push(performance.now() - start);
  }
  return samples;
}

async function waitForFrameMeasurement(
  controller: FrameMeasurementController,
  measurement: Promise<number>,
  label: string,
): Promise<number> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<number>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`Timed out waiting for ${label} completed frame measurement`);
      controller.cancel(error);
      reject(error);
    }, 5_000);
  });
  try {
    return await Promise.race([measurement, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function collectInputSamples(options: {
  readonly count: number;
  readonly controller: FrameMeasurementController;
  readonly frameId: () => number;
  readonly inputVersion: () => number;
  readonly scrollTop: () => number;
  readonly pressKey: () => void;
  readonly pressMouse: () => Promise<void>;
  readonly scrollMouse: (direction: "up" | "down") => Promise<void>;
}): Promise<{ key: number[]; mouse: number[]; scroll: number[] }> {
  const key: number[] = [];
  const mouse: number[] = [];
  const scroll: number[] = [];

  for (let index = 0; index < options.count; index++) {
    const expectedInputVersion = options.inputVersion() + 1;
    const keyMeasurement = options.controller.begin(
      options.frameId(),
      () => options.inputVersion() >= expectedInputVersion,
    );
    options.pressKey();
    key.push(await waitForFrameMeasurement(options.controller, keyMeasurement, "key"));

    const expectedMouseVersion = options.inputVersion() + 1;
    const mouseMeasurement = options.controller.begin(
      options.frameId(),
      () => options.inputVersion() >= expectedMouseVersion,
    );
    await options.pressMouse();
    mouse.push(await waitForFrameMeasurement(options.controller, mouseMeasurement, "mouse"));

    const previousScrollTop = options.scrollTop();
    const scrollMeasurement = options.controller.begin(
      options.frameId(),
      () => options.scrollTop() !== previousScrollTop,
    );
    await options.scrollMouse(index % 2 === 0 ? "up" : "down");
    scroll.push(await waitForFrameMeasurement(options.controller, scrollMeasurement, "scroll"));
  }

  return { key, mouse, scroll };
}

export function sampleRssAfterGcRequest(): number {
  if (FORCED_GC_AVAILABLE) Bun.gc(true);
  return process.memoryUsage().rss;
}
