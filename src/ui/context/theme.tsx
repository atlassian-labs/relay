import { SyntaxStyle } from "@opentui/core";
import { getConfig } from "../../config";
import type { ColorsConfig } from "../../config/themes";
import { createSimpleContext } from "./helper";

export function getColors(): ColorsConfig {
  return getConfig().colors;
}

export function buildSyntaxStyle(colors: ColorsConfig): SyntaxStyle {
  return SyntaxStyle.fromTheme([
    { scope: ["markup.heading"], style: { foreground: colors.fg, bold: true } },
    { scope: ["markup.heading.1"], style: { foreground: colors.fg, bold: true } },
    { scope: ["markup.heading.2"], style: { foreground: colors.fg, bold: true } },
    { scope: ["markup.heading.3"], style: { foreground: colors.fg, bold: true } },
    { scope: ["markup.heading.4"], style: { foreground: colors.fg, bold: true } },
    { scope: ["markup.heading.5"], style: { foreground: colors.fg, bold: true } },
    { scope: ["markup.heading.6"], style: { foreground: colors.fg, bold: true } },
    { scope: ["markup.bold", "markup.strong"], style: { foreground: colors.fg, bold: true } },
    { scope: ["markup.italic"], style: { foreground: colors.fg, italic: true } },
    { scope: ["markup.list"], style: { foreground: colors.fg } },
    { scope: ["markup.quote"], style: { foreground: colors.textLabel, italic: true } },
    { scope: ["markup.raw", "markup.raw.block"], style: { foreground: colors.markdownCode } },
    { scope: ["markup.raw.inline"], style: { foreground: colors.markdownCode, background: colors.bg } },
    { scope: ["markup.link"], style: { foreground: colors.accent, underline: true } },
    { scope: ["markup.link.label"], style: { foreground: colors.accent, underline: true } },
    { scope: ["markup.link.url"], style: { foreground: colors.accent, underline: true } },
    { scope: ["label"], style: { foreground: colors.fg } },
    { scope: ["spell", "nospell"], style: { foreground: colors.fg } },
    { scope: ["default"], style: { foreground: colors.fg } },
    { scope: ["conceal"], style: { foreground: colors.textMuted } },
    { scope: ["keyword"], style: { foreground: colors.accent } },
    { scope: ["keyword.control"], style: { foreground: colors.accent } },
    { scope: ["string"], style: { foreground: colors.markdownCode } },
    { scope: ["comment"], style: { foreground: colors.textMuted, italic: true } },
    { scope: ["function"], style: { foreground: colors.info } },
    { scope: ["number", "constant.numeric"], style: { foreground: colors.notice } },
    { scope: ["type"], style: { foreground: colors.info } },
    { scope: ["variable"], style: { foreground: colors.fg } },
    { scope: ["operator"], style: { foreground: colors.textLabel } },
    { scope: ["punctuation"], style: { foreground: colors.textLabel } },
  ]);
}

export function buildThinkingSyntaxStyle(colors: ColorsConfig): SyntaxStyle {
  const subtleItalic = { foreground: colors.textSubtle, italic: true };
  return SyntaxStyle.fromTheme([
    { scope: ["default"], style: subtleItalic },
    { scope: ["markup.heading"], style: subtleItalic },
    { scope: ["markup.heading.1"], style: subtleItalic },
    { scope: ["markup.heading.2"], style: subtleItalic },
    { scope: ["markup.heading.3"], style: subtleItalic },
    { scope: ["markup.heading.4"], style: subtleItalic },
    { scope: ["markup.heading.5"], style: subtleItalic },
    { scope: ["markup.heading.6"], style: subtleItalic },
    { scope: ["markup.bold", "markup.strong"], style: subtleItalic },
    { scope: ["markup.italic"], style: subtleItalic },
    { scope: ["markup.list"], style: subtleItalic },
    { scope: ["markup.quote"], style: subtleItalic },
    { scope: ["markup.raw", "markup.raw.block", "markup.raw.inline"], style: subtleItalic },
    { scope: ["markup.link", "markup.link.label", "markup.link.url"], style: subtleItalic },
    { scope: ["label", "spell", "nospell"], style: subtleItalic },
    { scope: ["conceal"], style: subtleItalic },
    { scope: ["keyword", "keyword.control"], style: subtleItalic },
    { scope: ["string"], style: subtleItalic },
    { scope: ["comment"], style: subtleItalic },
    { scope: ["function"], style: subtleItalic },
    { scope: ["number", "constant.numeric"], style: subtleItalic },
    { scope: ["type"], style: subtleItalic },
    { scope: ["variable"], style: subtleItalic },
    { scope: ["operator"], style: subtleItalic },
    { scope: ["punctuation"], style: subtleItalic },
  ]);
}

let cachedSyntaxStyle: SyntaxStyle | null = null;
let cachedSyntaxCacheKey = "";
let cachedThinkingSyntaxStyle: SyntaxStyle | null = null;
let cachedThinkingSyntaxCacheKey = "";

export function getSyntaxStyle(): SyntaxStyle {
  const cfg = getConfig();
  const cacheKey = cfg.ui.theme;
  if (cachedSyntaxStyle && cachedSyntaxCacheKey === cacheKey) return cachedSyntaxStyle;
  cachedSyntaxStyle = buildSyntaxStyle(getColors());
  cachedSyntaxCacheKey = cacheKey;
  return cachedSyntaxStyle;
}

export function getThinkingSyntaxStyle(): SyntaxStyle {
  const cfg = getConfig();
  const cacheKey = cfg.ui.theme;
  if (cachedThinkingSyntaxStyle && cachedThinkingSyntaxCacheKey === cacheKey) return cachedThinkingSyntaxStyle;
  cachedThinkingSyntaxStyle = buildThinkingSyntaxStyle(getColors());
  cachedThinkingSyntaxCacheKey = cacheKey;
  return cachedThinkingSyntaxStyle;
}

export function invalidateSyntaxStyle(): void {
  cachedSyntaxStyle = null;
  cachedSyntaxCacheKey = "";
  cachedThinkingSyntaxStyle = null;
  cachedThinkingSyntaxCacheKey = "";
}

export interface ThemeContextValue {
  colors: typeof getColors;
  syntaxStyle: typeof getSyntaxStyle;
  thinkingSyntaxStyle: typeof getThinkingSyntaxStyle;
  invalidateSyntaxStyle: typeof invalidateSyntaxStyle;
}

export function createThemeValue(): ThemeContextValue {
  return {
    colors: getColors,
    syntaxStyle: getSyntaxStyle,
    thinkingSyntaxStyle: getThinkingSyntaxStyle,
    invalidateSyntaxStyle,
  };
}

export const ThemeContext = createSimpleContext<ThemeContextValue>({
  name: "Theme",
  init: createThemeValue,
});

export const ThemeProvider = ThemeContext.provider;
export const useTheme = ThemeContext.use;
