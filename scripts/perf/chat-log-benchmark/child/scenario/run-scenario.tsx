import { performance } from "node:perf_hooks";
import { Renderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer, MouseButtons } from "@opentui/core/testing";
import { render as renderSolid } from "@opentui/solid";
import { createSignal } from "solid-js";
import { applyAcpSessionUpdate, type AcpConversationAdapter } from "../../../../../src/application/acp-mapping";
import { replayAcpSessionUpdates } from "../../../../../src/application/acp-orchestration";
import { resetConfig } from "../../../../../src/config";
import { runtimeEnvironment } from "../../../../../src/platform/environment";
import { ChatBlockView } from "../../../../../src/ui/component/blocks/chat-block";
import { ChatLog } from "../../../../../src/ui/component/chat-log";
import { StatusLine } from "../../../../../src/ui/component/status-line";
import { createAppStateValue, type AppStateContextValue } from "../../../../../src/ui/context/app-state";
import { AppContext, type ChatBlock, type ElicitationBlock, type ToolBlock } from "../../../../../src/ui/state";
import { ToastProvider } from "../../../../../src/ui/ui/toast";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS, spinnerFrameAt } from "../../../../../src/ui/util/spinner-frames";
import { resolveTranscriptRendererMode } from "../../../../../src/ui/util/transcript-renderer-mode";
import type { BenchmarkMeasurementOptions, ChildBenchmarkOptions } from "../../protocol/options";
import type { ChatLogBenchmarkScenario } from "../../protocol/scenario";
import {
  benchmarkFixtureSeed,
  buildChatLogBenchmarkFixture,
  countRenderableTree,
  measureToolPayloadBytes,
  summarizeChatBlocks,
  type ChatLogBenchmarkFixture,
} from "./fixtures";
import type { BenchmarkRunResult, CpuActivity, CpuIntervalResult, PhaseCounters } from "../../protocol/result";
import { BENCHMARK_PROFILE, BENCHMARK_TARGET_FPS, FORCED_GC_AVAILABLE } from "../../protocol/settings";

import { configureBenchmark } from "../configure-benchmark";
import {
  assertRenderableInstrumentationInactive,
  collectExplicitFrames,
  collectInputSamples,
  counterDelta,
  createFrameMeasurementController,
  distribution,
  installRenderableInstrumentation,
  sampleRssAfterGcRequest,
} from "./renderer-measurements";

const BENCHMARK_TRANSCRIPT_RENDERER_MODE = resolveTranscriptRendererMode(runtimeEnvironment(), "windowed");

interface UiControls {
  readonly setSpinnerFrame: (index: number) => void;
}

interface ModelResult {
  readonly appState: AppStateContextValue;
  readonly durationMs: number;
}

function createAcpAdapter(appState: AppStateContextValue): AcpConversationAdapter {
  const setState = appState.setState as unknown as (...args: unknown[]) => void;
  return {
    state: appState.state,
    addBlock: appState.addBlock,
    updateBlock: appState.updateBlock,
    appendToBlock: appState.appendToBlock,
    removeBlock: appState.removeBlock,
    setCurrentBlockId: appState.setCurrentBlockId,
    setState,
  };
}

function constructModel(fixture: ChatLogBenchmarkFixture): ModelResult {
  const start = performance.now();
  const appState = createAppStateValue(process.cwd(), {
    transcriptPagingEnabled: BENCHMARK_TRANSCRIPT_RENDERER_MODE === "windowed",
  });
  appState.setState("activeThreadId", "benchmark-thread");
  appState.replaceBlocks([]);

  if (fixture.modelConstruction !== "acp-replay") {
    appState.replaceBlocks(fixture.blocks);
    if (fixture.modelConstruction === "batch-blocks") {
      appState.setCurrentBlockId(fixture.blocks.at(-1)?.id ?? null);
      appState.setState("running", true);
      appState.setState("spinnerActive", true);
    }
  }

  return { appState, durationMs: performance.now() - start };
}

function replayMountedFixture(fixture: ChatLogBenchmarkFixture, appState: AppStateContextValue): number | null {
  if (fixture.modelConstruction !== "acp-replay") return null;
  const start = performance.now();
  replayAcpSessionUpdates(fixture.historyUpdates ?? [], createAcpAdapter(appState));
  return performance.now() - start;
}

function renderChatBlock(block: ChatBlock, prevBlock: ChatBlock | undefined, spinnerChar: () => string) {
  return (
    <ChatBlockView
      block={block}
      prevBlock={prevBlock}
      activeProfile={BENCHMARK_PROFILE}
      hideThinking={() => false}
      approvalOptionIndex={() => 0}
      elicitationOptionIndex={() => 0}
      getSpinnerChar={spinnerChar}
      pluginRunner={() => null}
      selectElicitationChoice={(_app, _block: ElicitationBlock) => {}}
    />
  );
}

function createUiControls(): {
  readonly controls: UiControls;
  readonly spinnerChar: () => string;
  readonly inputVersion: () => number;
  readonly handleInput: () => void;
} {
  const [spinnerIndex, setSpinnerIndex] = createSignal(0);
  const [inputVersion, setInputVersion] = createSignal(0);

  return {
    controls: {
      setSpinnerFrame(index: number) {
        setSpinnerIndex(index % SPINNER_FRAMES.length);
      },
    },
    spinnerChar: () => spinnerFrameAt(spinnerIndex()),
    inputVersion,
    handleInput() {
      setInputVersion((current) => current + 1);
    },
  };
}

function mutateTail(appState: AppStateContextValue, iteration: number): void {
  const tail = appState.state.blocks.at(-1);
  if (!tail) return;
  const suffix = ` ${iteration.toString(36)}`;

  switch (tail.type) {
    case "content":
    case "thinking":
    case "user":
    case "info":
    case "plugin":
      appState.updateBlock(tail.id, { content: `${tail.content}${suffix}` } as Partial<ChatBlock>);
      break;
    case "tool":
      appState.updateBlock(tail.id, { details: `${tail.details ?? ""}${suffix}` } as Partial<ToolBlock>);
      break;
    case "user-bash":
      appState.updateBlock(tail.id, { output: `${tail.output}${suffix}` } as Partial<ChatBlock>);
      break;
    case "elicitation":
      appState.updateBlock(tail.id, { message: `${tail.message}${suffix}` } as Partial<ChatBlock>);
      break;
  }
}

export function applyTailStreamingUpdate(appState: AppStateContextValue, iteration: number): void {
  applyAcpSessionUpdate(
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: ` ${iteration.toString(36)}` },
    },
    createAcpAdapter(appState),
  );
}

function applyDirtyUpdate(scenario: ChatLogBenchmarkScenario, appState: AppStateContextValue, iteration: number): void {
  if (scenario === "tail-streaming-and-spinner") {
    applyTailStreamingUpdate(appState, iteration);
    return;
  }
  mutateTail(appState, iteration);
}

function findScrollBox(root: Renderable): ScrollBoxRenderable {
  if (root instanceof ScrollBoxRenderable) return root;
  for (const child of root.getChildren()) {
    const found = findScrollBoxOrNull(child);
    if (found) return found;
  }
  throw new Error("Benchmark render tree does not contain a ScrollBoxRenderable");
}

function findScrollBoxOrNull(root: Renderable): ScrollBoxRenderable | null {
  if (root instanceof ScrollBoxRenderable) return root;
  for (const child of root.getChildren()) {
    const found = findScrollBoxOrNull(child);
    if (found) return found;
  }
  return null;
}

async function collectCpuInterval(options: {
  readonly activity: CpuActivity;
  readonly durationMs: number;
  readonly appState: AppStateContextValue;
  readonly controls: UiControls;
  readonly renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"];
  readonly renderOnce: () => Promise<void>;
}): Promise<CpuIntervalResult> {
  options.renderer.pause();
  options.renderer.resetStats();
  const frameStart = options.renderer.frameId;
  const cpuStart = process.cpuUsage();
  const timeStart = performance.now();
  const frameIntervalMs = 1_000 / BENCHMARK_TARGET_FPS;
  let nextFrameAt = timeStart;
  let nextSpinnerAt = timeStart;
  let iteration = 0;

  while (performance.now() - timeStart < options.durationMs) {
    const now = performance.now();
    if (options.activity === "spinner-only") {
      if (now >= nextSpinnerAt) {
        options.controls.setSpinnerFrame(iteration);
        nextSpinnerAt += SPINNER_INTERVAL_MS;
        iteration += 1;
      }
    } else {
      applyTailStreamingUpdate(options.appState, iteration);
      iteration += 1;
    }
    await options.renderOnce();
    nextFrameAt += frameIntervalMs;
    const delayMs = nextFrameAt - performance.now();
    if (delayMs > 0) await Bun.sleep(delayMs);
  }

  const elapsedMs = performance.now() - timeStart;
  const cpu = process.cpuUsage(cpuStart);
  const totalCpuMicros = cpu.user + cpu.system;
  const frames = Math.max(0, options.renderer.frameId - frameStart);
  return {
    activity: options.activity,
    durationMs: elapsedMs,
    processCpuPercent: elapsedMs > 0 ? totalCpuMicros / (elapsedMs * 10) : 0,
    userCpuMicros: cpu.user,
    systemCpuMicros: cpu.system,
    frames,
    nativeStats: options.renderer.getNativeStats(),
    rendererStats: options.renderer.getStats(),
  };
}

type BenchmarkTestRenderer = Awaited<ReturnType<typeof createTestRenderer>>;

async function renderBenchmarkUi(
  model: ModelResult,
  ui: ReturnType<typeof createUiControls>,
  options: BenchmarkMeasurementOptions,
  renderer: BenchmarkTestRenderer["renderer"],
): Promise<void> {
  await renderSolid(
    () => (
      <ToastProvider>
        <AppContext.Provider value={model.appState}>
          <box id="benchmark-root" width={options.width} height={options.height} flexDirection="column">
            <box
              id="benchmark-input-target"
              height={1}
              flexShrink={0}
              focusable
              onKeyDown={ui.handleInput}
              onMouseDown={ui.handleInput}
            >
              <text>{`benchmark input ${ui.inputVersion()}`}</text>
            </box>
            <ChatLog
              welcomeDismissed={() => true}
              rendererMode={BENCHMARK_TRANSCRIPT_RENDERER_MODE}
              renderBlock={(block: ChatBlock, prevBlock?: ChatBlock) =>
                renderChatBlock(block, prevBlock, ui.spinnerChar)
              }
              availableWidth={() => options.width}
            />
            <StatusLine spinnerChar={ui.spinnerChar} />
          </box>
        </AppContext.Provider>
      </ToastProvider>
    ),
    renderer,
  );
}

interface ScenarioDiagnostics {
  readonly firstFrameCounters: PhaseCounters;
  readonly cleanFrameCounters: PhaseCounters;
  readonly dirtyFrameCounters: PhaseCounters;
}

async function collectScenarioDiagnostics(
  options: BenchmarkMeasurementOptions,
  scenario: ChatLogBenchmarkScenario,
  fixtureSeed: number,
): Promise<ScenarioDiagnostics> {
  const fixture = buildChatLogBenchmarkFixture(scenario, fixtureSeed, options.fixturePreset);
  const model = constructModel(fixture);
  const ui = createUiControls();
  let app: BenchmarkTestRenderer | null = null;
  let instrumentation: ReturnType<typeof installRenderableInstrumentation> | null = null;

  try {
    app = await createTestRenderer({
      width: options.width,
      height: options.height,
      targetFps: BENCHMARK_TARGET_FPS,
      gatherStats: false,
    });
    app.renderer.pause();
    await renderBenchmarkUi(model, ui, options, app.renderer);
    replayMountedFixture(fixture, model.appState);

    instrumentation = installRenderableInstrumentation();
    const firstStart = instrumentation.snapshot();
    const firstFrameId = app.renderer.frameId;
    await app.renderOnce();
    const firstFrameCount = Math.max(0, app.renderer.frameId - firstFrameId);
    if (firstFrameCount <= 0) throw new Error("Diagnostic first renderOnce did not produce a frame");
    const firstFrameCounters = counterDelta(firstStart, instrumentation.snapshot(), firstFrameCount);

    await app.flush();
    const cleanStart = instrumentation.snapshot();
    const cleanFrameId = app.renderer.frameId;
    await app.renderOnce();
    const cleanFrameCount = Math.max(0, app.renderer.frameId - cleanFrameId);
    const cleanFrameCounters = counterDelta(cleanStart, instrumentation.snapshot(), cleanFrameCount);

    const dirtyStart = instrumentation.snapshot();
    const dirtyFrameId = app.renderer.frameId;
    applyDirtyUpdate(scenario, model.appState, 0);
    await app.renderOnce();
    const dirtyFrameCount = Math.max(0, app.renderer.frameId - dirtyFrameId);
    const dirtyFrameCounters = counterDelta(dirtyStart, instrumentation.snapshot(), dirtyFrameCount);

    return { firstFrameCounters, cleanFrameCounters, dirtyFrameCounters };
  } finally {
    instrumentation?.restore();
    app?.renderer.destroy();
    model.appState.clearBlocks();
    fixture.blocks.length = 0;
    if (fixture.historyUpdates) fixture.historyUpdates.length = 0;
  }
}

export async function runScenario(options: ChildBenchmarkOptions): Promise<BenchmarkRunResult> {
  const scenario = options.scenario;
  configureBenchmark();
  const rssBeforeModel = sampleRssAfterGcRequest();
  const fixtureSeed = benchmarkFixtureSeed(options.seed);
  const fixtureStart = performance.now();
  const fixture = buildChatLogBenchmarkFixture(scenario, fixtureSeed, options.fixturePreset);
  const fixtureConstructionMs = performance.now() - fixtureStart;
  const modelConstruction = fixture.modelConstruction;
  const model = constructModel(fixture);
  const rssBeforeMount = sampleRssAfterGcRequest();
  const ui = createUiControls();
  const frameMeasurement = createFrameMeasurementController();
  let app: BenchmarkTestRenderer | null = null;
  let handleFrame: (() => void) | null = null;

  try {
    const rendererSetupStart = performance.now();
    app = await createTestRenderer({
      width: options.width,
      height: options.height,
      targetFps: BENCHMARK_TARGET_FPS,
      gatherStats: true,
      maxStatSamples: Math.max(options.cleanFrames, options.dirtyUpdates, options.inputSamples, 1_000),
    });
    const rendererSetupMs = performance.now() - rendererSetupStart;
    app.renderer.pause();

    const initialMountStart = performance.now();
    const mountStart = initialMountStart;
    const renderableStart = performance.now();
    await renderBenchmarkUi(model, ui, options, app.renderer);
    const renderableConstructionMs = performance.now() - renderableStart;
    const mountedReplayToStableStart = modelConstruction === "acp-replay" ? performance.now() : null;
    const mountedReplayMs = replayMountedFixture(fixture, model.appState);
    const modelConstructionMs = model.durationMs;

    if (modelConstruction === "acp-replay") {
      fixture.blocks.length = 0;
      if (fixture.historyUpdates) fixture.historyUpdates.length = 0;
    }

    assertRenderableInstrumentationInactive("first-frame");
    const firstFrameId = app.renderer.frameId;
    const firstFrameStart = performance.now();
    await app.renderOnce();
    const firstFrameMs = performance.now() - firstFrameStart;
    const firstFrameCount = app.renderer.frameId - firstFrameId;
    if (firstFrameCount <= 0) throw new Error("First renderOnce did not produce a frame");
    const firstInteractiveFrameMs = performance.now() - mountStart;
    const initialMountMs = performance.now() - initialMountStart;

    const stabilizationFrameId = app.renderer.frameId;
    const stabilizationStart = performance.now();
    await app.flush();
    const stabilizationMs = performance.now() - stabilizationStart;
    const stabilizationFrameCount = Math.max(0, app.renderer.frameId - stabilizationFrameId);
    const mountedReplayToStableMs =
      mountedReplayToStableStart === null ? null : performance.now() - mountedReplayToStableStart;

    const scrollBox = findScrollBox(app.renderer.root);
    const inputTarget = app.renderer.root.findDescendantById("benchmark-input-target");
    if (!inputTarget) throw new Error("Benchmark input target was not mounted");
    inputTarget.focus();

    const mountedRenderableCount = countRenderableTree(app.renderer.root);
    const directScrollContentChildCount = scrollBox.content.getChildrenCount();
    const scrollHeight = scrollBox.scrollHeight;
    const capturedFrameBytes = new TextEncoder().encode(app.captureCharFrame()).byteLength;
    const payloadBytes = measureToolPayloadBytes(model.appState.state.blocks);
    const rssAfterMount = sampleRssAfterGcRequest();

    await collectExplicitFrames(options.warmFrames, app.renderOnce);

    assertRenderableInstrumentationInactive("clean-frame");
    app.renderer.resetStats();
    const cleanSamples = await collectExplicitFrames(options.cleanFrames, app.renderOnce);
    const cleanNativeStats = app.renderer.getNativeStats();

    assertRenderableInstrumentationInactive("dirty-frame");
    app.renderer.resetStats();
    const dirtySamples: number[] = [];
    for (let index = 0; index < options.dirtyUpdates; index++) {
      const start = performance.now();
      applyDirtyUpdate(scenario, model.appState, index);
      await app.renderOnce();
      dirtySamples.push(performance.now() - start);
    }
    const dirtyNativeStats = app.renderer.getNativeStats();

    const maxScrollTop = Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height);
    scrollBox.scrollTo(Math.floor(maxScrollTop / 2));
    await app.renderOnce();
    const scrollX = scrollBox.viewport.screenX + Math.max(1, Math.floor(scrollBox.viewport.width / 2));
    const scrollY = scrollBox.viewport.screenY + Math.max(1, Math.floor(scrollBox.viewport.height / 2));
    assertRenderableInstrumentationInactive("input-to-frame");
    handleFrame = () => frameMeasurement.completeFrame(app?.renderer.frameId ?? 0);
    app.renderer.on("frame", handleFrame);
    app.renderer.start();
    let inputSamples: Awaited<ReturnType<typeof collectInputSamples>>;
    try {
      inputSamples = await collectInputSamples({
        count: options.inputSamples,
        controller: frameMeasurement,
        frameId: () => app?.renderer.frameId ?? 0,
        inputVersion: ui.inputVersion,
        scrollTop: () => scrollBox.scrollTop,
        pressKey: () => app?.mockInput.pressKey("x"),
        pressMouse: async () => {
          await app?.mockMouse.emitMouseEvent("down", inputTarget.screenX, inputTarget.screenY, MouseButtons.LEFT, {
            delayMs: 0,
          });
          await app?.mockMouse.emitMouseEvent("up", inputTarget.screenX, inputTarget.screenY, MouseButtons.LEFT, {
            delayMs: 0,
          });
        },
        scrollMouse: async (direction) => {
          await app?.mockMouse.scroll(scrollX, scrollY, direction, { delayMs: 0 });
        },
      });
    } finally {
      app.renderer.pause();
      await app.renderer.idle();
      if (handleFrame) app.renderer.off("frame", handleFrame);
      handleFrame = null;
    }

    assertRenderableInstrumentationInactive("cpu");
    const hasStreamingActivity = scenario === "tail-streaming-and-spinner";
    const spinnerOnlyCpu = hasStreamingActivity
      ? await collectCpuInterval({
          activity: "spinner-only",
          durationMs: options.cpuIntervalMs,
          appState: model.appState,
          controls: ui.controls,
          renderer: app.renderer,
          renderOnce: app.renderOnce,
        })
      : null;
    const tailStreamingCpu = hasStreamingActivity
      ? await collectCpuInterval({
          activity: "tail-streaming",
          durationMs: options.cpuIntervalMs,
          appState: model.appState,
          controls: ui.controls,
          renderer: app.renderer,
          renderOnce: app.renderOnce,
        })
      : null;
    const blockSummary = summarizeChatBlocks(model.appState.state.blocks);
    const modelState = {
      currentBlockId: model.appState.state.currentBlockId,
      running: model.appState.state.running,
      spinnerActive: model.appState.state.spinnerActive,
    };

    app.renderer.destroy();
    app = null;
    model.appState.clearBlocks();
    fixture.blocks.length = 0;
    if (fixture.historyUpdates) fixture.historyUpdates.length = 0;
    await Bun.sleep(10);
    const rssAfterCleanup = sampleRssAfterGcRequest();
    const diagnostics = await collectScenarioDiagnostics(options, scenario, fixtureSeed);
    assertRenderableInstrumentationInactive("post-diagnostics");

    return {
      scenario,
      runIndex: options.runIndex,
      seed: fixtureSeed,
      blockSummary,
      modelState,
      modelConstruction,
      fixtureConstructionMs,
      modelConstructionMs,
      mountedReplayMs,
      mountedReplayToStableMs,
      rendererSetupMs,
      renderableConstructionMs,
      firstFrameMs,
      firstInteractiveFrameMs,
      stabilizationMs,
      stabilizationFrameCount,
      initialMountMs,
      mountedRenderableCount,
      directScrollContentChildCount,
      scrollHeight,
      diagnostics,
      cleanFrames: distribution(cleanSamples),
      cleanNativeStats,
      dirtyFrames: distribution(dirtySamples),
      dirtyNativeStats,
      inputToFrame: {
        syntheticKeyDispatch: distribution(inputSamples.key),
        syntheticMouseDispatch: distribution(inputSamples.mouse),
        chatLogScroll: distribution(inputSamples.scroll),
      },
      cpuIntervals: {
        spinnerOnly: spinnerOnlyCpu,
        tailStreaming: tailStreamingCpu,
      },
      rssBytes: {
        beforeModel: rssBeforeModel,
        beforeMount: rssBeforeMount,
        afterMount: rssAfterMount,
        afterCleanup: rssAfterCleanup,
        forcedGcRequested: FORCED_GC_AVAILABLE,
        comparisonMode: "fresh-process-non-gc-normalized",
      },
      payloadBytes,
      capturedFrameBytes,
    };
  } finally {
    frameMeasurement.cancel(new Error("Benchmark frame measurement was disposed"));
    if (app && handleFrame) app.renderer.off("frame", handleFrame);
    app?.renderer.destroy();
    resetConfig();
  }
}
