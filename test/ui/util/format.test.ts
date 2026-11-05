import { describe, expect, test } from "bun:test";
import {
  formatCompactNumber,
  formatDuration,
  formatPath,
  stripEmoji,
  stripTerminalControls,
  truncateTextEnd,
} from "../../../src/ui/util/format";

describe("format utilities", () => {
  test("stripEmoji removes emoji, variation selectors, ZWJ and replacement chars", () => {
    expect(stripEmoji("ok ✅ test 🚀\uFE0F\u200D�")).toBe("ok  test ");
  });

  test("stripTerminalControls removes ANSI escapes and non-printing controls", () => {
    expect(stripTerminalControls("\x1B[31mred\x1B[0m bell\x07\nnext\tok")).toBe("red bell\nnext\tok");
    expect(stripTerminalControls("\x1B]8;;https://example.com\x07link\x1B]8;;\x07")).toBe("link");
  });

  test("formatPath shortens paths under home", () => {
    expect(formatPath("/home/me/project/file.ts", "/home/me")).toBe("~/project/file.ts");
    expect(formatPath("/tmp/file.ts", "/home/me")).toBe("/tmp/file.ts");
  });

  test("truncateTextEnd handles edge widths", () => {
    expect(truncateTextEnd("abcdef", 0)).toBe("");
    expect(truncateTextEnd("abcdef", 2)).toBe("..");
    expect(truncateTextEnd("abcdef", 5)).toBe("ab...");
    expect(truncateTextEnd("abc", 5)).toBe("abc");
  });

  test("formatDuration uses compact units", () => {
    expect(formatDuration(-1)).toBe("0s");
    expect(formatDuration(59)).toBe("59s");
    expect(formatDuration(61)).toBe("1m 1s");
    expect(formatDuration(3661)).toBe("1h 1m");
    expect(formatDuration(90000)).toBe("1d 1h");
  });

  test("formatCompactNumber uses k and m suffixes", () => {
    expect(formatCompactNumber(999)).toBe("999");
    expect(formatCompactNumber(1000)).toBe("1k");
    expect(formatCompactNumber(1500)).toBe("1.5k");
    expect(formatCompactNumber(12_345)).toBe("12k");
    expect(formatCompactNumber(1_000_000)).toBe("1m");
    expect(formatCompactNumber(1_250_000)).toBe("1.3m");
  });
});
