// Core types - canonical provider-agnostic types for the agent framework.

// =================================================================================================
// Stop Reasons
// =================================================================================================

export enum StopReason {
  STOP = "stop",
  LENGTH = "length",
  TOOL_USE = "tool_use",
  ERROR = "error",
  INTERRUPTED = "interrupted",
}

// =================================================================================================
// Usage
// =================================================================================================

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export function createUsage(partial?: Partial<Usage>): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    ...partial,
  };
}

export function totalTokens(usage: Usage): number {
  return usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
}

// =================================================================================================
// Stream Parts - yielded by providers during streaming
// =================================================================================================

export interface TextPart {
  type: "text";
  text: string;
}

export interface ThinkPart {
  type: "think";
  think: string;
  signature?: string;
}

export interface ToolCallStart {
  type: "tool_call_start";
  id: string;
  name: string;
  index: number;
  arguments?: Record<string, unknown>;
}

export interface ToolCallDelta {
  type: "tool_call_delta";
  index: number;
  arguments_delta: string;
}

export interface StreamDone {
  type: "done";
  stop_reason: StopReason;
}

export interface StreamError {
  type: "error";
  error: string;
}

export type StreamPart = TextPart | ThinkPart | ToolCallStart | ToolCallDelta | StreamDone | StreamError;

// Merge helpers (mirrors Python .merge() methods)

export function mergeTextParts(a: TextPart, b: TextPart): TextPart {
  return { type: "text", text: a.text + b.text };
}

export function mergeThinkParts(a: ThinkPart, b: ThinkPart): ThinkPart {
  return {
    type: "think",
    think: a.think + b.think,
    signature: a.signature ?? b.signature,
  };
}

// =================================================================================================
// Message Content Types - canonical provider-agnostic conversation interface
// =================================================================================================

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string; // base64 encoded
  mime_type: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ToolCall {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ContentPart = TextContent | ThinkingContent | ToolCall;

// =================================================================================================
// Messages
// =================================================================================================

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentPart[];
  usage?: Usage;
  stop_reason?: StopReason;
}

export interface ToolResultMessage {
  role: "tool_result";
  tool_call_id: string;
  tool_name: string;
  content: (TextContent | ImageContent)[];
  ui_summary?: string;
  ui_details?: string;
  is_error?: boolean;
  file_changes?: FileChanges;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// =================================================================================================
// Tool Definitions
// =================================================================================================

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface FileChanges {
  path: string;
  added: number;
  removed: number;
}

export interface ToolResult {
  success: boolean;
  result?: string;
  images?: ImageContent[];
  ui_summary?: string;
  ui_details?: string;
  file_changes?: FileChanges;
}

// UI rendering model:
//
// format_call is defined for each tool like Read tool and the result they
// return contains further details (along with the result for llm) to help paint
// the complete picture (or as close to it as possible without polluting) in the ui
//
// - format_call(params): short call text shown on the header line
// - ui_summary: one-line result summary appended to the same header line
// - ui_details: multiline result body shown below the header
//
// Example (read):
//   -> Read ~/src/relay/turn.ts:150-204 (55 lines)
//   - format_call -> "~/src/relay/turn.ts:150-204"
//   - ui_summary  -> "(55 lines)"
//   - ui_details  -> undefined
//
// Example (edit):
//   + Edit ~/src/relay/tools/base.ts +3 -1
//     -12 old line
//     +12 new line
//   - format_call -> "~/src/relay/tools/base.ts"
//   - ui_summary  -> "+3 -1"
//   - ui_details  -> formatted diff
