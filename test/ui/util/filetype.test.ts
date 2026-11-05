import { describe, expect, test } from "bun:test";
import { getFiletype } from "../../../src/ui/util/filetype";

describe("getFiletype", () => {
  test("maps known extensions case-insensitively", () => {
    expect(getFiletype(".TSX")).toBe("typescript");
    expect(getFiletype(".py")).toBe("python");
    expect(getFiletype(".md")).toBe("markdown");
  });

  test("falls back to none", () => {
    expect(getFiletype(".unknown")).toBe("none");
  });
});
