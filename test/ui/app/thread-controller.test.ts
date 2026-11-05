import { afterEach, describe, expect, test } from "bun:test";
import type { AcpClient, AcpLaunchOptions } from "../../../src/acp/client";
import { findLastToolBlock } from "../../../src/application/acp-mapping";
import { ApprovalResponse } from "../../../src/core/events";
import type { ThreadInfo } from "../../../src/core/threads";
import { PluginRunner } from "../../../src/plugins";
import { getPluginRunner, hasPluginBlockEventListeners, setPluginRunner } from "../../../src/ui/app/plugin-runtime";
import { createThreadController, type ThreadControllerDeps } from "../../../src/ui/app/thread-controller";
import { createThreadQueueStore } from "../../../src/ui/app/thread-queue";
import { defaultAgentBehaviorProfile } from "../../../src/acp/profiles/default";
import { altaAgentBehaviorProfile } from "../../../src/acp/profiles/alta";
import {
  isPromptDispatchReserved,
  reservePromptDispatch,
  resetPromptDispatchState,
} from "../../../src/ui/app/prompt-dispatch";
import { store } from "../../../src/ui/app/runtime-store";
import type { ChatBlock, QueuedPrompt, useApp } from "../../../src/ui/state";
import type { PromptInput } from "../../../src/core/prompt-submission";
import { TranscriptViewState } from "../../../src/ui/util/transcript-view-state";
import { applyAcpSessionUpdate, finalizeAcpPrompt } from "../../../src/application/acp-mapping";
import { createAppStateValue } from "../../../src/ui/context/app-state";
import { acpAgentMessageChunk, acpPromptResponse } from "../../lib/acp-events";

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakeAcpClient {
  connected = false;
  newSessionCalls = 0;
  newSessionBeforeConnect = false;
  sessionId: string | null = null;

  constructor(
    private readonly connectDeferred: Deferred<void>,
    private readonly newSessionDeferred?: Deferred<void>,
    private readonly newSessionStarted?: Deferred<void>,
  ) {}

  async connect(): Promise<void> {
    await this.connectDeferred.promise;
    this.connected = true;
  }

  async newSession(_cwd: string): Promise<{ sessionId: string }> {
    this.newSessionCalls += 1;
    if (!this.connected) this.newSessionBeforeConnect = true;
    this.newSessionStarted?.resolve();
    await this.newSessionDeferred?.promise;
    this.sessionId = "lazy-session";
    return { sessionId: this.sessionId };
  }

  supportsSessionFork(): boolean {
    return false;
  }

  supportsSessionList(): boolean {
    return false;
  }

  supportsSessionLoad(): boolean {
    return false;
  }
}

class CloseTrackingAcpClient {
  closeSessionCalls: string[] = [];
  disposeCalls = 0;
  cancelCalls: Array<string | undefined> = [];
  sessionId: string | null;

  constructor(
    sessionId: string | null,
    private readonly closeSupported: boolean,
  ) {
    this.sessionId = sessionId;
  }

  supportsSessionClose(): boolean {
    return this.closeSupported;
  }

  async closeSession(sessionId: string): Promise<void> {
    this.closeSessionCalls.push(sessionId);
    if (this.sessionId === sessionId) this.sessionId = null;
  }

  async disposeAsync(): Promise<void> {
    this.disposeCalls += 1;
  }

  async cancel(sessionId?: string): Promise<void> {
    this.cancelCalls.push(sessionId);
  }
}

type App = ReturnType<typeof useApp>;

function makeThread(id: string, cwd: string): ThreadInfo {
  return {
    id,
    title: id,
    sessionId: null,
    cwd,
    workspaceKind: "local",
    status: "paused",
    archived: false,
  };
}

function createApp(transcriptPagingEnabled = false): App {
  const state = {
    activeThreadId: "thread-one",
    cwd: "/tmp/thread-one",
    threads: [makeThread("thread-one", "/tmp/thread-one"), makeThread("thread-two", "/tmp/thread-two")],
    blocks: [] as ChatBlock[],
    pendingQueue: [] as QueuedPrompt[],
    currentBlockId: null as string | null,
    modelId: "",
    modelConfigId: "",
    availableModels: [],
    modeId: "",
    availableModes: [],
    thinkingLevel: "",
    thinkingConfigId: "",
    availableThinkingLevels: [],
    sessionConfigOptions: [],
    availableCommands: [],
    connecting: false,
    running: false,
    spinnerActive: false,
    spinnerLabel: "",
    lastAcpActivityKind: null,
    lastAcpActivityLabel: "",
    lastAcpActivityAt: null,
  };
  const app = {
    state,
    transcriptPagingEnabled,
    setState: (...args: unknown[]) => {
      const [key, selectorOrValue, maybeValue] = args;
      if (key === "threads" && typeof selectorOrValue === "function") {
        state.threads = state.threads.map((thread) =>
          (selectorOrValue as (thread: ThreadInfo) => boolean)(thread)
            ? { ...thread, ...(maybeValue as Partial<ThreadInfo>) }
            : thread,
        );
        return;
      }
      if (typeof key === "string") {
        (state as Record<string, unknown>)[key] = selectorOrValue;
      }
    },
    blockEntry: (id: string) => {
      const index = state.blocks.findIndex((block) => block.id === id);
      const block = state.blocks[index];
      return block ? { block, index } : undefined;
    },
    findToolBlock: (toolCallId: string) => findLastToolBlock(state.blocks, toolCallId),
    addBlock: (block: ChatBlock) => {
      state.blocks = [...state.blocks, block];
    },
    appendBlock: (block: ChatBlock) => {
      state.blocks = [...state.blocks, block];
    },
    insertBlock: (index: number, block: ChatBlock) => {
      state.blocks = [...state.blocks.slice(0, index), block, ...state.blocks.slice(index)];
    },
    updateBlock: (id: string, updates: Partial<ChatBlock>) => {
      state.blocks = state.blocks.map((block) => (block.id === id ? ({ ...block, ...updates } as ChatBlock) : block));
    },
    appendToBlock: (id: string, text: string) => {
      state.blocks = state.blocks.map((block) =>
        block.id === id && "content" in block && typeof block.content === "string"
          ? ({ ...block, content: `${block.content}${text}` } as ChatBlock)
          : block,
      );
    },
    removeBlock: (id: string) => {
      state.blocks = state.blocks.filter((block) => block.id !== id);
    },
    replaceBlocks: (blocks: ChatBlock[]) => {
      state.blocks = blocks;
    },
    clearBlocks: () => {
      state.blocks = [];
    },
    setCurrentBlockId: (id: string | null) => {
      state.currentBlockId = id;
    },
    setActiveThreadState: (thread: ThreadInfo, blocks: ChatBlock[], pendingQueue: QueuedPrompt[] = []) => {
      state.activeThreadId = thread.id;
      state.cwd = thread.cwd;
      state.blocks = blocks;
      state.pendingQueue = pendingQueue;
      state.running = thread.status === "running";
    },
  };
  return app as unknown as App;
}

function resetRuntimeStore(): void {
  store.acpClient = null;
  store.activeAppInstanceId = 1;
  store.activeAgentName = "faux";
  store.activeAgentBehaviorProfile = defaultAgentBehaviorProfile;
  store.rootCwd = "/tmp/thread-one";
  store.activeAcpLaunchOptions = { cwd: "/tmp/thread-one", command: "faux", args: [] } as AcpLaunchOptions;
  store.activeAcpClientFactory = undefined;
  store.threadClients.clear();
  store.threadCurrentBlockIds.clear();
  store.threadAgentCommands.clear();
  store.threadAgentCommandsKnown.clear();
  store.threadSessionCapabilities.clear();
  store.threadPromptRunIds.clear();
  store.suppressedThreadPromptRunIds.clear();
  store.historyLoadedSessionIdsByThread.clear();
  store.threadBlocks.clear();
  store.threadTranscriptViews.clear();
  store.threadPendingQueues.clear();
  store.threadPreviews.clear();
  store.threadYoloEnabled.clear();
  store.threadYoloLaunchEnabled.clear();
  resetPromptDispatchState();
}

afterEach(() => {
  getPluginRunner()?.dispose();
  setPluginRunner(null);
  resetRuntimeStore();
});

function createController(overrides: Partial<ThreadControllerDeps> = {}) {
  return createThreadController({
    threadQueue: createThreadQueueStore(10),
    setQueueFocusIndex: () => undefined,
    clearQueueInteraction: () => undefined,
    editingQueueItem: () => null,
    setWelcomeDismissed: () => undefined,
    refreshOpenSlashAutocomplete: () => undefined,
    gitWatcherSetCwd: () => undefined,
    abortAndClearUserBash: () => undefined,
    loadSessionHistory: async () => ({ result: {}, updates: [] }),
    replayLoadedSessionUpdates: () => undefined,
    submitPromptToAgent: async (_input: PromptInput) => undefined,
    ...overrides,
  });
}

async function flushAsyncCallbacks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Asserts that an inactive thread's canonical blocks and page-index membership remain synchronized.
 *
 * @param threadId - Identifier of the inactive thread to validate.
 * @returns Nothing; the helper records test assertions or throws on failure.
 */
function expectThreadTranscriptConsistent(threadId: string): void {
  const blocks = store.threadBlocks.get(threadId) ?? [];
  const view = store.threadTranscriptViews.get(threadId);
  const indexedIds = view?.pageIndex.pages().flatMap((page) => page.blockIds) ?? [];
  expect(indexedIds).toEqual(blocks.map((block) => block.id));
  expect(new Set(indexedIds).size).toBe(indexedIds.length);
  for (const block of blocks) expect(view?.pageIndex.pageForBlock(block.id)).toBeDefined();
}

function modelConfigOptions(currentValue: string, modelIds: readonly string[]) {
  return [
    {
      id: "model",
      category: "model",
      type: "select",
      currentValue,
      options: modelIds.map((modelId) => ({ value: modelId, name: modelId })),
    },
  ];
}

describe("createThreadController", () => {
  test("full session capabilities replace stale cached capabilities", () => {
    resetRuntimeStore();
    const app = createApp();
    const controller = createController();
    const oldCommands = [{ name: "review", description: "Review changes" }];
    store.threadSessionCapabilities.set("thread-one", {
      models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
      modes: { currentModeId: "review", availableModes: [{ id: "review", name: "Review" }] },
      availableCommands: oldCommands,
    });
    store.threadAgentCommands.set("thread-one", []);

    controller.applyThreadSessionCapabilities(app, "thread-one", { configOptions: [] }, { replace: true });

    expect(store.threadSessionCapabilities.get("thread-one")).toEqual({ configOptions: [], availableCommands: [] });
    expect(store.threadAgentCommands.get("thread-one")).toEqual([]);
    expect(app.state.modelId).toBe("");
    expect(app.state.availableModels).toEqual([]);
    expect(app.state.modeId).toBe("");
    expect(app.state.availableModes).toEqual([]);
    expect(app.state.availableCommands).toEqual([]);
  });

  test("full session capabilities keep commands delivered before the session result", () => {
    resetRuntimeStore();
    const app = createApp();
    const controller = createController();
    const commands = [{ name: "test-skill", description: "Agent skill" }];
    store.threadAgentCommands.set("thread-one", commands);
    app.state.availableCommands = commands;

    controller.applyThreadSessionCapabilities(app, "thread-one", { configOptions: [] }, { replace: true });

    expect(store.threadSessionCapabilities.get("thread-one")).toEqual({
      configOptions: [],
      availableCommands: commands,
    });
    expect(store.threadAgentCommands.get("thread-one")).toEqual(commands);
    expect(app.state.availableCommands).toEqual(commands);
  });

  test("subagent config updates do not replace the parent model switcher", () => {
    resetRuntimeStore();
    const app = createApp();
    const controller = createController();
    const parentConfigOptions = modelConfigOptions("gpt-5.6-sol", ["gpt-5.6-sol", "gpt-5.6-luna"]);
    controller.applyThreadSessionCapabilities(app, "thread-one", { configOptions: parentConfigOptions });

    controller.createThreadCallbacks(app, "thread-one").onSessionUpdate?.(
      {
        sessionUpdate: "config_option_update",
        configOptions: modelConfigOptions("gpt-5.6-luna", ["gpt-5.6-luna"]),
      } as never,
      {
        sessionId: "subagent-session",
        metadata: {
          "alta/subagent": {
            invokingToolCallId: "invoke-navigator",
            childSessionId: "subagent-session",
          },
        },
      },
    );

    expect(store.threadSessionCapabilities.get("thread-one")?.configOptions).toEqual(parentConfigOptions);
    expect(app.state.modelId).toBe("gpt-5.6-sol");
    expect(app.state.availableModels.map((model) => model.modelId)).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"]);
  });

  test("loaded-session subagent config updates do not replace cached parent models", () => {
    resetRuntimeStore();
    const app = createApp();
    const controller = createController();
    const parentConfigOptions = modelConfigOptions("gpt-5.6-sol", ["gpt-5.6-sol", "gpt-5.6-luna"]);
    const client = { sessionId: "loaded-session" } as AcpClient;
    store.threadClients.set("thread-one", client);
    store.historyLoadedSessionIdsByThread.set("thread-one", "loaded-session");
    controller.applyThreadSessionCapabilities(app, "thread-one", { configOptions: parentConfigOptions });

    controller
      .createThreadCallbacks(app, "thread-one", () => client)
      .onSessionUpdate?.(
        {
          sessionUpdate: "config_option_update",
          configOptions: modelConfigOptions("gpt-5.6-luna", ["gpt-5.6-luna"]),
        } as never,
        {
          sessionId: "subagent-session",
          metadata: {
            "alta/subagent": {
              invokingToolCallId: "invoke-navigator",
              childSessionId: "subagent-session",
            },
          },
        },
      );

    expect(store.threadSessionCapabilities.get("thread-one")?.configOptions).toEqual(parentConfigOptions);
    expect(app.state.modelId).toBe("gpt-5.6-sol");
    expect(app.state.availableModels.map((model) => model.modelId)).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"]);
  });

  test("malformed subagent metadata cannot replace the parent model switcher", () => {
    resetRuntimeStore();
    const app = createApp();
    const controller = createController();
    const parentConfigOptions = modelConfigOptions("gpt-5.6-sol", ["gpt-5.6-sol", "gpt-5.6-luna"]);
    controller.applyThreadSessionCapabilities(app, "thread-one", { configOptions: parentConfigOptions });

    controller.createThreadCallbacks(app, "thread-one").onSessionUpdate?.(
      {
        sessionUpdate: "config_option_update",
        configOptions: modelConfigOptions("gpt-5.6-luna", ["gpt-5.6-luna"]),
      } as never,
      {
        sessionId: "subagent-session",
        metadata: { "alta/subagent": "malformed" },
      },
    );

    expect(store.threadSessionCapabilities.get("thread-one")?.configOptions).toEqual(parentConfigOptions);
    expect(app.state.modelId).toBe("gpt-5.6-sol");
    expect(app.state.availableModels.map((model) => model.modelId)).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"]);
  });

  test("live command updates survive later partial session capability results", () => {
    resetRuntimeStore();
    const app = createApp();
    const controller = createController();
    const commands = [{ name: "herdr", description: "Control Herdr" }];
    store.threadSessionCapabilities.set("thread-one", { availableCommands: [] });
    app.state.availableCommands = [];

    controller.createThreadCallbacks(app, "thread-one").onAvailableCommands?.(commands);
    controller.applyThreadSessionCapabilities(app, "thread-one", { configOptions: [] });

    expect(store.threadSessionCapabilities.get("thread-one")).toEqual({
      configOptions: [],
      availableCommands: commands,
    });
    expect(store.threadAgentCommands.get("thread-one")).toEqual(commands);
    expect(app.state.availableCommands).toEqual(commands);
  });

  test("partial session capabilities merge with cached full capabilities", () => {
    resetRuntimeStore();
    const app = createApp();
    const controller = createController();
    const oldCommands = [{ name: "review", description: "Review changes" }];
    const legacyModels = { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] };
    const modes = { currentModeId: "review", availableModes: [{ id: "review", name: "Review" }] };
    const configOptions = [
      {
        id: "thought_level",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
    ];
    store.threadSessionCapabilities.set("thread-one", {
      models: legacyModels,
      modes,
      availableCommands: oldCommands,
    });

    controller.applyThreadSessionCapabilities(app, "thread-one", { configOptions });

    expect(store.threadSessionCapabilities.get("thread-one")).toEqual({
      models: legacyModels,
      modes,
      availableCommands: oldCommands,
      configOptions,
    });
    expect(app.state.modelId).toBe("opus");
    expect(app.state.availableModels).toEqual([{ modelId: "opus", name: "Opus", description: undefined }]);
    expect(app.state.modeId).toBe("review");
    expect(app.state.availableModes).toEqual([{ id: "review", name: "Review", description: undefined }]);
    expect(app.state.availableCommands).toEqual(oldCommands);
    expect(app.state.thinkingLevel).toBe("high");
  });

  test("selecting a thread with persisted session shows loading session status", async () => {
    resetRuntimeStore();
    const app = createApp();
    app.state.threads[1] = { ...app.state.threads[1], title: "Handoff target", sessionId: "session-two" };
    const connectDeferred = new Deferred<void>();
    const loadDeferred = new Deferred<void>();
    const fakeClient = new FakeAcpClient(connectDeferred);
    store.activeAcpClientFactory = () => fakeClient as unknown as AcpClient;
    const controller = createThreadController({
      threadQueue: createThreadQueueStore(10),
      setQueueFocusIndex: () => undefined,
      clearQueueInteraction: () => undefined,
      editingQueueItem: () => null,
      setWelcomeDismissed: () => undefined,
      refreshOpenSlashAutocomplete: () => undefined,
      gitWatcherSetCwd: () => undefined,
      abortAndClearUserBash: () => undefined,
      loadSessionHistory: async () => {
        await loadDeferred.promise;
        return { result: { sessionId: "session-two" }, updates: [] };
      },
      replayLoadedSessionUpdates: () => undefined,
      submitPromptToAgent: async (_input: PromptInput) => undefined,
    });

    const select = controller.selectThread(app, "thread-two");
    await Promise.resolve();

    expect(app.state.spinnerActive).toBe(true);
    expect(app.state.spinnerLabel).toBe("Loading session: Handoff target");

    connectDeferred.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(app.state.spinnerActive).toBe(true);
    expect(app.state.spinnerLabel).toBe("Loading session: Handoff target");

    loadDeferred.resolve();
    await select;

    expect(app.state.spinnerActive).toBe(false);
    expect(app.state.spinnerLabel).toBe("");
  });

  test("lazy session creation waits for an in-flight thread client connection", async () => {
    resetRuntimeStore();
    const app = createApp();
    const connectDeferred = new Deferred<void>();
    const fakeClient = new FakeAcpClient(connectDeferred);
    store.activeAcpClientFactory = () => fakeClient as unknown as AcpClient;
    const controller = createThreadController({
      threadQueue: createThreadQueueStore(10),
      setQueueFocusIndex: () => undefined,
      clearQueueInteraction: () => undefined,
      editingQueueItem: () => null,
      setWelcomeDismissed: () => undefined,
      refreshOpenSlashAutocomplete: () => undefined,
      gitWatcherSetCwd: () => undefined,
      abortAndClearUserBash: () => undefined,
      loadSessionHistory: async () => ({ result: {}, updates: [] }),
      replayLoadedSessionUpdates: () => undefined,
      submitPromptToAgent: async (_input: PromptInput) => undefined,
    });

    const select = controller.selectThread(app, "thread-two");
    await Promise.resolve();
    const ensure = controller.ensureThreadSession(app, app.state.threads[1]);
    await Promise.resolve();

    expect(fakeClient.newSessionCalls).toBe(0);
    connectDeferred.resolve();
    await ensure;
    await select;

    expect(fakeClient.newSessionBeforeConnect).toBe(false);
    expect(fakeClient.newSessionCalls).toBe(1);
  });

  test("metadata warm-up reuses an in-flight session start", async () => {
    resetRuntimeStore();
    const app = createApp();
    const connectDeferred = new Deferred<void>();
    const newSessionDeferred = new Deferred<void>();
    const newSessionStarted = new Deferred<void>();
    const fakeClient = new FakeAcpClient(connectDeferred, newSessionDeferred, newSessionStarted);
    store.activeAcpClientFactory = () => fakeClient as unknown as AcpClient;
    const controller = createController();

    connectDeferred.resolve();
    expect(controller.warmThreadSessionCapabilities(app, "thread-one")).toBe(true);
    await newSessionStarted.promise;

    const ensured = controller.ensureThreadSession(app, app.state.threads[0]);
    await Promise.resolve();
    expect(fakeClient.newSessionCalls).toBe(1);

    newSessionDeferred.resolve();
    await ensured;
    expect(fakeClient.newSessionCalls).toBe(1);
    expect(app.state.threads.find((thread) => thread.id === "thread-one")?.sessionId).toBe("lazy-session");
  });

  test("session warm-up does not create a session for a thread archived before connect completes", async () => {
    resetRuntimeStore();
    const app = createApp();
    const connectDeferred = new Deferred<void>();
    const fakeClient = new FakeAcpClient(connectDeferred);
    store.activeAcpClientFactory = () => fakeClient as unknown as AcpClient;
    const controller = createController();

    const ensured = controller.ensureThreadSession(app, app.state.threads[0]);
    app.state.threads[0] = { ...app.state.threads[0], archived: true };
    connectDeferred.resolve();

    await ensured;
    expect(fakeClient.newSessionCalls).toBe(0);
    expect(fakeClient.sessionId).toBeNull();
  });

  test("archive closes an unreferenced ACP session when supported", async () => {
    resetRuntimeStore();
    const app = createApp(true);
    app.state.threads[1] = { ...app.state.threads[1], sessionId: "session-two" };
    const client = new CloseTrackingAcpClient("session-two", true);
    store.threadClients.set("thread-two", client as unknown as AcpClient);
    const controller = createController();
    controller.threadUiAdapter(app, "thread-two").addBlock({ type: "user", id: "u2", content: "prompt" });
    expect(store.threadTranscriptViews.has("thread-two")).toBe(true);

    await controller.archiveThread(app, "thread-two");

    expect(client.closeSessionCalls).toEqual(["session-two"]);
    expect(store.threadTranscriptViews.has("thread-two")).toBe(false);
    expect(client.disposeCalls).toBe(1);
    expect(app.state.threads.find((thread) => thread.id === "thread-two")?.archived).toBe(true);
  });

  test("archiving the active thread removes its view and restores the next thread view", async () => {
    resetRuntimeStore();
    const app = createApp();
    const activeBlocks: ChatBlock[] = [{ type: "user", id: "u1", content: "active" }];
    const nextBlocks: ChatBlock[] = [{ type: "user", id: "u2", content: "next" }];
    app.state.blocks = activeBlocks;
    app.state.currentBlockId = "u1";
    store.threadTranscriptViews.set("thread-one", new TranscriptViewState(activeBlocks, "u1"));
    store.threadBlocks.set("thread-two", nextBlocks);
    const nextView = new TranscriptViewState(nextBlocks, null);
    store.threadTranscriptViews.set("thread-two", nextView);
    store.threadPendingQueues.set("thread-one", [{ id: "queued", text: "queued" }]);
    const activeClient = new CloseTrackingAcpClient(null, false);
    const nextClientConnected = new Deferred<void>();
    nextClientConnected.resolve();
    const nextClient = new FakeAcpClient(nextClientConnected);
    store.threadClients.set("thread-one", activeClient as unknown as AcpClient);
    store.threadClients.set("thread-two", nextClient as unknown as AcpClient);
    const lifecycle: string[] = [];

    await createController({
      beforeThreadDeactivate: (threadId) => lifecycle.push(`before:${threadId}`),
      afterThreadActivate: (threadId) => lifecycle.push(`after:${threadId}`),
    }).archiveThread(app, "thread-one");

    expect(store.threadBlocks.has("thread-one")).toBe(false);
    expect(store.threadTranscriptViews.has("thread-one")).toBe(false);
    expect(store.threadPendingQueues.has("thread-one")).toBe(false);
    expect(app.state.activeThreadId).toBe("thread-two");
    expect(lifecycle).toEqual(["before:thread-one", "after:thread-two"]);
    expect(app.state.blocks).toEqual(nextBlocks);
    expect(store.threadTranscriptViews.get("thread-two")).toBe(nextView);
  });

  test("archive skips session close when another visible thread references the session", async () => {
    resetRuntimeStore();
    const app = createApp();
    app.state.threads[0] = { ...app.state.threads[0], sessionId: "shared-session" };
    app.state.threads[1] = { ...app.state.threads[1], sessionId: "shared-session" };
    const client = new CloseTrackingAcpClient("shared-session", true);
    store.threadClients.set("thread-two", client as unknown as AcpClient);
    const controller = createController();

    await controller.archiveThread(app, "thread-two");

    expect(client.closeSessionCalls).toEqual([]);
    expect(client.disposeCalls).toBe(1);
    expect(app.state.threads.find((thread) => thread.id === "thread-two")?.archived).toBe(true);
  });

  test("archive skips session close when unsupported", async () => {
    resetRuntimeStore();
    const app = createApp();
    app.state.threads[1] = { ...app.state.threads[1], sessionId: "session-two" };
    const client = new CloseTrackingAcpClient("session-two", false);
    store.threadClients.set("thread-two", client as unknown as AcpClient);
    const controller = createController();

    await controller.archiveThread(app, "thread-two");

    expect(client.closeSessionCalls).toEqual([]);
    expect(client.disposeCalls).toBe(1);
    expect(app.state.threads.find((thread) => thread.id === "thread-two")?.archived).toBe(true);
  });

  test("active-thread unexpected process exit records a visible error and clears running state", () => {
    resetRuntimeStore();
    const app = createApp();
    app.state.threads[0] = { ...app.state.threads[0], status: "running" };
    app.state.running = true;
    app.state.spinnerActive = true;
    app.state.spinnerLabel = "Working";
    app.state.currentBlockId = "streaming-block";
    app.state.blocks = [{ type: "content", id: "streaming-block", content: "partial", finalized: false }];
    const client = {} as AcpClient;
    store.acpClient = client;
    store.threadClients.set("thread-one", client);
    store.threadPromptRunIds.set("thread-one", 3);
    expect(reservePromptDispatch("thread-one")).not.toBeNull();
    expect(isPromptDispatchReserved("thread-one")).toBe(true);

    const callbacks = createController().createThreadCallbacks(app, "thread-one", () => client);
    callbacks.onProcessExit?.({ code: 0, expected: false, reason: "exit", transport: "stdio" });

    expect(app.state.blocks).toContainEqual(
      expect.objectContaining({
        type: "info",
        variant: "error",
        content: "ACP agent process exited unexpectedly (code 0). Start a new prompt to reconnect.",
      }),
    );
    expect(app.state.blocks[0]).toMatchObject({ finalized: true });
    expect(app.state.running).toBe(false);
    expect(app.state.spinnerActive).toBe(false);
    expect(app.state.spinnerLabel).toBe("");
    expect(app.state.currentBlockId).toBeNull();
    expect(app.state.threads.find((thread) => thread.id === "thread-one")?.status).toBe("paused");
    expect(store.threadClients.has("thread-one")).toBe(false);
    expect(store.acpClient).toBeNull();
    expect(store.threadPromptRunIds.has("thread-one")).toBe(false);
    expect(isPromptDispatchReserved("thread-one")).toBe(false);
  });

  test("applies ACP streaming through the real paging-aware active-thread adapter", () => {
    resetRuntimeStore();
    const app = createAppStateValue("/tmp/thread-one", { transcriptPagingEnabled: true });
    const activeThread = makeThread("thread-one", "/tmp/thread-one");
    app.setState("threads", [activeThread, makeThread("thread-two", "/tmp/thread-two")]);
    app.setActiveThreadState(activeThread, []);
    const adapter = createController().threadUiAdapter(app as App, "thread-one");

    applyAcpSessionUpdate(acpAgentMessageChunk("Hello, "), adapter);
    applyAcpSessionUpdate(acpAgentMessageChunk("world!"), adapter);

    const blockId = app.state.blocks[0]?.id;
    const view = store.threadTranscriptViews.get("thread-one");
    expect(blockId).toBeTruthy();
    expect(app.state.currentBlockId).toBe(blockId);
    expect(app.state.blocks).toEqual([
      expect.objectContaining({ type: "content", content: "Hello, world!", finalized: false }),
    ]);
    expect(view?.pageIndex.pageForBlock(blockId!)?.blockIds).toEqual([blockId]);
    expect(view?.pageIndex.pageForBlock(blockId!)?.estimatedRows).toBeGreaterThan(0);
    const streamingRevision = view?.pageIndex.pageForBlock(blockId!)?.layoutRevision ?? -1;

    finalizeAcpPrompt(adapter, acpPromptResponse());
    expect(app.state.blocks[0]).toMatchObject({ content: "Hello, world!", finalized: true });
    expect(app.state.currentBlockId).toBeNull();
    expect(view?.pageIndex.pageForBlock(blockId!)?.layoutRevision).toBeGreaterThan(streamingRevision);
  });

  test("keeps inactive-thread mutations paging-free when transcript paging is disabled", () => {
    resetRuntimeStore();
    const app = createApp(false);
    const adapter = createController().threadUiAdapter(app, "thread-two");
    store.threadBlocks.set("thread-two", []);

    adapter.addBlock({ type: "user", id: "u1", content: "prompt" });
    adapter.addBlock({ type: "content", id: "c1", content: "draft", finalized: false });
    adapter.appendToBlock("c1", " streamed");
    expect(store.threadBlocks.get("thread-two")![1]).toMatchObject({ content: "draft streamed", finalized: false });
    adapter.updateBlock("c1", { finalized: true });
    expect(store.threadBlocks.get("thread-two")![1]).toMatchObject({ content: "draft streamed", finalized: true });
    adapter.removeBlock("u1");
    adapter.replaceBlocks([{ type: "user", id: "u2", content: "replacement" }]);

    expect(store.threadBlocks.get("thread-two")).toEqual([{ type: "user", id: "u2", content: "replacement" }]);
    expect(store.threadTranscriptViews.size).toBe(0);
  });

  test("streaming into an inactive thread does not copy its transcript per chunk", () => {
    resetRuntimeStore();
    const app = createApp(false);
    const adapter = createController().threadUiAdapter(app, "thread-two");
    const blocks: ChatBlock[] = Array.from({ length: 2000 }, (_, i) => ({
      type: "content",
      id: `b${i}`,
      content: "x",
      finalized: true,
    }));
    let reads = 0;
    const tracked = new Proxy(blocks, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    store.threadBlocks.set("thread-two", tracked);
    adapter.appendToBlock("b0", ""); // primes the one-time id->index cache
    let maxReads = 0;
    const measure = (op: () => void) => {
      reads = 0;
      op();
      maxReads = Math.max(maxReads, reads);
    };
    const copies: number[] = [];
    const spread = Array.prototype[Symbol.iterator];
    const { slice, toSpliced } = Array.prototype;
    Array.prototype[Symbol.iterator] = function (this: unknown[]) {
      if (this.length >= 2000) copies.push(this.length);
      return spread.call(this);
    };
    Array.prototype.slice = function (this: unknown[], ...args: Parameters<typeof slice>) {
      if (this.length >= 2000) copies.push(this.length);
      return slice.apply(this, args);
    };
    Array.prototype.toSpliced = function (this: unknown[], ...args: Parameters<typeof toSpliced>) {
      if (this.length >= 2000) copies.push(this.length);
      return toSpliced.apply(this, args);
    };
    try {
      measure(() => adapter.addBlock({ type: "content", id: "live", content: "", finalized: false }));
      for (let i = 0; i < 200; i++) measure(() => adapter.appendToBlock("live", "y"));
      for (let i = 0; i < 200; i++) measure(() => adapter.updateBlock("live", { finalized: i === 199 }));
      measure(() => adapter.addBlock({ type: "info", id: "after", content: "done", variant: "info" }));
    } finally {
      Array.prototype[Symbol.iterator] = spread;
      Array.prototype.slice = slice;
      Array.prototype.toSpliced = toSpliced;
    }

    expect(copies).toEqual([]);
    // Each chunk touches a handful of blocks; a copy or a preview rescan would read all 2000.
    expect(maxReads).toBeLessThanOrEqual(20);
    expect(store.threadBlocks.get("thread-two")).toBe(tracked);
    expect(blocks).toHaveLength(2002);
    expect(blocks.at(-2)).toMatchObject({ id: "live", content: "y".repeat(200), finalized: true });
    expect(blocks.at(-1)).toMatchObject({ id: "after" });
  });

  test("a running tool keeps the inactive thread preview until it finishes", () => {
    resetRuntimeStore();
    const app = createApp(false);
    const adapter = createController().threadUiAdapter(app, "thread-two");
    adapter.addBlock({
      type: "tool",
      id: "t1",
      toolCallId: "c1",
      toolName: "bash",
      display: "sleep 60",
      status: "running",
    } as ChatBlock);
    for (let i = 0; i < 50; i++)
      adapter.addBlock({ type: "content", id: `c${i}`, content: `text ${i}`, finalized: true });
    adapter.appendToBlock("c49", " more");
    expect(store.threadPreviews.get("thread-two")).toBe("bash sleep 60");
    adapter.updateBlock("t1", { status: "completed" } as Partial<ChatBlock>);
    expect(store.threadPreviews.get("thread-two")).toBe("text 49 more");
    adapter.removeBlock("c0");
    adapter.updateBlock("t1", { status: "running" } as Partial<ChatBlock>);
    expect(store.threadPreviews.get("thread-two")).toBe("bash sleep 60");
    adapter.addBlock({
      type: "tool",
      id: "t2",
      toolCallId: "c2",
      toolName: "grep",
      display: "foo",
      status: "running",
    } as ChatBlock);
    expect(store.threadPreviews.get("thread-two")).toBe("grep foo");
    adapter.updateBlock("t2", { status: "completed" } as Partial<ChatBlock>);
    expect(store.threadPreviews.get("thread-two")).toBe("bash sleep 60");
  });

  test("a throwing transcript view does not leave a pushed block behind", () => {
    resetRuntimeStore();
    const app = createApp(true);
    const adapter = createController().threadUiAdapter(app, "thread-two");
    adapter.addBlock({ type: "user", id: "u1", content: "prompt" });
    const blocks = store.threadBlocks.get("thread-two")!;
    const view = store.threadTranscriptViews.get("thread-two")!;
    view.appendBlock = () => {
      throw new Error("view failed");
    };

    expect(() => adapter.addBlock({ type: "content", id: "c1", content: "x", finalized: false })).toThrow(
      "view failed",
    );
    expect(blocks.map((block) => block.id)).toEqual(["u1"]);
  });

  test("rebuilds a stale inactive-thread block index after same-length structural changes", () => {
    resetRuntimeStore();
    const app = createApp(false);
    const adapter = createController().threadUiAdapter(app, "thread-two");
    store.threadBlocks.set("thread-two", [
      { type: "content", id: "a", content: "a", finalized: false },
      { type: "content", id: "b", content: "b", finalized: false },
    ]);

    adapter.appendToBlock("b", " cached");
    store.threadBlocks.set("thread-two", [
      { type: "content", id: "b", content: "replacement b", finalized: false },
      { type: "content", id: "c", content: "replacement c", finalized: false },
    ]);

    adapter.appendToBlock("b", " streamed");

    expect(store.threadBlocks.get("thread-two")).toEqual([
      { type: "content", id: "b", content: "replacement b streamed", finalized: false },
      { type: "content", id: "c", content: "replacement c", finalized: false },
    ]);
  });

  test("keeps inactive-thread canonical blocks and page metadata synchronized across mutations", () => {
    resetRuntimeStore();
    const app = createApp(true);
    const adapter = createController().threadUiAdapter(app, "thread-two");
    store.threadBlocks.set("thread-two", []);

    adapter.addBlock({ type: "user", id: "u1", content: "prompt" });
    expectThreadTranscriptConsistent("thread-two");
    adapter.addBlock({ type: "content", id: "c1", content: "draft", finalized: false });
    adapter.setCurrentBlockId("c1");
    adapter.updateBlock("c1", { content: "complete", finalized: true });
    adapter.setCurrentBlockId(null);
    expectThreadTranscriptConsistent("thread-two");
    adapter.addBlock({ type: "info", id: "i1", content: "inserted", variant: "info" }, 1);
    expectThreadTranscriptConsistent("thread-two");
    adapter.removeBlock("i1");
    expectThreadTranscriptConsistent("thread-two");
    adapter.replaceBlocks([{ type: "user", id: "u2", content: "replacement" }]);
    expectThreadTranscriptConsistent("thread-two");
  });

  test("background-thread unexpected process exit is recorded only on that thread", () => {
    resetRuntimeStore();
    const app = createApp(true);
    app.state.threads[1] = { ...app.state.threads[1], status: "running" };
    const activeClient = {} as AcpClient;
    const backgroundClient = {} as AcpClient;
    store.acpClient = activeClient;
    store.threadClients.set("thread-one", activeClient);
    store.threadClients.set("thread-two", backgroundClient);
    store.threadBlocks.set("thread-two", []);

    const callbacks = createController().createThreadCallbacks(app, "thread-two", () => backgroundClient);
    callbacks.onProcessExit?.({ signal: "SIGHUP", expected: false, reason: "exit", transport: "stdio" });

    expect(app.state.blocks).toHaveLength(0);
    expect(store.threadBlocks.get("thread-two")).toContainEqual(
      expect.objectContaining({
        type: "info",
        variant: "error",
        content: "ACP agent process exited unexpectedly (signal SIGHUP). Start a new prompt to reconnect.",
      }),
    );
    expect(
      store.threadTranscriptViews
        .get("thread-two")
        ?.pageIndex.pages()
        .flatMap((page) => page.blockIds),
    ).toEqual(store.threadBlocks.get("thread-two")?.map((block) => block.id));
    expect(app.state.threads.find((thread) => thread.id === "thread-two")?.status).toBe("paused");
    expect(store.acpClient).toBe(activeClient);
    expect(store.threadClients.get("thread-one")).toBe(activeClient);
    expect(store.threadClients.has("thread-two")).toBe(false);
  });

  test("stale old-client process exit is ignored after replacement", () => {
    resetRuntimeStore();
    const app = createApp();
    app.state.threads[0] = { ...app.state.threads[0], status: "running" };
    const oldClient = {} as AcpClient;
    const newClient = {} as AcpClient;
    store.acpClient = newClient;
    store.threadClients.set("thread-one", newClient);

    const callbacks = createController().createThreadCallbacks(app, "thread-one", () => oldClient);
    callbacks.onProcessExit?.({ code: 1, expected: false, reason: "exit", transport: "stdio" });

    expect(app.state.blocks).toHaveLength(0);
    expect(app.state.threads.find((thread) => thread.id === "thread-one")?.status).toBe("running");
    expect(store.acpClient).toBe(newClient);
    expect(store.threadClients.get("thread-one")).toBe(newClient);
  });

  test("pre-initialize process exit metadata does not add a visible thread error", () => {
    resetRuntimeStore();
    const app = createApp();
    app.state.threads[0] = { ...app.state.threads[0], status: "connecting" };
    const client = {} as AcpClient;
    store.acpClient = client;
    store.threadClients.set("thread-one", client);

    const callbacks = createController().createThreadCallbacks(app, "thread-one", () => client);
    callbacks.onProcessExit?.({ code: 0, expected: false, reason: "exit", transport: "stdio", connected: false });

    expect(app.state.blocks).toHaveLength(0);
    expect(app.state.threads.find((thread) => thread.id === "thread-one")?.status).toBe("connecting");
    expect(store.acpClient).toBe(client);
    expect(store.threadClients.get("thread-one")).toBe(client);
  });

  test("intentional dispose process exit does not add an error", () => {
    resetRuntimeStore();
    const app = createApp();
    app.state.threads[0] = { ...app.state.threads[0], status: "running" };
    const client = {} as AcpClient;
    store.acpClient = client;
    store.threadClients.set("thread-one", client);

    const callbacks = createController().createThreadCallbacks(app, "thread-one", () => client);
    callbacks.onProcessExit?.({ code: 0, expected: true, reason: "dispose", transport: "stdio" });

    expect(app.state.blocks).toHaveLength(0);
    expect(app.state.threads.find((thread) => thread.id === "thread-one")?.status).toBe("running");
    expect(store.acpClient).toBe(client);
    expect(store.threadClients.get("thread-one")).toBe(client);
  });

  test("block transition events fire only when a plugin listens for them", async () => {
    resetRuntimeStore();
    const app = createApp();
    const client = {} as AcpClient;
    store.threadClients.set("thread-one", client);
    const runner = new PluginRunner({ cwd: app.state.cwd });
    const seen: string[] = [];
    await runner.register({
      info: { id: "other", name: "other", path: "/other" },
      factory: (relay) => {
        relay.on("prompt:complete", () => undefined);
      },
    });
    setPluginRunner(runner);
    expect(hasPluginBlockEventListeners()).toBe(false);
    const callbacks = createController().createThreadCallbacks(app, "thread-one", () => client);
    callbacks.onSessionUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } });
    await flushAsyncCallbacks();
    expect(app.state.blocks.length).toBe(1);
    await runner.register({
      info: { id: "watch", name: "watch", path: "/watch" },
      factory: (relay) => {
        relay.on("message:start", (event) => void seen.push(event.type));
        relay.on("message:update", (event) => void seen.push(`${event.type}:${event.delta}`));
      },
    });
    expect(hasPluginBlockEventListeners()).toBe(true);
    callbacks.onSessionUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" } });
    await flushAsyncCallbacks();
    expect(seen).toEqual(["message:update:b"]);
    expect(app.state.blocks.length).toBe(1);
  });

  test("session update mapping handles standard message content for every agent profile", () => {
    resetRuntimeStore();
    const app = createApp();
    const client = {} as AcpClient;
    store.threadClients.set("thread-one", client);
    const callbacks = createController().createThreadCallbacks(app, "thread-one", () => client);

    store.activeAgentBehaviorProfile = defaultAgentBehaviorProfile;
    callbacks.onSessionUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "default " } });
    expect(app.state.blocks).toEqual([
      expect.objectContaining({ type: "content", content: "default ", finalized: false }),
    ]);

    store.activeAgentBehaviorProfile = altaAgentBehaviorProfile;
    callbacks.onSessionUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "alta" } });
    expect(app.state.blocks).toEqual([
      expect.objectContaining({ type: "content", content: "default alta", finalized: false }),
    ]);
  });

  test("plugin permission hook can deny before approval UI appears", async () => {
    resetRuntimeStore();
    const app = createApp();
    const runner = new PluginRunner({ cwd: app.state.cwd });
    await runner.register({
      info: { id: "policy", name: "policy", path: "/policy" },
      factory: (relay) => {
        relay.permissions.onRequest((request) => {
          expect(request.threadId).toBe("thread-one");
          expect(request.cwd).toBe("/tmp/thread-one");
          expect(request.toolName).toBe("bash");
          return { action: "deny", reason: "blocked by test" };
        });
      },
    });
    setPluginRunner(runner);
    const responses: unknown[] = [];
    const callbacks = createController().createThreadCallbacks(app, "thread-one");

    callbacks.onPermissionRequest({
      toolName: "bash",
      toolCallId: "tool-1",
      preview: "rm -rf tmp",
      options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
      respond: (response) => responses.push(response),
    });
    await flushAsyncCallbacks();

    expect(responses).toEqual([ApprovalResponse.DENY]);
    expect(app.state.blocks).toEqual([
      expect.objectContaining({
        type: "info",
        variant: "warning",
        content: "Plugin policy denied permission for bash: blocked by test",
      }),
    ]);
  });

  test("plugin permission hook can select an approval option by id", async () => {
    resetRuntimeStore();
    const app = createApp();
    const runner = new PluginRunner({ cwd: app.state.cwd });
    await runner.register({
      info: { id: "policy", name: "policy", path: "/policy" },
      factory: (relay) => {
        relay.permissions.onRequest(() => ({ action: "select", optionId: "allow_always" }));
      },
    });
    setPluginRunner(runner);
    const selected = { optionId: "allow_always", name: "Allow always", kind: "allow_always" };
    const responses: unknown[] = [];
    const callbacks = createController().createThreadCallbacks(app, "thread-one");

    callbacks.onPermissionRequest({
      toolName: "bash",
      toolCallId: "tool-1",
      options: [{ optionId: "deny", name: "Deny", kind: "deny" }, selected],
      respond: (response) => responses.push(response),
    });
    await flushAsyncCallbacks();

    expect(responses).toEqual([selected]);
    expect(app.state.blocks).toEqual([
      expect.objectContaining({ type: "info", content: "Plugin policy approved permission for bash" }),
    ]);
  });

  test("Relay yolo auto-selects allow once without showing approval UI", async () => {
    resetRuntimeStore();
    const app = createApp();
    store.threadYoloEnabled.add("thread-one");
    const allowAlways = { optionId: "always", name: "Allow always", kind: "allow_always" };
    const allowOnce = { optionId: "once", name: "Allow once", kind: "allow_once" };
    const responses: unknown[] = [];
    const callbacks = createController().createThreadCallbacks(app, "thread-one");

    callbacks.onPermissionRequest({
      toolName: "bash",
      toolCallId: "tool-1",
      options: [allowAlways, allowOnce],
      respond: (response) => responses.push(response),
    });
    await flushAsyncCallbacks();

    expect(responses).toEqual([allowOnce]);
    expect(app.state.blocks).toEqual([]);
  });

  test("Relay yolo falls back to approval UI when no allow option is offered", async () => {
    resetRuntimeStore();
    const app = createApp();
    store.threadYoloEnabled.add("thread-one");
    const responses: unknown[] = [];
    const callbacks = createController().createThreadCallbacks(app, "thread-one");

    callbacks.onPermissionRequest({
      toolName: "bash",
      toolCallId: "tool-1",
      options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
      respond: (response) => responses.push(response),
    });
    await flushAsyncCallbacks();

    expect(responses).toEqual([]);
    expect(app.state.blocks).toEqual([expect.objectContaining({ type: "tool", status: "approval" })]);
  });

  test("permission continue falls back to approval UI", async () => {
    resetRuntimeStore();
    const app = createApp();
    const runner = new PluginRunner({ cwd: app.state.cwd });
    await runner.register({
      info: { id: "policy", name: "policy", path: "/policy" },
      factory: (relay) => {
        relay.permissions.onRequest(() => ({ action: "continue" }));
      },
    });
    setPluginRunner(runner);
    const responses: unknown[] = [];
    const callbacks = createController().createThreadCallbacks(app, "thread-one");

    callbacks.onPermissionRequest({
      toolName: "bash",
      toolCallId: "tool-1",
      preview: "echo hi",
      options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
      respond: (response) => responses.push(response),
    });
    await flushAsyncCallbacks();

    expect(responses).toEqual([]);
    expect(app.state.blocks).toEqual([
      expect.objectContaining({
        type: "tool",
        toolName: "bash",
        status: "approval",
        approvalPreview: "echo hi",
      }),
    ]);
  });

  test("plugin elicitation hook can respond before form UI appears", async () => {
    resetRuntimeStore();
    const app = createApp();
    const runner = new PluginRunner({ cwd: app.state.cwd });
    await runner.register({
      info: { id: "answers", name: "answers", path: "/answers" },
      factory: (relay) => {
        relay.elicitation.onRequest((request) => {
          expect(request.fields[0]?.key).toBe("env");
          return { action: "respond", response: { action: "accept", content: { env: "dev" } } };
        });
      },
    });
    setPluginRunner(runner);
    const responses: unknown[] = [];
    app.addBlock({
      type: "tool",
      id: "tool-block",
      toolCallId: "tool-1",
      toolName: "ask_user_questions",
      display: "ask",
      status: "running",
    });
    const callbacks = createController().createThreadCallbacks(app, "thread-one");

    callbacks.onElicitationRequest?.({
      mode: "form",
      message: "Pick env",
      toolCallId: "tool-1",
      requestedSchema: {
        type: "object",
        properties: {
          env: { type: "string", title: "Environment", enum: ["dev", "prod"] },
        },
        required: ["env"],
      },
      respond: (response) => responses.push(response),
    });
    await flushAsyncCallbacks();

    expect(responses).toEqual([{ action: "accept", content: { env: "dev" } }]);
    expect(app.state.blocks.some((block) => block.type === "elicitation")).toBe(false);
    expect(app.state.blocks).toContainEqual(
      expect.objectContaining({ type: "info", content: "Plugin answers answered elicitation: Pick env" }),
    );
    expect(app.state.blocks[0]).toMatchObject({ elicitationAnswers: [{ label: "Pick env", value: "dev" }] });
  });

  test("elicitation continue falls back to form UI", async () => {
    resetRuntimeStore();
    const app = createApp();
    const runner = new PluginRunner({ cwd: app.state.cwd });
    await runner.register({
      info: { id: "answers", name: "answers", path: "/answers" },
      factory: (relay) => {
        relay.elicitation.onRequest(() => ({ action: "continue" }));
      },
    });
    setPluginRunner(runner);
    const callbacks = createController().createThreadCallbacks(app, "thread-one");

    callbacks.onElicitationRequest?.({
      mode: "form",
      message: "Pick env",
      requestedSchema: {
        type: "object",
        properties: {
          env: { type: "string", title: "Environment", enum: ["dev", "prod"] },
        },
      },
      respond: () => undefined,
    });
    await flushAsyncCallbacks();

    expect(app.state.blocks).toEqual([
      expect.objectContaining({
        type: "elicitation",
        status: "pending",
        message: "Pick env",
        fields: [expect.objectContaining({ key: "env", title: "Environment" })],
      }),
    ]);
  });

  test("agent-published yoloo disables the Relay fallback", () => {
    resetRuntimeStore();
    const app = createApp();
    store.threadYoloEnabled.add("thread-one");

    createController()
      .createThreadCallbacks(app, "thread-one")
      .onAvailableCommands?.([{ name: "YOLOO", description: "Agent-owned yoloo" }]);

    expect(store.threadYoloEnabled.has("thread-one")).toBe(false);
    expect(app.state.availableCommands).toEqual([{ name: "YOLOO", description: "Agent-owned yoloo" }]);
  });

  test("agent-published yoloo does not disable yolo explicitly enabled at launch", () => {
    resetRuntimeStore();
    const app = createApp();
    store.threadYoloEnabled.add("thread-one");
    store.threadYoloLaunchEnabled.add("thread-one");

    createController()
      .createThreadCallbacks(app, "thread-one")
      .onAvailableCommands?.([{ name: "yoloo", description: "Agent-owned yoloo" }]);

    expect(store.threadYoloEnabled.has("thread-one")).toBe(true);
  });

  test("available command updates for inactive threads do not refresh active slash autocomplete", () => {
    resetRuntimeStore();
    const app = createApp();
    let refreshes = 0;
    const controller = createThreadController({
      threadQueue: createThreadQueueStore(10),
      setQueueFocusIndex: () => undefined,
      clearQueueInteraction: () => undefined,
      editingQueueItem: () => null,
      setWelcomeDismissed: () => undefined,
      refreshOpenSlashAutocomplete: () => {
        refreshes += 1;
      },
      refreshSlashAutocompleteForCommandUpdate: () => {
        refreshes += 1;
      },
      gitWatcherSetCwd: () => undefined,
      abortAndClearUserBash: () => undefined,
      loadSessionHistory: async () => ({ result: {}, updates: [] }),
      replayLoadedSessionUpdates: () => undefined,
      submitPromptToAgent: async (_input: PromptInput) => undefined,
    });

    controller
      .createThreadCallbacks(app, "thread-two")
      .onAvailableCommands?.([{ name: "real-skill", description: "agent-side real skill command" }]);

    expect(store.threadAgentCommands.get("thread-two")).toEqual([
      { name: "real-skill", description: "agent-side real skill command" },
    ]);
    expect(app.state.availableCommands).toEqual([]);
    expect(refreshes).toBe(0);
  });
});
