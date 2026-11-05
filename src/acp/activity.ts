import type { AcpActivityKind } from "../core/activity";

export interface AcpActivity {
  kind: AcpActivityKind;
  label: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textFromContent(content: unknown): string | undefined {
  if (!isRecord(content)) return undefined;
  return typeof content.text === "string" ? content.text : undefined;
}

function toolNameFromUpdate(update: Record<string, unknown>): string {
  const kind = typeof update.kind === "string" ? update.kind : undefined;
  if (kind === "execute") return "bash";
  return typeof update.title === "string" && update.title.trim() ? update.title.trim() : "";
}

export function activityFromAcpSessionUpdate(update: unknown): AcpActivity | null {
  if (!isRecord(update)) return null;

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textFromContent(update.content);
      return typeof text === "string" && text.length > 0 ? { kind: "streaming", label: "" } : null;
    }
    case "agent_thought_chunk": {
      const text = textFromContent(update.content);
      return typeof text === "string" && text.length > 0 ? { kind: "reasoning", label: "" } : null;
    }
    case "tool_call":
    case "tool_call_update":
      return { kind: "tool", label: toolNameFromUpdate(update) };
    case "usage_update":
      return { kind: "active", label: "" };
    default:
      return null;
  }
}
