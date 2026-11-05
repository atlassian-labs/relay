/**
 * Application state - reactive store shared across all UI components.
 *
 * Uses SolidJS createStore for fine-grained reactivity across shared app state.
 */

import { createContext, useContext } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import type { CommandDescriptor } from "../core/commands";
import { nextBlockId, type ChatBlock, type ToolBlock } from "../core/conversation";
import type { AcpActivityKind } from "../core/activity";
import type { PromptImageAttachment } from "../core/prompt-submission";
import type { FileChanges, Usage } from "../core/types";
import type { ThinkingLevel } from "../core/thinking";
import type { ThreadInfo } from "../core/threads";
import { createUsage } from "../core/types";
import type { UserPromptTitleIntent } from "../core/user-message";
import type { RelayAuthMethod } from "../acp/capabilities";

export * from "../core/conversation";
export type { AcpActivityKind } from "../core/activity";

export interface SessionModelOption {
  modelId: string;
  name: string;
  description?: string;
}

export interface SessionThinkingLevelOption {
  id: ThinkingLevel;
  name: string;
  description?: string;
}

export interface SessionModeOption {
  id: string;
  name: string;
  description?: string;
}

export type SessionCommandOption = CommandDescriptor;

export type SessionConfigValue = string | boolean | number | null;

export interface SessionConfigSelectOption {
  value: string;
  name: string;
  description?: string;
}

export interface SessionConfigOptionState {
  id: string;
  name: string;
  description?: string;
  category: string | null;
  type: string;
  currentValue?: SessionConfigValue;
  options: SessionConfigSelectOption[];
  raw: Record<string, unknown>;
}

export interface QueuedSkillPrompt {
  name: string;
  location: string;
  content: string;
  blockText: string;
  userMessage: string;
  userMessagePrefix?: string;
}

export interface QueuedPrompt {
  id: string;
  text: string;
  images?: PromptImageAttachment[];
  kind?: "text" | "skill";
  skill?: QueuedSkillPrompt;
  originalIndex?: number;
}

export type AuthStatus = "unknown" | "required" | "authenticated";

export interface AppState {
  // Session / agent
  connecting: boolean;
  connectingAgentName: string;
  running: boolean;
  turn: number;
  toolCallCount: number;
  generationSeconds: number;
  elapsedSeconds: number;
  lastAcpActivityKind: AcpActivityKind | null;
  lastAcpActivityLabel: string;
  lastAcpActivityAt: number | null;
  lastAcpActivitySequence: number;
  latestPromptTitleIntent: UserPromptTitleIntent | null;

  // Model / provider
  modelId: string;
  modelConfigId: string;
  providerName: string;
  modeId: string;
  thinkingLevel: ThinkingLevel | "";
  thinkingConfigId: string;
  availableModels: SessionModelOption[];
  availableThinkingLevels: SessionThinkingLevelOption[];
  availableModes: SessionModeOption[];
  availableCommands: SessionCommandOption[];
  sessionConfigOptions: SessionConfigOptionState[];
  sessionForkAvailable: boolean;
  sessionListAvailable: boolean;
  sessionLoadAvailable: boolean;
  sessionResumeAvailable: boolean;
  authMethods: RelayAuthMethod[];
  authLogoutAvailable: boolean;
  authStatus: AuthStatus;
  authMessage: string;

  // Tokens
  totalUsage: Usage;
  lastUsage: Usage | null;
  contextTokens: number | null;
  contextWindow: number | null;

  // File changes (cumulative)
  fileChanges: FileChanges[];

  // Chat blocks
  blocks: ChatBlock[];

  // Legacy compatibility field; global transcript expansion is intentionally disabled.
  detailsExpanded: boolean;

  // Current streaming block ID
  currentBlockId: string | null;

  // Pending prompt queue
  pendingQueue: QueuedPrompt[];

  // Status
  statusText: string;
  spinnerActive: boolean;
  spinnerLabel: string;

  // CWD
  cwd: string;

  // Git branch (null if not in a repo or detached HEAD)
  gitBranch: string | null;

  // Startup tip shown in the status line until the first submitted prompt is accepted.
  startupTip: string;

  // Thread / worktree context
  threads: ThreadInfo[];
  activeThreadId: string;
  worktreePath: string | null;
  worktreeBranch: string | null;

  // Status hint (e.g. "ctrl+c" + " again to exit")
  statusHint: { key: string; label: string } | null;

  // Keyboard-selected transcript block and the block shown in the details popup.
  transcriptSelectedBlockId: string | null;
  /** Fine-grained row selection flags so navigation only rerenders the old/new rows. */
  transcriptSelectedRows: Record<string, boolean>;
  transcriptDetailBlockId: string | null;
  /** Inline expansion state for configured consecutive tool-call groups. */
  expandedToolCallGroups: Record<string, boolean>;

  // Read-only child conversation selected from /subagents.
  selectedSubagentToolCallId: string | null;

  // User bash execution (! / !! commands)
  userBashMode: boolean;
  userBashRunning: boolean;
  pendingUserBashResults: Array<{ command: string; output: string; exitCode: number | undefined }>;
}

export function createInitialState(cwd: string): AppState {
  return {
    connecting: false,
    connectingAgentName: "",
    running: false,
    turn: 0,
    toolCallCount: 0,
    generationSeconds: 0,
    elapsedSeconds: 0,
    lastAcpActivityKind: null,
    lastAcpActivityLabel: "",
    lastAcpActivityAt: null,
    lastAcpActivitySequence: 0,
    latestPromptTitleIntent: null,

    modelId: "",
    modelConfigId: "",
    providerName: "",
    modeId: "",
    thinkingLevel: "",
    thinkingConfigId: "",
    availableModels: [],
    availableThinkingLevels: [],
    availableModes: [],
    availableCommands: [],
    sessionConfigOptions: [],
    sessionForkAvailable: false,
    sessionListAvailable: false,
    sessionLoadAvailable: false,
    sessionResumeAvailable: false,
    authMethods: [],
    authLogoutAvailable: false,
    authStatus: "unknown",
    authMessage: "",

    totalUsage: createUsage(),
    lastUsage: null,
    contextTokens: null,
    contextWindow: null,

    fileChanges: [],
    blocks: [],
    detailsExpanded: false,
    currentBlockId: null,
    pendingQueue: [],

    statusText: "",
    spinnerActive: false,
    spinnerLabel: "",

    cwd,
    gitBranch: null,
    startupTip: "",
    threads: [],
    activeThreadId: "",
    worktreePath: null,
    worktreeBranch: null,
    statusHint: null,
    transcriptSelectedBlockId: null,
    transcriptSelectedRows: {},
    transcriptDetailBlockId: null,
    expandedToolCallGroups: {},
    selectedSubagentToolCallId: null,

    userBashMode: false,
    userBashRunning: false,
    pendingUserBashResults: [],
  };
}

interface AppContextValue {
  state: AppState;
  readonly transcriptPagingEnabled: boolean;
  setState: SetStoreFunction<AppState>;
  blockEntry: (id: string) => { readonly block: ChatBlock; readonly index: number } | undefined;
  findToolBlock: (toolCallId: string) => ToolBlock | undefined;
  addBlock: (block: ChatBlock) => void;
  appendBlock: (block: ChatBlock) => void;
  insertBlock: (index: number, block: ChatBlock) => void;
  updateBlock: (id: string, updates: Partial<ChatBlock>) => void;
  appendToBlock: (id: string, text: string) => void;
  removeBlock: (id: string) => void;
  replaceBlocks: (blocks: ChatBlock[]) => void;
  clearBlocks: () => void;
  setCurrentBlockId: (id: string | null) => void;
  setActiveThreadState: (thread: ThreadInfo, blocks: ChatBlock[], pendingQueue?: QueuedPrompt[]) => void;
  cancelController: () => AbortController | null;
  setCancelController: (ctrl: AbortController | null) => void;
}

const AppContext = createContext<AppContextValue>();

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider"); // effect-shape-allow: Solid context hook fails fast when provider wiring is invalid.
  return ctx;
}

export { AppContext, nextBlockId };
