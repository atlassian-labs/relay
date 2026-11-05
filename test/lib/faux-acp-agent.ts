import type {
  AcpClient,
  AcpClientCallbacks,
  AcpClientOptions,
  AcpLaunchOptions,
  AcpProcessExitEvent,
  AcpSessionInfo,
  LoadSessionHistoryOptions,
} from "../../src/acp/client";
import type {
  ElicitationSchema,
  SessionModeOption,
  SessionModelOption,
  SessionThinkingLevelOption,
} from "../../src/ui/state";
import type { SlashCommand } from "../../src/ui/autocomplete";
import type { ApprovalOption, ApprovalSelection } from "../../src/core/events";
import { promptInputText, type PromptInput } from "../../src/core/prompt-submission";
import type { AcpEvent } from "./acp-events";

export interface FauxAcpAgentOptions {
  connectDelayMs?: number;
  newSessionDelayMs?: number;
  rejectNewSession?: boolean;
  promptDelayMs?: number;
  rejectConcurrentPrompts?: boolean;
  tokensPerSecond?: number;
  chunkSize?: { min?: number; max?: number };
  capabilities?: {
    modelConfigId?: string | null;
    availableModels?: SessionModelOption[];
    currentModelId?: string;
    availableModes?: SessionModeOption[];
    currentModeId?: string;
    availableThinkingLevels?: SessionThinkingLevelOption[];
    currentThinkingLevel?: string;
    sessionFork?: boolean;
    sessionResume?: boolean;
    sessionClose?: boolean;
    configOptions?: Array<{
      id: string;
      name?: string;
      category?: string;
      type?: string;
      currentValue?: string;
      options?: Array<{ value?: string; id?: string; name?: string; description?: string }>;
    }>;
  };
  activeTurnInput?: boolean;
  activeTurnInputResponse?:
    | { accepted: boolean; reason?: string }
    | ((text: string) => { accepted: boolean; reason?: string } | Promise<{ accepted: boolean; reason?: string }>);
  availableCommands?: SlashCommand[];
  /** Publish commands while a session config change is in flight, before its partial capability result returns. */
  availableCommandsOnConfigChange?: SlashCommand[];
  sessions?: AcpSessionInfo[];
  loadEvents?: AcpEvent[];
  loadEventDelayTurns?: number;
  loadSessionHistoryDelayMs?: number;
  /** Stream history via onHistoryReady, then wait this long before answering the load (like an agent connecting MCP). */
  loadSessionResponseDelayMs?: number;
  /** With loadSessionResponseDelayMs: stream only this many leading updates early (default: all). */
  earlyLoadEventCount?: number;
  /** With loadSessionResponseDelayMs: fail the load after streaming history early. */
  rejectLoadAfterHistory?: boolean;
  rejectLoadSessionIds?: string[];
  setSessionModelDelayMs?: number;
  setSessionModelBlocker?: Promise<void>;
  disposeDelayMs?: number;
  settlePromptAfterCancelMs?: number;
  promptDelaySequenceMs?: number[];
  rejectCancel?: boolean;
  hangAfterCancel?: boolean;
  /** Keep selected 1-based prompt calls pending forever after they have been accepted. */
  hangPromptIndexes?: number[];
  /** Keep prompt() pending forever after it has been accepted. Useful for deterministic running-turn UI tests. */
  hangPrompts?: boolean;
}

export interface FauxPermissionRequest {
  toolCallId: string;
  toolName: string;
  preview?: string;
  options?: readonly ApprovalOption[];
}

export interface FauxElicitationRequest {
  mode: "form" | "url";
  message: string;
  requestedSchema?: ElicitationSchema;
  url?: string;
  elicitationId?: string;
  toolCallId?: string;
}

type FauxClientShape = Pick<
  AcpClient,
  | "sessionId"
  | "connect"
  | "newSession"
  | "listSessions"
  | "loadSession"
  | "loadSessionHistory"
  | "resumeSession"
  | "closeSession"
  | "prompt"
  | "supportsActiveTurnInput"
  | "sendActiveTurnInput"
  | "cancel"
  | "setSessionMode"
  | "setSessionModel"
  | "setSessionThinkingLevel"
  | "setSessionConfigOption"
  | "supportsSessionFork"
  | "supportsSessionList"
  | "supportsSessionLoad"
  | "supportsSessionResume"
  | "supportsSessionClose"
  | "forkSession"
  | "forceDispose"
  | "disposeAsync"
  | "dispose"
>;

class FauxAcpClientImpl implements FauxClientShape {
  callbacks: AcpClientCallbacks | null = null;
  private currentSessionId: string | null = null;
  connected = false;

  constructor(private readonly agent: FauxAcpAgentImpl) {}

  attach(callbacks: AcpClientCallbacks, _opts?: Partial<AcpLaunchOptions>) {
    this.callbacks = callbacks;
  }

  get sessionId(): string | null {
    return this.currentSessionId;
  }

  async connect(): Promise<void> {
    if (this.agent.options.connectDelayMs) await this.agent.delay(this.agent.options.connectDelayMs, false);
    this.connected = true;
  }

  async newSession(cwd: string): Promise<{ sessionId: string; configOptions?: unknown; modes?: unknown }> {
    if (this.agent.options.newSessionDelayMs) await this.agent.delay(this.agent.options.newSessionDelayMs, false);
    if (this.agent.options.rejectNewSession) throw new Error("Failed to start new session");
    this.agent.newSessions.push({ cwd });
    this.currentSessionId = `faux-session-${this.agent.newSessions.length}`;
    if (this.agent.availableCommands !== undefined) this.callbacks?.onAvailableCommands?.(this.agent.availableCommands);
    return {
      sessionId: this.currentSessionId,
      configOptions: this.agent.configOptionsCapability(this.currentSessionId),
      modes: this.agent.modesCapability(),
    };
  }

  async listSessions(): Promise<AcpSessionInfo[]> {
    return this.agent.sessions;
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    additionalDirectories?: readonly string[],
  ): Promise<{ sessionId?: string; configOptions?: unknown; modes?: unknown }> {
    const loaded = await this.loadSessionHistory(sessionId, cwd, additionalDirectories);
    for (const event of loaded.updates) this.agent.emit(event);
    return loaded.result;
  }

  async loadSessionHistory(
    sessionId: string,
    cwd: string,
    additionalDirectories?: readonly string[],
    options?: LoadSessionHistoryOptions,
  ): Promise<{
    result: { sessionId?: string; configOptions?: unknown; modes?: unknown };
    updates: readonly AcpEvent[];
  }> {
    this.agent.loadSessions.push(sessionId);
    this.agent.loadSessionRequests.push({ sessionId, cwd, additionalDirectories: [...(additionalDirectories ?? [])] });
    if (this.agent.options.rejectLoadSessionIds?.includes(sessionId)) {
      throw new Error(`Failed to load ${sessionId}`);
    }
    if (this.agent.options.loadSessionHistoryDelayMs) {
      await this.agent.delay(this.agent.options.loadSessionHistoryDelayMs, false);
    }
    this.currentSessionId = sessionId;
    const updates = await this.agent.loadEvents();
    if (this.agent.options.loadSessionResponseDelayMs) {
      const early = updates.slice(0, this.agent.options.earlyLoadEventCount ?? updates.length);
      if (early.length > 0) options?.onHistoryReady?.(early);
      await this.agent.delay(this.agent.options.loadSessionResponseDelayMs, false);
      if (this.agent.options.rejectLoadAfterHistory) throw new Error(`Failed to load ${sessionId}`);
    }
    return {
      result: {
        sessionId,
        configOptions: this.agent.configOptionsCapability(sessionId),
        modes: this.agent.modesCapability(),
      },
      updates,
    };
  }

  async resumeSession(
    sessionId: string,
    _cwd: string,
  ): Promise<{ sessionId?: string; configOptions?: unknown; modes?: unknown }> {
    this.agent.resumeSessions.push(sessionId);
    this.currentSessionId = sessionId;
    return {
      sessionId,
      configOptions: this.agent.configOptionsCapability(),
      modes: this.agent.modesCapability(),
    };
  }

  async closeSession(sessionId: string): Promise<void> {
    this.agent.closeSessions.push(sessionId);
    if (this.currentSessionId === sessionId) this.currentSessionId = null;
  }

  supportsActiveTurnInput(): boolean {
    return this.agent.options.activeTurnInput === true;
  }

  async sendActiveTurnInput(text: string, sessionId?: string): Promise<{ accepted: boolean; reason?: string }> {
    const activeSessionId = sessionId ?? this.currentSessionId;
    if (!this.connected) throw new Error("ACP client is disconnected");
    if (!activeSessionId) throw new Error("No active ACP session");
    this.agent.activeTurnInputs.push(text);
    const response = this.agent.options.activeTurnInputResponse;
    if (typeof response === "function") return response(text);
    return response ?? { accepted: true };
  }

  async prompt(input: PromptInput, sessionId?: string): Promise<unknown> {
    const activeSessionId = sessionId ?? this.currentSessionId;
    if (!this.connected) throw new Error("ACP client is disconnected");
    if (!activeSessionId) throw new Error("No active ACP session");
    if (this.agent.options.rejectConcurrentPrompts && this.agent.inFlightPrompts > 0) {
      throw new Error("Concurrent ACP prompt");
    }
    this.agent.inFlightPrompts += 1;
    try {
      this.agent.promptInputs.push(input);
      this.agent.prompts.push(promptInputText(input));
      const promptIndex = this.agent.prompts.length;
      this.agent.cancelled = false;
      if (this.agent.options.hangPrompts || this.agent.options.hangPromptIndexes?.includes(promptIndex)) {
        return await new Promise(() => {});
      }
      await this.agent.delayForPrompt();
      if (this.agent.cancelled) await this.agent.delayAfterCancel();
      if (this.agent.cancelled && this.agent.options.hangAfterCancel) {
        return await new Promise(() => {});
      }
      await this.agent.drainNextScript();
      return this.agent.nextPromptResponse();
    } finally {
      this.agent.inFlightPrompts -= 1;
    }
  }

  async cancel(_sessionId?: string): Promise<void> {
    this.agent.cancellations += 1;
    if (this.agent.options.rejectCancel) {
      throw new Error("ACP cancel failed");
    }
    this.agent.cancelled = true;
  }

  async setSessionMode(modeId: string, _sessionId?: string): Promise<void> {
    this.agent.modeChanges.push(modeId);
  }

  async setSessionModel(modelId: string, configId?: string, sessionId?: string): Promise<{ configOptions?: unknown }> {
    this.agent.modelChanges.push(modelId);
    this.agent.modelConfigChanges.push({ modelId, configId });
    if (this.agent.options.setSessionModelBlocker) await this.agent.options.setSessionModelBlocker;
    if (this.agent.options.setSessionModelDelayMs) {
      await this.agent.delay(this.agent.options.setSessionModelDelayMs, false);
    }
    return this.setSessionConfigOption("model", modelId, sessionId);
  }

  async setSessionConfigOption(
    configId: string,
    value: boolean | number | string,
    sessionId?: string,
  ): Promise<{ configOptions?: unknown }> {
    this.agent.configOptionChanges.push({ configId, value });
    this.agent.configOptionValues.set(configId, String(value));
    const activeSessionId = sessionId ?? this.currentSessionId;
    this.agent.setSessionConfigOptionValue(activeSessionId, configId, value);
    if (this.agent.options.availableCommandsOnConfigChange) {
      this.callbacks?.onAvailableCommands?.(this.agent.options.availableCommandsOnConfigChange);
    }
    return { configOptions: this.agent.configOptionsCapability(activeSessionId) };
  }

  async setSessionThinkingLevel(
    thinkingLevel: string,
    configId = "thought_level",
    sessionId?: string,
  ): Promise<{ configOptions?: unknown }> {
    this.agent.thinkingLevelChanges.push({ thinkingLevel, configId });
    return this.setSessionConfigOption(configId, thinkingLevel, sessionId);
  }

  supportsSessionFork(): boolean {
    return this.agent.options.capabilities?.sessionFork ?? false;
  }

  supportsSessionList(): boolean {
    return true;
  }

  supportsSessionLoad(): boolean {
    return true;
  }

  supportsSessionResume(): boolean {
    return this.agent.options.capabilities?.sessionResume ?? false;
  }

  supportsSessionClose(): boolean {
    return this.agent.options.capabilities?.sessionClose ?? false;
  }

  async forkSession(
    cwd: string,
  ): Promise<{ sessionId: string; configOptions?: unknown; modes?: unknown; availableCommands?: SlashCommand[] }> {
    if (!this.supportsSessionFork()) throw new Error("ACP agent did not advertise session/fork");
    const index = this.agent.forkedSessions.length + 1;
    const sessionId = `faux-forked-session-${index}`;
    this.agent.forkedSessions.push({ name: "fork", cwd, prompts: [] });
    return {
      sessionId,
      configOptions: this.agent.configOptionsCapability(),
      modes: this.agent.modesCapability(),
      availableCommands: this.agent.availableCommands,
    };
  }

  forceDispose(): void {
    this.agent.forceDisposals += 1;
    this.dispose();
  }

  async disposeAsync(): Promise<void> {
    this.agent.disposeStarts += 1;
    const delayMs = this.agent.options.disposeDelayMs;
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    this.dispose();
    this.agent.disposals += 1;
  }

  dispose(): void {
    this.connected = false;
    this.currentSessionId = null;
  }
}

class FauxAcpAgentImpl {
  readonly options: FauxAcpAgentOptions;
  readonly client: AcpClient;
  readonly clientImpl: FauxAcpClientImpl;
  readonly availableCommands: SlashCommand[] | undefined;
  readonly sessions: AcpSessionInfo[];

  prompts: string[] = [];
  promptInputs: PromptInput[] = [];
  activeTurnInputs: string[] = [];
  cancellations = 0;
  newSessions: Array<{ cwd: string }> = [];
  forkedSessions: Array<{ name: string; cwd: string; prompts: string[] }> = [];
  loadSessions: string[] = [];
  loadSessionRequests: Array<{ sessionId: string; cwd: string; additionalDirectories: string[] }> = [];
  resumeSessions: string[] = [];
  closeSessions: string[] = [];
  inFlightPrompts = 0;
  modeChanges: string[] = [];
  modelChanges: string[] = [];
  modelConfigChanges: Array<{ modelId: string; configId?: string }> = [];
  thinkingLevelChanges: Array<{ thinkingLevel: string; configId?: string }> = [];
  configOptionChanges: Array<{ configId: string; value: boolean | number | string }> = [];
  configOptionValues = new Map<string, string>();
  launchOptions: Partial<AcpClientOptions>[] = [];
  private readonly sessionConfigOptionValues = new Map<string, Map<string, string>>();
  disposeStarts = 0;
  forceDisposals = 0;
  disposals = 0;
  cancelled = false;

  private promptCount = 0;
  private scripts: Array<{ events: AcpEvent[]; response?: unknown }> = [];
  private defaultResponse: unknown = {};

  constructor(options: FauxAcpAgentOptions = {}) {
    this.options = options;
    this.availableCommands = options.availableCommands;
    this.sessions = options.sessions ?? [];
    this.clientImpl = new FauxAcpClientImpl(this);
    this.client = this.clientImpl as unknown as AcpClient;
  }

  attach(callbacks: AcpClientCallbacks, opts?: Partial<AcpClientOptions>): AcpClient {
    this.clientImpl.attach(callbacks, opts);
    if (opts) this.launchOptions.push(opts);
    return this.client;
  }

  factory(): (callbacks: AcpClientCallbacks, opts: AcpClientOptions) => AcpClient {
    return (callbacks, opts) => this.attach(callbacks, opts);
  }

  script(events: AcpEvent[], response?: unknown): void {
    this.scripts.push({ events, response });
  }

  setDefaultResponse(response: unknown): void {
    this.defaultResponse = response;
  }

  emit(event: AcpEvent): void {
    this.emitWithEnvelope(event);
  }

  emitWithEnvelope(event: AcpEvent, envelope?: Parameters<AcpClientCallbacks["onSessionUpdate"]>[1]): void {
    this.clientImpl.callbacks?.onSessionUpdate(event, envelope);
    if (event.sessionUpdate === "available_commands_update") {
      this.clientImpl.callbacks?.onAvailableCommands?.(formatCommands(event.availableCommands));
    }
  }

  async loadEvents(): Promise<readonly AcpEvent[]> {
    const events = this.options.loadEvents ?? [];
    const delayTurns = this.options.loadEventDelayTurns ?? 0;
    if (delayTurns > 0) await this.delayLoadEvents(delayTurns);
    return events;
  }

  private async delayLoadEvents(turns: number): Promise<void> {
    if (turns <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await this.delayLoadEvents(turns - 1);
  }

  async requestPermission(req: FauxPermissionRequest): Promise<ApprovalSelection> {
    const callbacks = this.clientImpl.callbacks;
    if (!callbacks) throw new Error("Faux ACP client is not attached");
    return await new Promise((resolve) => {
      callbacks.onPermissionRequest({ ...req, options: req.options ?? [], respond: resolve });
    });
  }

  async requestElicitation(req: FauxElicitationRequest): Promise<unknown> {
    const callbacks = this.clientImpl.callbacks;
    if (!callbacks) throw new Error("Faux ACP client is not attached");
    const onElicitationRequest = callbacks.onElicitationRequest;
    if (!onElicitationRequest) return { action: "cancel" };
    return await new Promise((resolve) => {
      onElicitationRequest({ ...req, respond: resolve });
    });
  }

  exit(event: Partial<AcpProcessExitEvent> = {}): void {
    this.clientImpl.callbacks?.onProcessExit?.({
      code: 0,
      expected: false,
      reason: "exit",
      transport: "stdio",
      ...event,
    });
    this.clientImpl.dispose();
  }

  disconnect(reason: "exit" | "crash" = "exit"): void {
    this.exit(reason === "crash" ? { code: 1 } : { code: 0 });
  }

  async delayForPrompt(): Promise<void> {
    const ms = this.options.promptDelaySequenceMs?.[this.promptCount++] ?? this.options.promptDelayMs;
    if (!ms) return;
    await this.delay(ms);
  }

  async delayAfterCancel(): Promise<void> {
    const ms = this.options.settlePromptAfterCancelMs;
    if (!ms) return;
    await this.delay(ms, false);
  }

  async drainNextScript(): Promise<void> {
    const script = this.scripts.shift();
    if (!script) return;
    for (const event of expandEvents(script.events, this.options.chunkSize)) {
      if (this.cancelled) break;
      await this.delayFor(event);
      if (this.cancelled) break;
      this.emit(event);
    }
    if (script.response !== undefined) this.defaultResponse = script.response;
  }

  nextPromptResponse(): unknown {
    return this.defaultResponse;
  }

  setSessionConfigOptionValue(sessionId: string | null, configId: string, value: boolean | number | string): void {
    if (!sessionId) return;
    const values = this.sessionConfigOptionValues.get(sessionId) ?? new Map<string, string>();
    values.set(configId, String(value));
    this.sessionConfigOptionValues.set(sessionId, values);
  }

  configOptionsCapability(sessionId?: string | null) {
    const values = sessionId ? this.sessionConfigOptionValues.get(sessionId) : undefined;
    const modelConfigId = this.options.capabilities?.modelConfigId;
    const configuredOptions = this.options.capabilities?.configOptions ?? [];
    const hasConfiguredThinkingOption = configuredOptions.some(
      (option) => option.id === "thought_level" || option.category === "thought_level",
    );
    return [
      {
        ...(modelConfigId === null ? {} : { id: modelConfigId ?? "model" }),
        category: "model",
        type: "select",
        currentValue: values?.get("model") ?? this.options.capabilities?.currentModelId ?? "",
        options: (this.options.capabilities?.availableModels ?? []).map((model) => ({
          id: model.modelId,
          name: model.name,
          description: model.description,
        })),
      },
      ...(!hasConfiguredThinkingOption && this.options.capabilities?.availableThinkingLevels
        ? [
            {
              id: "thought_level",
              category: "thought_level",
              type: "select",
              currentValue: values?.get("thought_level") ?? this.options.capabilities.currentThinkingLevel ?? "",
              options: this.options.capabilities.availableThinkingLevels.map((thinkingLevel) => ({
                value: thinkingLevel.id,
                name: thinkingLevel.name,
                description: thinkingLevel.description,
              })),
            },
          ]
        : []),
      ...configuredOptions.map((option) => ({
        ...option,
        currentValue: values?.get(option.id) ?? option.currentValue,
      })),
    ];
  }

  modesCapability() {
    return {
      availableModes: this.options.capabilities?.availableModes ?? [],
      currentModeId: this.options.capabilities?.currentModeId,
    };
  }

  private async delayFor(event: AcpEvent): Promise<void> {
    const tokensPerSecond = this.options.tokensPerSecond;
    if (!tokensPerSecond) {
      await Promise.resolve();
      return;
    }
    const text = textContentFromEvent(event)?.text ?? "";
    const ms = Math.max(1, (Math.max(text.length, 1) / tokensPerSecond) * 1000);
    await this.delay(ms);
  }

  async delay(ms: number, stopOnCancel = true): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (stopOnCancel && this.cancelled) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
    }
  }
}

export type FauxAcpAgent = FauxAcpAgentImpl;

export function createFauxAcpAgent(opts?: FauxAcpAgentOptions): FauxAcpAgent {
  return new FauxAcpAgentImpl(opts);
}

function expandEvents(events: AcpEvent[], chunkSize?: { min?: number; max?: number }): AcpEvent[] {
  if (!chunkSize) return events;
  return events.flatMap((event) => {
    const textContent = textContentFromEvent(event);
    if (!textContent) {
      return [event];
    }
    const { content, text } = textContent;
    const max = Math.max(1, chunkSize.max ?? chunkSize.min ?? text.length);
    const chunks: AcpEvent[] = [];
    for (let i = 0; i < text.length; i += max) {
      chunks.push({ ...event, content: { ...content, text: text.slice(i, i + max) } } as AcpEvent);
    }
    return chunks;
  });
}

function textContentFromEvent(
  event: AcpEvent,
): { readonly content: Record<string, unknown>; readonly text: string } | null {
  if (event.sessionUpdate !== "agent_message_chunk" && event.sessionUpdate !== "agent_thought_chunk") return null;
  const content = (event as unknown as Record<string, unknown>).content;
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const contentRecord = content as Record<string, unknown>;
  return typeof contentRecord.text === "string" ? { content: contentRecord, text: contentRecord.text } : null;
}

function formatCommands(commands: unknown): SlashCommand[] {
  if (!Array.isArray(commands)) return [];
  return commands
    .map((command) => {
      if (!command || typeof command !== "object") return null;
      const data = command as Record<string, unknown>;
      const name = typeof data.name === "string" ? data.name.replace(/^\//, "") : "";
      if (!name) return null;
      return { name, description: typeof data.description === "string" ? data.description : "" };
    })
    .filter((command): command is SlashCommand => command !== null);
}
