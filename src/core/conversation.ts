import type { ApprovalOption, ApprovalSelection } from "./events";
import type { FileChanges } from "./types";

/** Provider-neutral conversation blocks shared by terminal and web presentation adapters. */
export interface ThinkingBlock {
  type: "thinking";
  id: string;
  content: string;
  finalized: boolean;
  signature?: string;
  contentItems?: MessageContentItem[];
}

export interface ContentBlock {
  type: "content";
  id: string;
  content: string;
  finalized: boolean;
  contentItems?: MessageContentItem[];
}

export interface UserSkillInvocationEcho {
  name: string;
  userMessage?: string;
}

export interface UserBlock {
  type: "user";
  id: string;
  content: string;
  delivery?: "turn" | "current-turn-guidance";
  origin?: "local" | "acp";
  skillInvocation?: UserSkillInvocationEcho;
  contentItems?: MessageContentItem[];
}

export type MessageContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resourceLink"; name: string; uri: string; description?: string; mimeType?: string }
  | { type: "resource"; uri: string; mimeType?: string; text?: string; blob?: string };

export interface ToolDiff {
  path: string;
  oldText: string;
  newText: string;
}

export interface ToolDiffContent {
  type: "diff";
  diff: ToolDiff;
}

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolAudioContent {
  type: "audio";
  data: string;
  mimeType: string;
}

export interface ToolResourceLinkContent {
  type: "resourceLink";
  name: string;
  uri: string;
  description?: string;
  mimeType?: string;
}

export interface ToolResourceContent {
  type: "resource";
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface ToolTerminalContent {
  type: "terminal";
  terminalId: string;
}

export type ToolContentItem =
  | ToolDiffContent
  | ToolTextContent
  | ToolImageContent
  | ToolAudioContent
  | ToolResourceLinkContent
  | ToolResourceContent
  | ToolTerminalContent;

export type ToolStatus = "pending" | "running" | "success" | "error" | "approval";

export interface ToolSubagentProgressItem {
  kind: "message" | "thinking" | "tool";
  text: string;
  status?: ToolStatus;
  toolCallId?: string;
}

export type ToolSubagentStatus = "running" | "success" | "error" | "cancelled";

export interface ToolSubagentState {
  invokingToolCallId: string;
  childSessionId?: string;
  parentSessionId?: string;
  agentName?: string;
  background?: boolean;
  status: ToolSubagentStatus;
  progress: ToolSubagentProgressItem[];
  /** Complete child conversation assembled from Alta's attributed ACP stream. */
  blocks?: ChatBlock[];
  currentBlockId?: string | null;
  startedAt?: number;
  finishedAt?: number;
}

export interface ToolBlock {
  type: "tool";
  id: string;
  toolCallId: string;
  toolName: string;
  toolKind?: string;
  display: string;
  status: ToolStatus;
  summary?: string;
  details?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  /** Normalized ACP tool content, preserving order for mixed text/diff outputs. */
  content?: ToolContentItem[];
  /** First normalized ACP diff, kept for compatibility with existing renderers/tests. */
  diff?: ToolDiff;
  approvalPreview?: string;
  approvalOptions?: readonly ApprovalOption[];
  resolveApproval?: (response: ApprovalSelection) => void;
  fileChanges?: FileChanges;
  /** Answers collected via elicitation, keyed by question key. Immune to tool result overwriting. */
  elicitationAnswers?: Array<{ label: string; value: string }>;
  /** Bounded live progress from an Alta child agent invoked by this tool call. */
  subagent?: ToolSubagentState;
}

export interface UserBashBlock {
  type: "user-bash";
  id: string;
  command: string;
  output: string;
  exitCode: number | undefined;
  status: "running" | "done" | "error";
  excludeFromContext: boolean;
}

export interface InfoBlock {
  type: "info";
  id: string;
  content: string;
  variant: "info" | "warning" | "error" | "session" | "resources" | "plain" | "spinner";
}

export interface PluginBlock {
  type: "plugin";
  id: string;
  pluginId: string;
  pluginName: string;
  blockType: string;
  content: string;
  data?: unknown;
}

export interface ElicitationChoice {
  value: string;
  title: string;
  description?: string;
}

export interface ElicitationField {
  key: string;
  type?: string;
  title: string;
  description?: string;
  required?: boolean;
  choices: ElicitationChoice[];
}

export interface ElicitationSchema {
  type: "object";
  title?: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

export type ElicitationResponse =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

export interface ElicitationBlock {
  type: "elicitation";
  id: string;
  mode: "form" | "url";
  message: string;
  schema?: ElicitationSchema;
  url?: string;
  elicitationId?: string;
  status: "pending" | "accepted" | "declined" | "cancelled";
  fields: ElicitationField[];
  currentFieldIndex: number;
  answers: Record<string, unknown>;
  /** Agent-profile extension: enum choices are suggestions and may be replaced with custom text. */
  allowCustomEnumInput?: boolean;
  editingCustomFieldKey?: string;
  respond?: (response: ElicitationResponse) => void;
}

export type ChatBlock =
  | ThinkingBlock
  | ContentBlock
  | UserBlock
  | ToolBlock
  | UserBashBlock
  | ElicitationBlock
  | InfoBlock
  | PluginBlock;

let blockIdCounter = 0;

export function nextBlockId(): string {
  return `blk-${++blockIdCounter}`;
}
