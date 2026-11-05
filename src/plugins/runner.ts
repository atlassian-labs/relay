import { Effect } from "effect";
import { RelayError } from "../effect/errors";
import { runEffect } from "../effect/runtime";
import { createRelayPluginApi } from "./api";
import { RelayPluginCommandRegistry } from "./commands";
import { RelayPluginEditorRegistry } from "./editor";
import { RelayPluginEventBus } from "./events";
import { RelayPluginKeybindingRegistry } from "./keybindings";
import { RelayPluginMcpRegistry } from "./mcp";
import { RelayPluginRendererRegistry } from "./renderers";
import { RelayPluginSlotRegistry } from "./slots";
import { PersistentPluginStorage } from "./storage";
import { RelayPluginTipRegistry } from "./tips";
import type {
  Disposable,
  LoadedRelayPlugin,
  RelayElicitationRequest,
  RelayElicitationRequestHandler,
  RelayElicitationRequestHandlerResult,
  RelayMcpServerConfig,
  RelayPermissionRequest,
  RelayPermissionRequestHandler,
  RelayPermissionRequestHandlerResult,
  RelayPromptBeforeSubmitHandler,
  RelayPromptBeforeSubmitResult,
  RelaySystemReminderContext,
  RelaySystemReminderProvider,
  RelaySystemReminderResult,
  RelayEventHandler,
  RelayPluginActiveTurnInputResult,
  RelayPluginAgentPromptOptions,
  RelayPluginChatBlockInput,
  RelayPluginForkSessionOptions,
  RelayPluginSessionResult,
  RelayPluginDiagnostic,
  RelayPluginEvent,
  RelayPluginInfo,
  RelayConversationSnapshot,
  RelayPluginModeInfo,
  RelayPluginModelInfo,
  RelayPluginSettingDefinition,
  RelayPluginThreadCreateOptions,
  RelayPluginThreadInfo,
  RelayPluginThreadSessionInfo,
  RelayPluginToastVariant,
  RelayWidgetPlacement,
  RelayDiffOverlayOptions,
  RelayPluginConfirmDialogOptions,
  RelayPluginEditorDialogOptions,
  RelayPluginInputDialogOptions,
  RelayPluginSelectDialogOptions,
  RelayPluginSelectOption,
  RelayUserBashBeforeRunHandler,
  RelayUserBashEvent,
  RelayUserBashRunEvent,
  RelayUserBashRunHandler,
  RelayUserBashResult,
} from "./types";

export interface PluginRunnerOptions {
  readonly cwd: string;
  readonly toast?: (message: string, variant?: RelayPluginToastVariant, durationMs?: number) => void;
  readonly invalidate?: () => void;
  readonly invalidateChrome?: () => void;
  readonly invalidateWidget?: (placement: RelayWidgetPlacement) => void;
  readonly invalidateWidgetInteraction?: () => void;
  /** Maximum time to wait for each plugin's shutdown lifecycle before continuing. */
  readonly lifecycleTimeoutMs?: number;
  readonly editor?: {
    getText(): string;
    setText(text: string): void;
    insertText(text: string): void;
    attachImage(path: string): boolean;
    submit(text?: string): Promise<void>;
  };
  readonly chat?: {
    addBlock(plugin: RelayPluginInfo, block: RelayPluginChatBlockInput): string | undefined;
    userMessageCount(threadId?: string): number;
  };
  readonly agent?: {
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
  readonly thread?: {
    current(): RelayPluginThreadInfo | null;
    list(): readonly RelayPluginThreadInfo[];
    conversation?(threadId?: string): RelayConversationSnapshot | null;
    conversationMarkdown?(threadId?: string): string | null;
    create?(options?: RelayPluginThreadCreateOptions): Promise<RelayPluginThreadInfo | null>;
    ensureSession?(threadId?: string): Promise<RelayPluginThreadSessionInfo | null>;
    select(threadId: string): Promise<void>;
    archive(threadId: string): Promise<void>;
  };
  readonly diffOverlay?: {
    open(plugin: RelayPluginInfo, options: RelayDiffOverlayOptions): Disposable;
    clearPlugin(plugin: RelayPluginInfo): void;
  };
  readonly dialogs?: {
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
    clearPlugin(plugin: RelayPluginInfo): void;
  };
}

type PluginRuntime = {
  readonly info: RelayPluginInfo;
  readonly disposables: Disposable[];
};

type RelayPermissionPolicyDecision = {
  readonly plugin: RelayPluginInfo;
  readonly result: Exclude<RelayPermissionRequestHandlerResult, void | null | { readonly action: "continue" }>;
};

type RelayElicitationPolicyDecision = {
  readonly plugin: RelayPluginInfo;
  readonly result: Extract<RelayElicitationRequestHandlerResult, { readonly action: "respond" }>;
};

export class PluginRunner {
  private readonly eventBus = new RelayPluginEventBus();
  private readonly runtimes = new Map<string, PluginRuntime>();
  private readonly collectedDiagnostics: RelayPluginDiagnostic[] = [];
  private readonly promptInterceptors = new Map<
    string,
    { readonly plugin: RelayPluginInfo; readonly handler: RelayPromptBeforeSubmitHandler }
  >();
  private readonly systemReminderProviders = new Map<
    string,
    { readonly plugin: RelayPluginInfo; readonly provider: RelaySystemReminderProvider }
  >();
  private readonly userBashBeforeRunHandlers = new Map<
    string,
    { readonly plugin: RelayPluginInfo; readonly handler: RelayUserBashBeforeRunHandler }
  >();
  private readonly userBashRunHandlers = new Map<
    string,
    { readonly plugin: RelayPluginInfo; readonly handler: RelayUserBashRunHandler }
  >();
  private readonly permissionRequestHandlers = new Map<
    string,
    { readonly plugin: RelayPluginInfo; readonly handler: RelayPermissionRequestHandler }
  >();
  private readonly elicitationRequestHandlers = new Map<
    string,
    { readonly plugin: RelayPluginInfo; readonly handler: RelayElicitationRequestHandler }
  >();
  private readonly pluginStorage = new Map<string, Map<string, unknown>>();
  private readonly pluginPersistedStorage = new Map<string, PersistentPluginStorage>();
  private readonly pluginSettingDefs = new Map<string, Map<string, RelayPluginSettingDefinition>>();
  private disposed = false;
  readonly commands = new RelayPluginCommandRegistry();
  readonly slots = new RelayPluginSlotRegistry();
  readonly editor = new RelayPluginEditorRegistry();
  readonly keybindings = new RelayPluginKeybindingRegistry();
  readonly renderers = new RelayPluginRendererRegistry();
  readonly mcp = new RelayPluginMcpRegistry();
  readonly tips = new RelayPluginTipRegistry();

  constructor(private readonly options: PluginRunnerOptions) {}

  get diagnostics(): readonly RelayPluginDiagnostic[] {
    return this.collectedDiagnostics;
  }

  assertActive(plugin?: RelayPluginInfo): void {
    if (!this.disposed) return;
    const name = plugin?.name ? ` "${plugin.name}"` : "";
    const message = `Relay plugin${name} context is stale after reload or shutdown. Do not use APIs captured from an old plugin runtime.`;
    throw new Error(message); // effect-shape-allow: stale imperative plugin APIs must fail synchronously.
  }

  async register(plugin: LoadedRelayPlugin): Promise<boolean> {
    if (this.disposed) return false;
    const runtime: PluginRuntime = { info: plugin.info, disposables: [] };
    this.runtimes.set(plugin.info.id, runtime);
    const api = createRelayPluginApi({
      cwd: this.options.cwd,
      plugin: plugin.info,
      runner: this,
      toast: (message, variant, durationMs) => this.options.toast?.(message, variant, durationMs),
      invalidate: () => this.invalidate(),
      editorHost: this.options.editor,
      chatHost: this.options.chat,
      agentHost: this.options.agent,
      threadHost: this.options.thread,
      diffOverlayHost: this.options.diffOverlay,
      dialogHost: this.options.dialogs,
    });
    try {
      await plugin.factory(api);
      return true;
    } catch (error) {
      this.recordError(plugin.info, "Plugin setup failed", error);
      return false;
    }
  }

  on<E extends RelayPluginEvent["type"]>(plugin: RelayPluginInfo, type: E, handler: RelayEventHandler<E>): Disposable {
    if (this.disposed) return { dispose: () => undefined };
    const disposable = this.eventBus.on(plugin.id, type, handler);
    this.runtimes.get(plugin.id)?.disposables.push(disposable);
    return disposable;
  }

  onPromptBeforeSubmit(plugin: RelayPluginInfo, handler: RelayPromptBeforeSubmitHandler): Disposable {
    const key = `${plugin.id}:prompt:${this.promptInterceptors.size + 1}`;
    this.promptInterceptors.set(key, { plugin, handler });
    return { dispose: () => this.promptInterceptors.delete(key) };
  }

  addSystemReminder(plugin: RelayPluginInfo, provider: RelaySystemReminderProvider): Disposable {
    const key = `${plugin.id}:system-reminder:${this.systemReminderProviders.size + 1}`;
    this.systemReminderProviders.set(key, { plugin, provider });
    return { dispose: () => this.systemReminderProviders.delete(key) };
  }

  onUserBashBeforeRun(plugin: RelayPluginInfo, handler: RelayUserBashBeforeRunHandler): Disposable {
    const key = `${plugin.id}:user-bash-before:${this.userBashBeforeRunHandlers.size + 1}`;
    this.userBashBeforeRunHandlers.set(key, { plugin, handler });
    return { dispose: () => this.userBashBeforeRunHandlers.delete(key) };
  }

  onUserBashRun(plugin: RelayPluginInfo, handler: RelayUserBashRunHandler): Disposable {
    const key = `${plugin.id}:user-bash-run:${this.userBashRunHandlers.size + 1}`;
    this.userBashRunHandlers.set(key, { plugin, handler });
    return { dispose: () => this.userBashRunHandlers.delete(key) };
  }

  onPermissionRequest(plugin: RelayPluginInfo, handler: RelayPermissionRequestHandler): Disposable {
    const key = `${plugin.id}:permission:${this.permissionRequestHandlers.size + 1}`;
    this.permissionRequestHandlers.set(key, { plugin, handler });
    return { dispose: () => this.permissionRequestHandlers.delete(key) };
  }

  onElicitationRequest(plugin: RelayPluginInfo, handler: RelayElicitationRequestHandler): Disposable {
    const key = `${plugin.id}:elicitation:${this.elicitationRequestHandlers.size + 1}`;
    this.elicitationRequestHandlers.set(key, { plugin, handler });
    return { dispose: () => this.elicitationRequestHandlers.delete(key) };
  }

  async beforeSubmit(text: string, source: "user" | "plugin" | "queue"): Promise<{ text: string; handled: boolean }> {
    let current = text;
    await this.emit({ type: "prompt:beforeSubmit", text: current, source });
    for (const entry of this.promptInterceptors.values()) {
      try {
        const result = await entry.handler({ text: current, source });
        const applied = applyPromptInterceptorResult(current, result);
        current = applied.text;
        if (applied.handled) return { text: current, handled: true };
      } catch (error) {
        this.recordError(entry.plugin, "Prompt interceptor failed", error);
      }
    }
    return { text: current, handled: false };
  }

  async systemReminders(ctx: RelaySystemReminderContext): Promise<string[]> {
    const reminders: string[] = [];
    for (const entry of this.systemReminderProviders.values()) {
      try {
        const result = typeof entry.provider === "function" ? await entry.provider(ctx) : entry.provider;
        appendSystemReminderResult(reminders, result);
      } catch (error) {
        this.recordError(entry.plugin, "System reminder provider failed", error);
      }
    }
    return reminders;
  }

  async beforeUserBashRun(event: RelayUserBashEvent): Promise<RelayUserBashEvent> {
    let current = event;
    for (const entry of this.userBashBeforeRunHandlers.values()) {
      try {
        const result = await entry.handler(current);
        current = applyUserBashBeforeRunResult(current, result);
      } catch (error) {
        this.recordError(entry.plugin, "User bash before-run hook failed", error);
      }
    }
    return current;
  }

  async runUserBash(event: RelayUserBashRunEvent): Promise<RelayUserBashResult | null> {
    for (const entry of this.userBashRunHandlers.values()) {
      try {
        const result = await entry.handler(event);
        if (result) return result;
      } catch (error) {
        this.recordError(entry.plugin, "User bash run hook failed", error);
      }
    }
    return null;
  }

  async handlePermissionRequest(request: RelayPermissionRequest): Promise<RelayPermissionPolicyDecision | null> {
    for (const entry of this.permissionRequestHandlers.values()) {
      try {
        const result = await entry.handler(request);
        if (!isPermissionPolicyDecision(result)) continue;
        return { plugin: entry.plugin, result };
      } catch (error) {
        this.recordError(entry.plugin, "Permission request hook failed", error);
      }
    }
    return null;
  }

  async handleElicitationRequest(request: RelayElicitationRequest): Promise<RelayElicitationPolicyDecision | null> {
    for (const entry of this.elicitationRequestHandlers.values()) {
      try {
        const result = await entry.handler(request);
        if (!isElicitationPolicyDecision(result)) continue;
        return { plugin: entry.plugin, result };
      } catch (error) {
        this.recordError(entry.plugin, "Elicitation request hook failed", error);
      }
    }
    return null;
  }

  storageFor(plugin: RelayPluginInfo): Map<string, unknown> {
    const existing = this.pluginStorage.get(plugin.id);
    if (existing) return existing;
    const created = new Map<string, unknown>();
    this.pluginStorage.set(plugin.id, created);
    return created;
  }

  persistedStorageFor(plugin: RelayPluginInfo): PersistentPluginStorage {
    const existing = this.pluginPersistedStorage.get(plugin.id);
    if (existing) return existing;
    const created = new PersistentPluginStorage({
      plugin,
      recordError: (message, cause) => this.recordError(plugin, message, cause),
    });
    this.pluginPersistedStorage.set(plugin.id, created);
    return created;
  }

  defineSetting(plugin: RelayPluginInfo, key: string, definition: RelayPluginSettingDefinition): void {
    let defs = this.pluginSettingDefs.get(plugin.id);
    if (!defs) {
      defs = new Map();
      this.pluginSettingDefs.set(plugin.id, defs);
    }
    defs.set(key, definition);
  }

  getSettingDef(plugin: RelayPluginInfo, key: string): RelayPluginSettingDefinition | undefined {
    return this.pluginSettingDefs.get(plugin.id)?.get(key);
  }

  allPluginSettings(): Array<{ plugin: RelayPluginInfo; key: string; definition: RelayPluginSettingDefinition }> {
    const result: Array<{ plugin: RelayPluginInfo; key: string; definition: RelayPluginSettingDefinition }> = [];
    for (const [pluginId, defs] of this.pluginSettingDefs) {
      const runtime = this.runtimes.get(pluginId);
      if (!runtime) continue;
      for (const [key, definition] of defs) {
        result.push({ plugin: runtime.info, key, definition });
      }
    }
    return result;
  }

  mcpServers(): readonly RelayMcpServerConfig[] {
    return this.mcp.listServers();
  }

  invalidate(): void {
    this.options.invalidate?.();
  }

  invalidateChrome(): void {
    this.options.invalidateChrome?.();
  }

  invalidateWidgets(placements: Iterable<RelayWidgetPlacement>, interactionChanged = false): void {
    for (const placement of new Set(placements)) this.options.invalidateWidget?.(placement);
    if (interactionChanged) this.options.invalidateWidgetInteraction?.();
  }

  /**
   * Invokes one plugin event handler and records failures without interrupting the remaining handlers.
   * Error handlers do not emit another `plugin:error` event, which prevents recursive failure reporting.
   */
  private async invokeEventHandler(
    runtime: PluginRuntime,
    event: RelayPluginEvent,
    handler: RelayEventHandler<RelayPluginEvent["type"]>,
  ): Promise<void> {
    try {
      await handler(event);
    } catch (error) {
      this.recordError(runtime.info, `Plugin handler failed for ${event.type}`, error, {
        emit: event.type !== "plugin:error",
      });
    }
  }

  hasListeners(types: readonly RelayPluginEvent["type"][]): boolean {
    return this.eventBus.hasAny(types);
  }

  async emit(event: RelayPluginEvent): Promise<void> {
    if (this.disposed && event.type !== "plugin:error") return;
    const entries = this.eventBus.entries(event.type);
    for (const entry of entries) {
      const runtime = this.runtimes.get(entry.pluginId);
      if (!runtime) continue;
      await this.invokeEventHandler(runtime, event, entry.handler);
    }
  }

  /**
   * Dispatches an ordered lifecycle sequence serially within each plugin while running plugins concurrently.
   * This lets responsive plugins finish their lifecycle hooks even when another plugin blocks indefinitely.
   *
   * @param events - Lifecycle events to deliver in order to each plugin.
   */
  async emitLifecycleSequenceByPlugin(events: readonly RelayPluginEvent[]): Promise<void> {
    if (this.disposed) return;
    const timeoutMs = this.options.lifecycleTimeoutMs ?? 5000;
    const dispatch = async (runtime: PluginRuntime): Promise<void> => {
      for (const event of events) {
        const entries = this.eventBus.entries(event.type).filter((entry) => entry.pluginId === runtime.info.id);
        for (const entry of entries) {
          if (this.disposed) return;
          await this.invokeEventHandler(runtime, event, entry.handler);
        }
      }
    };
    const recordTimeout = (runtime: PluginRuntime): void => {
      this.recordError(runtime.info, `Plugin lifecycle timed out after ${timeoutMs}ms`, undefined, { emit: false });
    };
    await runEffect(
      Effect.forEach(
        [...this.runtimes.values()],
        (runtime) =>
          Effect.gen(function* () {
            const outcome = yield* Effect.race(
              Effect.tryPromise({
                try: () => dispatch(runtime),
                catch: (cause) => new RelayError({ message: "Plugin lifecycle dispatch failed", cause }),
              }).pipe(Effect.as("complete" as const)),
              Effect.sleep(timeoutMs).pipe(Effect.as("timeout" as const)),
            );
            if (outcome === "timeout") recordTimeout(runtime);
          }),
        { concurrency: "unbounded" },
      ),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const runtime of this.runtimes.values()) {
      for (const disposable of runtime.disposables.toReversed()) {
        try {
          disposable.dispose();
        } catch (error) {
          this.recordError(runtime.info, "Plugin disposable failed", error);
        }
      }
      this.eventBus.clearPlugin(runtime.info.id);
      this.commands.clearPlugin(runtime.info.id);
      this.slots.clearPlugin(runtime.info.id);
      this.editor.clearPlugin(runtime.info.id);
      this.keybindings.clearPlugin(runtime.info.id);
      this.renderers.clearPlugin(runtime.info.id);
      this.mcp.clearPlugin(runtime.info.id);
      this.tips.clearPlugin(runtime.info.id);
      this.options.diffOverlay?.clearPlugin(runtime.info);
      this.options.dialogs?.clearPlugin(runtime.info);
      this.pluginPersistedStorage.delete(runtime.info.id);
      this.pluginSettingDefs.delete(runtime.info.id);
      for (const key of [...this.promptInterceptors.keys()]) {
        if (key.startsWith(`${runtime.info.id}:`)) this.promptInterceptors.delete(key);
      }
      for (const key of [...this.systemReminderProviders.keys()]) {
        if (key.startsWith(`${runtime.info.id}:`)) this.systemReminderProviders.delete(key);
      }
      for (const key of [...this.userBashBeforeRunHandlers.keys()]) {
        if (key.startsWith(`${runtime.info.id}:`)) this.userBashBeforeRunHandlers.delete(key);
      }
      for (const key of [...this.userBashRunHandlers.keys()]) {
        if (key.startsWith(`${runtime.info.id}:`)) this.userBashRunHandlers.delete(key);
      }
      for (const key of [...this.permissionRequestHandlers.keys()]) {
        if (key.startsWith(`${runtime.info.id}:`)) this.permissionRequestHandlers.delete(key);
      }
      for (const key of [...this.elicitationRequestHandlers.keys()]) {
        if (key.startsWith(`${runtime.info.id}:`)) this.elicitationRequestHandlers.delete(key);
      }
    }
    this.eventBus.clear();
    this.commands.clear();
    this.slots.clear();
    this.editor.clear();
    this.keybindings.clear();
    this.renderers.clear();
    this.mcp.clear();
    this.tips.clear();
    this.promptInterceptors.clear();
    this.systemReminderProviders.clear();
    this.userBashBeforeRunHandlers.clear();
    this.userBashRunHandlers.clear();
    this.permissionRequestHandlers.clear();
    this.elicitationRequestHandlers.clear();
    this.pluginPersistedStorage.clear();
    this.pluginSettingDefs.clear();
    this.runtimes.clear();
  }

  recordError(
    plugin: RelayPluginInfo,
    message: string,
    cause?: unknown,
    options: { readonly emit?: boolean } = {},
  ): void {
    const diagnostic: RelayPluginDiagnostic = {
      plugin,
      message: cause === undefined ? message : `${message}: ${formatPluginError(cause)}`,
      cause,
    };
    this.collectedDiagnostics.push(diagnostic);
    try {
      this.options.toast?.(diagnostic.message, "error", 6000);
    } catch {
      // Diagnostic observers must not interrupt plugin dispatch or shutdown cleanup.
    }
    if (this.disposed || options.emit === false) return;
    void this.emit({ type: "plugin:error", plugin, error: diagnostic.message });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPermissionPolicyDecision(
  result: RelayPermissionRequestHandlerResult,
): result is Exclude<RelayPermissionRequestHandlerResult, void | null | { readonly action: "continue" }> {
  if (!isRecord(result)) return false;
  switch (result.action) {
    case "deny":
      return result.reason === undefined || typeof result.reason === "string";
    case "approve":
      return result.optionId === undefined || typeof result.optionId === "string";
    case "select":
      return typeof result.optionId === "string";
    case "continue":
    default:
      return false;
  }
}

function isElicitationPolicyDecision(
  result: RelayElicitationRequestHandlerResult,
): result is Extract<RelayElicitationRequestHandlerResult, { readonly action: "respond" }> {
  if (!isRecord(result) || result.action !== "respond" || !isRecord(result.response)) return false;
  switch (result.response.action) {
    case "accept":
      return isRecord(result.response.content);
    case "decline":
    case "cancel":
      return true;
    default:
      return false;
  }
}

function applyPromptInterceptorResult(
  text: string,
  result: RelayPromptBeforeSubmitResult,
): { text: string; handled: boolean } {
  if (result === undefined) return { text, handled: false };
  if (result === false) return { text, handled: true };
  if (typeof result === "string") return { text: result, handled: false };
  return { text: result.text ?? text, handled: result.handled === true };
}

function appendSystemReminderResult(reminders: string[], result: RelaySystemReminderResult): void {
  if (!result) return;
  const values = typeof result === "string" ? [result] : result;
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) reminders.push(trimmed);
  }
}

function applyUserBashBeforeRunResult(
  event: RelayUserBashEvent,
  result: Awaited<ReturnType<RelayUserBashBeforeRunHandler>>,
): RelayUserBashEvent {
  if (!result) return event;
  return {
    ...event,
    command: result.command ?? event.command,
    cwd: result.cwd ?? event.cwd,
    env: result.env ? { ...event.env, ...result.env } : event.env,
  };
}

function formatPluginError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
