import { describe, expect, test } from "bun:test";
import { elicitationNotificationSummary } from "../../../src/ui/util/elicitation-notification";
import type { ElicitationField } from "../../../src/ui/state";

function field(overrides: Partial<ElicitationField> = {}): ElicitationField {
  return {
    key: "target",
    title: "Target",
    description: undefined,
    type: "string",
    choices: [{ value: "local", title: "local" }],
    ...overrides,
  };
}

describe("elicitationNotificationSummary", () => {
  test("uses the visible field title for choice questions", () => {
    expect(
      elicitationNotificationSummary({
        mode: "form",
        message: "Hidden ACP prompt message",
        fields: [field()],
      }),
    ).toBe("Question: Target");
  });

  test("matches multi-step question numbering", () => {
    expect(
      elicitationNotificationSummary({
        mode: "form",
        message: "Hidden ACP prompt message",
        fields: [field(), field({ key: "region", title: "Region" })],
      }),
    ).toBe("Question 1 of 2: Target");
  });

  test("falls back to the visible unsupported-field message", () => {
    expect(
      elicitationNotificationSummary({
        mode: "form",
        message: "Enter a free-form answer",
        fields: [field({ choices: [] })],
      }),
    ).toBe("Question: Enter a free-form answer");
  });

  test("uses the terminal-visible URL fallback", () => {
    expect(
      elicitationNotificationSummary({
        mode: "url",
        message: "Open a browser",
        fields: [],
      }),
    ).toBe("URL elicitation is not supported in this terminal yet.");
  });
});
