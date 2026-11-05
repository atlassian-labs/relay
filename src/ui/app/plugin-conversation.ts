import type {
  RelayConversationBlock,
  RelayConversationContentItem,
  RelayConversationSnapshot,
  RelayConversationToolContentItem,
  RelayPluginThreadInfo,
} from "../../plugins";
import type { ChatBlock, MessageContentItem, ToolContentItem } from "../state";

export interface RelayConversationSnapshotOptions {
  readonly thread: RelayPluginThreadInfo;
  readonly blocks: readonly ChatBlock[];
  readonly sessionId?: string | null;
}

function conversationContentItem(item: MessageContentItem): RelayConversationContentItem {
  switch (item.type) {
    case "text":
      return { type: "text", text: item.text };
    case "image":
      return { type: "image", data: item.data, mimeType: item.mimeType };
    case "audio":
      return { type: "audio", data: item.data, mimeType: item.mimeType };
    case "resourceLink":
      return {
        type: "resourceLink",
        name: item.name,
        uri: item.uri,
        ...(item.description ? { description: item.description } : {}),
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      };
    case "resource":
      return {
        type: "resource",
        uri: item.uri,
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
        ...(item.text !== undefined ? { text: item.text } : {}),
        ...(item.blob !== undefined ? { blob: item.blob } : {}),
      };
  }
}

function conversationContentItems(
  items: readonly MessageContentItem[] | undefined,
): readonly RelayConversationContentItem[] | undefined {
  return items ? items.map(conversationContentItem) : undefined;
}

function conversationToolContentItem(item: ToolContentItem): RelayConversationToolContentItem {
  switch (item.type) {
    case "diff":
      return {
        type: "diff",
        diff: { path: item.diff.path, oldText: item.diff.oldText, newText: item.diff.newText },
      };
    case "text":
      return { type: "text", text: item.text };
    case "image":
      return { type: "image", data: item.data, mimeType: item.mimeType };
    case "audio":
      return { type: "audio", data: item.data, mimeType: item.mimeType };
    case "resourceLink":
      return {
        type: "resourceLink",
        name: item.name,
        uri: item.uri,
        ...(item.description ? { description: item.description } : {}),
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      };
    case "resource":
      return {
        type: "resource",
        uri: item.uri,
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
        ...(item.text !== undefined ? { text: item.text } : {}),
        ...(item.blob !== undefined ? { blob: item.blob } : {}),
      };
    case "terminal":
      return { type: "terminal", terminalId: item.terminalId };
  }
}

function conversationToolContentItems(
  items: readonly ToolContentItem[] | undefined,
): readonly RelayConversationToolContentItem[] | undefined {
  return items ? items.map(conversationToolContentItem) : undefined;
}

function conversationElicitationFields(block: Extract<ChatBlock, { readonly type: "elicitation" }>) {
  return block.fields.map((field) => ({
    key: field.key,
    ...(field.type ? { type: field.type } : {}),
    title: field.title,
    ...(field.description ? { description: field.description } : {}),
    ...(field.required !== undefined ? { required: field.required } : {}),
    choices: field.choices.map((choice) => ({
      value: choice.value,
      title: choice.title,
      ...(choice.description ? { description: choice.description } : {}),
    })),
  }));
}

export function relayConversationBlock(block: ChatBlock): RelayConversationBlock {
  switch (block.type) {
    case "user":
      return {
        type: "user",
        id: block.id,
        role: "user",
        content: block.content,
        ...(block.delivery ? { delivery: block.delivery } : {}),
        ...(block.origin ? { origin: block.origin } : {}),
        ...(block.skillInvocation
          ? {
              skillInvocation: {
                kind: "skill",
                name: block.skillInvocation.name,
                ...(block.skillInvocation.userMessage ? { userMessage: block.skillInvocation.userMessage } : {}),
              },
            }
          : {}),
        ...(block.contentItems ? { contentItems: conversationContentItems(block.contentItems) } : {}),
      };
    case "content":
    case "thinking":
      return {
        type: block.type,
        id: block.id,
        role: "assistant",
        content: block.content,
        finalized: block.finalized,
        ...(block.contentItems ? { contentItems: conversationContentItems(block.contentItems) } : {}),
      };
    case "tool":
      return {
        type: "tool",
        id: block.id,
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        ...(block.toolKind ? { toolKind: block.toolKind } : {}),
        display: block.display,
        status: block.status,
        ...(block.summary ? { summary: block.summary } : {}),
        ...(block.details ? { details: block.details } : {}),
        input: block.rawInput ?? null,
        output: block.rawOutput ?? null,
        ...(block.content ? { content: conversationToolContentItems(block.content) } : {}),
      };
    case "user-bash":
      return {
        type: "user-bash",
        id: block.id,
        command: block.command,
        output: block.output,
        ...(block.exitCode !== undefined ? { exitCode: block.exitCode } : {}),
        status: block.status,
        excludeFromContext: block.excludeFromContext,
      };
    case "info":
      return { type: "info", id: block.id, content: block.content, variant: block.variant };
    case "plugin":
      return {
        type: "plugin",
        id: block.id,
        pluginId: block.pluginId,
        pluginName: block.pluginName,
        blockType: block.blockType,
        content: block.content,
        ...(block.data !== undefined ? { data: block.data } : {}),
      };
    case "elicitation":
      return {
        type: "elicitation",
        id: block.id,
        mode: block.mode,
        message: block.message,
        ...(block.schema ? { schema: block.schema } : {}),
        ...(block.url ? { url: block.url } : {}),
        ...(block.elicitationId ? { elicitationId: block.elicitationId } : {}),
        status: block.status,
        fields: conversationElicitationFields(block),
        answers: { ...block.answers },
      };
  }
}

export function snapshotRelayConversation(options: RelayConversationSnapshotOptions): RelayConversationSnapshot {
  return {
    thread: options.thread,
    threadId: options.thread.id,
    sessionId: options.sessionId ?? options.thread.sessionId,
    cwd: options.thread.cwd,
    blocks: options.blocks.map(relayConversationBlock),
  };
}
