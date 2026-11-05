import { describe, expect, test } from "bun:test";
import { composeUserBashContext } from "../../../src/ui/util/submit";

describe("submit utilities", () => {
  test("composeUserBashContext appends pending command output", () => {
    expect(composeUserBashContext("explain", [{ command: "ls", output: "a\n", exitCode: 0 }])).toContain("$ ls\na");
  });

  test("composeUserBashContext includes non-zero exits", () => {
    expect(composeUserBashContext("fix", [{ command: "false", output: "", exitCode: 1 }])).toContain("(exit 1)");
  });

  test("composeUserBashContext leaves text unchanged without pending results", () => {
    expect(composeUserBashContext("hello", [])).toBe("hello");
  });
});
