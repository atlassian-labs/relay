import { describe, expect, test } from "bun:test";
import {
  bottomOverlayReservedRows,
  clampDimension,
  composerPaddingX,
  composerReservedRows,
  modalFooterLabels,
  queueControlHints,
  queueControlsLabel,
  shouldSplitModalHeader,
  UI_COMPOSER_COMPACT_WIDTH,
  UI_COMPOSER_MIN_HEIGHT,
  UI_GUTTER_X,
  UI_INFO_BAR_HEIGHT,
  UI_PANEL_PADDING_X,
  UI_STATUS_LINE_HEIGHT,
} from "../../src/ui/layout";

describe("UI layout helpers", () => {
  test("uses compact composer padding on narrow terminals", () => {
    expect(composerPaddingX(UI_COMPOSER_COMPACT_WIDTH - 1)).toBe(UI_GUTTER_X);
    expect(composerPaddingX(UI_COMPOSER_COMPACT_WIDTH)).toBe(UI_PANEL_PADDING_X);
  });

  test("reserves only the compact composer rows", () => {
    expect(composerReservedRows(63)).toBe(UI_COMPOSER_MIN_HEIGHT);
    expect(composerReservedRows(120)).toBe(UI_COMPOSER_MIN_HEIGHT);
    expect(composerReservedRows(120, true)).toBe(UI_COMPOSER_MIN_HEIGHT);
    expect(bottomOverlayReservedRows(120)).toBe(UI_INFO_BAR_HEIGHT + UI_STATUS_LINE_HEIGHT + UI_COMPOSER_MIN_HEIGHT);
  });

  test("fits queue controls by terminal width", () => {
    expect(queueControlsLabel(80, "⌥↑/⌥↓")).toBe("⌥↑/⌥↓ select · enter edit · esc close");
    expect(queueControlsLabel(120, "⌥↑/⌥↓")).toBe(
      "↑/↓ select · enter edit · shift+⌥↑/⌥↓ move · tab steer · del remove · esc close",
    );
    expect(queueControlHints(80, "⌥↑/⌥↓")).toEqual([
      ["⌥↑/⌥↓", "select"],
      ["enter", "edit"],
      ["esc", "close"],
    ]);
  });

  test("clamps modal dimensions within terminal-safe bounds", () => {
    expect(clampDimension(20, 30, 80)).toBe(30);
    expect(clampDimension(120, 30, 80)).toBe(80);
    expect(clampDimension(56, 30, 80)).toBe(56);
  });

  test("fits modal header and footer affordances by available content width", () => {
    expect(shouldSplitModalHeader(24, "File changes", "12 files +120 -30")).toBe(false);
    expect(shouldSplitModalHeader(32, "File changes", "12 files +120 -30")).toBe(true);

    expect(modalFooterLabels(20)).toEqual({ primary: "esc close", secondary: null });
    expect(modalFooterLabels(60)).toEqual({ primary: "Click outside or esc close", secondary: "review before exit" });
  });
});
