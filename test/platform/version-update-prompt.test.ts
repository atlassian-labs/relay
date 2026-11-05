import { describe, expect, test } from "bun:test";
import {
  applyVersionUpdatePromptKey,
  renderVersionUpdateCompleteMessage,
  renderVersionUpdatePrompt,
  type VersionUpdatePromptState,
} from "../../src/platform/version-update-prompt";
import type { VersionUpdateInfo } from "../../src/platform/version-check";

const update: VersionUpdateInfo = {
  version: "2026.28.1176+4d80caf",
  currentVersion: "2026.26.989+6cd3cd5",
  updateCommand: "atlas plugin upgrade -n relay",
};

const ESCAPE_CHARACTER = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`, "g");

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

describe("version update prompt", () => {
  test("renders update and skip choices", () => {
    const rendered = stripAnsi(renderVersionUpdatePrompt(update, "2026.26.989+6cd3cd5"));

    expect(rendered).toContain("Update available! 2026.26.989+6cd3cd5 -> 2026.28.1176+4d80caf");
    expect(rendered).toContain("  › 1. Update now (runs `atlas plugin upgrade -n relay`)");
    expect(rendered).toContain("    2. Skip");
    expect(rendered).toContain("  Press enter to continue");
  });

  test("highlights the active row marker", () => {
    const rendered = renderVersionUpdatePrompt(update);

    expect(rendered).toContain("  \x1b[36m›\x1b[0m 1. Update now (runs `atlas plugin upgrade -n relay`)");
  });

  test("renders update completion message", () => {
    expect(renderVersionUpdateCompleteMessage("2026.28.1176+4d80caf")).toBe(
      "Relay updated to version 2026.28.1176+4d80caf. Please start again.",
    );
  });

  test("supports direct update and skip selections", () => {
    const state: VersionUpdatePromptState = { highlighted: "update", selection: null };

    expect(applyVersionUpdatePromptKey(state, "1")).toEqual({ highlighted: "update", selection: "update" });
    expect(applyVersionUpdatePromptKey(state, "2")).toEqual({ highlighted: "skip", selection: "skip" });
  });

  test("enter selects highlighted choice", () => {
    const state: VersionUpdatePromptState = { highlighted: "skip", selection: null };

    expect(applyVersionUpdatePromptKey(state, "\r")).toEqual({ highlighted: "skip", selection: "skip" });
  });

  test("escape and control-c skip", () => {
    const state: VersionUpdatePromptState = { highlighted: "update", selection: null };

    expect(applyVersionUpdatePromptKey(state, "\x1b")).toEqual({ highlighted: "skip", selection: "skip" });
    expect(applyVersionUpdatePromptKey(state, "\u0003")).toEqual({ highlighted: "skip", selection: "skip" });
  });

  test("arrow and vim keys move highlight", () => {
    const state: VersionUpdatePromptState = { highlighted: "update", selection: null };

    expect(applyVersionUpdatePromptKey(state, "j")).toEqual({ highlighted: "skip", selection: null });
    expect(applyVersionUpdatePromptKey({ highlighted: "skip", selection: null }, "\x1b[A")).toEqual({
      highlighted: "update",
      selection: null,
    });
  });
});
