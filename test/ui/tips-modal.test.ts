import { expect, test } from "bun:test";
import { wrapTipRows } from "../../src/ui/component/shortcut-reference-modal";

test("wrapTipRows wraps long tips with hanging indentation", () => {
  expect(wrapTipRows(["xxxx", "xxxxxx xxx", "xxx"], 10)).toEqual([
    { prefix: "1.", text: "xxxx" },
    { prefix: "2.", text: "xxxxxx" },
    { prefix: "", text: "xxx" },
    { prefix: "3.", text: "xxx" },
  ]);
});

test("wrapTipRows reserves enough prefix width for double digit tips", () => {
  const tips = Array.from({ length: 10 }, (_, index) => (index === 9 ? "alpha beta" : `tip ${index + 1}`));

  expect(wrapTipRows(tips, 9).slice(-2)).toEqual([
    { prefix: "10.", text: "alpha" },
    { prefix: "", text: "beta" },
  ]);
});

test("wrapTipRows splits words longer than the available text width", () => {
  expect(wrapTipRows(["abcdefgh"], 6)).toEqual([
    { prefix: "1.", text: "abc" },
    { prefix: "", text: "def" },
    { prefix: "", text: "gh" },
  ]);
});
