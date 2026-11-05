export type ActiveTurnInputSubmission = {
  text: string;
  historyText: string;
  pasteMappings?: Record<number, string>;
};

export type ActiveTurnInputValidation =
  | { ok: true }
  | { ok: false; reason: "empty" | "command" | "not-running" | "unsupported"; message?: string };

export function validateActiveTurnInput(
  submission: ActiveTurnInputSubmission,
  options: { running: boolean; supportsActiveTurnInput: boolean },
): ActiveTurnInputValidation {
  const trimmed = submission.text.trim();
  const historyTrimmed = submission.historyText.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (historyTrimmed.startsWith("!") || historyTrimmed.startsWith("/")) {
    return { ok: false, reason: "command", message: "Only ordinary prompts can be added to the current turn" };
  }
  if (!options.running) {
    return {
      ok: false,
      reason: "not-running",
      message: "Add to current turn is only available while the agent is running",
    };
  }
  if (!options.supportsActiveTurnInput) {
    return { ok: false, reason: "unsupported", message: "This agent cannot add to the current turn" };
  }
  return { ok: true };
}
