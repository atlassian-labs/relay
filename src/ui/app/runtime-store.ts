/**
 * Shared mutable runtime state for the TUI app.
 *
 * These singletons (the active ACP client, agent identity, launch options, and
 * the per-thread bookkeeping maps) are read and written across the app-root
 * orchestrator and the thread / session / submit controllers. Holding them in
 * one store object lets those modules share state by import instead of threading
 * dozens of getter/setter callbacks through every factory.
 *
 * Lifetime: a single App instance owns this state. `App` resets the fields and
 * clears the maps on mount/cleanup (keyed by the instance id) so a remount
 * starts clean.
 */

import type { AgentBehaviorProfile } from "../../acp/agent-profile";
import type {
  AcpClient,
  AcpClientCallbacks,
  AcpClientOptions,
  AcpLaunchOptions,
  AcpSessionResult,
} from "../../acp/client";
import { defaultAgentBehaviorProfile } from "../../acp/profiles/default";
import type { PluginRunner } from "../../plugins";
import type { AgentProfile } from "../tool-renderers";
import type { ChatBlock, QueuedPrompt } from "../state";
import type { SlashCommand } from "../autocomplete";
import type { SessionCapabilitiesResult } from "../context/session";
import type { TranscriptViewState } from "../util/transcript-view-state";

export interface RuntimeStore {
  /** ACP client for the active thread, or null when disconnected. */
  acpClient: AcpClient | null;
  /** Monotonic id of the live App instance; stale async work checks against it. */
  activeAppInstanceId: number;
  activeAgentName: string;
  /** Thinking level from the launch `--thinking-level` flag; takes precedence over the configured preferred thinking level. Empty when unset. */
  launchThinkingLevelOverride: string;
  activeAgentProfile: AgentProfile;
  activeAgentBehaviorProfile: AgentBehaviorProfile;
  liveSessionInstanceId: string;
  liveSessionEndpoint: string;
  liveSessionToken: string;
  /** Workspace root (the cwd App launched in). */
  rootCwd: string;
  activeAcpLaunchOptions: AcpLaunchOptions | null;
  activeAcpClientFactory: ((callbacks: AcpClientCallbacks, opts: AcpClientOptions) => AcpClient) | undefined;
  activeAgentCommandCacheKey: string | null;
  cachedAgentCommands: SlashCommand[];
  pluginRunner: PluginRunner | null;
  /** Set once the user interrupts the current turn (gates "send queued now"). */
  cancelRequested: boolean;
  /** Whether prompt-history navigation may continue past the current session. */
  allowGlobalPromptHistoryContinuation: boolean;

  // Per-thread bookkeeping (keyed by thread id).
  readonly threadClients: Map<string, AcpClient>;
  readonly threadCurrentBlockIds: Map<string, string | null>;
  readonly threadAgentCommands: Map<string, SlashCommand[]>;
  readonly threadAgentCommandsKnown: Set<string>;
  readonly threadSessionCapabilities: Map<string, SessionCapabilitiesResult>;
  readonly threadPromptRunIds: Map<string, number>;
  readonly suppressedThreadPromptRunIds: Map<string, number>;
  readonly historyLoadedSessionIdsByThread: Map<string, string>;
  readonly threadBlocks: Map<string, ChatBlock[]>;
  readonly threadTranscriptViews: Map<string, TranscriptViewState>;
  readonly threadPendingQueues: Map<string, QueuedPrompt[]>;
  readonly liveSessionWaitingThreads: Set<string>;
  /** Parent threads with an automatically scheduled collaboration continuation. */
  readonly liveSessionContinuationThreads: Set<string>;
  readonly threadPreviews: Map<string, string>;
  /** Threads where Relay should automatically select an ACP allow-once permission option. */
  readonly threadYoloEnabled: Set<string>;
  /** Threads where Relay yolo was explicitly enabled by the launch flag. */
  readonly threadYoloLaunchEnabled: Set<string>;
}

export const store: RuntimeStore = {
  acpClient: null,
  activeAppInstanceId: 0,
  activeAgentName: "",
  launchThinkingLevelOverride: "",
  activeAgentProfile: "default",
  activeAgentBehaviorProfile: defaultAgentBehaviorProfile,
  liveSessionInstanceId: "",
  liveSessionEndpoint: "",
  liveSessionToken: "",
  rootCwd: "",
  activeAcpLaunchOptions: null,
  activeAcpClientFactory: undefined,
  activeAgentCommandCacheKey: null,
  cachedAgentCommands: [],
  pluginRunner: null,
  cancelRequested: false,
  allowGlobalPromptHistoryContinuation: false,
  threadClients: new Map(),
  threadCurrentBlockIds: new Map(),
  threadAgentCommands: new Map(),
  threadAgentCommandsKnown: new Set(),
  threadSessionCapabilities: new Map(),
  threadPromptRunIds: new Map(),
  suppressedThreadPromptRunIds: new Map(),
  historyLoadedSessionIdsByThread: new Map(),
  threadBlocks: new Map(),
  threadTranscriptViews: new Map(),
  threadPendingQueues: new Map(),
  liveSessionWaitingThreads: new Set(),
  liveSessionContinuationThreads: new Set(),
  threadPreviews: new Map(),
  threadYoloEnabled: new Set(),
  threadYoloLaunchEnabled: new Set(),
};

export function mergeSessionCapabilities(
  previous: SessionCapabilitiesResult | undefined,
  next: SessionCapabilitiesResult,
): SessionCapabilitiesResult {
  return {
    configOptions: next.configOptions !== undefined ? next.configOptions : previous?.configOptions,
    models: next.models !== undefined ? next.models : previous?.models,
    modes: next.modes !== undefined ? next.modes : previous?.modes,
    availableCommands: next.availableCommands !== undefined ? next.availableCommands : previous?.availableCommands,
  };
}
