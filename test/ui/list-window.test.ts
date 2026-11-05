import { describe, expect, test } from "bun:test";

import { centeredWindowStart, listRangeLabel } from "../../src/ui/util/list-window";

describe("list window helpers", () => {
  test("centers a selection while clamping the first and last windows", () => {
    expect(centeredWindowStart(0, 20, 5)).toBe(0);
    expect(centeredWindowStart(10, 20, 5)).toBe(8);
    expect(centeredWindowStart(19, 20, 5)).toBe(15);
  });

  test("clamps invalid selection indexes", () => {
    expect(centeredWindowStart(-10, 20, 5)).toBe(0);
    expect(centeredWindowStart(100, 20, 5)).toBe(15);
  });

  test("only shows a range when the list overflows", () => {
    expect(listRangeLabel(0, 5, 5)).toBe("");
    expect(listRangeLabel(5, 5, 12)).toBe("6-10/12");
    expect(listRangeLabel(10, 5, 12)).toBe("11-12/12");
  });
});
