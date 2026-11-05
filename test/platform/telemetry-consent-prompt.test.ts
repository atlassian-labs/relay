import { describe, expect, test } from "bun:test";
import { renderTelemetryConsentPrompt } from "../../src/platform/telemetry-consent-prompt";

const ESCAPE_CHARACTER = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`, "g");

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

describe("telemetry consent prompt", () => {
  test("states what is collected and how to change the choice", () => {
    const rendered = stripAnsi(renderTelemetryConsentPrompt());
    expect(rendered).toContain("Usage analytics");
    expect(rendered).toContain("session duration");
    expect(rendered).toContain("Never collected: prompts, responses, file contents, or file paths.");
    expect(rendered).toContain("/settings");
  });

  test("defaults to keeping analytics off", () => {
    const rendered = stripAnsi(renderTelemetryConsentPrompt());
    expect(rendered).toContain("> No, keep analytics off");
    expect(rendered).toContain("(default)");
    expect(rendered).not.toContain("> Yes, enable usage analytics");
  });

  // Privacy requires the disclosure to come before the choice, and both answers
  // to read as equally prominent options.
  test("describes the collection before offering equally prominent answers", () => {
    const rendered = stripAnsi(renderTelemetryConsentPrompt());
    const disclosure = rendered.indexOf("session duration");
    const question = rendered.indexOf("Enable usage analytics?");
    const optIn = rendered.indexOf("Yes, enable usage analytics");
    const optOut = rendered.indexOf("No, keep analytics off");

    expect(disclosure).toBeGreaterThan(-1);
    expect(question).toBeGreaterThan(disclosure);
    expect(optIn).toBeGreaterThan(question);
    expect(optOut).toBeGreaterThan(optIn);
  });

  test("highlights the opt-in option when selected", () => {
    const rendered = stripAnsi(renderTelemetryConsentPrompt("yes"));
    expect(rendered).toContain("> Yes, enable usage analytics");
    expect(rendered).not.toContain("> No, keep analytics off");
  });
});
