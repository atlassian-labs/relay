import { ANSI, renderStartupPrompt, runStartupPrompt, type StartupPromptConfig } from "./startup-prompt";

export type TelemetryConsentSelection = "yes" | "no";

const TELEMETRY_CONSENT_CONFIG: StartupPromptConfig<TelemetryConsentSelection> = {
  header: [
    "",
    `  ${ANSI.BOLD}Usage analytics${ANSI.RESET}`,
    "",
    "  To help us improve Relay, we would like to collect anonymous usage",
    "  analytics: session duration, message count, tool-call count,",
    "  slash-command names, and which agent you use.",
    "",
    `  ${ANSI.DIM}Never collected: prompts, responses, file contents, or file paths.${ANSI.RESET}`,
    `  ${ANSI.DIM}You can change this later with ${ANSI.RESET}${ANSI.CYAN}/settings${ANSI.RESET}${ANSI.DIM}.${ANSI.RESET}`,
    "",
    "  Enable usage analytics?",
  ],
  options: [
    { value: "yes", label: "Yes, enable usage analytics" },
    { value: "no", label: "No, keep analytics off", isDefault: true },
  ],
  initialHighlight: "no",
  skipValue: "no",
};

export function renderTelemetryConsentPrompt(highlighted: TelemetryConsentSelection = "no"): string {
  return renderStartupPrompt(TELEMETRY_CONSENT_CONFIG, highlighted);
}

export function runTelemetryConsentPrompt(): Promise<TelemetryConsentSelection> {
  return runStartupPrompt(TELEMETRY_CONSENT_CONFIG);
}
