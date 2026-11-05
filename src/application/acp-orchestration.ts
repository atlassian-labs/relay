import { Effect, Option } from "effect";
import { getConfigLoadResult, resolveConfiguredAgent, resolveInlineAcpAgentProfile } from "../config";
import { getRelayLogger } from "../logging/logger";
import { runEffect } from "../effect/runtime";
import { nextBlockId, type ChatBlock } from "../core/conversation";
import { resolveAgentBehaviorProfile, type AgentBehaviorProfile } from "../acp/agent-profile";
import {
  AcpClient,
  latestAvailableCommandsFromUpdates,
  type AcpClientOptions,
  type AcpLaunchOptions,
  type AcpProcessExitEvent,
  type LoadSessionHistoryOptions,
} from "../acp/client";
import type { RelayAuthMethod } from "../acp/capabilities";
import type { RelaySessionUpdate } from "../acp/sdk";
import { applyAcpSessionUpdate, finalizeAcpPrompt, type AcpConversationAdapter } from "./acp-mapping";
import { formatUnexpectedProcessExitMessage, promptErrorRaceDelay } from "../acp/process-exit";

export const AGENT_CONNECT_TIMEOUT_MS = 60_000;

export const MISSING_AGENT_CONFIGURATION_MESSAGE =
  "No agent configured. Set [agents].default in ~/.config/relay/config.toml or launch with --agent <name>.";

export type ResolvedAcpLaunchAgent = NonNullable<ReturnType<typeof resolveConfiguredAgent>> & {
  readonly shell?: boolean;
};

export type LoadedAcpSessionHistory = Awaited<ReturnType<AcpClient["loadSessionHistory"]>>;
export type LatestAcpAvailableCommands = NonNullable<ReturnType<typeof latestAvailableCommandsFromUpdates>>;

export interface AcpClientCapabilityFlags {
  readonly sessionForkAvailable: boolean;
  readonly sessionListAvailable: boolean;
  readonly sessionLoadAvailable: boolean;
  readonly sessionResumeAvailable: boolean;
  readonly authMethods: readonly RelayAuthMethod[];
  readonly authLogoutAvailable: boolean;
}

export interface LoadOrResumeAcpSessionHistoryOptions extends LoadSessionHistoryOptions {
  readonly onLoadedSessionId?: (sessionId: string) => void;
}

export interface ReplayAcpSessionUpdatesOptions {
  readonly onAvailableCommands?: (commands: LatestAcpAvailableCommands) => void;
  readonly finalize?: boolean;
}

export type AcpSessionStartKind = "new" | "load" | "resume";
export type StartedAcpSession = LoadedAcpSessionHistory & {
  readonly kind: AcpSessionStartKind;
};

export interface StartAcpSessionOptions extends LoadOrResumeAcpSessionHistoryOptions {
  readonly cwd: string;
  readonly sessionId?: string | null;
  readonly additionalDirectories?: readonly string[];
  readonly replayHistory?: boolean;
}

export interface RunAcpPromptTurnOptions {
  readonly prompt: () => Promise<unknown>;
  readonly isCurrent?: () => boolean;
  readonly onComplete: (response: unknown) => void | Promise<void>;
  readonly onError: (error: unknown, promptError: string) => void | Promise<void>;
  readonly onSettled?: () => void;
}

function hasAuthMethods(client: AcpClient | null): client is AcpClient {
  return typeof client?.authMethods === "function";
}

function hasAuthLogoutSupport(client: AcpClient | null): client is AcpClient {
  return typeof client?.supportsAuthLogout === "function";
}

export function acpClientCapabilityFlags(client: AcpClient | null): AcpClientCapabilityFlags {
  return {
    sessionForkAvailable: client?.supportsSessionFork() ?? false,
    sessionListAvailable: client?.supportsSessionList() ?? false,
    sessionLoadAvailable: client?.supportsSessionLoad() ?? false,
    sessionResumeAvailable: client?.supportsSessionResume?.() ?? false,
    authMethods: hasAuthMethods(client) ? [...client.authMethods()] : [],
    authLogoutAvailable: hasAuthLogoutSupport(client) ? client.supportsAuthLogout() : false,
  };
}

export function resolveAcpLaunchAgent(agentName?: string, acpCommand?: string): ResolvedAcpLaunchAgent | null {
  if (acpCommand) {
    const inlineProfile = resolveInlineAcpAgentProfile(agentName ?? "", acpCommand);
    return {
      name: inlineProfile.name,
      transport: "stdio",
      command: acpCommand,
      args: [],
      profile: inlineProfile.profile,
      internalSessionTitleAliases: inlineProfile.internalSessionTitleAliases,
      shell: true,
    };
  }
  return resolveConfiguredAgent(agentName) as ResolvedAcpLaunchAgent | null;
}

export function missingAcpLaunchAgentErrorMessage(agentName?: string): string {
  const requestedAgentName = agentName?.trim();
  if (!requestedAgentName) return MISSING_AGENT_CONFIGURATION_MESSAGE;
  const configFile = getConfigLoadResult().filePath;
  return `No agent runner configured for: ${requestedAgentName}. Config file: ${configFile}`;
}

export function resolveAgentBehaviorProfileForLaunchAgent(agent?: ResolvedAcpLaunchAgent | null): AgentBehaviorProfile {
  return resolveAgentBehaviorProfile(agent?.profile, {
    internalSessionTitleAliases: agent?.internalSessionTitleAliases,
  });
}

export function acpLaunchOptionsForAgent(agent: ResolvedAcpLaunchAgent, cwd: string): AcpLaunchOptions {
  if ((agent.transport ?? "stdio") === "websocket") {
    return {
      cwd,
      transport: "websocket",
      url: agent.url ?? "",
      ...(agent.headers ? { headers: agent.headers } : {}),
      ...(agent.protocols ? { protocols: agent.protocols } : {}),
      ...(agent.framing ? { framing: agent.framing } : {}),
    };
  }

  return {
    cwd,
    command: agent.command,
    args: agent.args,
    shell: agent.shell ?? false,
    ...(agent.env ? { env: agent.env } : {}),
  };
}

export function acpClientOptionsForAgent(
  agent: ResolvedAcpLaunchAgent,
  cwd: string,
  agentBehaviorProfile: AgentBehaviorProfile,
): AcpClientOptions {
  return {
    ...acpLaunchOptionsForAgent(agent, cwd),
    agentBehaviorProfile,
    agentName: agent.name,
  };
}

export function connectAcpClientWithTimeout(client: AcpClient, agentName: string): Promise<void> {
  const connectEffect: Effect.Effect<void | undefined, unknown, never> =
    typeof client.connectEffect === "function" ? client.connectEffect() : Effect.tryPromise(() => client.connect());
  return runEffect(
    connectEffect.pipe(Effect.timeoutOption(`${AGENT_CONNECT_TIMEOUT_MS} millis`)).pipe(
      Effect.flatMap((result) =>
        Option.match(result, {
          onSome: () => Effect.void,
          onNone: () =>
            Effect.gen(function* () {
              getRelayLogger().error("acp.connect.timeout", {
                agentName,
                timeoutMs: AGENT_CONNECT_TIMEOUT_MS,
              });
              return yield* Effect.fail(
                new Error(`Timed out connecting to ${agentName} after ${AGENT_CONNECT_TIMEOUT_MS / 1000}s`),
              );
            }),
        }),
      ),
    ),
  );
}

export function finalizeCurrentAcpAdapterBlock(adapter: AcpConversationAdapter): void {
  const currentBlockId = adapter.state.currentBlockId;
  if (!currentBlockId) return;
  const currentBlock = adapter.state.blocks.find((block) => block.id === currentBlockId);
  if (currentBlock?.type === "content" || currentBlock?.type === "thinking") {
    adapter.updateBlock(currentBlockId, { finalized: true } as Partial<ChatBlock>);
  }
  adapter.setCurrentBlockId(null);
}

export function addAcpPromptErrorBlock(adapter: AcpConversationAdapter, message: string): void {
  finalizeCurrentAcpAdapterBlock(adapter);
  adapter.addBlock({
    type: "info",
    id: nextBlockId(),
    content: `ACP prompt error: ${message}`,
    variant: "error",
  });
}

export function addUnexpectedAcpProcessExitBlock(adapter: AcpConversationAdapter, event: AcpProcessExitEvent): string {
  finalizeCurrentAcpAdapterBlock(adapter);
  const message = formatUnexpectedProcessExitMessage(event);
  adapter.addBlock({ type: "info", id: nextBlockId(), content: message, variant: "error" });
  return message;
}

export function runAcpPromptTurn(options: RunAcpPromptTurnOptions): void {
  const isCurrent = () => options.isCurrent?.() ?? true;
  Promise.resolve()
    .then(() => options.prompt())
    .then((response) => {
      if (!isCurrent()) return;
      return options.onComplete(response);
    })
    .catch(async (error) => {
      const promptError = error instanceof Error ? error.message : String(error);
      await promptErrorRaceDelay(promptError);
      if (!isCurrent()) return;
      await options.onError(error, promptError);
    })
    .finally(() => options.onSettled?.());
}

export function loadOrResumeAcpSessionHistory(
  client: AcpClient,
  sessionId: string,
  cwd: string,
  additionalDirectories?: readonly string[],
  options: LoadOrResumeAcpSessionHistoryOptions = {},
): Promise<LoadedAcpSessionHistory> {
  if (client.supportsSessionLoad()) {
    return client.loadSessionHistory(sessionId, cwd, additionalDirectories, options).then((loaded) => {
      options.onLoadedSessionId?.(loaded.result.sessionId ?? sessionId);
      return loaded;
    });
  }
  if (!client.supportsSessionResume()) {
    return Promise.reject(new Error("ACP agent did not advertise session/load or session/resume"));
  }
  return client.resumeSession(sessionId, cwd, additionalDirectories).then((result) => {
    options.onLoadedSessionId?.(result.sessionId ?? sessionId);
    return { result, updates: [] };
  });
}

export function startAcpSession(client: AcpClient, options: StartAcpSessionOptions): Promise<StartedAcpSession> {
  const { cwd, sessionId, additionalDirectories } = options;
  if (sessionId) {
    if (options.replayHistory !== false) {
      const kind: AcpSessionStartKind = client.supportsSessionLoad() ? "load" : "resume";
      return loadOrResumeAcpSessionHistory(client, sessionId, cwd, additionalDirectories, options).then((loaded) => ({
        ...loaded,
        kind,
      }));
    }
    if (client.supportsSessionResume() && !client.supportsSessionLoad()) {
      return client
        .resumeSession(sessionId, cwd, additionalDirectories)
        .then((result) => ({ kind: "resume", result, updates: [] }));
    }
    return client
      .loadSession(sessionId, cwd, additionalDirectories)
      .then((result) => ({ kind: "load", result, updates: [] }));
  }
  return client.newSession(cwd, additionalDirectories).then((result) => ({ kind: "new", result, updates: [] }));
}

type PlainTextChunk = Extract<RelaySessionUpdate, { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }> & {
  content: { type: "text"; text: string };
};

/** A text chunk with no fields beyond sessionUpdate and {type, text} (no _meta, messageId, annotations...). */
function isPlainTextChunk(update: RelaySessionUpdate): update is PlainTextChunk {
  if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") return false;
  const { content } = update;
  return Object.keys(update).length === 2 && content.type === "text" && Object.keys(content).length === 2;
}

/**
 * Merges adjacent plain-text agent message/thought chunks of the same kind so history
 * replay appends one large string instead of tens of thousands of tiny ones.
 */
export function mergeAdjacentTextChunks(updates: readonly RelaySessionUpdate[]): RelaySessionUpdate[] {
  const merged: RelaySessionUpdate[] = [];
  let run: { kind: PlainTextChunk["sessionUpdate"]; parts: string[] } | undefined;
  const flush = () => {
    if (run && run.parts.length > 1) {
      const chunk: PlainTextChunk = { sessionUpdate: run.kind, content: { type: "text", text: run.parts.join("") } };
      merged[merged.length - 1] = chunk;
    }
    run = undefined;
  };
  for (const update of updates) {
    const plain = isPlainTextChunk(update);
    if (plain && run?.kind === update.sessionUpdate) {
      run.parts.push(update.content.text);
      continue;
    }
    flush();
    merged.push(update);
    if (plain) run = { kind: update.sessionUpdate, parts: [update.content.text] };
  }
  flush();
  return merged;
}

export function replayAcpSessionUpdates(
  updates: readonly RelaySessionUpdate[],
  adapter: AcpConversationAdapter,
  options: ReplayAcpSessionUpdatesOptions = {},
): LatestAcpAvailableCommands | null {
  const latestCommands = latestAvailableCommandsFromUpdates(updates);
  if (latestCommands) options.onAvailableCommands?.(latestCommands);

  for (const update of mergeAdjacentTextChunks(updates)) {
    applyAcpSessionUpdate(update, adapter);
  }
  if (options.finalize ?? updates.length > 0) finalizeAcpPrompt(adapter, {});
  return latestCommands ?? null;
}
