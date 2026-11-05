import { describe, expect, test } from "bun:test";
import { appendUserBashOutput, createUserBashBlock, finalizeUserBashBlock } from "../../../src/ui/util/user-bash-block";

describe("user bash block utilities", () => {
  test("creates running bash blocks", () => {
    expect(createUserBashBlock("ls", false)).toMatchObject({
      type: "user-bash",
      command: "ls",
      status: "running",
      excludeFromContext: false,
    });
  });

  test("appends output", () => {
    const block = createUserBashBlock("ls", false);
    block.output = "a";
    expect(appendUserBashOutput(block, "b")).toEqual({ output: "ab" });
  });

  test("finalizes status", () => {
    expect(finalizeUserBashBlock("out", 0, false)).toMatchObject({ status: "done" });
    expect(finalizeUserBashBlock("out", undefined, true)).toMatchObject({ status: "error" });
  });
});
