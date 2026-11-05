import { describe, expect, test } from "bun:test";
import { buildExitMessage, formatExitDuration, hexToAnsi } from "../../../src/ui/util/exit-message";
import { getColors } from "../../../src/ui/context/theme";

describe("exit message utilities", () => {
  test("formats durations", () => {
    expect(formatExitDuration(12)).toBe("12s");
    expect(formatExitDuration(75)).toBe("1m 15s");
  });

  test("converts hex colors to ansi", () => {
    expect(hexToAnsi("#010203")).toBe("\x1b[38;2;1;2;3m");
    expect(hexToAnsi("bad")).toBe("");
  });

  test("builds message with time, file changes and resume command", () => {
    const message = buildExitMessage({
      colors: getColors(),
      sessionStartedAt: 0,
      now: 65_000,
      sessionId: "session-1",
      fileChanges: [
        { path: "a.ts", added: 2, removed: 1 },
        { path: "a.ts", added: 3, removed: 0 },
      ],
    });
    expect(message).toContain("Time");
    expect(message).toContain("1m 5s");
    expect(message).toContain("Changed 1 file");
    expect(message).toContain("relay -r session-1");
    expect(message).toContain(hexToAnsi(getColors().accent));
    expect(message.indexOf("Time")).toBeGreaterThan(message.lastIndexOf("░"));
    expect(message.indexOf("To resume")).toBeGreaterThan(message.lastIndexOf("░"));
  });
});
