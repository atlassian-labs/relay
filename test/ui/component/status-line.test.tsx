import { describe, expect, test } from "bun:test";
import { resolveStatusLineRightContent, statusLineContentText } from "../../../src/ui/component/status-line";

describe("resolveStatusLineRightContent", () => {
  test("gives core status hints precedence over passive plugin status-line segments", () => {
    const content = resolveStatusLineRightContent({ key: "ctrl+c", label: " again to exit" }, ["pull-requests(9)"]);

    expect(content.hint).toEqual({ key: "ctrl+c", label: " again to exit" });
    expect(content.statusLine.text).toBe("");
  });

  test("shows plugin status-line segments when no core status hint is active", () => {
    const content = resolveStatusLineRightContent(null, ["pull-requests(9)", "demo"]);

    expect(content.hint).toBeNull();
    expect(statusLineContentText(content.statusLine)).toBe("pull-requests(9) · demo");
  });

  test("preserves rich status-line segment styles", () => {
    const content = resolveStatusLineRightContent(null, [
      {
        text: "PR(1) ctrl+p",
        segments: [{ text: "PR(1)", fg: "#7f849c" }, { text: " ctrl+p" }],
      },
      "demo",
    ]);

    expect(statusLineContentText(content.statusLine)).toBe("PR(1) ctrl+p · demo");
    expect(content.statusLine.segments?.[0]).toEqual({ text: "PR(1)", fg: "#7f849c" });
    expect(content.statusLine.segments?.[1]).toEqual({ text: " ctrl+p" });
    expect(content.statusLine.segments?.[2]).toEqual({ text: " · " });
    expect(content.statusLine.segments?.[3]).toEqual({ text: "demo" });
  });
});
