import type {
  Disposable,
  RelayEventHandler,
  RelayMcpServerConfig,
  RelayMcpServerLifecycleOptions,
  RelayPluginActiveTurnInputResult,
  RelayPluginAgentPromptOptions,
  RelayPluginApi,
  RelayPluginChatBlockInput,
  RelayPluginForkSessionOptions,
  RelayPluginSessionResult,
  RelayPluginEvent,
  RelayPluginInfo,
  RelayConversationSnapshot,
  RelayPluginModeInfo,
  RelayPluginModelInfo,
  RelayPluginThreadCreateOptions,
  RelayPluginThreadInfo,
  RelayPluginThreadSessionInfo,
  RelayPluginToastVariant,
  RelayOverlayWidget,
  RelayWidget,
  RelayWidgetHandle,
  RelayWidgetPlacement,
  RelayDiffOverlayOptions,
  RelayPluginConfirmDialogOptions,
  RelayPluginEditorDialogOptions,
  RelayPluginInputDialogOptions,
  RelayPluginSelectDialogOptions,
  RelayPluginSelectOption,
  RelayThemeConfig,
} from "./types";
import { coercePluginSettingValue } from "./types";
import type { PluginRunner } from "./runner";
import { getConfig, getPluginSettingRaw, setPluginSettingValue } from "../config";

export interface RelayPluginApiOptions {
  readonly cwd: string;
  readonly plugin: RelayPluginInfo;
  readonly runner: PluginRunner;
  readonly toast: (message: string, variant?: RelayPluginToastVariant, durationMs?: number) => void;
  readonly invalidate: () => void;
  readonly editorHost?: {
    getText(): string;
    setText(text: string): void;
    insertText(text: string): void;
    attachImage(path: string): boolean;
    submit(text?: string): Promise<void>;
  };
  readonly chatHost?: {
    addBlock(plugin: RelayPluginInfo, block: RelayPluginChatBlockInput): string | undefined;
    userMessageCount(threadId?: string): number;
  };
  readonly agentHost?: {
    name(): string;
    profile(): string;
    sessionId(): string | null;
    isRunning(): boolean;
    waitForIdle(): Promise<void>;
    hasQueuedPrompts(): boolean;
    supportsActiveTurnInput(): boolean;
    supportsSessionFork?(): boolean;
    supportsSessionDelete?(): boolean;
    supportsSessionClose?(): boolean;
    addToCurrentTurn(text: string): Promise<RelayPluginActiveTurnInputResult>;
    forkSession?(options?: RelayPluginForkSessionOptions): Promise<RelayPluginSessionResult>;
    runHiddenPrompt?(sessionId: string, text: string): Promise<string>;
    deleteSession?(sessionId: string): Promise<void>;
    closeSession?(sessionId: string): Promise<void>;
    availableModes(): readonly RelayPluginModeInfo[];
    availableModels(): readonly RelayPluginModelInfo[];
    availableThinkingLevels(): readonly string[];
    prompt(text: string, options?: RelayPluginAgentPromptOptions): Promise<void>;
    cancel(): Promise<void>;
    restart(): Promise<void>;
    newSession(cwd?: string): Promise<void>;
    loadSession(sessionId: string, cwd?: string): Promise<void>;
    setMode(modeId: string): Promise<void>;
    setModel(modelId: string): Promise<void>;
    setThinkingLevel(level: string): Promise<void>;
    setSessionModel?(sessionId: string, modelId: string): Promise<void>;
    setSessionThinkingLevel?(sessionId: string, level: string): Promise<void>;
  };
  readonly threadHost?: {
    current(): RelayPluginThreadInfo | null;
    list(): readonly RelayPluginThreadInfo[];
    conversation?(threadId?: string): RelayConversationSnapshot | null;
    conversationMarkdown?(threadId?: string): string | null;
    create?(options?: RelayPluginThreadCreateOptions): Promise<RelayPluginThreadInfo | null>;
    ensureSession?(threadId?: string): Promise<RelayPluginThreadSessionInfo | null>;
    select(threadId: string): Promise<void>;
    archive(threadId: string): Promise<void>;
  };
  readonly diffOverlayHost?: {
    open(plugin: RelayPluginInfo, options: RelayDiffOverlayOptions): Disposable;
  };
  readonly dialogHost?: {
    confirm(
      plugin: RelayPluginInfo,
      title: string,
      message: string,
      options?: RelayPluginConfirmDialogOptions,
    ): Promise<boolean>;
    select(
      plugin: RelayPluginInfo,
      title: string,
      options: readonly RelayPluginSelectOption[],
      dialogOptions?: RelayPluginSelectDialogOptions,
    ): Promise<string | undefined>;
    input(
      plugin: RelayPluginInfo,
      title: string,
      placeholder?: string,
      options?: RelayPluginInputDialogOptions,
    ): Promise<string | undefined>;
    editor(
      plugin: RelayPluginInfo,
      title: string,
      prefill?: string,
      options?: RelayPluginEditorDialogOptions,
    ): Promise<string | undefined>;
  };
}

function handleMcpLifecycleChange(
  options: RelayPluginApiOptions,
  lifecycleOptions?: RelayMcpServerLifecycleOptions,
): void {
  const status = options.runner.mcp.status();
  if (!status.restartNeeded) return;

  const apply = lifecycleOptions?.apply ?? "nextSession";
  if (apply === "nextSession") return;

  if (apply === "promptRestart") {
    options.toast("MCP changes will apply after restarting the agent", "warning", 5000);
    return;
  }

  const agentHost = options.agentHost;
  if (!agentHost) {
    options.toast("MCP changes require an agent restart, but no active agent host is available", "warning", 5000);
    return;
  }

  void agentHost
    .restart()
    .then(() => {
      options.runner.mcp.markApplied();
      options.toast("MCP changes applied after agent restart", "info", 3000);
    })
    .catch((error) => options.runner.recordError(options.plugin, "Failed to restart agent for MCP changes", error));
}

async function runPluginDialog<T>(
  options: RelayPluginApiOptions,
  fallback: T,
  run: () => Promise<T> | undefined,
): Promise<T> {
  try {
    const result = run();
    if (!result) return fallback;
    return await result;
  } catch (error) {
    options.runner.recordError(options.plugin, "Plugin dialog failed", error);
    return fallback;
  }
}

type WidgetStateSnapshot = {
  readonly placement: RelayWidgetPlacement;
  readonly focused: boolean;
  readonly hidden: boolean;
};

type FocusedWidgetSnapshot = {
  readonly plugin: RelayPluginInfo;
  readonly key: string;
  readonly widget: RelayWidget;
};

function focusedWidgetId(entry: FocusedWidgetSnapshot | null): string | null {
  return entry ? `${entry.plugin.id}:${entry.key}` : null;
}

function invalidateWidgetMutation(
  runner: PluginRunner,
  before: WidgetStateSnapshot | null,
  after: WidgetStateSnapshot | null,
  focusedBefore: FocusedWidgetSnapshot | null,
  focusedAfter: FocusedWidgetSnapshot | null,
): void {
  const placements = new Set<RelayWidgetPlacement>();
  if (before) placements.add(before.placement);
  if (after) placements.add(after.placement);
  if (focusedBefore) placements.add(focusedBefore.widget.placement);
  if (focusedAfter) placements.add(focusedAfter.widget.placement);
  runner.invalidateWidgets(placements, focusedWidgetId(focusedBefore) !== focusedWidgetId(focusedAfter));
}

function setPluginWidget(
  options: RelayPluginApiOptions,
  key: string,
  widget: RelayWidget | undefined,
): RelayWidgetHandle | undefined {
  const before = options.runner.slots.widgetState(options.plugin, key);
  const focusedBefore = options.runner.slots.focusedKeyboardWidget();
  const changed = options.runner.slots.setWidget(options.plugin, key, widget);
  if (changed) {
    invalidateWidgetMutation(
      options.runner,
      before,
      options.runner.slots.widgetState(options.plugin, key),
      focusedBefore,
      options.runner.slots.focusedKeyboardWidget(),
    );
  }
  if (!widget) return undefined;
  return createWidgetHandle(options, key);
}

function invalidateChromeOnDispose(disposable: Disposable, runner: PluginRunner): Disposable {
  return {
    dispose(): void {
      disposable.dispose();
      runner.invalidateChrome();
    },
  };
}

function createWidgetHandle(options: RelayPluginApiOptions, key: string): RelayWidgetHandle {
  let disposed = false;
  const state = () => options.runner.slots.widgetState(options.plugin, key);
  const apply = (operation: () => boolean): void => {
    if (disposed) return;
    const before = state();
    const focusedBefore = options.runner.slots.focusedKeyboardWidget();
    if (!operation()) return;
    invalidateWidgetMutation(
      options.runner,
      before,
      state(),
      focusedBefore,
      options.runner.slots.focusedKeyboardWidget(),
    );
  };
  return {
    get focused() {
      return state()?.focused ?? false;
    },
    get hidden() {
      return state()?.hidden ?? true;
    },
    focus(): void {
      apply(() => options.runner.slots.focusWidget(options.plugin, key));
    },
    unfocus(): void {
      apply(() => options.runner.slots.unfocusWidget(options.plugin, key));
    },
    setHidden(hidden: boolean): void {
      apply(() => options.runner.slots.setWidgetHidden(options.plugin, key, hidden));
    },
    invalidate(): void {
      const current = disposed ? null : state();
      if (current) options.runner.invalidateWidgets([current.placement]);
    },
    dispose(): void {
      if (disposed) return;
      const before = state();
      const focusedBefore = options.runner.slots.focusedKeyboardWidget();
      disposed = true;
      if (!options.runner.slots.removeWidget(options.plugin, key)) return;
      invalidateWidgetMutation(
        options.runner,
        before,
        null,
        focusedBefore,
        options.runner.slots.focusedKeyboardWidget(),
      );
    },
  };
}

function activePluginApiProxy<T extends object>(
  value: T,
  assertActive: () => void,
  cache = new WeakMap<object, object>(),
): T {
  const cached = cache.get(value);
  if (cached) return cached as T;
  const methodCache = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  const proxy = new Proxy(value, {
    get(target, property, receiver) {
      assertActive();
      const result = Reflect.get(target, property, receiver) as unknown;
      if (typeof result === "function") {
        const cachedMethod = methodCache.get(property);
        if (cachedMethod) return cachedMethod;
        const method = (...args: unknown[]) => {
          assertActive();
          return Reflect.apply(result, target, args) as unknown;
        };
        methodCache.set(property, method);
        return method;
      }
      if (result !== null && typeof result === "object") {
        return activePluginApiProxy(result, assertActive, cache);
      }
      return result;
    },
  });
  cache.set(value, proxy);
  return proxy;
}

export function createRelayPluginApi(options: RelayPluginApiOptions): RelayPluginApi {
  const api: RelayPluginApi = {
    plugin: options.plugin,
    cwd: options.cwd,
    on<E extends RelayPluginEvent["type"]>(type: E, handler: RelayEventHandler<E>): Disposable {
      return options.runner.on(options.plugin, type, handler);
    },
    ui: {
      getTheme(): RelayThemeConfig {
        const config = getConfig();
        return { id: config.ui.theme, colors: config.colors };
      },
      toast(message, variant = "info", durationMs = 2000): void {
        options.toast(message, variant, durationMs);
      },
      openDiff(diffOptions): Disposable {
        return options.diffOverlayHost?.open(options.plugin, diffOptions) ?? { dispose: () => undefined };
      },
      confirm(title, message, dialogOptions): Promise<boolean> {
        return runPluginDialog(options, false, () =>
          options.dialogHost?.confirm(options.plugin, title, message, dialogOptions),
        );
      },
      select(title, selectOptions, dialogOptions): Promise<string | undefined> {
        return runPluginDialog(options, undefined, () =>
          options.dialogHost?.select(options.plugin, title, selectOptions, dialogOptions),
        );
      },
      input(title, placeholder, dialogOptions): Promise<string | undefined> {
        return runPluginDialog(options, undefined, () =>
          options.dialogHost?.input(options.plugin, title, placeholder, dialogOptions),
        );
      },
      editor(title, prefill, dialogOptions): Promise<string | undefined> {
        return runPluginDialog(options, undefined, () =>
          options.dialogHost?.editor(options.plugin, title, prefill, dialogOptions),
        );
      },
      addTip(text, tipOptions): Disposable {
        const disposable = options.runner.tips.register(options.plugin, text, tipOptions);
        options.runner.invalidateChrome();
        return disposable;
      },
      addChatBlock(block): string | undefined {
        const id = options.chatHost?.addBlock(options.plugin, block);
        if (id) options.invalidate();
        return id;
      },
      userMessageCount(threadId): number {
        return options.chatHost?.userMessageCount(threadId) ?? 0;
      },
      setEditorStatus(key, value): void {
        if (options.runner.slots.setEditorStatus(options.plugin, key, value)) {
          options.runner.invalidateChrome();
        }
      },
      showOverlay(key: string, widget: RelayOverlayWidget): RelayWidgetHandle {
        return setPluginWidget(options, key, { ...widget, placement: "overlay" })!;
      },
      setWidget(key, widget): RelayWidgetHandle | undefined {
        return setPluginWidget(options, key, widget);
      },
      setEditorStatusSegment(key, segment): void {
        options.runner.slots.setEditorStatusSegment(options.plugin, key, segment);
        options.runner.invalidateChrome();
      },
      setEditorFooterSegment(key, segment): void {
        options.runner.slots.setEditorFooterSegment(options.plugin, key, segment);
        options.runner.invalidateChrome();
      },
      registerEditorHeaderRenderer(renderer): Disposable {
        const disposable = options.runner.slots.registerEditorHeaderRenderer(options.plugin, renderer);
        options.runner.invalidateChrome();
        return invalidateChromeOnDispose(disposable, options.runner);
      },
      registerEditorFooterRenderer(renderer): Disposable {
        const disposable = options.runner.slots.registerEditorFooterRenderer(options.plugin, renderer);
        options.runner.invalidateChrome();
        return invalidateChromeOnDispose(disposable, options.runner);
      },
      registerEditorChromeElementRenderer(renderer): Disposable {
        const disposable = options.runner.slots.registerEditorChromeElementRenderer(options.plugin, renderer);
        options.runner.invalidateChrome();
        return invalidateChromeOnDispose(disposable, options.runner);
      },
      registerToolRenderer(renderer): Disposable {
        const disposable = options.runner.renderers.registerRenderer(options.plugin, renderer);
        options.invalidate();
        return disposable;
      },
      registerMessageRenderer(renderer): Disposable {
        const disposable = options.runner.renderers.registerMessageRenderer(options.plugin, renderer);
        options.invalidate();
        return disposable;
      },
    },
    editor: {
      configure(editorOptions) {
        const disposable = options.runner.editor.configure(options.plugin, editorOptions);
        options.invalidate();
        return disposable;
      },
      setTheme(theme) {
        const disposable = options.runner.editor.setTheme(options.plugin, theme);
        options.invalidate();
        return disposable;
      },
      addAutocompleteProvider(provider) {
        const disposable = options.runner.editor.addAutocompleteProvider(options.plugin, provider);
        options.invalidate();
        return disposable;
      },
      getText: () => options.editorHost?.getText() ?? "",
      setText: (text) => options.editorHost?.setText(text),
      insertText: (text) => options.editorHost?.insertText(text),
      attachImage: (path) => options.editorHost?.attachImage(path) ?? false,
      submit: (text) => options.editorHost?.submit(text) ?? Promise.resolve(),
    },
    input: {
      onBeforeSubmit(handler): Disposable {
        return options.runner.onPromptBeforeSubmit(options.plugin, handler);
      },
      addSystemReminder(provider): Disposable {
        return options.runner.addSystemReminder(options.plugin, provider);
      },
    },
    userBash: {
      onBeforeRun(handler): Disposable {
        return options.runner.onUserBashBeforeRun(options.plugin, handler);
      },
      onRun(handler): Disposable {
        return options.runner.onUserBashRun(options.plugin, handler);
      },
    },
    permissions: {
      onRequest(handler): Disposable {
        return options.runner.onPermissionRequest(options.plugin, handler);
      },
    },
    elicitation: {
      onRequest(handler): Disposable {
        return options.runner.onElicitationRequest(options.plugin, handler);
      },
    },
    commands: {
      register(name, command): Disposable {
        const disposable = options.runner.commands.register(options.plugin, name, command);
        options.invalidate();
        return disposable;
      },
      list() {
        return options.runner.commands.list().map((entry) => ({
          plugin: entry.plugin,
          name: entry.name,
          invocationName: entry.invocationName,
          ...(entry.command.description ? { description: entry.command.description } : {}),
          ...(entry.command.argumentPlaceholder ? { argumentPlaceholder: entry.command.argumentPlaceholder } : {}),
          ...(entry.diagnostics ? { diagnostics: entry.diagnostics } : {}),
        }));
      },
    },
    keybindings: {
      register(key, binding): Disposable {
        const disposable = options.runner.keybindings.register(options.plugin, key, binding);
        options.invalidate();
        return disposable;
      },
    },
    tools: {
      setDisplayPolicy(toolName, policy): Disposable {
        const disposable = options.runner.renderers.setDisplayPolicy(options.plugin, toolName, policy);
        options.invalidate();
        return disposable;
      },
      registerRenderer(renderer): Disposable {
        const disposable = options.runner.renderers.registerRenderer(options.plugin, renderer);
        options.invalidate();
        return disposable;
      },
    },
    agent: {
      get name() {
        return options.agentHost?.name() ?? "";
      },
      get profile() {
        return options.agentHost?.profile() ?? "default";
      },
      get sessionId() {
        return options.agentHost?.sessionId() ?? null;
      },
      isRunning: () => options.agentHost?.isRunning() ?? false,
      waitForIdle: () => options.agentHost?.waitForIdle() ?? Promise.resolve(),
      hasQueuedPrompts: () => options.agentHost?.hasQueuedPrompts() ?? false,
      supportsActiveTurnInput: () => options.agentHost?.supportsActiveTurnInput() ?? false,
      supportsSessionFork: () => options.agentHost?.supportsSessionFork?.() ?? false,
      supportsSessionDelete: () => options.agentHost?.supportsSessionDelete?.() ?? false,
      supportsSessionClose: () => options.agentHost?.supportsSessionClose?.() ?? false,
      addToCurrentTurn: (text) =>
        options.agentHost?.addToCurrentTurn(text) ??
        Promise.resolve({ accepted: false, reason: "No active agent host is available" }),
      forkSession: (forkOptions) =>
        options.agentHost?.forkSession?.(forkOptions) ?? Promise.resolve({ sessionId: null }),
      runHiddenPrompt: (sessionId, text) =>
        options.agentHost?.runHiddenPrompt?.(sessionId, text) ?? Promise.resolve(""),
      deleteSession: (sessionId) => options.agentHost?.deleteSession?.(sessionId) ?? Promise.resolve(),
      closeSession: (sessionId) => options.agentHost?.closeSession?.(sessionId) ?? Promise.resolve(),
      availableModes: () => options.agentHost?.availableModes() ?? [],
      availableModels: () => options.agentHost?.availableModels() ?? [],
      availableThinkingLevels: () => options.agentHost?.availableThinkingLevels() ?? [],
      prompt: (text, promptOptions) => options.agentHost?.prompt(text, promptOptions) ?? Promise.resolve(),
      cancel: () => options.agentHost?.cancel() ?? Promise.resolve(),
      restart: () => options.agentHost?.restart() ?? Promise.resolve(),
      newSession: (cwd) => options.agentHost?.newSession(cwd) ?? Promise.resolve(),
      loadSession: (sessionId, cwd) => options.agentHost?.loadSession(sessionId, cwd) ?? Promise.resolve(),
      setMode: (modeId) => options.agentHost?.setMode(modeId) ?? Promise.resolve(),
      setModel: (modelId) => options.agentHost?.setModel(modelId) ?? Promise.resolve(),
      setThinkingLevel: (level) => options.agentHost?.setThinkingLevel(level) ?? Promise.resolve(),
      setSessionModel: (sessionId, modelId) =>
        options.agentHost?.setSessionModel?.(sessionId, modelId) ?? Promise.resolve(),
      setSessionThinkingLevel: (sessionId, level) =>
        options.agentHost?.setSessionThinkingLevel?.(sessionId, level) ?? Promise.resolve(),
    },
    thread: {
      current: () => options.threadHost?.current() ?? null,
      list: () => options.threadHost?.list() ?? [],
      conversation: (threadId) => options.threadHost?.conversation?.(threadId) ?? null,
      conversationMarkdown: (threadId) => options.threadHost?.conversationMarkdown?.(threadId) ?? null,
      create: (createOptions) => options.threadHost?.create?.(createOptions) ?? Promise.resolve(null),
      ensureSession: (threadId) => options.threadHost?.ensureSession?.(threadId) ?? Promise.resolve(null),
      select: (threadId) => options.threadHost?.select(threadId) ?? Promise.resolve(),
      archive: (threadId) => options.threadHost?.archive(threadId) ?? Promise.resolve(),
    },
    acp: {
      supportsRawRequests: false,
      onSessionUpdate(handler): Disposable {
        return options.runner.on(options.plugin, "session:update", (event) => handler(event.update));
      },
      request(): Promise<unknown> {
        return Promise.reject(new Error("Raw ACP requests are not enabled"));
      },
    },
    mcp: {
      addServer(server: RelayMcpServerConfig, lifecycleOptions?: RelayMcpServerLifecycleOptions): Disposable {
        const disposable = options.runner.mcp.addServer(options.plugin, server);
        options.invalidate();
        handleMcpLifecycleChange(options, lifecycleOptions);
        return disposable;
      },
      removeServer(name, lifecycleOptions): boolean {
        const removed = options.runner.mcp.removeServer(options.plugin, name);
        if (removed) {
          options.invalidate();
          handleMcpLifecycleChange(options, lifecycleOptions);
        }
        return removed;
      },
      listServers: () => options.runner.mcp.listServers(),
      status: () => options.runner.mcp.status(),
    },
    storage: {
      get(key) {
        return options.runner.storageFor(options.plugin).get(key);
      },
      set(key, value) {
        options.runner.storageFor(options.plugin).set(key, value);
      },
      delete(key) {
        options.runner.storageFor(options.plugin).delete(key);
      },
      clear() {
        options.runner.storageFor(options.plugin).clear();
      },
      persisted: {
        get(key) {
          return options.runner.persistedStorageFor(options.plugin).get(key);
        },
        set(key, value) {
          options.runner.persistedStorageFor(options.plugin).set(key, value);
        },
        delete(key) {
          options.runner.persistedStorageFor(options.plugin).delete(key);
        },
        clear() {
          options.runner.persistedStorageFor(options.plugin).clear();
        },
      },
    },
    settings: {
      define(key, definition) {
        options.runner.defineSetting(options.plugin, key, definition);
      },
      get(key) {
        const definition = options.runner.getSettingDef(options.plugin, key);
        if (!definition) {
          options.runner.recordError(
            options.plugin,
            `relay.settings.get("${key}") called before relay.settings.define("${key}")`,
          );
          return "";
        }
        const raw = getPluginSettingRaw(options.plugin.id, options.plugin.name, key);
        return coercePluginSettingValue(raw, definition);
      },
      set(key, value) {
        setPluginSettingValue(options.plugin.id, options.plugin.name, key, value);
      },
    },
  };
  return activePluginApiProxy(api, () => options.runner.assertActive(options.plugin));
}
