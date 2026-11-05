// Agent events - all events yielded by the agent loop.

import type { AssistantMessage, FileChanges, ToolResultMessage, Usage } from "./types";
import { StopReason } from "./types";

// =================================================================================================
// Approval Response
// =================================================================================================

export enum ApprovalResponse {
  APPROVE = "approve",
  DENY = "deny",
}

export interface ApprovalOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind?: string;
}

export type ApprovalSelection = ApprovalResponse | ApprovalOption;

export function isApprovalOptionAllow(option: ApprovalOption): boolean {
  const marker = option.kind ?? option.optionId;
  return marker.startsWith("allow");
}

export function isApprovalSelectionAllow(selection: ApprovalSelection): boolean {
  return typeof selection === "string" ? selection === ApprovalResponse.APPROVE : isApprovalOptionAllow(selection);
}

// =================================================================================================
// Agent Lifecycle Events
// =================================================================================================

export interface AgentStartEvent {
  type: "agent_start";
}

export interface AgentEndEvent {
  type: "agent_end";
  stop_reason: StopReason;
  total_turns: number;
  total_usage?: Usage;
}

// =================================================================================================
// Turn Lifecycle Events
// =================================================================================================

export interface TurnStartEvent {
  type: "turn_start";
  turn: number;
}

export interface TurnEndEvent {
  type: "turn_end";
  turn: number;
  assistant_message?: AssistantMessage;
  tool_results: ToolResultMessage[];
  stop_reason: StopReason;
  generation_seconds?: number;
  tool_call_count: number;
}

// =================================================================================================
// Content Streaming Events
// =================================================================================================

export interface ThinkingStartEvent {
  type: "thinking_start";
}

export interface ThinkingDeltaEvent {
  type: "thinking_delta";
  delta: string;
}

export interface ThinkingEndEvent {
  type: "thinking_end";
  thinking: string;
  signature?: string;
}

export interface TextStartEvent {
  type: "text_start";
}

export interface TextDeltaEvent {
  type: "text_delta";
  delta: string;
}

export interface TextEndEvent {
  type: "text_end";
  text: string;
}

// =================================================================================================
// Tool Events
// =================================================================================================

export interface ToolStartEvent {
  type: "tool_start";
  tool_call_id: string;
  tool_name: string;
}

export interface ToolArgsDeltaEvent {
  type: "tool_args_delta";
  tool_call_id: string;
  delta: string;
}

export interface ToolArgsTokenUpdateEvent {
  type: "tool_args_token_update";
  tool_call_id: string;
  tool_name: string;
  token_count: number;
}

export interface ToolEndEvent {
  type: "tool_end";
  tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  display: string;
}

export interface ToolResultEvent {
  type: "tool_result";
  tool_call_id: string;
  tool_name: string;
  result?: ToolResultMessage;
  file_changes?: FileChanges;
}

export interface ToolApprovalEvent {
  type: "tool_approval";
  tool_call_id: string;
  tool_name: string;
  display: string;
  resolve: (response: ApprovalSelection) => void;
}

// =================================================================================================
// Compaction Events
// =================================================================================================

export interface CompactionStartEvent {
  type: "compaction_start";
}

export interface CompactionEndEvent {
  type: "compaction_end";
  tokens_before: number;
  aborted: boolean;
}

// =================================================================================================
// Other Events
// =================================================================================================

export interface RetryEvent {
  type: "retry";
  attempt: number;
  total_attempts: number;
  delay: number;
  error: string;
}

export interface ErrorEvent {
  type: "error";
  error: string;
}

export interface WarningEvent {
  type: "warning";
  warning: string;
}

export interface InterruptedEvent {
  type: "interrupted";
  message: string;
}

// =================================================================================================
// Union Types
// =================================================================================================

/** Events yielded by run_single_turn (turn.ts) */
export type StreamEvent =
  | ThinkingStartEvent
  | ThinkingDeltaEvent
  | ThinkingEndEvent
  | TextStartEvent
  | TextDeltaEvent
  | TextEndEvent
  | ToolStartEvent
  | ToolArgsDeltaEvent
  | ToolArgsTokenUpdateEvent
  | ToolEndEvent
  | ToolResultEvent
  | ToolApprovalEvent
  | RetryEvent
  | TurnEndEvent
  | ErrorEvent
  | WarningEvent
  | InterruptedEvent;

/** All events yielded by Agent.run() (loop.ts) */
export type Event =
  | AgentStartEvent
  | AgentEndEvent
  | TurnStartEvent
  | CompactionStartEvent
  | CompactionEndEvent
  | StreamEvent;
