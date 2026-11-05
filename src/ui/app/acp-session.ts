export {
  availableModelIdsFromSessionResult,
  availableThinkingLevelsFromSessionResult,
  currentModelIdFromSessionResult,
  currentThinkingLevelFromSessionResult,
  modelConfigIdFromSessionResult,
  thinkingConfigIdFromSessionResult,
} from "../../acp/session-config";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * Extract text from an ACP ToolCallContent[] array. Used as a fallback when
 * rawOutput is null/undefined but the tool_call_update still carries results
 * in its content field.
 */
export function extractAcpContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!isRecord(item) || item.type !== "content" || !isRecord(item.content)) return "";
      if (item.content.type !== "text") return "";
      return String(item.content.text ?? "");
    })
    .filter(Boolean)
    .join("\n");
}
