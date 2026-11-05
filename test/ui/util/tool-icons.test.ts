import { describe, expect, test } from "bun:test";
import { formatToolName } from "../../../src/ui/util/tool-icons";

describe("tool icon utilities", () => {
  test("formatToolName capitalizes underscore-separated words", () => {
    expect(formatToolName("read_file")).toBe("Read File");
    expect(formatToolName("bash")).toBe("Bash");
  });
});
