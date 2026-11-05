import type { ElicitationField } from "../state";

const URL_ELICITATION_UNSUPPORTED_MESSAGE = "URL elicitation is not supported in this terminal yet.";

function compactPreviewText(value: string, maxLength: number): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  return compacted.length > maxLength ? `${compacted.slice(0, Math.max(0, maxLength - 3))}...` : compacted;
}

export function elicitationNotificationSummary(options: {
  readonly mode: "form" | "url";
  readonly message: string;
  readonly fields: readonly ElicitationField[];
}): string {
  if (options.mode !== "form") return URL_ELICITATION_UNSUPPORTED_MESSAGE;

  const field = options.fields[0];
  if (!field || field.choices.length === 0) {
    const message = compactPreviewText(options.message, 160);
    return message ? `Question: ${message}` : "Question";
  }

  const prefix = options.fields.length > 1 ? `Question 1 of ${options.fields.length}` : "Question";
  const visiblePrompt = compactPreviewText(field.title || options.message, 160);
  return visiblePrompt ? `${prefix}: ${visiblePrompt}` : prefix;
}
