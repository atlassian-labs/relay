import { describe, expect, test } from "bun:test";
import {
  connectionFailureSummary,
  formatInlineConnectionFailure,
  formatInlineStartupError,
  RELAY_WELCOME_LOGO_LINES,
  startupErrorSummary,
  WELCOME_TIPS,
} from "../../src/ui/component/welcome-screen";

describe("welcome screen tips", () => {
  test("keeps startup tips structurally renderable", () => {
    const normalizedTips = WELCOME_TIPS.map((tip) => tip.trim());

    expect(normalizedTips.length).toBeGreaterThan(0);
    expect(normalizedTips.every((tip) => tip.length > 0)).toBe(true);
    expect(normalizedTips.every((tip) => !tip.includes("\n"))).toBe(true);
    expect(normalizedTips.every((tip) => !tip.endsWith("."))).toBe(true);
    expect(new Set(normalizedTips).size).toBe(normalizedTips.length);
    expect(Math.max(...normalizedTips.map((tip) => tip.length))).toBeLessThanOrEqual(64);
  });

  test("uses the Relay wordmark", () => {
    expect(RELAY_WELCOME_LOGO_LINES).toEqual([
      "                    ░██                       ",
      "                    ░██                       ",
      "░██░████  ░███████  ░██  ░██████   ░██    ░██ ",
      "░███     ░██    ░██ ░██       ░██  ░██    ░██ ",
      "░██      ░█████████ ░██  ░███████  ░██    ░██ ",
      "░██      ░██        ░██ ░██   ░██  ░██   ░███ ",
      "░██       ░███████  ░██  ░█████░██  ░█████░██ ",
      "                                          ░██ ",
      "                                    ░███████  ",
    ]);
    expect(new Set(RELAY_WELCOME_LOGO_LINES.map((line) => line.length))).toEqual(new Set([46]));
  });

  test("extracts the connection failure reason from verbose agent output", () => {
    const summary = connectionFailureSummary(
      "Failed to connect to alta-gpt5-high agent: ACP connection closed\n\nAgent output:\n[16:40:54.098] DEBUG cached token",
    );

    expect(summary).toEqual({
      lead: "Failed to connect to alta-gpt5-high agent: ",
      reason: "ACP connection closed",
      details:
        "Failed to connect to alta-gpt5-high agent: ACP connection closed\n\nAgent output:\n[16:40:54.098] DEBUG cached token",
    });
  });

  test("promotes safe startup stderr over ACP connection closed", () => {
    const summary = connectionFailureSummary(
      [
        "Failed to connect to sample-agent agent: ACP connection closed",
        "",
        "Agent output:",
        "error: Authentication required. No OAuth credential is saved.",
        "hint: Run `sample-agent auth login`.",
      ].join("\n"),
    );

    expect(summary?.reason).toBe(
      "Authentication required. No OAuth credential is saved. Run `sample-agent auth login`.",
    );
  });

  test("formats connection failures within the inline preview bounds", () => {
    const summary = connectionFailureSummary(
      `Failed to connect to sample-agent agent: ${"refresh endpoint returned 403 ".repeat(20)}`,
    );

    expect(summary).not.toBeNull();
    const lines = formatInlineConnectionFailure(summary!, "x ", 100);
    const text = lines.map((line) => line.text).join("");

    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.text.length <= 72)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text.endsWith(" ↗")).toBe(true);
  });

  test("formats connection failures to fit narrower terminals", () => {
    const summary = connectionFailureSummary(
      `Failed to connect to sample-agent agent: ${"refresh endpoint returned 403 ".repeat(10)}`,
    );

    expect(summary).not.toBeNull();
    const lines = formatInlineConnectionFailure(summary!, "x ", 40);

    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines.every((line) => line.text.length <= 40)).toBe(true);
    expect(lines[0]?.lead.startsWith("x Failed to connect to sample-agent")).toBe(true);
  });

  test("summarizes generic startup errors for bounded welcome previews", () => {
    const content = [
      "No agent runner configured for: missing-agent. Available agents: faux, rovo, codex, claude, cursor. Config file: /tmp/relay/config.toml",
      "Use --agent <name> to select another agent.",
    ].join("\n");

    const summary = startupErrorSummary(content);

    expect(summary).toEqual({
      lead: "",
      reason:
        "No agent runner configured for: missing-agent. Available agents: faux, rovo, codex, claude, cursor. Config file: /tmp/relay/config.toml",
      details: content,
      title: "Startup error",
    });
  });

  test("formats generic startup errors within the inline preview bounds", () => {
    const summary = startupErrorSummary(
      `No agent runner configured for: missing-agent. Available agents: ${"faux, ".repeat(40)}`,
    );

    expect(summary).not.toBeNull();
    const lines = formatInlineStartupError(summary!, "✗ ", 120);
    const text = lines.map((line) => line.text).join("");

    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.text.length <= 72)).toBe(true);
    expect(lines[0]?.lead).toBe("✗ ");
    expect(text.endsWith(" ↗")).toBe(true);
  });
});
