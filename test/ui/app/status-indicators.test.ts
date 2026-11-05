import { describe, expect, test } from "bun:test";
import { shouldResetIdleStartupTip } from "../../../src/ui/app/status-indicators";

describe("shouldResetIdleStartupTip", () => {
  test("does not reset completed turn tips paired with elapsed status", () => {
    expect(
      shouldResetIdleStartupTip({
        connecting: false,
        running: false,
        elapsedSeconds: 12,
      }),
    ).toBe(false);
  });

  test("resets idle startup tips before any turn status is visible", () => {
    expect(
      shouldResetIdleStartupTip({
        connecting: false,
        running: false,
        elapsedSeconds: 0,
      }),
    ).toBe(true);
  });

  test("does not reset while connecting or running", () => {
    expect(
      shouldResetIdleStartupTip({
        connecting: true,
        running: false,
        elapsedSeconds: 0,
      }),
    ).toBe(false);
    expect(
      shouldResetIdleStartupTip({
        connecting: false,
        running: true,
        elapsedSeconds: 0,
      }),
    ).toBe(false);
  });
});
