import type { ContentBlock as AcpContentBlock, SessionUpdate, ToolCallContent } from "./sdk";

type StandardAcpSessionUpdateKind = SessionUpdate["sessionUpdate"];
type AcpTextContentBlock = Extract<AcpContentBlock, { type: "text" }>;
type AcpImageContentBlock = Extract<AcpContentBlock, { type: "image" }>;
type AcpAudioContentBlock = Extract<AcpContentBlock, { type: "audio" }>;
type AcpResourceLinkContentBlock = Extract<AcpContentBlock, { type: "resource_link" }>;
type AcpEmbeddedResourceContentBlock = Extract<AcpContentBlock, { type: "resource" }>;
type AcpContentToolCallContent = Extract<ToolCallContent, { type: "content" }>;
type AcpDiffToolCallContent = Extract<ToolCallContent, { type: "diff" }>;
type AcpTerminalToolCallContent = Extract<ToolCallContent, { type: "terminal" }>;

export type RelayAcpSessionUpdate = SessionUpdate & Record<string, unknown>;

export type AcpThreadContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  | { readonly type: "audio"; readonly data: string; readonly mimeType: string }
  | {
      readonly type: "resourceLink";
      readonly name: string;
      readonly uri: string;
      readonly description?: string;
      readonly mimeType?: string;
    }
  | {
      readonly type: "resource";
      readonly uri: string;
      readonly mimeType?: string;
      readonly text?: string;
      readonly blob?: string;
    };

export type AcpThreadToolContent =
  | { readonly type: "content"; readonly content: AcpThreadContent }
  | { readonly type: "diff"; readonly path: string; readonly oldText: string; readonly newText: string }
  | { readonly type: "terminal"; readonly terminalId: string };

export type AcpThreadEvent =
  | { readonly type: "userMessage"; readonly content?: AcpThreadContent }
  | { readonly type: "agentMessage"; readonly content?: AcpThreadContent }
  | { readonly type: "agentThought"; readonly content?: AcpThreadContent }
  | {
      readonly type: "toolCall";
      readonly toolCallId: string;
      readonly title?: string;
      readonly kind?: string;
      readonly status?: string;
      readonly rawInput?: unknown;
      readonly rawOutput?: unknown;
      readonly content?: readonly AcpThreadToolContent[];
    }
  | { readonly type: "availableCommands"; readonly raw: RelayAcpSessionUpdate }
  | { readonly type: "currentMode"; readonly currentModeId?: string }
  | { readonly type: "configOption"; readonly raw: RelayAcpSessionUpdate }
  | { readonly type: "sessionInfo"; readonly title?: string }
  | { readonly type: "usage"; readonly usage?: unknown; readonly size?: number; readonly used?: number }
  | { readonly type: "plan"; readonly raw: RelayAcpSessionUpdate }
  | { readonly type: "planUpdate"; readonly raw: RelayAcpSessionUpdate }
  | { readonly type: "planRemoved"; readonly raw: RelayAcpSessionUpdate };

const STANDARD_ACP_SESSION_UPDATE_KINDS = [
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_update",
  "plan_removed",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
] as const satisfies readonly StandardAcpSessionUpdateKind[];

const STANDARD_ACP_SESSION_UPDATE_KIND_SET = new Set<StandardAcpSessionUpdateKind>(STANDARD_ACP_SESSION_UPDATE_KINDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function relayAcpSessionUpdate(value: unknown): RelayAcpSessionUpdate | null {
  if (!isRecord(value) || typeof value.sessionUpdate !== "string") return null;
  return STANDARD_ACP_SESSION_UPDATE_KIND_SET.has(value.sessionUpdate as StandardAcpSessionUpdateKind)
    ? (value as RelayAcpSessionUpdate)
    : null;
}

function isAcpTextContentBlock(value: unknown): value is AcpTextContentBlock {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isAcpImageContentBlock(value: unknown): value is AcpImageContentBlock {
  return (
    isRecord(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string"
  );
}

function isAcpAudioContentBlock(value: unknown): value is AcpAudioContentBlock {
  return (
    isRecord(value) && value.type === "audio" && typeof value.data === "string" && typeof value.mimeType === "string"
  );
}

function isAcpResourceLinkContentBlock(value: unknown): value is AcpResourceLinkContentBlock {
  return (
    isRecord(value) && value.type === "resource_link" && typeof value.name === "string" && typeof value.uri === "string"
  );
}

function isAcpEmbeddedResourceContentBlock(value: unknown): value is AcpEmbeddedResourceContentBlock {
  if (!isRecord(value) || value.type !== "resource" || !isRecord(value.resource)) return false;
  const resource = value.resource;
  return (
    (typeof resource.uri === "string" && typeof resource.text === "string") ||
    (typeof resource.uri === "string" && typeof resource.blob === "string")
  );
}

function isAcpContentBlock(value: unknown): value is AcpContentBlock {
  return (
    isAcpTextContentBlock(value) ||
    isAcpImageContentBlock(value) ||
    isAcpAudioContentBlock(value) ||
    isAcpResourceLinkContentBlock(value) ||
    isAcpEmbeddedResourceContentBlock(value)
  );
}

function isAcpContentToolCallContent(value: unknown): value is AcpContentToolCallContent {
  return isRecord(value) && value.type === "content" && isAcpContentBlock(value.content);
}

function isAcpDiffToolCallContent(value: unknown): value is AcpDiffToolCallContent {
  if (!isRecord(value) || value.type !== "diff") return false;
  return (
    typeof value.path === "string" &&
    typeof value.newText === "string" &&
    (typeof value.oldText === "string" || value.oldText === undefined || value.oldText === null)
  );
}

function isAcpTerminalToolCallContent(value: unknown): value is AcpTerminalToolCallContent {
  return isRecord(value) && value.type === "terminal" && typeof value.terminalId === "string";
}

function threadContentFromAcpContentBlock(content: AcpContentBlock): AcpThreadContent {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "image":
      return { type: "image", data: content.data, mimeType: content.mimeType };
    case "audio":
      return { type: "audio", data: content.data, mimeType: content.mimeType };
    case "resource_link":
      return {
        type: "resourceLink",
        name: content.name,
        uri: content.uri,
        ...(typeof content.description === "string" ? { description: content.description } : {}),
        ...(typeof content.mimeType === "string" ? { mimeType: content.mimeType } : {}),
      };
    case "resource": {
      const resource = content.resource;
      return {
        type: "resource",
        uri: resource.uri,
        ...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
        ...("text" in resource && typeof resource.text === "string" ? { text: resource.text } : {}),
        ...("blob" in resource && typeof resource.blob === "string" ? { blob: resource.blob } : {}),
      };
    }
  }
}

function threadToolContentFromAcpToolContent(content: unknown): AcpThreadToolContent | null {
  if (isAcpContentToolCallContent(content)) {
    return { type: "content", content: threadContentFromAcpContentBlock(content.content) };
  }
  if (isAcpDiffToolCallContent(content)) {
    return { type: "diff", path: content.path, oldText: content.oldText ?? "", newText: content.newText };
  }
  if (isAcpTerminalToolCallContent(content)) {
    return { type: "terminal", terminalId: content.terminalId };
  }
  return null;
}

function threadToolContentList(content: unknown): readonly AcpThreadToolContent[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const items = content
    .map((item) => threadToolContentFromAcpToolContent(item))
    .filter((item): item is AcpThreadToolContent => item !== null);
  return items.length > 0 ? items : undefined;
}

function threadContentFromUnknown(value: unknown): AcpThreadContent | undefined {
  return isAcpContentBlock(value) ? threadContentFromAcpContentBlock(value) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function acpThreadEventFromSessionUpdate(update: unknown): AcpThreadEvent | null {
  const relayUpdate = relayAcpSessionUpdate(update);
  if (!relayUpdate) return null;

  switch (relayUpdate.sessionUpdate) {
    case "user_message_chunk":
      return { type: "userMessage", content: threadContentFromUnknown(relayUpdate.content) };
    case "agent_message_chunk":
      return { type: "agentMessage", content: threadContentFromUnknown(relayUpdate.content) };
    case "agent_thought_chunk":
      return { type: "agentThought", content: threadContentFromUnknown(relayUpdate.content) };
    case "tool_call":
    case "tool_call_update": {
      const title = stringValue(relayUpdate.title);
      const kind = stringValue(relayUpdate.kind);
      const status = stringValue(relayUpdate.status);
      const content = threadToolContentList(relayUpdate.content);
      return {
        type: "toolCall",
        toolCallId: String(relayUpdate.toolCallId ?? ""),
        ...(title ? { title } : {}),
        ...(kind ? { kind } : {}),
        ...(status ? { status } : {}),
        ...(relayUpdate.rawInput !== undefined ? { rawInput: relayUpdate.rawInput } : {}),
        ...(relayUpdate.rawOutput !== undefined ? { rawOutput: relayUpdate.rawOutput } : {}),
        ...(content ? { content } : {}),
      };
    }
    case "available_commands_update":
      return { type: "availableCommands", raw: relayUpdate };
    case "current_mode_update":
      return { type: "currentMode", currentModeId: stringValue(relayUpdate.currentModeId) };
    case "config_option_update":
      return { type: "configOption", raw: relayUpdate };
    case "session_info_update":
      return { type: "sessionInfo", title: stringValue(relayUpdate.title) };
    case "usage_update":
      return {
        type: "usage",
        usage: relayUpdate.usage,
        size: typeof relayUpdate.size === "number" ? relayUpdate.size : undefined,
        used: typeof relayUpdate.used === "number" ? relayUpdate.used : undefined,
      };
    case "plan":
      return { type: "plan", raw: relayUpdate };
    case "plan_update":
      return { type: "planUpdate", raw: relayUpdate };
    case "plan_removed":
      return { type: "planRemoved", raw: relayUpdate };
  }
}

export function textFromAcpThreadContent(content: AcpThreadContent, context: "message" | "tool"): string | undefined {
  switch (content.type) {
    case "text":
      return content.text;
    case "image":
      return "`Image`";
    case "audio":
      return "`Audio`";
    case "resourceLink":
      return content.uri;
    case "resource":
      if (context === "tool" && typeof content.text === "string") return content.text;
      return content.uri;
  }
}

export function textFromAcpThreadToolContent(content: AcpThreadToolContent): string | undefined {
  if (content.type === "content") return textFromAcpThreadContent(content.content, "tool");
  if (content.type === "terminal") return `Terminal: ${content.terminalId}`;
  return undefined;
}
