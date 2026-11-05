import { describe, expect, test } from "bun:test";
import { combineRelayLines } from "../../../src/ui/util/editor-chrome";

describe("combineRelayLines", () => {
  test("preserves line and segment strikethrough while composing editor chrome", () => {
    const combined = combineRelayLines(
      [
        { text: "whole", strikethrough: true },
        {
          text: "inherited",
          strikethrough: true,
          segments: [{ text: "in" }, { text: "herited" }],
        },
        {
          text: "mixed",
          segments: [{ text: "mix", strikethrough: true }, { text: "ed" }],
        },
      ],
      " | ",
    );

    expect(combined.segments).toEqual([
      { text: "whole", strikethrough: true },
      { text: " | " },
      { text: "in", strikethrough: true },
      { text: "herited", strikethrough: true },
      { text: " | " },
      { text: "mix", strikethrough: true },
      { text: "ed" },
    ]);
  });
});
