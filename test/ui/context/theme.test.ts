import { describe, expect, test } from "bun:test";
import { getLayerColors, getTheme, getThemeIds } from "../../../src/config/themes";
import { buildSyntaxStyle, getColors, getSyntaxStyle, invalidateSyntaxStyle } from "../../../src/ui/context/theme";

function rgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  return [0, 2, 4].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16)) as [number, number, number];
}

function relativeLuminance(hex: string): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = rgb(hex).map(channel) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg: string, bg: string): number {
  const fgLum = relativeLuminance(fg);
  const bgLum = relativeLuminance(bg);
  return (Math.max(fgLum, bgLum) + 0.05) / (Math.min(fgLum, bgLum) + 0.05);
}

function expectHexColor(value: string): void {
  expect(value).toMatch(/^#[0-9a-f]{6}$/i);
}

describe("theme context helpers", () => {
  test("getColors returns configured theme colors", () => {
    expect(getColors().fg).toBeTruthy();
  });

  test("getSyntaxStyle caches until invalidated", () => {
    const first = getSyntaxStyle();
    expect(getSyntaxStyle()).toBe(first);
    invalidateSyntaxStyle();
    expect(getSyntaxStyle()).not.toBe(first);
  });

  test("buildSyntaxStyle returns a SyntaxStyle", () => {
    expect(buildSyntaxStyle(getColors())).toBeTruthy();
  });

  test("derived layer colors are valid and readable across bundled themes", () => {
    for (const themeId of getThemeIds()) {
      const colors = getTheme(themeId).colors;
      const layers = getLayerColors(colors);
      for (const color of Object.values(layers)) expectHexColor(color);

      expect(contrastRatio(layers.onPanelDim, colors.panel)).toBeGreaterThanOrEqual(2.4);
      expect(contrastRatio(layers.onPanelAltDim, colors.panelAlt)).toBeGreaterThanOrEqual(2.4);
      expect(contrastRatio(layers.onUserPanelDim, colors.panelUser)).toBeGreaterThanOrEqual(2.4);
      expect(contrastRatio(layers.onPanelBorderSubtle, colors.panel)).toBeGreaterThanOrEqual(1.5);
      expect(contrastRatio(layers.borderSubtle, colors.bg)).toBeGreaterThanOrEqual(1.5);
    }
  });

  test("bundled panel surfaces remain distinguishable from app backgrounds", () => {
    for (const themeId of getThemeIds()) {
      const colors = getTheme(themeId).colors;
      expect(contrastRatio(colors.panel, colors.bg), themeId).toBeGreaterThanOrEqual(1.1);
    }
  });

  test("recently added themes keep tool status surfaces visually distinct", () => {
    for (const themeId of ["amp-dark", "amp-light", "grok-day", "grok-night", "synthwave84", "vesper"]) {
      const colors = getTheme(themeId).colors;
      expect(new Set(Object.values(colors.toolBg)).size, themeId).toBe(3);
    }
  });

  test("corrected themes keep label text between muted and foreground text", () => {
    const themeIds = [
      "dracula",
      "grok-night",
      "kanagawa",
      "kanagawa-dragon",
      "one-dark",
      "palenight",
      "rosepine",
      "solarized-dark",
      "solarized-light",
      "tokyo-day",
      "tokyo-night",
    ];

    for (const themeId of themeIds) {
      const colors = getTheme(themeId).colors;
      const subtleContrast = contrastRatio(colors.textSubtle, colors.bg);
      const mutedContrast = contrastRatio(colors.textMuted, colors.bg);
      const labelContrast = contrastRatio(colors.textLabel, colors.bg);
      const foregroundContrast = contrastRatio(colors.fg, colors.bg);

      expect(mutedContrast, themeId).toBeGreaterThan(subtleContrast);
      expect(labelContrast, themeId).toBeGreaterThan(mutedContrast);
      expect(foregroundContrast, themeId).toBeGreaterThan(labelContrast);
      expect(contrastRatio(colors.fg, colors.textLabel), themeId).toBeGreaterThanOrEqual(1.4);
    }
  });

  test("amp dark uses its configured editor and tool colors", () => {
    const colors = getTheme("amp-dark").colors;

    expect(colors.bg).toBe("#091c1e");
    expect(colors.panel).toBe("#122728");
    expect(colors.panelAlt).toBe(colors.bg);
    expect(colors.panelUser).toBe("#29322c");
    expect(colors.badge.label).toBe("#f6833b");
    expect(colors.running).toBe("#f6833b");
    expect(colors.textSubtle).toBe("#667069");
    expect(colors.textMuted).toBe("#818a82");
    expect(colors.textLabel).toBe("#9da49c");
    expect(colors.thinking).toBe(colors.textSubtle);
    expect(colors.diffAdded).toBe("#62c76b");
    expect(colors.diffRemoved).toBe("#f06f75");
  });

  test("vesper keeps full thinking blocks readable", () => {
    const colors = getTheme("vesper").colors;

    expect(contrastRatio(colors.textSubtle, colors.bg)).toBeGreaterThanOrEqual(2.8);
    expect(colors.thinking).toBe("#5c5c5c");
  });

  test("derived panel dim color strengthens weak gray-on-panel pairings", () => {
    const colors = getTheme("solarized-dark").colors;
    const layers = getLayerColors(colors);

    expect(contrastRatio(colors.dim, colors.panelUser)).toBeLessThan(2.4);
    expect(contrastRatio(layers.onUserPanelDim, colors.panelUser)).toBeGreaterThanOrEqual(2.4);
  });
});
