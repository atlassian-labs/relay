import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { CliRenderEvents } from "@opentui/core";
import { appPropsForLaunch, logUncaughtErrorsUntilDestroy } from "../../../src/ui/app/launch";

describe("launchTUI app props", () => {
  test("uses the windowed renderer when no rollout override is present", () => {
    const props = appPropsForLaunch({ cwd: "/tmp/relay" }, {});

    expect(props.transcriptRendererMode).toBe("windowed");
  });

  test("propagates yolo mode into App", () => {
    expect(appPropsForLaunch({ cwd: "/tmp/relay", yolo: true }, {}).initialYolo).toBe(true);
    expect(appPropsForLaunch({ cwd: "/tmp/relay" }, {}).initialYolo).toBe(false);
  });

  test("propagates the startup transcript renderer kill switch into App", () => {
    const legacy = appPropsForLaunch({ cwd: "/tmp/relay" }, { RELAY_TRANSCRIPT_RENDERER: "legacy" });
    const windowed = appPropsForLaunch({ cwd: "/tmp/relay" }, { RELAY_TRANSCRIPT_RENDERER: "windowed" });

    expect(legacy.transcriptRendererMode).toBe("legacy");
    expect(windowed.transcriptRendererMode).toBe("windowed");
    expect(legacy.cwd).toBe("/tmp/relay");
    expect(windowed.cwd).toBe("/tmp/relay");
  });
});

describe("logUncaughtErrorsUntilDestroy", () => {
  const listenerCounts = () => [
    process.listenerCount("uncaughtException"),
    process.listenerCount("unhandledRejection"),
  ];

  test("logs the error kind and raw value, then detaches when the renderer is destroyed", () => {
    const renderer = new EventEmitter();
    const entries: unknown[] = [];
    const before = listenerCounts();

    logUncaughtErrorsUntilDestroy(renderer, { error: (_event, data) => entries.push(data) });
    process.emit("unhandledRejection", { code: 42 }, Promise.resolve());
    process.emit("uncaughtException", new Error("boom"));

    expect(entries).toEqual([
      { kind: "rejection", error: { code: 42 } },
      { kind: "exception", error: expect.stringContaining("boom") },
    ]);
    expect(listenerCounts()).toEqual(before.map((count) => count + 1));

    renderer.emit(CliRenderEvents.DESTROY);
    expect(listenerCounts()).toEqual(before);
    expect(renderer.listenerCount(CliRenderEvents.DESTROY)).toBe(0);
  });
});
