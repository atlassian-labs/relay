import { describe, expect, test } from "bun:test";

import { hasOptionModifier, isEnterKey } from "../../../src/ui/util/key-events";

describe("key event helpers", () => {
  test("detects enter-equivalent key names", () => {
    expect(isEnterKey({ name: "return" })).toBe(true);
    expect(isEnterKey({ name: "kpenter" })).toBe(true);
    expect(isEnterKey({ name: "enter" })).toBe(true);
    expect(isEnterKey({ name: "up" })).toBe(false);
  });

  test("detects option modifier from option or meta event shapes", () => {
    expect(hasOptionModifier({ option: true })).toBe(true);
    expect(hasOptionModifier({ meta: true })).toBe(true);
    expect(hasOptionModifier({ option: false, meta: false })).toBe(false);
  });
});
