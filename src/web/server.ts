import * as path from "node:path";
import { Effect } from "effect";
import { readdirSync, statSync } from "../platform/fs";
import { spawn } from "../platform/process";
import { clearTimer, isoNow, nowMs, setTimer, type TimerHandle } from "../platform/time";
import { uuid } from "../platform/crypto";
import { startLiveSessionControlServer, type LiveSessionControlServer } from "../platform/live-session-control";
import { getChildSessionReminderTemplate, getConfig, listAvailableAgentNames } from "../config";
import type { AgentBehaviorProfile } from "../acp/agent-profile";
import { AcpClient, type AcpClientCallbacks, type AcpLaunchOptions, type AcpProcessExitEvent } from "../acp/client";
import type { RelaySessionUpdate } from "../acp/sdk";
import {
  applyAcpSessionUpdate,
  finalizeAcpPrompt,
  findLastToolBlock,
  type AcpConversationAdapter,
} from "../application/acp-mapping";
import { startupProcessExitSettle } from "../acp/process-exit";
import {
  availableModelIdsFromSessionResult,
  availableThinkingLevelsFromSessionResult,
  modelConfigIdFromSessionResult,
  thinkingConfigIdFromSessionResult,
  type SessionConfigurationResult,
} from "../acp/session-config";
import { disposeAcpClientsForShutdown } from "../acp/shutdown";
import {
  acpClientCapabilityFlags,
  acpClientOptionsForAgent,
  acpLaunchOptionsForAgent,
  addAcpPromptErrorBlock,
  addUnexpectedAcpProcessExitBlock,
  connectAcpClientWithTimeout,
  loadOrResumeAcpSessionHistory,
  MISSING_AGENT_CONFIGURATION_MESSAGE,
  replayAcpSessionUpdates,
  resolveAcpLaunchAgent,
  resolveAgentBehaviorProfileForLaunchAgent,
  runAcpPromptTurn,
  startAcpSession,
  type ResolvedAcpLaunchAgent,
} from "../application/acp-orchestration";
import { applySessionCapabilities, applySessionConfigOptionUpdate } from "../ui/context/session";
import { resumableSessions } from "../ui/app/session-list";
import { sanitizeInternalThreadTitle } from "../ui/app/session-policy";
import { threadTitleUpdateFromPrompt } from "../ui/app/thread-metadata";
import { compactPreviewText, lastAssistantResponseText } from "../ui/util/thread-preview";
import type { AppStateContextValue } from "../ui/context/app-state";
import { fieldsFromElicitationSchema } from "../ui/util/elicitation-schema";
import * as SlashCommandUtil from "../ui/util/slash-commands";
import { isBuiltinSlashCommandDisabled } from "../ui/util/native-slash-commands";
import { composeUserBashContext } from "../ui/util/submit";
import { appendUserBashOutput, createUserBashBlock, finalizeUserBashBlock } from "../ui/util/user-bash-block";
import { executeUserBashEffect } from "../user-bash";
import { runEffect } from "../effect/runtime";
import { getRelayLogPath } from "../logging/logger";
import { flushTelemetry, getTelemetry } from "../telemetry";
import { flushTelemetryBeforeExit } from "../telemetry-shutdown";
import {
  ApprovalResponse,
  isApprovalSelectionAllow,
  type ApprovalOption,
  type ApprovalSelection,
} from "../core/events";
import { childSessionCollaborationReminder } from "../core/child-session-task-types";
import { withPromptInputSystemReminders } from "../core/prompt-submission";
import { parseThinkingLevel, thinkingLevelLabel } from "../core/thinking";
import {
  appendLiveSessionInboxEvent,
  canCancelLiveSession,
  canInspectLiveSession,
  canMessageLiveSession,
  childCompletionDelivery,
  childSessionHistoryFromValue,
  childSessionHistoryLabel,
  childSessionOpeningPrompt,
  formatChildCompletionEvent,
  formatLiveSessionMessage,
  inspectedSessionContextTurns,
  isLiveSessionVisibleTo,
  isTerminalChildTaskStatus,
  LIVE_SESSION_CONTINUATION_ACKNOWLEDGEMENT,
  LIVE_SESSION_CONTINUATION_PROMPT,
  LIVE_SESSION_MESSAGE_MAX_BYTES,
  LIVE_SESSION_PROTOCOL_VERSION,
  LIVE_SESSION_WAIT_DEFAULT_MS,
  LIVE_SESSION_WAIT_MAX_MS,
  LIVE_SESSION_WAIT_MIN_MS,
  liveSessionInboxReminder,
  liveSessionMessageRelation,
  liveSessionRole,
  MAX_ACTIVE_CHILD_SESSIONS,
  pendingLiveSessionInboxEvents,
  parseLiveSessionMessage,
  restoredLiveSessionMessageBlocks,
  type LiveSessionControlRequest,
  type LiveSessionControlResponse,
  type LiveSessionInfo,
  type LiveSessionMessageDelivery,
  type LiveSessionMessageResult,
} from "../core/live-sessions";
import {
  additionalDirectoriesForThread,
  archiveRelayWorktree,
  createRelaySessionId,
  createRelayWorktree,
  discoverThreadWorktreeCandidates,
  loadThreadsForWorkspace,
  normalizeRelaySessionName,
  relaySessionNameFromId,
  saveThreadsForWorkspace,
  summarizeThreadRequest,
  threadRelaySessionName,
  type ChildTaskStatus,
  type LiveSessionInboxEvent,
  type PersistedLiveSessionMessage,
  type ThreadInfo,
} from "../core/threads";
import {
  createInitialState,
  nextBlockId,
  type AppState,
  type ChatBlock,
  type QueuedPrompt,
  type UserSkillInvocationEcho,
} from "../ui/state";
import { VERSION } from "../version";
import { findBuiltinSkill } from "../builtin-skills/registry";
import type { BuiltinSkill } from "../builtin-skills/types";
import type { RelayCommandContext } from "../plugins";
import { loadWebAssets, type WebAssets } from "./assets";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const MAX_QUEUE = 20;
const WEB_SHUTDOWN_DISPOSE_TIMEOUT_MS = 250;
const WEB_SHUTDOWN_FORCE_SETTLE_MS = 25;
const WEB_NATIVE_PREFERRED_AGENT_COMMANDS = new Set([
  "models",
  "model",
  "thinking",
  "modes",
  "mode",
  "resume",
  "sessions",
]);

export function webNativePreferredAgentCommandNames(disabledBuiltinCommands: readonly string[] = []): Set<string> {
  return new Set(
    [...WEB_NATIVE_PREFERRED_AGENT_COMMANDS].filter(
      (name) => !isBuiltinSlashCommandDisabled(name, disabledBuiltinCommands),
    ),
  );
}

export function webAgentSlashSkillInvocationEcho(
  text: string,
  state: AppState,
  disabledBuiltinCommands: readonly string[] = [],
): UserSkillInvocationEcho | null {
  const commandName = SlashCommandUtil.slashCommandName(text);
  if (
    SlashCommandUtil.shouldPreferNativeSlashCommand(
      commandName,
      state,
      webNativePreferredAgentCommandNames(disabledBuiltinCommands),
    )
  ) {
    return null;
  }
  return SlashCommandUtil.agentSlashSkillInvocationEcho(text, state.availableCommands);
}

type ResolvedAgent = ResolvedAcpLaunchAgent;

type WebThreadRuntime = {
  info: ThreadInfo;
  state: AppState;
  adapter: AcpConversationAdapter;
  client: AcpClient | null;
  acpLaunchOptions: AcpLaunchOptions | null;
  queueCounter: number;
  promptRunId: number;
  elapsedTimer: TimerHandle | null;
  turnStartedAt: number | null;
  pendingApprovals: Map<string, (response: ApprovalSelection) => void>;
  pendingElicitations: Map<
    string,
    (
      response: { action: "accept"; content: Record<string, unknown> } | { action: "decline" } | { action: "cancel" },
    ) => void
  >;
  userBashAbortController: AbortController | null;
};

export interface LaunchWebOptions {
  cwd?: string;
  agent?: string;
  defaultRenderer?: boolean;
  resume?: boolean;
  resumeSessionId?: string;
  continueSession?: boolean;
  acpCommand?: string;
  initialPrompt?: string;
  /** Thinking level to apply on launch, overriding the agent's configured preferred thinking level. */
  thinkingLevel?: string;
  host?: string;
  port?: number;
  open?: boolean;
}

type WebCommand =
  | { type: "prompt"; text?: unknown }
  | { type: "activeTurnInput"; text?: unknown }
  | { type: "cancel" }
  | { type: "newThread"; worktree?: unknown; worktreePath?: unknown }
  | { type: "selectThread"; threadId?: unknown }
  | { type: "archiveThread"; threadId?: unknown }
  | { type: "approval"; blockId?: unknown; response?: unknown }
  | { type: "elicitation"; blockId?: unknown; response?: unknown }
  | { type: "switchMode"; modeId?: unknown }
  | { type: "switchModel"; modelId?: unknown }
  | { type: "switchThinking"; thinkingLevel?: unknown }
  | { type: "switchAgent"; agent?: unknown }
  | { type: "listSessions" }
  | { type: "listWorktrees" }
  | { type: "pathComplete"; requestId?: unknown; query?: unknown };

function openBrowser(url: string): void {
  try {
    const child =
      process.platform === "darwin"
        ? spawn("open", [url], { stdio: "ignore", detached: true })
        : process.platform === "win32"
          ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true })
          : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Best-effort only. The URL is still printed to the terminal.
  }
}

let threadCounter = 0;

function threadId(prefix = "thread"): string {
  threadCounter += 1;
  return `${prefix}-${nowMs().toString(36)}-${threadCounter.toString(36)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function liveControlSuccess(requestId: string, result: unknown): LiveSessionControlResponse {
  return { version: LIVE_SESSION_PROTOCOL_VERSION, requestId, ok: true, result };
}

function liveControlFailure(requestId: string, code: string, message: string): LiveSessionControlResponse {
  return { version: LIVE_SESSION_PROTOCOL_VERSION, requestId, ok: false, error: { code, message } };
}

function safeClone(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "function") return undefined;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => safeClone(item, seen));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const cloned = safeClone(entry, seen);
    if (cloned !== undefined) out[key] = cloned;
  }
  return out;
}

function statusLabel(state: AppState): string {
  if (state.spinnerLabel) return state.spinnerLabel;
  if (state.connecting) return `Connecting to ${state.connectingAgentName || "agent"}…`;
  if (state.running) {
    const activity = state.lastAcpActivityLabel ? ` · ${state.lastAcpActivityLabel}` : "";
    return `Running${activity}`;
  }
  return state.statusText || "Ready";
}

class MutableAppAdapter implements AcpConversationAdapter {
  constructor(
    private readonly runtime: WebThreadRuntime,
    private readonly onChange: () => void,
  ) {}

  get state() {
    return this.runtime.state;
  }

  addBlock = (block: ChatBlock): void => {
    this.runtime.state.blocks = [...this.runtime.state.blocks, block];
    this.onChange();
  };

  updateBlock = (id: string, updates: Partial<ChatBlock>): void => {
    this.runtime.state.blocks = this.runtime.state.blocks.map((block) =>
      block.id === id ? ({ ...block, ...updates } as ChatBlock) : block,
    );
    this.onChange();
  };

  appendToBlock = (id: string, text: string): void => {
    this.runtime.state.blocks = this.runtime.state.blocks.map((block) => {
      if (block.id !== id || !("content" in block) || typeof block.content !== "string") return block;
      return { ...block, content: `${block.content}${text}` } as ChatBlock;
    });
    this.onChange();
  };

  removeBlock = (id: string): void => {
    this.runtime.state.blocks = this.runtime.state.blocks.filter((block) => block.id !== id);
    this.onChange();
  };

  setCurrentBlockId = (id: string | null): void => {
    this.runtime.state.currentBlockId = id;
    this.onChange();
  };

  setState = (...args: unknown[]): void => {
    if (typeof args[0] !== "string") return;
    const key = args[0] as keyof AppState;
    const valueOrUpdater = args[1];
    const current = this.runtime.state[key];
    (this.runtime.state as Record<keyof AppState, unknown>)[key] =
      typeof valueOrUpdater === "function" ? (valueOrUpdater as (value: unknown) => unknown)(current) : valueOrUpdater;
    this.onChange();
  };
}

function applyWebClientCapabilities(runtime: WebThreadRuntime, client: AcpClient | null): void {
  const capabilities = acpClientCapabilityFlags(client);
  runtime.state.sessionForkAvailable = capabilities.sessionForkAvailable;
  runtime.state.sessionListAvailable = capabilities.sessionListAvailable;
  runtime.state.sessionLoadAvailable = capabilities.sessionLoadAvailable;
  runtime.state.sessionResumeAvailable = capabilities.sessionResumeAvailable;
  runtime.state.authMethods = [...capabilities.authMethods];
  runtime.state.authLogoutAvailable = capabilities.authLogoutAvailable;
  if (!client) {
    runtime.state.authStatus = "unknown";
    runtime.state.authMessage = "";
  }
}

function capabilitiesAdapterFor(runtime: WebThreadRuntime): AppStateContextValue {
  return {
    state: runtime.state,
    transcriptPagingEnabled: false,
    setState: runtime.adapter.setState as AppStateContextValue["setState"],
    /**
     * Resolves a web-runtime block and its current array index for shared capability helpers.
     *
     * @param id - Identifier of the block to locate.
     * @returns The matching block and index, or `undefined` when no block has the identifier.
     */
    blockEntry: (id) => {
      const index = runtime.state.blocks.findIndex((block) => block.id === id);
      const block = runtime.state.blocks[index];
      return block ? { block, index } : undefined;
    },
    findToolBlock: (toolCallId) => findLastToolBlock(runtime.state.blocks, toolCallId),
    addBlock: runtime.adapter.addBlock,
    appendBlock: runtime.adapter.addBlock,
    insertBlock: (index, block) => {
      runtime.state.blocks = [...runtime.state.blocks.slice(0, index), block, ...runtime.state.blocks.slice(index)];
    },
    updateBlock: runtime.adapter.updateBlock,
    appendToBlock: runtime.adapter.appendToBlock,
    removeBlock: runtime.adapter.removeBlock,
    replaceBlocks: (blocks) => {
      runtime.state.blocks = blocks;
    },
    clearBlocks: () => {
      runtime.state.blocks = [];
    },
    setCurrentBlockId: runtime.adapter.setCurrentBlockId,
    setActiveThreadState: (thread, blocks, pendingQueue = []) => {
      runtime.state.activeThreadId = thread.id;
      runtime.state.cwd = thread.cwd;
      runtime.state.blocks = blocks;
      runtime.state.pendingQueue = pendingQueue;
    },
    cancelController: () => null,
    setCancelController: () => undefined,
  };
}

function applyWebConfigOptionUpdate(runtime: WebThreadRuntime, update: unknown): void {
  applySessionConfigOptionUpdate(capabilitiesAdapterFor(runtime), update);
}

class WebRelayServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private liveSessionControlServer: LiveSessionControlServer | null = null;
  private readonly sockets = new Set<Bun.ServerWebSocket<unknown>>();
  private readonly cwd: string;
  private readonly host: string;
  private readonly port: number;
  private activeAgentName: string;
  private activeAgentBehaviorProfile: AgentBehaviorProfile;
  private resolvedAgent: ResolvedAgent;
  private activeThreadId: string | null = null;
  private readonly runtimes = new Map<string, WebThreadRuntime>();
  private readonly threadInfos = new Map<string, ThreadInfo>();
  private readonly pendingLiveSessionNames = new Set<string>();
  private readonly pendingChildNamesByParent = new Map<string, Set<string>>();
  private readonly reportedTerminalChildrenByParent = new Map<string, Set<string>>();
  private readonly waitingLiveSessionIds = new Set<string>();
  private stopping = false;
  private webAssets: WebAssets | null = null;
  private readonly sessionsCache: { loading: boolean; items: unknown[]; error: string | null } = {
    loading: false,
    items: [],
    error: null,
  };

  constructor(private readonly opts: LaunchWebOptions) {
    this.cwd = opts.cwd ?? process.cwd();
    this.host = opts.host ?? DEFAULT_HOST;
    this.port = opts.port ?? DEFAULT_PORT;
    this.resolvedAgent = this.resolveAgent(opts.agent, opts.acpCommand);
    this.activeAgentName = this.resolvedAgent.name;
    this.activeAgentBehaviorProfile = resolveAgentBehaviorProfileForLaunchAgent(this.resolvedAgent);
  }

  async start(): Promise<string> {
    this.webAssets = await loadWebAssets();
    try {
      this.liveSessionControlServer = await startLiveSessionControlServer((request) =>
        this.handleLiveSessionControlRequest(request),
      );
    } catch (error) {
      process.stderr.write(
        `Relay live-session control unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    this.server = Bun.serve({
      hostname: this.host,
      port: this.port,
      fetch: (request, server) => this.fetch(request, server),
      websocket: {
        open: (ws) => {
          this.sockets.add(ws);
          this.send(ws, { type: "snapshot", snapshot: this.snapshot() });
        },
        message: (ws, message) => {
          void this.handleSocketMessage(ws, message).catch((err) => {
            this.addActiveInfo(`Web command failed: ${err instanceof Error ? err.message : String(err)}`, "error");
          });
        },
        close: (ws) => {
          this.sockets.delete(ws);
        },
      },
    });

    const address = `http://${this.server.hostname}:${this.server.port}`;
    process.stdout.write(`Relay web dashboard listening at ${address}\n`);
    if (this.opts.open !== false) openBrowser(address);
    void this.bootstrapThreads().catch((err) => {
      this.addActiveInfo(
        `Failed to initialize Relay web: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      this.broadcastSnapshot();
    });
    return address;
  }

  /**
   * Stops accepting web work before disposing ACP clients and flushing telemetry.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    const activeServer = this.server;
    this.server = null;
    await activeServer?.stop(true);
    await this.liveSessionControlServer?.close();
    this.liveSessionControlServer = null;

    const clients = new Set<AcpClient>();
    for (const runtime of this.runtimes.values()) {
      this.stopElapsedTimer(runtime);
      runtime.userBashAbortController?.abort();
      if (runtime.client) clients.add(runtime.client);
      runtime.client = null;
    }
    this.runtimes.clear();

    await disposeAcpClientsForShutdown(clients, {
      disposeTimeoutMs: WEB_SHUTDOWN_DISPOSE_TIMEOUT_MS,
      forceSettleMs: WEB_SHUTDOWN_FORCE_SETTLE_MS,
    });
    await flushTelemetryBeforeExit(flushTelemetry);
  }

  private resolveAgent(agentName?: string, acpCommand?: string): ResolvedAgent {
    const resolved = resolveAcpLaunchAgent(agentName, acpCommand);
    if (!resolved) throw new Error(MISSING_AGENT_CONFIGURATION_MESSAGE); // effect-shape-allow: sync web startup reports missing configured agent.
    return resolved;
  }

  private agentForThread(info: ThreadInfo): ResolvedAgent {
    const agentName = info.agentName?.trim() || this.activeAgentName;
    return agentName === this.activeAgentName ? this.resolvedAgent : this.resolveAgent(agentName);
  }

  private createRelaySessionIdentity(requestedName?: string): { id: string; name: string } {
    const id = createRelaySessionId();
    const liveNames = [...this.runtimes.values()]
      .filter((runtime) => !runtime.info.archived && runtime.client !== null)
      .map((runtime) => threadRelaySessionName(runtime.info));
    const unavailableNames = [...liveNames, ...this.pendingLiveSessionNames];
    const name = requestedName
      ? normalizeRelaySessionName(requestedName)
      : relaySessionNameFromId(id, unavailableNames);
    if (unavailableNames.includes(name)) throw new Error(`Session name ${name} is already in use`); // effect-shape-allow: web session creation reports duplicate live names.
    return { id, name };
  }

  private async bootstrapThreads(): Promise<void> {
    const persisted = loadThreadsForWorkspace(this.cwd);
    const createRootThread = (): ThreadInfo => {
      const now = isoNow();
      const relaySession = this.createRelaySessionIdentity();
      return {
        id: `${threadId()}-root`,
        relaySessionId: relaySession.id,
        relaySessionName: relaySession.name,
        title: "New thread",
        sessionId: null,
        agentName: this.activeAgentName,
        cwd: this.cwd,
        workspaceKind: "local",
        status: "connecting",
        archived: false,
        createdAt: now,
        updatedAt: now,
      };
    };

    const restoredThreads = persisted?.threads.length
      ? persisted.threads.map((thread) =>
          sanitizeInternalThreadTitle(thread, this.activeAgentBehaviorProfile.sessionListPolicy),
        )
      : [createRootThread()];
    for (const thread of restoredThreads) {
      this.threadInfos.set(thread.id, { ...thread, status: "paused" });
    }

    const active =
      firstString(this.opts.resumeSessionId) !== undefined
        ? createRootThread()
        : (persisted?.activeThreadId && this.threadInfos.get(persisted.activeThreadId)) ||
          restoredThreads.find((thread) => !thread.archived) ||
          createRootThread();

    if (firstString(this.opts.resumeSessionId)) active.sessionId = firstString(this.opts.resumeSessionId)!;
    this.threadInfos.set(active.id, active);
    this.activeThreadId = active.id;
    await this.ensureRuntime(active.id);

    if (this.opts.initialPrompt) {
      await this.submitPrompt(active.id, this.opts.initialPrompt);
    }
  }

  private createRuntime(info: ThreadInfo): WebThreadRuntime {
    const state = createInitialState(info.cwd);
    const agentName = info.agentName ?? this.activeAgentName;
    state.providerName = agentName;
    state.threads = this.visibleThreads();
    state.activeThreadId = info.id;
    state.cwd = info.cwd;
    state.worktreePath = info.worktreePath ?? null;
    state.worktreeBranch = info.worktreeBranch ?? null;
    state.connecting = true;
    state.connectingAgentName = agentName;

    const runtime = {
      info,
      state,
      adapter: null as unknown as AcpConversationAdapter,
      client: null,
      acpLaunchOptions: null,
      queueCounter: 0,
      promptRunId: 0,
      elapsedTimer: null,
      turnStartedAt: null,
      pendingApprovals: new Map(),
      pendingElicitations: new Map(),
      userBashAbortController: null,
    } satisfies WebThreadRuntime;
    runtime.adapter = new MutableAppAdapter(runtime, () => this.broadcastSnapshot());
    runtime.adapter.addBlock({ type: "info", id: nextBlockId(), content: "", variant: "session" });
    return runtime;
  }

  private async ensureRuntime(threadIdValue: string): Promise<WebThreadRuntime> {
    if (this.stopping) return Promise.reject(new Error("Relay web server is shutting down"));

    const existing = this.runtimes.get(threadIdValue);
    if (existing) return existing;
    const info = this.threadInfos.get(threadIdValue);
    if (!info) return Promise.reject(new Error(`Unknown thread ${threadIdValue}`));

    const runtime = this.createRuntime(info);
    this.runtimes.set(threadIdValue, runtime);
    await this.connectRuntime(runtime);
    return runtime;
  }

  private async applyChildSessionConfiguration(
    runtime: WebThreadRuntime,
    initialResult: SessionConfigurationResult,
  ): Promise<void> {
    const client = runtime.client;
    if (!client) throw new Error("No ACP agent is connected"); // effect-shape-allow: web child startup reports unavailable agent connection.
    let capabilities = initialResult;
    if (runtime.info.modelId) {
      const configId = modelConfigIdFromSessionResult(capabilities);
      const available = availableModelIdsFromSessionResult(capabilities);
      if (!configId) throw new Error("The active agent does not support model selection"); // effect-shape-allow: web child startup reports unsupported explicit configuration.
      if (!available.includes(runtime.info.modelId)) {
        throw new Error( // effect-shape-allow: web child startup reports unavailable explicit configuration.
          `Model ${runtime.info.modelId} is unavailable. Available models: ${available.join(", ") || "none"}`,
        );
      }
      capabilities = await client.setSessionModel(runtime.info.modelId, configId);
      applySessionCapabilities(capabilitiesAdapterFor(runtime), capabilities);
    }
    if (runtime.info.thinkingLevel) {
      const configId = thinkingConfigIdFromSessionResult(capabilities);
      const available = availableThinkingLevelsFromSessionResult(capabilities);
      if (!configId) throw new Error("The active agent does not support thinking-level selection"); // effect-shape-allow: web child startup reports unsupported explicit configuration.
      if (!available.includes(runtime.info.thinkingLevel)) {
        throw new Error( // effect-shape-allow: web child startup reports unavailable explicit configuration.
          `Thinking level ${runtime.info.thinkingLevel} is unavailable. Available thinking levels: ${available.join(", ") || "none"}`,
        );
      }
      const result = await client.setSessionThinkingLevel(runtime.info.thinkingLevel, configId);
      applySessionCapabilities(capabilitiesAdapterFor(runtime), result);
    }
  }

  private async connectRuntime(runtime: WebThreadRuntime): Promise<void> {
    let clientRef: AcpClient | null = null;
    const callbacks = this.createCallbacks(runtime, () => clientRef);
    const agent = this.agentForThread(runtime.info);
    const agentName = agent.name;
    const agentBehaviorProfile = resolveAgentBehaviorProfileForLaunchAgent(agent);
    const baseAcpOpts = acpClientOptionsForAgent(agent, runtime.info.cwd, agentBehaviorProfile);
    const parent = runtime.info.parentThreadId ? this.threadInfos.get(runtime.info.parentThreadId) : undefined;
    const control = this.liveSessionControlServer;
    const relaySessionId = runtime.info.relaySessionId ?? runtime.info.id;
    const acpOpts = control
      ? {
          ...baseAcpOpts,
          env: {
            ...(baseAcpOpts.env ?? {}),
            RELAY_CONTROL_ENDPOINT: control.endpoint,
            RELAY_CONTROL_TOKEN: control.tokenForSession(relaySessionId),
            RELAY_INSTANCE_ID: control.instanceId,
            RELAY_SESSION_ID: relaySessionId,
            RELAY_SESSION_NAME: threadRelaySessionName(runtime.info),
            RELAY_SESSION_ROLE: liveSessionRole(runtime.info),
            ...(parent
              ? {
                  RELAY_PARENT_SESSION_ID: parent.relaySessionId ?? parent.id,
                  RELAY_PARENT_SESSION_NAME: threadRelaySessionName(parent),
                }
              : {}),
            RELAY_BIN_PATH: process.argv[1] ?? "relay",
          },
        }
      : baseAcpOpts;
    runtime.acpLaunchOptions = acpLaunchOptionsForAgent(agent, runtime.info.cwd);
    const client = new AcpClient(callbacks, acpOpts);
    clientRef = client;
    runtime.client = client;
    const runtimeClientStillCurrent = () => runtime.client === client;
    runtime.state.connecting = true;
    runtime.state.connectingAgentName = agentName;
    const requiresExplicitChildConfiguration =
      !runtime.info.sessionId && Boolean(runtime.info.modelId || runtime.info.thinkingLevel);
    this.updateThread(runtime.info.id, { status: "connecting" });
    this.broadcastSnapshot();

    try {
      await connectAcpClientWithTimeout(runtime.client, agentName);
      await startupProcessExitSettle();
      if (!runtimeClientStillCurrent()) return;
      applyWebClientCapabilities(runtime, runtime.client);
      const isNewSession = !runtime.info.sessionId;
      if (isNewSession) runtime.state.availableCommands = [];
      const loaded = await startAcpSession(runtime.client, {
        cwd: runtime.info.cwd,
        sessionId: runtime.info.sessionId,
        additionalDirectories: this.additionalDirectoriesForRuntime(runtime),
      });
      if (!runtimeClientStillCurrent()) return;
      const sessionResult = loaded.result;
      this.updateThread(runtime.info.id, {
        sessionId: sessionResult.sessionId ?? runtime.info.sessionId,
        status: "paused",
      });
      runtime.state.connecting = false;
      const sessionCapabilities =
        sessionResult.availableCommands === undefined && runtime.state.availableCommands.length > 0
          ? { ...sessionResult, availableCommands: runtime.state.availableCommands }
          : sessionResult;
      applySessionCapabilities(capabilitiesAdapterFor(runtime), sessionCapabilities, { replace: true });
      if (isNewSession && (runtime.info.modelId || runtime.info.thinkingLevel)) {
        await this.applyChildSessionConfiguration(runtime, sessionCapabilities);
      } else if (isNewSession) {
        await this.applyLaunchThinking(runtime);
      }
      this.replayRuntimeSessionUpdates(runtime, loaded.updates);
      runtime.adapter.addBlock({
        type: "info",
        id: nextBlockId(),
        content: `Connected to ${agentName} agent (session: ${sessionResult.sessionId ?? runtime.info.sessionId ?? "unknown"})`,
        variant: "info",
      });
      this.persistThreads();
    } catch (err) {
      await startupProcessExitSettle();
      if (!runtimeClientStillCurrent()) return;
      runtime.state.connecting = false;
      runtime.client = null;
      applyWebClientCapabilities(runtime, null);
      this.updateThread(runtime.info.id, {
        status: "paused",
        ...(runtime.info.parentThreadId
          ? {
              childTaskStatus: "failed" as const,
              childTaskFinishedAt: isoNow(),
              latestResultPreview: (err instanceof Error ? err.message : String(err)).slice(0, 240),
            }
          : {}),
      });
      const paths = client.diagnosticLogPaths();
      const lines = [`Failed to connect to ${agentName} agent: ${err instanceof Error ? err.message : String(err)}`];
      const relayLogPath = paths?.relay ?? getRelayLogPath();
      if (relayLogPath) lines.push(`Relay log: ${relayLogPath}`);
      if (paths?.stderr) lines.push(`Agent stderr log: ${paths.stderr}`);
      runtime.adapter.addBlock({
        type: "info",
        id: nextBlockId(),
        content: lines.join("\n"),
        variant: "error",
      });
      if (requiresExplicitChildConfiguration) throw err; // effect-shape-allow: explicit child configuration failures propagate to the control request.
    }
  }

  private finalizeRuntimeAfterUnexpectedProcessExit(
    runtime: WebThreadRuntime,
    event: AcpProcessExitEvent,
    sourceClient: AcpClient | null,
  ): void {
    if (event.expected || event.connected === false) return;
    if (sourceClient && runtime.client !== sourceClient) return;
    if (this.runtimes.get(runtime.info.id) !== runtime || runtime.info.archived) return;

    runtime.promptRunId += 1;
    this.stopElapsedTimer(runtime);
    if (!sourceClient || runtime.client === sourceClient) runtime.client = null;
    applyWebClientCapabilities(runtime, runtime.client);
    runtime.state.connecting = false;
    runtime.state.running = false;
    runtime.state.spinnerActive = false;
    runtime.state.spinnerLabel = "";
    runtime.state.lastAcpActivityKind = null;
    runtime.state.lastAcpActivityLabel = "";
    runtime.state.lastAcpActivityAt = null;
    addUnexpectedAcpProcessExitBlock(runtime.adapter, event);
    this.updateThread(runtime.info.id, { status: "paused" });
    this.broadcastSnapshot();
  }

  private createCallbacks(runtime: WebThreadRuntime, clientRef?: () => AcpClient | null): AcpClientCallbacks {
    const callbackClient = () => clientRef?.() ?? null;
    const isCurrentCallbackClient = () => {
      const sourceClient = callbackClient();
      return !sourceClient || runtime.client === sourceClient;
    };
    return {
      onProcessExit: (event) => {
        this.finalizeRuntimeAfterUnexpectedProcessExit(runtime, event, callbackClient());
      },
      onSessionUpdate: (update) => {
        if (!isCurrentCallbackClient()) return;
        applyAcpSessionUpdate(update, runtime.adapter);
        applyWebConfigOptionUpdate(runtime, update);
        this.broadcastSnapshot();
      },
      onAvailableCommands: (commands) => {
        if (!isCurrentCallbackClient()) return;
        runtime.state.availableCommands = commands;
        this.broadcastSnapshot();
      },
      onPermissionRequest: (request) => {
        if (!isCurrentCallbackClient()) return;
        const id = nextBlockId();
        runtime.pendingApprovals.set(id, request.respond);
        runtime.adapter.addBlock({
          type: "tool",
          id,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          display: request.preview ?? request.toolName,
          status: "approval",
          approvalPreview: request.preview,
          approvalOptions: request.options,
          resolveApproval: request.respond,
        });
      },
      onElicitationRequest: (request) => {
        if (!isCurrentCallbackClient()) return;
        const id = nextBlockId();
        runtime.pendingElicitations.set(id, request.respond);
        runtime.adapter.addBlock({
          type: "elicitation",
          id,
          mode: request.mode,
          message: request.message,
          schema: request.requestedSchema,
          url: request.url,
          elicitationId: request.elicitationId,
          status: "pending",
          fields: fieldsFromElicitationSchema(request.requestedSchema),
          currentFieldIndex: 0,
          answers: {},
          respond: request.respond,
        });
      },
    };
  }

  private additionalDirectoriesForRuntime(runtime: WebThreadRuntime): string[] {
    return additionalDirectoriesForThread(runtime.info, [...this.threadInfos.values()]);
  }

  private async loadOrResumeRuntimeSession(
    runtime: WebThreadRuntime,
    sessionId: string,
  ): Promise<Awaited<ReturnType<AcpClient["loadSessionHistory"]>>> {
    const client = runtime.client;
    if (!client) return Promise.reject(new Error("No ACP agent is connected"));
    return loadOrResumeAcpSessionHistory(
      client,
      sessionId,
      runtime.info.cwd,
      this.additionalDirectoriesForRuntime(runtime),
    );
  }

  private replayRuntimeSessionUpdates(runtime: WebThreadRuntime, updates: readonly RelaySessionUpdate[]): void {
    replayAcpSessionUpdates(updates, runtime.adapter, {
      onAvailableCommands: (commands) => {
        runtime.state.availableCommands = commands;
      },
    });
    if (runtime.info.sessionId) {
      for (const block of restoredLiveSessionMessageBlocks(
        runtime.info,
        runtime.info.sessionId,
        runtime.state.blocks,
      )) {
        runtime.adapter.addBlock(block);
      }
    }
    this.broadcastSnapshot();
  }

  private activeRuntime(): WebThreadRuntime | null {
    return this.activeThreadId ? (this.runtimes.get(this.activeThreadId) ?? null) : null;
  }

  private visibleThreads(): ThreadInfo[] {
    return [...this.threadInfos.values()]
      .filter((thread) => !thread.archived)
      .sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""));
  }

  private syncThreadLists(): void {
    const threads = this.visibleThreads();
    for (const runtime of this.runtimes.values()) {
      runtime.state.threads = threads;
      runtime.state.activeThreadId = this.activeThreadId ?? "";
    }
  }

  private updateThread(id: string, updates: Partial<ThreadInfo>): void {
    const current = this.threadInfos.get(id);
    if (!current) return;
    const normalizedUpdates =
      "title" in updates && !("titleQuality" in updates) ? { ...updates, titleQuality: undefined } : updates;
    // Only advance updatedAt on genuine activity (a new turn or a title change), not on
    // status/connection churn from selecting or reconnecting a thread. Keeps the sidebar
    // ordering static like the TUI so accessing a thread does not reshuffle the list.
    const touchesRecency = "title" in updates || updates.status === "running";
    const next = {
      ...current,
      ...normalizedUpdates,
      updatedAt: touchesRecency ? isoNow() : current.updatedAt,
    };
    this.threadInfos.set(id, next);
    const runtime = this.runtimes.get(id);
    if (runtime) {
      runtime.info = next;
      runtime.state.cwd = next.cwd;
      runtime.state.worktreePath = next.worktreePath ?? null;
      runtime.state.worktreeBranch = next.worktreeBranch ?? null;
      runtime.state.running = next.status === "running";
      runtime.state.spinnerActive = next.status === "running";
    }
    this.syncThreadLists();
    this.persistThreads();
    this.broadcastSnapshot();
  }

  private persistThreads(): void {
    saveThreadsForWorkspace(this.cwd, {
      activeThreadId: this.activeThreadId,
      threads: [...this.threadInfos.values()],
    });
  }

  private addActiveInfo(content: string, variant: "info" | "warning" | "error" = "info"): void {
    this.activeRuntime()?.adapter.addBlock({ type: "info", id: nextBlockId(), content, variant });
  }

  private nextQueueId(runtime: WebThreadRuntime): string {
    runtime.queueCounter += 1;
    return `queue-${runtime.queueCounter}`;
  }

  private queuePrompt(runtime: WebThreadRuntime, text: string): boolean {
    if (runtime.state.pendingQueue.length >= MAX_QUEUE) {
      runtime.adapter.addBlock({
        type: "info",
        id: nextBlockId(),
        content: `Queue full (max ${MAX_QUEUE})`,
        variant: "warning",
      });
      return false;
    }
    const item: QueuedPrompt = { id: this.nextQueueId(runtime), text };
    runtime.state.pendingQueue = [...runtime.state.pendingQueue, item];
    this.broadcastSnapshot();
    return true;
  }

  private startElapsedTimer(runtime: WebThreadRuntime): void {
    this.stopElapsedTimer(runtime);
    runtime.turnStartedAt = nowMs();
    runtime.state.generationSeconds = 0;
    runtime.state.elapsedSeconds = 0;
    const tick = () => {
      if (runtime.turnStartedAt === null) return;
      const elapsed = (nowMs() - runtime.turnStartedAt) / 1000;
      runtime.state.generationSeconds = elapsed;
      runtime.state.elapsedSeconds = elapsed;
      this.broadcastSnapshot();
      runtime.elapsedTimer = setTimer(tick, 500);
    };
    runtime.elapsedTimer = setTimer(tick, 500);
  }

  private stopElapsedTimer(runtime: WebThreadRuntime): void {
    if (runtime.elapsedTimer) clearTimer(runtime.elapsedTimer);
    runtime.elapsedTimer = null;
    if (runtime.turnStartedAt !== null) {
      const elapsed = (nowMs() - runtime.turnStartedAt) / 1000;
      runtime.state.generationSeconds = elapsed;
      runtime.state.elapsedSeconds = elapsed;
    }
    runtime.turnStartedAt = null;
  }

  private async submitPrompt(threadIdValue: string, rawText: string): Promise<void> {
    const runtime = await this.ensureRuntime(threadIdValue);
    const text = rawText.trim();
    if (!text) return;

    if (text.startsWith("/")) {
      await this.handleSlashCommand(runtime, text);
      return;
    }

    if (text.startsWith("!")) {
      await this.handleUserBash(runtime, text);
      return;
    }

    if (!runtime.client && !runtime.state.connecting) await this.connectRuntime(runtime);
    this.submitAgentPrompt(runtime, text);
  }

  private agentSlashSkillInvocationEcho(runtime: WebThreadRuntime, text: string): UserSkillInvocationEcho | null {
    return webAgentSlashSkillInvocationEcho(text, runtime.state, getConfig().ui.disabled_builtin_slash_commands);
  }

  private submitAgentPrompt(
    runtime: WebThreadRuntime,
    text: string,
    options: {
      suppressLocalEcho?: boolean;
      localEchoSkillInvocation?: UserSkillInvocationEcho;
    } = {},
  ): void {
    if (runtime.state.connecting) {
      runtime.adapter.addBlock({
        type: "info",
        id: nextBlockId(),
        content: "Agent is still initializing…",
        variant: "warning",
      });
      return;
    }
    if (runtime.info.status === "running" || runtime.state.running) {
      this.queuePrompt(runtime, text);
      return;
    }
    if (!runtime.client) {
      runtime.adapter.addBlock({
        type: "info",
        id: nextBlockId(),
        content: "No ACP agent is connected",
        variant: "error",
      });
      return;
    }

    const pendingBash = runtime.state.pendingUserBashResults;
    const composedText = composeUserBashContext(text, pendingBash);
    runtime.state.pendingUserBashResults = [];
    const skillInvocation = options.localEchoSkillInvocation ?? this.agentSlashSkillInvocationEcho(runtime, text);
    if (skillInvocation) {
      runtime.adapter.addBlock({ type: "user", id: nextBlockId(), content: text, origin: "local", skillInvocation });
    } else if (options.suppressLocalEcho !== true) {
      runtime.adapter.addBlock({ type: "user", id: nextBlockId(), content: text, origin: "local" });
    }
    const titleUpdate = threadTitleUpdateFromPrompt(runtime.info, text, skillInvocation);
    this.updateThread(runtime.info.id, {
      ...(titleUpdate ?? {}),
      status: "running",
      ...(runtime.info.parentThreadId
        ? { childTaskStatus: "running" as const, childTaskFinishedAt: undefined, latestResultPreview: undefined }
        : {}),
    });
    runtime.state.running = true;
    runtime.state.spinnerActive = true;
    runtime.state.currentBlockId = null;
    runtime.state.turn += 1;
    runtime.state.toolCallCount = 0;
    runtime.state.lastAcpActivityKind = null;
    runtime.state.lastAcpActivityLabel = "";
    runtime.state.lastAcpActivityAt = null;
    this.startElapsedTimer(runtime);

    const runId = ++runtime.promptRunId;
    const promptClient = runtime.client;
    const liveSessionReminder =
      !runtime.info.parentThreadId && parseLiveSessionMessage(text) === null
        ? childSessionCollaborationReminder({
            template: getChildSessionReminderTemplate(),
            prompt: text,
            taskTypes: getConfig().task_types,
            currentSessionName: threadRelaySessionName(runtime.info),
          })
        : undefined;
    const inboxEvents = pendingLiveSessionInboxEvents(runtime.info);
    const inboxReminder = liveSessionInboxReminder(inboxEvents);
    runAcpPromptTurn({
      prompt: () => {
        const admittedPrompt = promptClient.prompt(
          withPromptInputSystemReminders(composedText, [
            ...(liveSessionReminder ? [liveSessionReminder] : []),
            ...(inboxReminder ? [inboxReminder] : []),
          ]),
        );
        if (inboxEvents.length > 0) {
          const deliveredIds = new Set(inboxEvents.map((event) => event.id));
          const deliveredAt = isoNow();
          this.updateThread(runtime.info.id, {
            liveSessionInbox: (runtime.info.liveSessionInbox ?? []).map((event) =>
              deliveredIds.has(event.id) ? { ...event, deliveredAt, consumedAt: deliveredAt } : event,
            ),
          });
        }
        return admittedPrompt;
      },
      isCurrent: () => runtime.promptRunId === runId && runtime.client === promptClient,
      onComplete: async (response) => {
        this.stopElapsedTimer(runtime);
        finalizeAcpPrompt(runtime.adapter, response);
        const childResult = lastAssistantResponseText(runtime.state.blocks);
        this.updateThread(runtime.info.id, {
          status: "paused",
          ...(runtime.info.parentThreadId
            ? {
                childTaskStatus: "done" as const,
                childTaskFinishedAt: isoNow(),
                latestResultPreview: compactPreviewText(childResult, 240, false),
              }
            : {}),
        });
        if (runtime.info.parentThreadId) await this.publishWebChildCompletion(runtime, "done", childResult);
        if (
          !runtime.info.parentThreadId &&
          (runtime.info.liveSessionInbox ?? []).some((event) => event.requiresContinuation && !event.consumedAt)
        ) {
          runtime.state.pendingQueue = [
            {
              id: this.nextQueueId(runtime),
              text: LIVE_SESSION_CONTINUATION_PROMPT,
            },
            ...runtime.state.pendingQueue,
          ];
        }
        const next = runtime.state.pendingQueue[0];
        if (next) {
          runtime.state.pendingQueue = runtime.state.pendingQueue.slice(1);
          this.submitAgentPrompt(runtime, next.text);
        }
      },
      onError: async (_err, promptError) => {
        this.stopElapsedTimer(runtime);
        addAcpPromptErrorBlock(runtime.adapter, promptError);
        runtime.state.running = false;
        runtime.state.spinnerActive = false;
        runtime.state.currentBlockId = null;
        this.updateThread(runtime.info.id, {
          status: "paused",
          ...(runtime.info.parentThreadId
            ? {
                childTaskStatus: "failed" as const,
                childTaskFinishedAt: isoNow(),
                latestResultPreview: promptError.slice(0, 240),
              }
            : {}),
        });
        if (runtime.info.parentThreadId) await this.publishWebChildCompletion(runtime, "failed", promptError);
      },
      onSettled: () => this.broadcastSnapshot(),
    });

    this.broadcastSnapshot();
  }

  private async handleUserBash(runtime: WebThreadRuntime, text: string): Promise<void> {
    if (runtime.userBashAbortController) {
      runtime.adapter.addBlock({
        type: "info",
        id: nextBlockId(),
        content: "A bash command is already running",
        variant: "warning",
      });
      return;
    }
    const sendToLlm = text.startsWith("!!");
    const command = (sendToLlm ? text.slice(2) : text.slice(1)).trim();
    if (!command) {
      runtime.adapter.addBlock({
        type: "info",
        id: nextBlockId(),
        content: "Type a command after ! or !! to run bash.",
        variant: "warning",
      });
      return;
    }
    const block = createUserBashBlock(command, !sendToLlm);
    runtime.adapter.addBlock(block);
    runtime.state.userBashRunning = true;
    runtime.userBashAbortController = new AbortController();
    const result = await runEffect(
      executeUserBashEffect(
        command,
        runtime.info.cwd,
        (chunk) => {
          const current = runtime.state.blocks.find((entry) => entry.id === block.id && entry.type === "user-bash") as
            | typeof block
            | undefined;
          runtime.adapter.updateBlock(block.id, appendUserBashOutput(current, chunk) as Partial<ChatBlock>);
        },
        runtime.userBashAbortController.signal,
      ),
    );
    runtime.userBashAbortController = null;
    runtime.state.userBashRunning = false;
    runtime.adapter.updateBlock(
      block.id,
      finalizeUserBashBlock(result.output, result.exitCode, result.cancelled) as Partial<ChatBlock>,
    );
    if (sendToLlm && !result.cancelled) {
      runtime.state.pendingUserBashResults = [
        ...runtime.state.pendingUserBashResults,
        { command, output: result.output, exitCode: result.exitCode },
      ];
    }
    this.broadcastSnapshot();
  }

  private async handleSlashCommand(runtime: WebThreadRuntime, text: string): Promise<void> {
    const [commandRaw, ...rest] = text.slice(1).trim().split(/\s+/);
    const command = commandRaw.toLowerCase() === "sessions" ? "resume" : commandRaw.toLowerCase();
    const arg = rest.join(" ").trim();
    getTelemetry().recordSlashCommand(command);
    const disabledBuiltinCommands = getConfig().ui.disabled_builtin_slash_commands;
    const builtinCommandDisabled = isBuiltinSlashCommandDisabled(command, disabledBuiltinCommands);
    const builtinSkill = !builtinCommandDisabled ? findBuiltinSkill(command) : null;
    const agentAdvertisedCommand = SlashCommandUtil.isAgentAdvertisedSlashCommand(
      text,
      runtime.state.availableCommands,
    );
    const preferredWebNativeCommands = webNativePreferredAgentCommandNames(disabledBuiltinCommands);
    if (
      !builtinSkill &&
      !SlashCommandUtil.shouldPreferNativeSlashCommand(command, runtime.state, preferredWebNativeCommands) &&
      agentAdvertisedCommand
    ) {
      this.submitAgentPrompt(runtime, text, { suppressLocalEcho: true });
      return;
    }
    if (builtinCommandDisabled) {
      this.submitAgentPrompt(runtime, text, agentAdvertisedCommand ? { suppressLocalEcho: true } : undefined);
      return;
    }
    if (builtinSkill) {
      await this.submitBuiltinSkill(runtime, builtinSkill, SlashCommandUtil.slashCommandUserMessage(text) ?? "");
      return;
    }
    switch (command) {
      case "new":
        await this.createThread(false, arg || undefined);
        break;
      case "clear":
        runtime.state.blocks = [];
        runtime.adapter.addBlock({
          type: "info",
          id: nextBlockId(),
          content: "Cleared web transcript",
          variant: "info",
        });
        break;
      case "cancel":
        await this.cancelRuntime(runtime);
        break;
      case "threads":
        runtime.adapter.addBlock({
          type: "info",
          id: nextBlockId(),
          content: this.visibleThreads()
            .map((thread) => `${thread.id === this.activeThreadId ? "•" : " "} ${thread.title} (${thread.status})`)
            .join("\n"),
          variant: "info",
        });
        break;
      case "models":
        runtime.adapter.addBlock({
          type: "info",
          id: nextBlockId(),
          content: runtime.state.availableModels.length
            ? runtime.state.availableModels
                .map(
                  (model) =>
                    `${model.modelId === runtime.state.modelId ? "•" : " "} ${model.name} ${model.description ?? ""}`,
                )
                .join("\n")
            : "No model switcher advertised by this agent.",
          variant: "info",
        });
        break;
      case "model":
        if (!arg)
          runtime.adapter.addBlock({
            type: "info",
            id: nextBlockId(),
            content: "Usage: /model <model-id>",
            variant: "warning",
          });
        else await this.switchModel(runtime, arg);
        break;
      case "thinking": {
        if (!arg) {
          runtime.adapter.addBlock({
            type: "info",
            id: nextBlockId(),
            content: runtime.state.availableThinkingLevels.length
              ? runtime.state.availableThinkingLevels
                  .map(
                    (thinkingLevel) =>
                      `${thinkingLevel.id === runtime.state.thinkingLevel ? "•" : " "} ${thinkingLevelLabel(
                        thinkingLevel.id,
                      )} ${thinkingLevel.description ?? ""}`,
                  )
                  .join("\n")
              : "No thinking level switcher advertised by this agent.",
            variant: "info",
          });
          break;
        }
        const thinkingLevel = parseThinkingLevel(arg);
        if (!thinkingLevel) {
          runtime.adapter.addBlock({
            type: "info",
            id: nextBlockId(),
            content: "Usage: /thinking <value>",
            variant: "warning",
          });
          break;
        }
        await this.switchThinking(runtime, thinkingLevel);
        break;
      }
      case "modes":
        runtime.adapter.addBlock({
          type: "info",
          id: nextBlockId(),
          content: runtime.state.availableModes.length
            ? runtime.state.availableModes
                .map((mode) => `${mode.id === runtime.state.modeId ? "•" : " "} ${mode.name} ${mode.description ?? ""}`)
                .join("\n")
            : "No mode switcher advertised by this agent.",
          variant: "info",
        });
        break;
      case "mode":
        if (!arg)
          runtime.adapter.addBlock({
            type: "info",
            id: nextBlockId(),
            content: "Usage: /mode <mode-id>",
            variant: "warning",
          });
        else await this.switchMode(runtime, arg);
        break;
      case "resume":
        if (!arg) {
          runtime.adapter.addBlock({
            type: "info",
            id: nextBlockId(),
            content: "Usage: /resume <session-id>",
            variant: "warning",
          });
        } else if (!runtime.client) {
          runtime.adapter.addBlock({
            type: "info",
            id: nextBlockId(),
            content: "No ACP agent is connected",
            variant: "error",
          });
        } else if (!runtime.client.supportsSessionLoad() && !runtime.client.supportsSessionResume()) {
          runtime.adapter.addBlock({
            type: "info",
            id: nextBlockId(),
            content: "This ACP agent did not advertise session/load or session/resume.",
            variant: "warning",
          });
        } else {
          try {
            runtime.state.blocks = [];
            runtime.pendingApprovals.clear();
            runtime.pendingElicitations.clear();
            const { result, updates } = await this.loadOrResumeRuntimeSession(runtime, arg);
            this.updateThread(runtime.info.id, { sessionId: result.sessionId ?? arg, status: "paused" });
            applySessionCapabilities(capabilitiesAdapterFor(runtime), result, { replace: true });
            runtime.adapter.addBlock({
              type: "info",
              id: nextBlockId(),
              content: `Resumed session: ${result.sessionId ?? arg}`,
              variant: "info",
            });
            this.replayRuntimeSessionUpdates(runtime, updates);
          } catch (err) {
            runtime.adapter.addBlock({
              type: "info",
              id: nextBlockId(),
              content: `Failed to resume session: ${err instanceof Error ? err.message : String(err)}`,
              variant: "error",
            });
          }
        }
        break;
      case "settings":
        runtime.adapter.addBlock({
          type: "info",
          id: nextBlockId(),
          content: "Web settings live in the prompt controls: agent, model, mode, sessions, and cancel.",
          variant: "info",
        });
        break;
      case "copy":
        runtime.adapter.addBlock({
          type: "info",
          id: nextBlockId(),
          content: "Use browser selection/copy for now. Native web clipboard copy is coming next.",
          variant: "info",
        });
        break;
      default:
        runtime.adapter.addBlock({
          type: "info",
          id: nextBlockId(),
          content: `Unknown web command: /${command}`,
          variant: "warning",
        });
    }
    this.broadcastSnapshot();
  }

  private builtinSkillCommandContext(runtime: WebThreadRuntime): RelayCommandContext {
    return {
      cwd: runtime.info.cwd,
      sessionId: runtime.client?.sessionId ?? runtime.info.sessionId ?? null,
      threadId: runtime.info.id,
      userMessageCount: runtime.state.blocks.filter((block) => block.type === "user").length,
      running: runtime.state.running,
      waitForIdle: () => Promise.resolve(),
      toast: (message, variant = "info") => {
        runtime.adapter.addBlock({
          type: "info",
          id: nextBlockId(),
          content: message,
          variant,
        });
      },
    };
  }

  private async submitBuiltinSkill(runtime: WebThreadRuntime, skill: BuiltinSkill, args: string): Promise<void> {
    const prompt = await skill.createPrompt(args, this.builtinSkillCommandContext(runtime));
    const userMessage = args.trim();
    this.submitAgentPrompt(runtime, prompt, {
      localEchoSkillInvocation: {
        name: skill.name,
        ...(userMessage ? { userMessage } : {}),
      },
    });
  }

  private availableWorktreeCandidates(): Array<{
    path: string;
    branch: string | null;
    head: string | null;
    label: string;
    description: string;
  }> {
    const usedPaths = new Set(
      [...this.threadInfos.values()]
        .filter((thread) => !thread.archived)
        .map((thread) => path.resolve(thread.worktreePath ?? thread.cwd)),
    );
    return discoverThreadWorktreeCandidates(this.cwd)
      .filter((worktree) => !worktree.bare && !usedPaths.has(path.resolve(worktree.path)))
      .map((worktree) => ({
        path: worktree.path,
        branch: worktree.branch,
        head: worktree.head,
        label: worktree.branch ?? path.basename(worktree.path),
        description: worktree.path,
      }));
  }

  private async createThreadFromExistingWorktree(worktreePath: string): Promise<void> {
    const resolvedPath = path.resolve(worktreePath);
    const found = this.availableWorktreeCandidates().find((worktree) => path.resolve(worktree.path) === resolvedPath);
    if (!found) return Promise.reject(new Error("Selected worktree is not available"));

    const now = isoNow();
    const id = threadId();
    const relaySession = this.createRelaySessionIdentity();
    const info: ThreadInfo = {
      id,
      relaySessionId: relaySession.id,
      relaySessionName: relaySession.name,
      title: found.branch ? `Worktree: ${found.branch}` : "Existing worktree",
      sessionId: null,
      agentName: this.activeAgentName,
      cwd: found.path,
      workspaceKind: "worktree",
      worktreePath: found.path,
      worktreeBranch: found.branch ?? undefined,
      status: "connecting",
      archived: false,
      managedWorktree: false,
      createdAt: now,
      updatedAt: now,
    };
    this.threadInfos.set(id, info);
    this.activeThreadId = id;
    this.syncThreadLists();
    this.persistThreads();
    this.broadcastSnapshot();
    const runtime = await this.ensureRuntime(id);
    runtime.adapter.addBlock({
      type: "info",
      id: nextBlockId(),
      content: `Existing worktree thread: ${found.path}`,
      variant: "info",
    });
  }

  private async createThread(worktree: boolean, title?: string): Promise<void> {
    const baseCwd = this.cwd;
    const now = isoNow();
    const id = threadId();
    let cwd = this.cwd;
    let worktreePath: string | undefined;
    let worktreeBranch: string | undefined;
    let managedWorktree = false;
    if (worktree) {
      const created = createRelayWorktree(baseCwd, id, getConfig().ui.thread_worktree_location);
      cwd = created.path;
      worktreePath = created.path;
      worktreeBranch = created.branch;
      managedWorktree = true;
    }
    const relaySession = this.createRelaySessionIdentity();
    const info: ThreadInfo = {
      id,
      relaySessionId: relaySession.id,
      relaySessionName: relaySession.name,
      title: title ?? (worktree ? "New worktree thread" : "New thread"),
      sessionId: null,
      agentName: this.activeAgentName,
      cwd,
      workspaceKind: worktree ? "worktree" : "local",
      worktreePath,
      worktreeBranch,
      status: "connecting",
      archived: false,
      managedWorktree,
      createdAt: now,
      updatedAt: now,
    };
    this.threadInfos.set(id, info);
    this.activeThreadId = id;
    this.syncThreadLists();
    this.persistThreads();
    this.broadcastSnapshot();
    await this.ensureRuntime(id);
  }

  private async selectThread(id: string): Promise<void> {
    if (!this.threadInfos.has(id)) return Promise.reject(new Error(`Unknown thread ${id}`));
    this.activeThreadId = id;
    this.syncThreadLists();
    this.persistThreads();
    this.broadcastSnapshot();
    await this.ensureRuntime(id);
  }

  private async archiveThread(id: string): Promise<void> {
    const info = this.threadInfos.get(id);
    if (!info) return;
    const runtime = this.runtimes.get(id);
    if (runtime) {
      await this.closeRuntimeSessionIfUnreferenced(id, info, runtime);
      await runtime.client?.disposeAsync().catch(() => undefined);
    }
    this.runtimes.delete(id);
    if (info.managedWorktree && info.worktreePath) archiveRelayWorktree(info.worktreePath, this.cwd);
    this.threadInfos.set(id, { ...info, archived: true, status: "paused", updatedAt: isoNow() });
    if (this.activeThreadId === id) {
      const next = this.visibleThreads()[0];
      this.activeThreadId = next?.id ?? null;
      if (!next) await this.createThread(false);
      else await this.ensureRuntime(next.id);
    }
    this.syncThreadLists();
    this.persistThreads();
    this.broadcastSnapshot();
  }

  private sessionReferencedByOtherVisibleThread(threadId: string, sessionId: string): boolean {
    return [...this.threadInfos.values()].some(
      (thread) => thread.id !== threadId && !thread.archived && thread.sessionId === sessionId,
    );
  }

  private async closeRuntimeSessionIfUnreferenced(
    threadId: string,
    info: ThreadInfo,
    runtime: WebThreadRuntime,
  ): Promise<void> {
    const client = runtime.client;
    const sessionId = info.sessionId ?? client?.sessionId ?? null;
    if (!sessionId || !client?.supportsSessionClose()) return;
    if (this.sessionReferencedByOtherVisibleThread(threadId, sessionId)) return;
    await client.closeSession(sessionId).catch(() => undefined);
  }

  private async cancelRuntime(runtime: WebThreadRuntime): Promise<void> {
    runtime.userBashAbortController?.abort();
    if (!runtime.client || !runtime.state.running) return;
    runtime.promptRunId += 1;
    this.stopElapsedTimer(runtime);
    await runtime.client.cancel().catch(() => undefined);
    runtime.adapter.addBlock({ type: "info", id: nextBlockId(), content: "Interrupted by user", variant: "info" });
    runtime.state.running = false;
    runtime.state.spinnerActive = false;
    runtime.state.currentBlockId = null;
    this.updateThread(runtime.info.id, {
      status: "paused",
      ...(runtime.info.parentThreadId
        ? { childTaskStatus: "interrupted" as const, childTaskFinishedAt: isoNow() }
        : {}),
    });
    if (runtime.info.parentThreadId) {
      await this.publishWebChildCompletion(runtime, "interrupted", "Child session was interrupted.");
    }
  }

  private async switchMode(runtime: WebThreadRuntime, modeId: string): Promise<void> {
    await runtime.client?.setSessionMode(modeId);
    runtime.state.modeId = modeId;
    runtime.adapter.addBlock({ type: "info", id: nextBlockId(), content: `Mode: ${modeId}`, variant: "info" });
    this.broadcastSnapshot();
  }

  private async switchModel(runtime: WebThreadRuntime, modelId: string): Promise<void> {
    const modelConfigId = runtime.state.modelConfigId;
    if (!modelConfigId) {
      runtime.adapter.addBlock({
        type: "info",
        id: nextBlockId(),
        content: "No ACP model switcher advertised by this agent.",
        variant: "warning",
      });
      return;
    }
    if (
      runtime.state.availableModels.length > 0 &&
      !runtime.state.availableModels.some((option) => option.modelId === modelId)
    ) {
      runtime.adapter.addBlock({
        type: "info",
        id: nextBlockId(),
        content: `Model "${modelId}" was not advertised by this agent.`,
        variant: "warning",
      });
      return;
    }
    await runtime.client?.setSessionModel(modelId, modelConfigId);
    runtime.state.modelId = modelId;
    runtime.adapter.addBlock({ type: "info", id: nextBlockId(), content: `Model: ${modelId}`, variant: "info" });
    this.broadcastSnapshot();
  }

  /** Apply the launch `--thinking-level` override (if set) to a freshly created web session. */
  private async applyLaunchThinking(runtime: WebThreadRuntime): Promise<void> {
    const thinkingLevel = parseThinkingLevel(this.opts.thinkingLevel);
    if (!thinkingLevel) return;
    if (runtime.state.thinkingLevel === thinkingLevel) return;
    const available = runtime.state.availableThinkingLevels;
    if (!runtime.state.thinkingConfigId || available.length === 0) return;
    if (!available.some((level) => level.id === thinkingLevel)) {
      runtime.adapter.addBlock({
        type: "info",
        id: nextBlockId(),
        content: `Requested thinking level "${thinkingLevelLabel(thinkingLevel)}" is not available; using ${
          runtime.state.thinkingLevel ? thinkingLevelLabel(runtime.state.thinkingLevel) : "the default thinking level"
        }.`,
        variant: "warning",
      });
      return;
    }
    try {
      await this.switchThinking(runtime, thinkingLevel);
    } catch (err) {
      runtime.adapter.addBlock({
        type: "info",
        id: nextBlockId(),
        content: `Requested thinking level could not be applied; using ${
          runtime.state.thinkingLevel ? thinkingLevelLabel(runtime.state.thinkingLevel) : "the default thinking level"
        }: ${err instanceof Error ? err.message : String(err)}`,
        variant: "warning",
      });
    }
  }

  private async switchThinking(
    runtime: WebThreadRuntime,
    thinkingLevel: ReturnType<typeof parseThinkingLevel>,
  ): Promise<void> {
    if (!thinkingLevel) return;
    if (!runtime.state.thinkingConfigId) {
      runtime.adapter.addBlock({
        type: "info",
        id: nextBlockId(),
        content: "No ACP thinking level switcher advertised by this agent.",
        variant: "warning",
      });
      return;
    }
    if (!runtime.state.availableThinkingLevels.some((option) => option.id === thinkingLevel)) {
      runtime.adapter.addBlock({
        type: "info",
        id: nextBlockId(),
        content: `Thinking level "${thinkingLevel}" was not advertised by this agent.`,
        variant: "warning",
      });
      return;
    }
    await runtime.client?.setSessionThinkingLevel(thinkingLevel, runtime.state.thinkingConfigId);
    runtime.state.thinkingLevel = thinkingLevel;
    runtime.adapter.addBlock({
      type: "info",
      id: nextBlockId(),
      content: `Thinking: ${thinkingLevelLabel(thinkingLevel)}`,
      variant: "info",
    });
    this.broadcastSnapshot();
  }

  private async listSessions(runtime: WebThreadRuntime): Promise<void> {
    if (!runtime.client) return;
    this.sessionsCache.loading = true;
    this.sessionsCache.error = null;
    this.broadcastSnapshot();
    try {
      const sessions = resumableSessions(
        await runtime.client.listSessions(),
        resolveAgentBehaviorProfileForLaunchAgent(this.agentForThread(runtime.info)).sessionListPolicy,
      );
      this.sessionsCache.items = sessions;
      runtime.adapter.addBlock({
        type: "info",
        id: nextBlockId(),
        content: sessions.length
          ? sessions.map((session) => `${session.title || session.sessionId} · ${session.sessionId}`).join("\n")
          : "No sessions returned by the agent.",
        variant: "info",
      });
    } catch (err) {
      this.sessionsCache.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.sessionsCache.loading = false;
      this.broadcastSnapshot();
    }
  }

  private async switchAgent(agentName: string): Promise<void> {
    const nextAgent = this.resolveAgent(agentName, undefined);
    for (const info of this.threadInfos.values()) info.agentName = nextAgent.name;
    this.persistThreads();
    for (const runtime of this.runtimes.values()) {
      this.stopElapsedTimer(runtime);
      runtime.userBashAbortController?.abort();
      await runtime.client?.disposeAsync().catch(() => undefined);
    }
    this.runtimes.clear();
    this.threadInfos.clear();
    this.activeThreadId = null;
    this.resolvedAgent = nextAgent;
    this.activeAgentName = nextAgent.name;
    this.activeAgentBehaviorProfile = resolveAgentBehaviorProfileForLaunchAgent(nextAgent);
    await this.bootstrapThreads();
    this.broadcastSnapshot();
  }

  private async handleSocketMessage(ws: Bun.ServerWebSocket<unknown>, rawMessage: string | Buffer): Promise<void> {
    if (this.stopping) return;

    const message = typeof rawMessage === "string" ? rawMessage : rawMessage.toString("utf8");
    const command = JSON.parse(message) as WebCommand;
    const runtime = this.activeRuntime();
    switch (command.type) {
      case "prompt":
        if (runtime) await this.submitPrompt(runtime.info.id, String(command.text ?? ""));
        break;
      case "activeTurnInput":
        if (runtime) await this.sendActiveTurnInput(runtime, String(command.text ?? ""));
        break;
      case "cancel":
        if (runtime) await this.cancelRuntime(runtime);
        break;
      case "newThread":
        if (typeof command.worktreePath === "string") await this.createThreadFromExistingWorktree(command.worktreePath);
        else await this.createThread(command.worktree === true);
        break;
      case "selectThread":
        if (typeof command.threadId === "string") await this.selectThread(command.threadId);
        break;
      case "archiveThread":
        if (typeof command.threadId === "string") await this.archiveThread(command.threadId);
        break;
      case "approval":
        if (runtime && typeof command.blockId === "string")
          this.respondApproval(runtime, command.blockId, command.response);
        break;
      case "elicitation":
        if (runtime && typeof command.blockId === "string")
          this.respondElicitation(runtime, command.blockId, command.response);
        break;
      case "switchMode":
        if (runtime && typeof command.modeId === "string") await this.switchMode(runtime, command.modeId);
        break;
      case "switchModel":
        if (runtime && typeof command.modelId === "string") await this.switchModel(runtime, command.modelId);
        break;
      case "switchThinking": {
        const thinkingLevel = parseThinkingLevel(command.thinkingLevel);
        if (runtime && thinkingLevel) await this.switchThinking(runtime, thinkingLevel);
        break;
      }
      case "switchAgent":
        if (typeof command.agent === "string") await this.switchAgent(command.agent);
        break;
      case "listSessions":
        if (runtime) await this.listSessions(runtime);
        break;
      case "listWorktrees":
        this.send(ws, { type: "worktreeCandidates", items: this.availableWorktreeCandidates() });
        break;
      case "pathComplete":
        if (runtime && typeof command.requestId === "string") {
          this.send(ws, {
            type: "pathCompletions",
            requestId: command.requestId,
            items: this.completePaths(runtime.info.cwd, String(command.query ?? "")),
          });
        }
        break;
    }
  }

  private async sendActiveTurnInput(runtime: WebThreadRuntime, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!runtime.client || !runtime.state.running || !runtime.client.supportsActiveTurnInput()) {
      this.queuePrompt(runtime, trimmed);
      return;
    }
    const result = await runtime.client.sendActiveTurnInput(trimmed);
    if (result.accepted) {
      runtime.adapter.addBlock({
        type: "user",
        id: nextBlockId(),
        content: trimmed,
        delivery: "current-turn-guidance",
      });
    } else {
      this.queuePrompt(runtime, trimmed);
    }
    this.broadcastSnapshot();
  }

  private completePaths(
    cwd: string,
    query: string,
  ): Array<{ label: string; value: string; detail: string; kind: "file" | "directory" }> {
    const normalized = query.replace(/^@/, "").replace(/\\/g, "/");
    const dirname = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/") + 1) : "";
    const basename = normalized.slice(dirname.length).toLowerCase();
    const root = path.resolve(cwd);
    const baseDir = path.resolve(root, dirname || ".");
    const relative = path.relative(root, baseDir);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return [];
    try {
      return readdirSync(baseDir)
        .filter((entry) => !entry.startsWith(".") && entry.toLowerCase().includes(basename))
        .slice(0, 40)
        .map((entry) => {
          const full = path.join(baseDir, entry);
          const isDirectory = statSync(full).isDirectory();
          const value = `${dirname}${entry}${isDirectory ? "/" : ""}`;
          return {
            label: `${entry}${isDirectory ? "/" : ""}`,
            value,
            detail: isDirectory ? "directory" : "file",
            kind: isDirectory ? ("directory" as const) : ("file" as const),
          };
        })
        .sort(
          (a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.label.localeCompare(b.label),
        );
    } catch {
      return [];
    }
  }

  private approvalOptionForBlock(
    runtime: WebThreadRuntime,
    blockId: string,
    optionId: string,
  ): ApprovalOption | undefined {
    const block = runtime.state.blocks.find((candidate) => candidate.id === blockId);
    if (!block || block.type !== "tool") return undefined;
    return block.approvalOptions?.find((option) => option.optionId === optionId);
  }

  private approvalSelectionForResponse(
    runtime: WebThreadRuntime,
    blockId: string,
    response: unknown,
  ): ApprovalSelection {
    const optionId = isRecord(response) && typeof response.optionId === "string" ? response.optionId : undefined;
    const option = optionId ? this.approvalOptionForBlock(runtime, blockId, optionId) : undefined;
    if (option) return option;
    return ApprovalResponse.DENY;
  }

  private respondApproval(runtime: WebThreadRuntime, blockId: string, response: unknown): void {
    const respond = runtime.pendingApprovals.get(blockId);
    if (!respond) return;
    runtime.pendingApprovals.delete(blockId);
    const normalized = this.approvalSelectionForResponse(runtime, blockId, response);
    respond(normalized);
    runtime.adapter.updateBlock(blockId, {
      status: isApprovalSelectionAllow(normalized) ? "running" : "error",
      resolveApproval: undefined,
    } as Partial<ChatBlock>);
  }

  private respondElicitation(runtime: WebThreadRuntime, blockId: string, response: unknown): void {
    const respond = runtime.pendingElicitations.get(blockId);
    if (!respond) return;
    runtime.pendingElicitations.delete(blockId);
    const normalized = isRecord(response) ? response : { action: "cancel" };
    if (normalized.action === "accept" && isRecord(normalized.content)) {
      respond({ action: "accept", content: normalized.content });
      runtime.adapter.updateBlock(blockId, { status: "accepted", answers: normalized.content } as Partial<ChatBlock>);
    } else if (normalized.action === "decline") {
      respond({ action: "decline" });
      runtime.adapter.updateBlock(blockId, { status: "declined" } as Partial<ChatBlock>);
    } else {
      respond({ action: "cancel" });
      runtime.adapter.updateBlock(blockId, { status: "cancelled" } as Partial<ChatBlock>);
    }
  }

  private liveSessionInfo(info: ThreadInfo): LiveSessionInfo {
    const parent = info.parentThreadId ? this.threadInfos.get(info.parentThreadId) : undefined;
    const control = this.liveSessionControlServer;
    return {
      id: info.relaySessionId ?? info.id,
      name: threadRelaySessionName(info),
      role: liveSessionRole(info),
      instanceId: control?.instanceId ?? "",
      threadId: info.id,
      ...(info.sessionId ? { acpSessionId: info.sessionId } : {}),
      ...(parent ? { parentSessionId: parent.relaySessionId ?? parent.id } : {}),
      ...(info.relationKind ? { relation: info.relationKind } : {}),
      title: info.title,
      cwd: info.cwd,
      agent: info.agentName ?? this.activeAgentName,
      activity: info.status === "running" ? "running" : info.status === "connecting" ? "connecting" : "idle",
      ...(info.childTaskStatus ? { taskState: info.childTaskStatus } : {}),
      ...(info.createdAt ? { createdAt: info.createdAt } : {}),
      ...(info.updatedAt ? { updatedAt: info.updatedAt } : {}),
      ...(info.latestResultPreview ? { latestResultPreview: info.latestResultPreview } : {}),
      ...(info.childTaskType ? { taskType: info.childTaskType } : {}),
      ...(info.modelId ? { model: info.modelId } : {}),
      ...(info.thinkingLevel ? { thinkingLevel: info.thinkingLevel } : {}),
    };
  }

  private runtimeByRelaySessionId(sessionId: string): WebThreadRuntime | undefined {
    return [...this.runtimes.values()].find(
      (runtime) =>
        !runtime.info.archived &&
        runtime.client !== null &&
        (runtime.info.relaySessionId ?? runtime.info.id) === sessionId,
    );
  }

  private runtimeByRelaySessionName(sessionName: string): WebThreadRuntime | undefined {
    return [...this.runtimes.values()].find(
      (runtime) =>
        !runtime.info.archived && runtime.client !== null && threadRelaySessionName(runtime.info) === sessionName,
    );
  }

  private requesterRuntime(params: Record<string, unknown>): WebThreadRuntime | undefined {
    const requesterSessionId = firstString(params.requesterSessionId);
    const requesterSessionName = firstString(params.requesterSessionName);
    if (!requesterSessionId && !requesterSessionName) return undefined;
    const byId = requesterSessionId ? this.runtimeByRelaySessionId(requesterSessionId) : undefined;
    const byName = requesterSessionName ? this.runtimeByRelaySessionName(requesterSessionName) : undefined;
    if (byId && byName && byId.info.id !== byName.info.id) return undefined;
    return byId ?? byName;
  }

  private hasRequesterIdentity(params: Record<string, unknown>): boolean {
    return Boolean(firstString(params.requesterSessionId) || firstString(params.requesterSessionName));
  }

  private isActiveLiveChild(runtime: WebThreadRuntime): boolean {
    if (isTerminalChildTaskStatus(runtime.info.childTaskStatus)) return false;
    return (
      runtime.info.childTaskStatus === "starting" ||
      runtime.info.childTaskStatus === "running" ||
      runtime.info.status === "connecting" ||
      runtime.info.status === "running"
    );
  }

  private activeLiveChildCount(parentThreadId: string): number {
    return [...this.runtimes.values()].filter(
      (runtime) =>
        !runtime.info.archived && runtime.info.parentThreadId === parentThreadId && this.isActiveLiveChild(runtime),
    ).length;
  }

  private reservedLiveChildCapacity(parentThreadId: string): number {
    const pendingNames = this.pendingChildNamesByParent.get(parentThreadId) ?? new Set<string>();
    const representedPendingNames = new Set(
      [...this.runtimes.values()].flatMap((runtime) =>
        !runtime.info.archived &&
        runtime.info.parentThreadId === parentThreadId &&
        this.isActiveLiveChild(runtime) &&
        runtime.info.relaySessionName &&
        pendingNames.has(runtime.info.relaySessionName)
          ? [runtime.info.relaySessionName]
          : [],
      ),
    );
    return this.activeLiveChildCount(parentThreadId) + pendingNames.size - representedPendingNames.size;
  }

  private terminalLiveChildKey(runtime: WebThreadRuntime): string {
    return `${runtime.info.id}:${runtime.info.childTaskFinishedAt ?? runtime.info.childTaskStatus ?? "terminal"}`;
  }

  private liveChildResult(runtime: WebThreadRuntime): string | undefined {
    const result =
      runtime.info.childTaskStatus === "done" ? lastAssistantResponseText(runtime.state.blocks).trim() : "";
    return result || runtime.info.latestResultPreview?.trim() || undefined;
  }

  private async publishLiveSessionInboxEvent(
    target: WebThreadRuntime,
    event: LiveSessionInboxEvent,
    notifyActive: boolean,
  ): Promise<LiveSessionMessageDelivery> {
    this.updateThread(target.info.id, {
      liveSessionInbox: appendLiveSessionInboxEvent(target.info.liveSessionInbox, event),
    });
    if (!notifyActive || !target.state.running || !target.client?.supportsActiveTurnInput()) return "queued";
    const delivery = await target.client.sendActiveTurnInput(event.content);
    if (!delivery.accepted) return "queued";
    const deliveredAt = isoNow();
    this.updateThread(target.info.id, {
      liveSessionInbox: (target.info.liveSessionInbox ?? []).map((candidate) =>
        candidate.id === event.id ? { ...candidate, deliveredAt } : candidate,
      ),
    });
    return "steered";
  }

  private async publishWebChildCompletion(
    runtime: WebThreadRuntime,
    status: ChildTaskStatus,
    result: string,
  ): Promise<void> {
    if (!runtime.info.parentThreadId) return;
    const parent = this.runtimes.get(runtime.info.parentThreadId);
    if (!parent) return;
    const event: LiveSessionInboxEvent = {
      id: `re_${uuid().replaceAll("-", "")}`,
      kind: "completion",
      sourceSessionId: runtime.info.relaySessionId ?? runtime.info.id,
      sourceSessionName: threadRelaySessionName(runtime.info),
      content: formatChildCompletionEvent(threadRelaySessionName(runtime.info), status, result),
      createdAt: isoNow(),
      childTaskStatus: status,
    };
    await this.publishLiveSessionInboxEvent(parent, event, false);

    const markForContinuation = (): void => {
      this.updateThread(parent.info.id, {
        liveSessionInbox: (parent.info.liveSessionInbox ?? []).map((candidate) =>
          candidate.id === event.id ? { ...candidate, requiresContinuation: true } : candidate,
        ),
      });
    };
    const delivery = childCompletionDelivery({
      parentRunning: parent.state.running || parent.info.status === "running",
      parentWaiting: this.waitingLiveSessionIds.has(parent.info.id),
      supportsActiveTurnInput: Boolean(parent.client?.supportsActiveTurnInput()),
    });
    if (delivery === "steer" && parent.client) {
      try {
        const steered = await parent.client.sendActiveTurnInput(event.content, parent.info.sessionId ?? undefined);
        if (steered.accepted) {
          const deliveredAt = isoNow();
          const blockId = `live-${event.id}`;
          const persistedMessage: PersistedLiveSessionMessage | undefined = parent.info.sessionId
            ? {
                id: blockId,
                acpSessionId: parent.info.sessionId,
                content: event.content,
                delivery: "current-turn-guidance",
                createdAt: deliveredAt,
              }
            : undefined;
          this.updateThread(parent.info.id, {
            liveSessionInbox: (parent.info.liveSessionInbox ?? []).map((candidate) =>
              candidate.id === event.id ? { ...candidate, deliveredAt, consumedAt: deliveredAt } : candidate,
            ),
            ...(persistedMessage
              ? { liveSessionMessages: [...(parent.info.liveSessionMessages ?? []), persistedMessage] }
              : {}),
          });
          parent.adapter.addBlock({
            type: "user",
            id: blockId,
            content: event.content,
            origin: "local",
            delivery: "current-turn-guidance",
          });
          return;
        }
      } catch {
        // The parent may have gone idle while the child was publishing its result.
      }
    }

    if (parent.state.running || parent.info.status === "running" || this.waitingLiveSessionIds.has(parent.info.id)) {
      markForContinuation();
      return;
    }
    this.submitAgentPrompt(parent, LIVE_SESSION_CONTINUATION_PROMPT, { suppressLocalEcho: true });
  }

  private attributedLiveMessageText(
    target: WebThreadRuntime,
    senderSessionId: string | undefined,
    senderSessionName: string | undefined,
    text: string,
  ): string {
    const sender = senderSessionId
      ? this.runtimeByRelaySessionId(senderSessionId)
      : senderSessionName
        ? this.runtimeByRelaySessionName(senderSessionName)
        : undefined;
    const senderName = sender ? threadRelaySessionName(sender.info) : senderSessionName;
    if (!senderName) return text;
    if (!sender) return formatLiveSessionMessage("session", senderName, text);
    return formatLiveSessionMessage(
      liveSessionMessageRelation(this.liveSessionInfo(sender.info), this.liveSessionInfo(target.info)),
      senderName,
      text,
    );
  }

  private async createLiveChild(params: Record<string, unknown>): Promise<WebThreadRuntime> {
    const parentSessionId = firstString(params.parentSessionId);
    const task = firstString(params.task);
    if (!parentSessionId || !task) throw new Error("parentSessionId and task are required"); // effect-shape-allow: web control boundary reports invalid child requests.
    const parent = this.runtimeByRelaySessionId(parentSessionId);
    if (!parent) throw new Error(`Parent session ${parentSessionId} was not found`); // effect-shape-allow: web control boundary reports missing live parent.
    if (liveSessionRole(parent.info) !== "parent") {
      throw new Error(`Child session ${threadRelaySessionName(parent.info)} cannot create sessions`); // effect-shape-allow: web control boundary enforces the two-level live-session hierarchy.
    }
    if (this.reservedLiveChildCapacity(parent.info.id) >= MAX_ACTIVE_CHILD_SESSIONS) {
      // effect-shape-allow: web control boundary reports live-session capacity.
      throw new Error(
        `Parent session ${threadRelaySessionName(parent.info)} already has ${MAX_ACTIVE_CHILD_SESSIONS} active children`,
      ); // effect-shape-allow: web control boundary reports live-session capacity.
    }
    const history =
      params.history === undefined ? { mode: "none" as const } : childSessionHistoryFromValue(params.history);
    if (!history) throw new Error("history must be none, all, or recent with positive turns"); // effect-shape-allow: web control boundary reports invalid child history.
    const openingPrompt = childSessionOpeningPrompt(
      firstString(params.openingPrompt) ?? task,
      parent.state.blocks,
      history,
      parent.state.running || parent.state.connecting,
    );
    const id = threadId();
    const worktree =
      params.worktree === true ? createRelayWorktree(this.cwd, id, getConfig().ui.thread_worktree_location) : undefined;
    const now = isoNow();
    const requestedName = firstString(params.name);
    const relaySession = this.createRelaySessionIdentity(requestedName);
    const parentAgent = parent.info.agentName ?? this.activeAgentName;
    const agentName = firstString(params.agent) ?? parentAgent;
    const inheritsParentConfiguration = agentName === parentAgent;
    const model =
      firstString(params.model) ??
      (inheritsParentConfiguration ? parent.state.modelId || parent.info.modelId : undefined);
    const thinkingLevel =
      firstString(params.thinkingLevel) ??
      (inheritsParentConfiguration ? parent.state.thinkingLevel || parent.info.thinkingLevel : undefined);
    this.pendingLiveSessionNames.add(relaySession.name);
    const pendingChildNames = this.pendingChildNamesByParent.get(parent.info.id) ?? new Set<string>();
    pendingChildNames.add(relaySession.name);
    this.pendingChildNamesByParent.set(parent.info.id, pendingChildNames);
    try {
      const info: ThreadInfo = {
        id,
        relaySessionId: relaySession.id,
        relaySessionName: relaySession.name,
        title: requestedName ?? summarizeThreadRequest(task),
        sessionId: null,
        parentThreadId: parent.info.id,
        relationKind: params.relation === "handoff" ? "handoff" : "child",
        relationGoal: task,
        relationCreatedAt: now,
        childTaskStatus: "starting",
        ...(firstString(params.taskType) ? { childTaskType: firstString(params.taskType) } : {}),
        agentName,
        ...(model ? { modelId: model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        cwd: worktree?.path ?? parent.info.cwd,
        workspaceKind: worktree ? "worktree" : "local",
        worktreePath: worktree?.path,
        worktreeBranch: worktree?.branch,
        managedWorktree: Boolean(worktree),
        status: "connecting",
        archived: false,
        createdAt: now,
        updatedAt: now,
      };
      this.threadInfos.set(id, info);
      this.syncThreadLists();
      this.persistThreads();
      const runtime = await this.ensureRuntime(id);
      if (parent.info.sessionId && runtime.info.sessionId) {
        this.updateThread(id, {
          relationParentSessionId: parent.info.sessionId,
          relationChildSessionId: runtime.info.sessionId,
        });
      }
      this.submitAgentPrompt(runtime, openingPrompt);
      return runtime;
    } finally {
      this.pendingLiveSessionNames.delete(relaySession.name);
      const remainingNames = this.pendingChildNamesByParent.get(parent.info.id);
      remainingNames?.delete(relaySession.name);
      if (remainingNames?.size === 0) this.pendingChildNamesByParent.delete(parent.info.id);
    }
  }

  private async handleLiveSessionControlRequest(
    request: LiveSessionControlRequest,
  ): Promise<LiveSessionControlResponse> {
    if (request.method === "session.list") {
      const params = request.params ?? {};
      const requester = this.requesterRuntime(params);
      if (this.hasRequesterIdentity(params) && !requester) {
        return liveControlFailure(
          request.requestId,
          "requester_not_found",
          "The requesting Relay session was not found",
        );
      }
      return liveControlSuccess(request.requestId, {
        sessions: [...this.runtimes.values()]
          .filter((runtime) => !runtime.info.archived && runtime.client !== null)
          .map((runtime) => this.liveSessionInfo(runtime.info))
          .filter((session) => !requester || isLiveSessionVisibleTo(this.liveSessionInfo(requester.info), session)),
      });
    }
    if (request.method === "session.inspect") {
      const params = request.params ?? {};
      const targetSessionId = firstString(params.targetSessionId);
      if (!targetSessionId) {
        return liveControlFailure(request.requestId, "invalid_request", "targetSessionId is required");
      }
      const target = this.runtimeByRelaySessionId(targetSessionId);
      if (!target) {
        return liveControlFailure(
          request.requestId,
          "session_not_found",
          `Live session ${targetSessionId} was not found`,
        );
      }
      const history =
        params.history === undefined
          ? { mode: "recent" as const, turns: 3 }
          : childSessionHistoryFromValue(params.history);
      if (!history) {
        return liveControlFailure(
          request.requestId,
          "invalid_history",
          "history must be none, all, or recent with positive turns",
        );
      }
      const requester = this.requesterRuntime(params);
      if (this.hasRequesterIdentity(params) && !requester) {
        return liveControlFailure(
          request.requestId,
          "requester_not_found",
          "The requesting Relay session was not found",
        );
      }
      if (
        requester &&
        !canInspectLiveSession(this.liveSessionInfo(requester.info), this.liveSessionInfo(target.info))
      ) {
        return liveControlFailure(
          request.requestId,
          "inspection_forbidden",
          `Session ${threadRelaySessionName(requester.info)} may inspect only itself and its direct children`,
        );
      }
      try {
        return liveControlSuccess(request.requestId, {
          session: this.liveSessionInfo(target.info),
          history: childSessionHistoryLabel(history),
          turns: inspectedSessionContextTurns(
            target.state.blocks,
            history,
            target.state.running || target.state.connecting,
          ),
        });
      } catch (error) {
        return liveControlFailure(
          request.requestId,
          "inspection_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (request.method === "session.createChild") {
      const params = request.params ?? {};
      const requester = this.requesterRuntime(params);
      if (this.hasRequesterIdentity(params) && !requester) {
        return liveControlFailure(
          request.requestId,
          "requester_not_found",
          "The requesting Relay session was not found",
        );
      }
      const parentSessionId = firstString(params.parentSessionId);
      const requestedParent = parentSessionId ? this.runtimeByRelaySessionId(parentSessionId) : undefined;
      if (
        requester &&
        (liveSessionRole(requester.info) !== "parent" || requester.info.id !== requestedParent?.info.id)
      ) {
        return liveControlFailure(
          request.requestId,
          "child_creation_forbidden",
          `Session ${threadRelaySessionName(requester.info)} cannot create a child for ${parentSessionId ?? "unknown"}`,
        );
      }
      try {
        const requestedName = firstString(params.name);
        const task = firstString(params.task);
        if (requestedName && task) {
          const normalizedName = normalizeRelaySessionName(requestedName);
          const existing = this.runtimeByRelaySessionName(normalizedName);
          if (
            existing &&
            existing.info.parentThreadId === requestedParent?.info.id &&
            existing.info.relationGoal === task
          ) {
            return liveControlSuccess(request.requestId, {
              session: this.liveSessionInfo(existing.info),
              replayed: true,
            });
          }
        }
        const child = await this.createLiveChild(params);
        return liveControlSuccess(request.requestId, { session: this.liveSessionInfo(child.info) });
      } catch (error) {
        return liveControlFailure(
          request.requestId,
          "child_start_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (request.method === "session.wait") {
      const params = request.params ?? {};
      const targetSessionId = firstString(params.targetSessionId);
      const requester = this.requesterRuntime(params);
      if (this.hasRequesterIdentity(params) && !requester) {
        return liveControlFailure(
          request.requestId,
          "requester_not_found",
          "The requesting Relay session was not found",
        );
      }
      if (!targetSessionId && (!requester || liveSessionRole(requester.info) !== "parent")) {
        return liveControlFailure(
          request.requestId,
          "wait_forbidden",
          "Waiting for the next child requires a managed parent session",
        );
      }
      const target = targetSessionId ? this.runtimeByRelaySessionId(targetSessionId) : undefined;
      if (targetSessionId && !target) {
        return liveControlFailure(
          request.requestId,
          "session_not_found",
          `Live session ${targetSessionId} was not found`,
        );
      }
      if (
        requester &&
        target &&
        !canInspectLiveSession(this.liveSessionInfo(requester.info), this.liveSessionInfo(target.info))
      ) {
        return liveControlFailure(
          request.requestId,
          "wait_forbidden",
          `Session ${threadRelaySessionName(requester.info)} cannot wait for ${threadRelaySessionName(target.info)}`,
        );
      }
      const timeoutValue = params.timeoutMs ?? LIVE_SESSION_WAIT_DEFAULT_MS;
      if (
        typeof timeoutValue !== "number" ||
        !Number.isFinite(timeoutValue) ||
        timeoutValue < LIVE_SESSION_WAIT_MIN_MS ||
        timeoutValue > LIVE_SESSION_WAIT_MAX_MS
      ) {
        return liveControlFailure(
          request.requestId,
          "invalid_timeout",
          `timeoutMs must be between ${LIVE_SESSION_WAIT_MIN_MS} and ${LIVE_SESSION_WAIT_MAX_MS}`,
        );
      }

      if (requester) this.waitingLiveSessionIds.add(requester.info.id);
      const finishWait = (response: LiveSessionControlResponse): LiveSessionControlResponse => {
        if (requester) this.waitingLiveSessionIds.delete(requester.info.id);
        return response;
      };
      const reported = requester
        ? (this.reportedTerminalChildrenByParent.get(requester.info.id) ?? new Set<string>())
        : new Set<string>();
      if (requester) this.reportedTerminalChildrenByParent.set(requester.info.id, reported);
      const candidates = (): WebThreadRuntime[] =>
        targetSessionId
          ? ([this.runtimeByRelaySessionId(targetSessionId)].filter(Boolean) as WebThreadRuntime[])
          : [...this.runtimes.values()].filter(
              (runtime) =>
                !runtime.info.archived && runtime.info.parentThreadId === requester?.info.id && runtime.client !== null,
            );
      const completed = (): WebThreadRuntime | undefined =>
        candidates().find(
          (runtime) =>
            isTerminalChildTaskStatus(runtime.info.childTaskStatus) &&
            (targetSessionId !== undefined || !reported.has(this.terminalLiveChildKey(runtime))),
        );
      const inboxEvent = (): LiveSessionInboxEvent | undefined => {
        if (!requester) return undefined;
        const sourceIds = new Set(candidates().map((runtime) => runtime.info.relaySessionId ?? runtime.info.id));
        return (requester.info.liveSessionInbox ?? []).find(
          (event) => !event.consumedAt && sourceIds.has(event.sourceSessionId),
        );
      };
      const inboxResponse = (event: LiveSessionInboxEvent, startedAt: number): LiveSessionControlResponse => {
        if (!requester) {
          return liveControlFailure(request.requestId, "wait_forbidden", "A parent session is required");
        }
        this.updateThread(requester.info.id, {
          liveSessionInbox: (requester.info.liveSessionInbox ?? []).map((candidate) =>
            candidate.id === event.id ? { ...candidate, requiresContinuation: true } : candidate,
          ),
        });
        const source = this.runtimeByRelaySessionId(event.sourceSessionId);
        if (source && event.kind === "completion") reported.add(this.terminalLiveChildKey(source));
        const sourceInfo = source ? this.liveSessionInfo(source.info) : undefined;
        return liveControlSuccess(request.requestId, {
          ...(sourceInfo
            ? {
                session:
                  event.kind === "completion" && event.childTaskStatus
                    ? { ...sourceInfo, taskState: event.childTaskStatus }
                    : sourceInfo,
              }
            : {}),
          outcome: event.kind === "completion" ? "terminal" : "message",
          waitedMs: nowMs() - startedAt,
          delivery: "continuation",
          result: LIVE_SESSION_CONTINUATION_ACKNOWLEDGEMENT,
        });
      };
      const terminalResponse = (runtime: WebThreadRuntime, startedAt: number): LiveSessionControlResponse => {
        reported.add(this.terminalLiveChildKey(runtime));
        const result = this.liveChildResult(runtime);
        return liveControlSuccess(request.requestId, {
          session: this.liveSessionInfo(runtime.info),
          outcome: "terminal",
          waitedMs: nowMs() - startedAt,
          delivery: "inline",
          ...(result ? { result } : {}),
        });
      };

      const startedAt = nowMs();
      const pendingEvent = inboxEvent();
      if (pendingEvent) return finishWait(inboxResponse(pendingEvent, startedAt));
      const alreadyCompleted = completed();
      if (alreadyCompleted) return finishWait(terminalResponse(alreadyCompleted, startedAt));
      if (!candidates().some((runtime) => this.isActiveLiveChild(runtime))) {
        return finishWait(liveControlSuccess(request.requestId, { outcome: "idle", waitedMs: nowMs() - startedAt }));
      }
      while (nowMs() - startedAt < timeoutValue) {
        const message = inboxEvent();
        if (message) return finishWait(inboxResponse(message, startedAt));
        const finished = completed();
        if (finished) return finishWait(terminalResponse(finished, startedAt));
        await Bun.sleep(Math.min(100, timeoutValue - (nowMs() - startedAt)));
      }
      const currentTarget = targetSessionId ? this.runtimeByRelaySessionId(targetSessionId) : undefined;
      return finishWait(
        liveControlSuccess(request.requestId, {
          ...(currentTarget ? { session: this.liveSessionInfo(currentTarget.info) } : {}),
          outcome: "timeout",
          waitedMs: nowMs() - startedAt,
        }),
      );
    }

    if (request.method === "session.cancel") {
      const params = request.params ?? {};
      const targetSessionId = firstString(params.targetSessionId);
      if (!targetSessionId) {
        return liveControlFailure(request.requestId, "invalid_request", "targetSessionId is required");
      }
      const target = this.runtimeByRelaySessionId(targetSessionId);
      if (!target) {
        return liveControlFailure(
          request.requestId,
          "session_not_found",
          `Live session ${targetSessionId} was not found`,
        );
      }
      const requester = this.requesterRuntime(params);
      if (this.hasRequesterIdentity(params) && !requester) {
        return liveControlFailure(
          request.requestId,
          "requester_not_found",
          "The requesting Relay session was not found",
        );
      }
      if (requester && !canCancelLiveSession(this.liveSessionInfo(requester.info), this.liveSessionInfo(target.info))) {
        return liveControlFailure(
          request.requestId,
          "cancel_forbidden",
          `Session ${threadRelaySessionName(requester.info)} cannot cancel ${threadRelaySessionName(target.info)}`,
        );
      }
      await this.cancelRuntime(target);
      return liveControlSuccess(request.requestId, {
        session: this.liveSessionInfo(target.info),
        cancelled: true,
      });
    }

    const params = request.params ?? {};
    const targetSessionId = firstString(params.targetSessionId);
    const text = firstString(params.text);
    const requestedDelivery = firstString(params.delivery) ?? "mailbox";
    if (!["mailbox", "steer", "turn", "auto", "next"].includes(requestedDelivery)) {
      return liveControlFailure(
        request.requestId,
        "invalid_delivery",
        `Unsupported delivery mode ${requestedDelivery}`,
      );
    }
    if (!targetSessionId || !text) {
      return liveControlFailure(request.requestId, "invalid_request", "targetSessionId and text are required");
    }
    if (new TextEncoder().encode(text).byteLength > LIVE_SESSION_MESSAGE_MAX_BYTES) {
      return liveControlFailure(
        request.requestId,
        "message_too_large",
        `Messages may not exceed ${LIVE_SESSION_MESSAGE_MAX_BYTES} bytes`,
      );
    }
    const runtime = this.runtimeByRelaySessionId(targetSessionId);
    if (!runtime) {
      return liveControlFailure(
        request.requestId,
        "session_not_found",
        `Live session ${targetSessionId} was not found`,
      );
    }
    const senderSessionId = firstString(params.senderSessionId);
    const senderSessionName = firstString(params.senderSessionName);
    const hasSenderIdentity = Boolean(senderSessionId || senderSessionName);
    const sender = senderSessionId
      ? this.runtimeByRelaySessionId(senderSessionId)
      : senderSessionName
        ? this.runtimeByRelaySessionName(senderSessionName)
        : undefined;
    if (hasSenderIdentity && !sender) {
      return liveControlFailure(request.requestId, "sender_not_found", "The sending Relay session was not found");
    }
    if (sender?.info.id === runtime.info.id) {
      return liveControlFailure(
        request.requestId,
        "self_message_rejected",
        `Session ${threadRelaySessionName(runtime.info)} cannot message itself`,
      );
    }
    if (sender && !canMessageLiveSession(this.liveSessionInfo(sender.info), this.liveSessionInfo(runtime.info))) {
      return liveControlFailure(
        request.requestId,
        "message_forbidden",
        `Session ${threadRelaySessionName(sender.info)} cannot message ${threadRelaySessionName(runtime.info)}`,
      );
    }
    const delivery =
      requestedDelivery === "next"
        ? "turn"
        : requestedDelivery === "auto"
          ? runtime.state.running
            ? "steer"
            : "turn"
          : requestedDelivery;
    const attributedText = this.attributedLiveMessageText(runtime, senderSessionId, senderSessionName, text);
    if (delivery === "mailbox") {
      const event: LiveSessionInboxEvent = {
        id: `re_${uuid().replaceAll("-", "")}`,
        kind: "message",
        sourceSessionId: sender?.info.relaySessionId ?? sender?.info.id ?? "external",
        sourceSessionName: sender ? threadRelaySessionName(sender.info) : "external-shell",
        content: attributedText,
        createdAt: isoNow(),
      };
      const delivered = await this.publishLiveSessionInboxEvent(
        runtime,
        event,
        Boolean(
          sender && (sender.info.parentThreadId === runtime.info.id || runtime.info.parentThreadId === sender.info.id),
        ),
      );
      const message: LiveSessionMessageResult = {
        messageId: event.id,
        targetSessionId,
        delivery: delivered,
        accepted: true,
      };
      return liveControlSuccess(request.requestId, message);
    }
    if (delivery === "steer" && !runtime.state.running) {
      return liveControlFailure(request.requestId, "session_not_running", `Session ${targetSessionId} is not running`);
    }
    if (delivery === "steer" && runtime.state.running && runtime.client?.supportsActiveTurnInput()) {
      const result = await runtime.client.sendActiveTurnInput(attributedText);
      if (result.accepted) {
        const messageId = `rm_${uuid().replaceAll("-", "")}`;
        const blockId = `live-${messageId}`;
        if (runtime.info.sessionId) {
          const persistedMessage: PersistedLiveSessionMessage = {
            id: blockId,
            acpSessionId: runtime.info.sessionId,
            content: attributedText,
            delivery: "current-turn-guidance",
            createdAt: isoNow(),
          };
          this.updateThread(runtime.info.id, {
            liveSessionMessages: [...(runtime.info.liveSessionMessages ?? []), persistedMessage],
          });
        }
        runtime.adapter.addBlock({
          type: "user",
          id: blockId,
          content: attributedText,
          origin: "local",
          delivery: "current-turn-guidance",
        });
        const message: LiveSessionMessageResult = {
          messageId,
          targetSessionId,
          delivery: "steered",
          accepted: true,
        };
        return liveControlSuccess(request.requestId, message);
      }
      if (delivery === "steer") {
        return liveControlFailure(request.requestId, "steering_rejected", result.reason ?? "Steering was rejected");
      }
    } else if (delivery === "steer") {
      return liveControlFailure(
        request.requestId,
        "steering_unsupported",
        `Session ${targetSessionId} cannot accept steering`,
      );
    }

    const queued = runtime.state.running || runtime.state.connecting;
    if (
      runtime.info.parentThreadId &&
      !this.isActiveLiveChild(runtime) &&
      this.reservedLiveChildCapacity(runtime.info.parentThreadId) >= MAX_ACTIVE_CHILD_SESSIONS
    ) {
      return liveControlFailure(
        request.requestId,
        "capacity",
        `Parent session already has ${MAX_ACTIVE_CHILD_SESSIONS} active children`,
      );
    }
    if (queued && !this.queuePrompt(runtime, attributedText)) {
      return liveControlFailure(
        request.requestId,
        "mailbox_full",
        `Session ${targetSessionId} cannot accept another message`,
      );
    }
    if (!queued) this.submitAgentPrompt(runtime, attributedText);
    const message: LiveSessionMessageResult = {
      messageId: `rm_${uuid().replaceAll("-", "")}`,
      targetSessionId,
      delivery: queued ? "queued" : "started_turn",
      accepted: true,
    };
    return liveControlSuccess(request.requestId, message);
  }

  private snapshot(): Record<string, unknown> {
    const active = this.activeRuntime();
    const agents = listAvailableAgentNames();
    return safeClone({
      version: VERSION,
      cwd: this.cwd,
      agent: this.activeAgentName,
      agents,
      threads: this.visibleThreads(),
      activeThreadId: this.activeThreadId,
      state: active?.state ?? createInitialState(this.cwd),
      status: active ? statusLabel(active.state) : "Starting…",
      availableCommands: active?.state.availableCommands ?? [],
      sessions: this.sessionsCache,
      disabledBuiltinSlashCommands: getConfig().ui.disabled_builtin_slash_commands,
    }) as Record<string, unknown>;
  }

  private send(ws: Bun.ServerWebSocket<unknown>, value: unknown): void {
    try {
      ws.send(JSON.stringify(safeClone(value)));
    } catch {
      // Ignore stale sockets.
    }
  }

  private broadcastSnapshot(): void {
    const snapshot = this.snapshot();
    for (const socket of this.sockets) this.send(socket, { type: "snapshot", snapshot });
  }

  private fetch(request: Request, server: Bun.Server<unknown>): Response {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(request, { data: {} })) return new Response(null, { status: 101 });
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    if (!this.webAssets) return new Response("Web assets are not ready", { status: 503 });
    // Assets are rebundled from source on every server start, so never let the
    // browser reuse a stale cached copy — otherwise UI changes appear to "not apply".
    const noCache = "no-cache, no-store, must-revalidate";
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(this.webAssets.indexHtml, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": noCache },
      });
    }
    if (url.pathname === "/styles.css") {
      return new Response(this.webAssets.stylesCss, {
        headers: { "content-type": "text/css; charset=utf-8", "cache-control": noCache },
      });
    }
    if (url.pathname === "/client.js") {
      return new Response(this.webAssets.clientJs, {
        headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": noCache },
      });
    }
    if (url.pathname === "/api/snapshot") {
      return Response.json(this.snapshot());
    }
    return new Response("Not found", { status: 404 });
  }
}

export function launchWeb(opts: LaunchWebOptions = {}): Promise<void> {
  const server = new WebRelayServer(opts);
  return server.start().then(() => {
    let shutdownPromise: Promise<void> | null = null;
    const shutdown = () => {
      if (shutdownPromise) return;
      shutdownPromise = server.stop().finally(() => {
        process.off("SIGHUP", shutdown);
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        process.exit(0);
      });
    };
    process.on("SIGHUP", shutdown);
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
