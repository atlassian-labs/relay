import * as path from "node:path";
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "../platform/fs";

// ---------------------------------------------------------------------------
// Theme definitions
// ---------------------------------------------------------------------------

export interface ToolBgConfig {
  pending: string;
  success: string;
  error: string;
}

export interface BadgeColorConfig {
  bg: string;
  label: string;
}

export interface ColorsConfig {
  bg: string;
  fg: string;
  /** Very low contrast text for gutters, separators, and least-important hints. */
  textSubtle: string;
  /** Muted readable text for metadata, thinking text, and tool output. */
  textMuted: string;
  /** Label/detail text for headings, tool details, and structural labels. */
  textLabel: string;
  /** @deprecated Use textSubtle. */
  faint: string;
  /** @deprecated Use textMuted. */
  dim: string;
  /** @deprecated Use textLabel. */
  muted: string;
  title: string;
  spinner: string;
  accent: string;
  info: string;
  markdownHeading: string;
  markdownCode: string;
  selected: string;
  error: string;
  notice: string;
  diffAdded: string;
  diffRemoved: string;
  toolBg: ToolBgConfig;
  badge: BadgeColorConfig;
  running: string;
  success: string;
  failed: string;
  panel: string;
  panelAlt: string;
  panelUser: string;
  border: string;
  thinking: string;
}

/**
 * Computed diff colors for the <diff> element, derived from base theme colors.
 * Uses low-alpha background tinting for green/red changes.
 */
export interface DiffColors {
  addedBg: string;
  removedBg: string;
  contextBg: string;
  lineNumberFg: string;
  highlightAdded: string;
  highlightRemoved: string;
  addedLineNumberBg: string;
  removedLineNumberBg: string;
}

export interface LayerColors {
  onPanelDim: string;
  onPanelAltDim: string;
  onUserPanelDim: string;
  onPanelBorderSubtle: string;
  borderSubtle: string;
}

/** Parse a hex color into [r, g, b] (0-255). */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Convert [r, g, b] (0-255) to hex string. */
function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${clamp(r).toString(16).padStart(2, "0")}${clamp(g).toString(16).padStart(2, "0")}${clamp(b).toString(16).padStart(2, "0")}`;
}

/** Blend color with base at given alpha (0-1). */
function tint(base: string, color: string, alpha: number): string {
  const [br, bg, bb] = hexToRgb(base);
  const [cr, cg, cb] = hexToRgb(color);
  return rgbToHex(br + (cr - br) * alpha, bg + (cg - bg) * alpha, bb + (cb - bb) * alpha);
}

export function blendHexColors(base: string, overlay: string, overlayWeight: number): string {
  return tint(base, overlay, overlayWeight);
}

function relativeLuminance(hex: string): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = hexToRgb(hex).map(channel) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg: string, bg: string): number {
  const fgLum = relativeLuminance(fg);
  const bgLum = relativeLuminance(bg);
  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);
  return (lighter + 0.05) / (darker + 0.05);
}

function mostReadableOn(bg: string, candidates: readonly string[]): string {
  let best = candidates[0] ?? "#ffffff";
  let bestContrast = contrastRatio(best, bg);
  for (const candidate of candidates.slice(1)) {
    const candidateContrast = contrastRatio(candidate, bg);
    if (candidateContrast > bestContrast) {
      best = candidate;
      bestContrast = candidateContrast;
    }
  }
  return best;
}

function ensureContrastOnSurface(candidate: string, surface: string, target: string, minimum: number): string {
  if (contrastRatio(candidate, surface) >= minimum) return candidate;

  for (let step = 1; step <= 20; step++) {
    const strengthened = tint(candidate, target, step / 20);
    if (contrastRatio(strengthened, surface) >= minimum) return strengthened;
  }

  return mostReadableOn(surface, [target, "#ffffff", "#000000"]);
}

export function getLayerColors(colors: ColorsConfig): LayerColors {
  return {
    onPanelDim: ensureContrastOnSurface(colors.textMuted, colors.panel, colors.fg, 2.4),
    onPanelAltDim: ensureContrastOnSurface(colors.textMuted, colors.panelAlt, colors.fg, 2.4),
    onUserPanelDim: ensureContrastOnSurface(colors.textMuted, colors.panelUser, colors.fg, 2.4),
    onPanelBorderSubtle: ensureContrastOnSurface(colors.border, colors.panel, colors.fg, 1.5),
    borderSubtle: ensureContrastOnSurface(colors.border, colors.bg, colors.fg, 1.5),
  };
}

/** Compute diff colors from a theme's base colors. */
export function computeDiffColors(colors: ColorsConfig): DiffColors {
  const isDark = isDarkTheme(colors.bg);
  const alpha = isDark ? 0.18 : 0.12;
  const green = colors.diffAdded;
  const red = colors.diffRemoved;

  return {
    addedBg: tint(colors.bg, green, alpha),
    removedBg: tint(colors.bg, red, alpha),
    contextBg: tint(colors.bg, colors.textMuted, 0.08),
    lineNumberFg: colors.textMuted,
    highlightAdded: colors.diffAdded,
    highlightRemoved: colors.diffRemoved,
    addedLineNumberBg: tint(colors.panel, green, alpha),
    removedLineNumberBg: tint(colors.panel, red, alpha),
  };
}

function isDarkTheme(bg: string): boolean {
  const [r, g, b] = hexToRgb(bg);
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance < 128;
}

export interface ThemeConfig {
  id: string;
  label: string;
  colors: ColorsConfig;
}

type RawColorsConfig = Omit<ColorsConfig, "faint" | "dim" | "muted"> &
  Partial<Pick<ColorsConfig, "faint" | "dim" | "muted">>;

type RawThemeConfig = Omit<ThemeConfig, "colors"> & {
  colors: RawColorsConfig;
};

function resolveThemeColors(theme: RawThemeConfig): ColorsConfig {
  const { textSubtle, textMuted, textLabel } = theme.colors;
  return {
    ...theme.colors,
    faint: theme.colors.faint ?? textSubtle,
    dim: theme.colors.dim ?? textMuted,
    muted: theme.colors.muted ?? textLabel,
  };
}

// ---------------------------------------------------------------------------
// Bundled themes
// ---------------------------------------------------------------------------

const BUILTIN_THEMES: Record<string, RawThemeConfig> = {
  "amp-dark": {
    id: "amp-dark",
    label: "Amp Dark",
    colors: {
      bg: "#091c1e",
      fg: "#f6fff5",
      textSubtle: "#667069",
      textMuted: "#818a82",
      textLabel: "#9da49c",
      title: "#2aa12b",
      spinner: "#36c838",
      accent: "#2aa12b",
      info: "#1ee9b6",
      markdownHeading: "#ffb71b",
      markdownCode: "#1ee9b6",
      selected: "#2aa12b",
      error: "#f87171",
      notice: "#ffb71b",
      diffAdded: "#62c76b",
      diffRemoved: "#f06f75",
      toolBg: { pending: "#102426", success: "#102f24", error: "#2a1d1e" },
      badge: { bg: "#172c2d", label: "#f6833b" },
      running: "#f6833b",
      success: "#2aa12b",
      failed: "#f87171",
      panel: "#122728",
      panelAlt: "#091c1e",
      panelUser: "#29322c",
      border: "#566361",
      thinking: "#667069",
    },
  },

  "amp-light": {
    id: "amp-light",
    label: "Amp Light",
    colors: {
      bg: "#fafaf8",
      fg: "#0b0d0b",
      textSubtle: "#595959",
      textMuted: "#333333",
      textLabel: "#828381",
      title: "#29702a",
      spinner: "#2aa12b",
      accent: "#29702a",
      info: "#1a8f72",
      markdownHeading: "#9e6e05",
      markdownCode: "#1a8f72",
      selected: "#29702a",
      error: "#d44444",
      notice: "#9e6e05",
      diffAdded: "#29702a",
      diffRemoved: "#d44444",
      toolBg: { pending: "#f3f3f1", success: "#e4f0e4", error: "#f7e3e3" },
      badge: { bg: "#ececea", label: "#29702a" },
      running: "#2aa12b",
      success: "#29702a",
      failed: "#d44444",
      panel: "#ededeb",
      panelAlt: "#ececea",
      panelUser: "#e7e7e4",
      border: "#878b86",
      thinking: "#333333",
    },
  },

  ayu: {
    id: "ayu",
    label: "Ayu",
    colors: {
      bg: "#0f1419",
      fg: "#e6e1cf",
      textSubtle: "#575c63",
      textMuted: "#788390",
      textLabel: "#9aa4b1",
      title: "#D2A6FF",
      spinner: "#59C2FF",
      accent: "#E6B450",
      info: "#39BAE6",
      markdownHeading: "#D2A6FF",
      markdownCode: "#AAD94C",
      selected: "#7FD962",
      error: "#D95757",
      notice: "#E6B673",
      diffAdded: "#7FD962",
      diffRemoved: "#F26D78",
      toolBg: { pending: "#0D1017", success: "#20303b", error: "#37222c" },
      badge: { bg: "#0D1017", label: "#D2A6FF" },
      running: "#59C2FF",
      success: "#7FD962",
      failed: "#D95757",
      panel: "#1c1f25",
      panelAlt: "#0D1017",
      panelUser: "#282a30",
      border: "#6C7380",
      thinking: "#D2A6FF",
    },
  },

  "catppuccin-frappe": {
    id: "catppuccin-frappe",
    label: "Catppuccin Frappe",
    colors: {
      bg: "#303446",
      fg: "#c6d0f5",
      textSubtle: "#727992",
      textMuted: "#8790aa",
      textLabel: "#a5adce",
      title: "#ca9ee6",
      spinner: "#8da4e2",
      accent: "#f4b8e4",
      info: "#81c8be",
      markdownHeading: "#ca9ee6",
      markdownCode: "#a6d189",
      selected: "#a6d189",
      error: "#e78284",
      notice: "#e5c890",
      diffAdded: "#a6d189",
      diffRemoved: "#e78284",
      toolBg: { pending: "#232634", success: "#29342b", error: "#3a2a31" },
      badge: { bg: "#232634", label: "#ca9ee6" },
      running: "#8da4e2",
      success: "#a6d189",
      failed: "#e78284",
      panel: "#292c3c",
      panelAlt: "#232634",
      panelUser: "#484c5c",
      border: "#414559",
      thinking: "#ca9ee6",
    },
  },

  "catppuccin-latte": {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    colors: {
      bg: "#eff1f5",
      fg: "#4c4f69",
      textSubtle: "#8b8ea1",
      textMuted: "#8c8fa1",
      textLabel: "#7c7f93",
      title: "#dc8a78",
      spinner: "#1e66f5",
      accent: "#1e66f5",
      info: "#df8e1d",
      markdownHeading: "#df8e1d",
      markdownCode: "#179299",
      selected: "#40a02b",
      error: "#d20f39",
      notice: "#fe640b",
      diffAdded: "#40a02b",
      diffRemoved: "#d20f39",
      toolBg: { pending: "#e6e9ef", success: "#dfe8dc", error: "#f2d8dd" },
      badge: { bg: "#e6e9ef", label: "#8839ef" },
      running: "#1e66f5",
      success: "#40a02b",
      failed: "#d20f39",
      panel: "#e1e4eb",
      panelAlt: "#dce0e8",
      panelUser: "#e5e7eb",
      border: "#ccd0da",
      thinking: "#8839ef",
    },
  },

  "catppuccin-macchiato": {
    id: "catppuccin-macchiato",
    label: "Catppuccin Macchiato",
    colors: {
      bg: "#24273a",
      fg: "#cad3f5",
      textSubtle: "#666d85",
      textMuted: "#8087a2",
      textLabel: "#a5adcb",
      title: "#c6a0f6",
      spinner: "#8aadf4",
      accent: "#f5bde6",
      info: "#8bd5ca",
      markdownHeading: "#c6a0f6",
      markdownCode: "#a6da95",
      selected: "#a6da95",
      error: "#ed8796",
      notice: "#eed49f",
      diffAdded: "#a6da95",
      diffRemoved: "#ed8796",
      toolBg: { pending: "#181926", success: "#29342b", error: "#3a2a31" },
      badge: { bg: "#181926", label: "#c6a0f6" },
      running: "#8aadf4",
      success: "#a6da95",
      failed: "#ed8796",
      panel: "#1c1e2d",
      panelAlt: "#181926",
      panelUser: "#3e4051",
      border: "#363a4f",
      thinking: "#c6a0f6",
    },
  },

  "catppuccin-mocha": {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    colors: {
      bg: "#1e1e2e",
      // 11.34:1 on bg (#1e1e2e), exceeding WCAG 2.2 AAA's 7:1 minimum for normal text.
      fg: "#cdd6f4",
      // 4.81:1 on bg (#1e1e2e), exceeding WCAG 2.2 AA's 4.5:1 minimum for normal text.
      textSubtle: "#858aa3",
      // 5.81:1 on bg (#1e1e2e), exceeding WCAG 2.2 AA's 4.5:1 minimum for normal text.
      textMuted: "#9399b2",
      // 7.37:1 on bg (#1e1e2e), exceeding WCAG 2.2 AAA's 7:1 minimum for normal text.
      textLabel: "#a6adc8",
      title: "#f5e0dc",
      spinner: "#89b4fa",
      accent: "#89b4fa",
      info: "#f9e2af",
      markdownHeading: "#f9e2af",
      markdownCode: "#94e2d5",
      selected: "#a6e3a1",
      error: "#f38ba8",
      notice: "#fab387",
      diffAdded: "#a6e3a1",
      diffRemoved: "#f38ba8",
      toolBg: { pending: "#313244", success: "#2b3a33", error: "#3d2f38" },
      badge: { bg: "#313244", label: "#cba6f7" },
      running: "#89b4fa",
      success: "#a6e3a1",
      failed: "#f38ba8",
      panel: "#313244",
      panelAlt: "#45475a",
      panelUser: "#393947",
      border: "#45475a",
      thinking: "#cba6f7",
    },
  },

  dracula: {
    id: "dracula",
    label: "Dracula",
    colors: {
      bg: "#282a36",
      fg: "#f8f8f2",
      textSubtle: "#636f90",
      textMuted: "#9aa7cc",
      textLabel: "#b8c1de",
      title: "#ff79c6",
      spinner: "#8be9fd",
      accent: "#8be9fd",
      info: "#f1fa8c",
      markdownHeading: "#ff79c6",
      markdownCode: "#50fa7b",
      selected: "#50fa7b",
      error: "#ff5555",
      notice: "#ffb86c",
      diffAdded: "#50fa7b",
      diffRemoved: "#ff5555",
      toolBg: { pending: "#343746", success: "#2f3b35", error: "#43303a" },
      badge: { bg: "#343746", label: "#bd93f9" },
      running: "#8be9fd",
      success: "#50fa7b",
      failed: "#ff5555",
      panel: "#343746",
      panelAlt: "#3a3d4d",
      panelUser: "#41434e",
      border: "#44475a",
      thinking: "#bd93f9",
    },
  },

  everforest: {
    id: "everforest",
    label: "Everforest",
    colors: {
      bg: "#1e2326",
      fg: "#d3c6aa",
      textSubtle: "#606b67",
      textMuted: "#7a8478",
      textLabel: "#859289",
      title: "#7fbbb3",
      spinner: "#a7c080",
      accent: "#d699b6",
      info: "#dbbc7f",
      markdownHeading: "#d699b6",
      markdownCode: "#83c092",
      selected: "#a7c080",
      error: "#e67e80",
      notice: "#e69875",
      diffAdded: "#a7c080",
      diffRemoved: "#e67e80",
      toolBg: { pending: "#2e383c", success: "#3c4841", error: "#493b40" },
      badge: { bg: "#2e383c", label: "#7fbbb3" },
      running: "#a7c080",
      success: "#a7c080",
      failed: "#e67e80",
      panel: "#272e33",
      panelAlt: "#2e383c",
      panelUser: "#374145",
      border: "#495156",
      thinking: "#7fbbb3",
    },
  },

  flexoki: {
    id: "flexoki",
    label: "Flexoki",
    colors: {
      bg: "#100F0F",
      fg: "#CECDC3",
      textSubtle: "#5d5c58",
      textMuted: "#5f5e5a",
      textLabel: "#878580",
      title: "#4385BE",
      spinner: "#DA702C",
      accent: "#8B7EC8",
      info: "#3AA99F",
      markdownHeading: "#8B7EC8",
      markdownCode: "#3AA99F",
      selected: "#879A39",
      error: "#D14D41",
      notice: "#DA702C",
      diffAdded: "#879A39",
      diffRemoved: "#D14D41",
      toolBg: { pending: "#282726", success: "#1A2D1A", error: "#2D1A1A" },
      badge: { bg: "#282726", label: "#4385BE" },
      running: "#DA702C",
      success: "#879A39",
      failed: "#D14D41",
      panel: "#1C1B1A",
      panelAlt: "#282726",
      panelUser: "#2c2b2b",
      border: "#575653",
      thinking: "#4385BE",
    },
  },

  "github-dark": {
    id: "github-dark",
    label: "GitHub Dark",
    colors: {
      bg: "#101216",
      fg: "#c9d1d9",
      textSubtle: "#575d67",
      textMuted: "#6e7681",
      textLabel: "#8b949e",
      title: "#58a6ff",
      spinner: "#58a6ff",
      accent: "#58a6ff",
      info: "#d29922",
      markdownHeading: "#79c0ff",
      markdownCode: "#a5d6ff",
      selected: "#3fb950",
      error: "#f85149",
      notice: "#db6d28",
      diffAdded: "#3fb950",
      diffRemoved: "#f85149",
      toolBg: { pending: "#161b22", success: "#132a1b", error: "#2d1f24" },
      badge: { bg: "#161b22", label: "#bc8cff" },
      running: "#58a6ff",
      success: "#3fb950",
      failed: "#f85149",
      panel: "#191e26",
      panelAlt: "#1f2630",
      panelUser: "#2a2d32",
      border: "#30363d",
      thinking: "#bc8cff",
    },
  },

  "github-light": {
    id: "github-light",
    label: "GitHub Light",
    colors: {
      bg: "#ffffff",
      fg: "#1f2328",
      textSubtle: "#9499a1",
      textMuted: "#77808a",
      textLabel: "#656d76",
      title: "#0969da",
      spinner: "#0969da",
      accent: "#0969da",
      info: "#9a6700",
      markdownHeading: "#0969da",
      markdownCode: "#1a7f37",
      selected: "#1a7f37",
      error: "#cf222e",
      notice: "#bc4c00",
      diffAdded: "#1a7f37",
      diffRemoved: "#cf222e",
      toolBg: { pending: "#f6f8fa", success: "#eaf5ec", error: "#f8e6e8" },
      badge: { bg: "#f6f8fa", label: "#8250df" },
      running: "#0969da",
      success: "#1a7f37",
      failed: "#cf222e",
      panel: "#eff2f6",
      panelAlt: "#eaeef2",
      panelUser: "#f4f4f4",
      border: "#d0d7de",
      thinking: "#8250df",
    },
  },

  "grok-day": {
    id: "grok-day",
    label: "Grok Day",
    colors: {
      bg: "#eeeeee",
      fg: "#262626",
      textSubtle: "#a5a5a5",
      textMuted: "#767676",
      textLabel: "#444444",
      title: "#7d4bc6",
      spinner: "#7d4bc6",
      accent: "#7d4bc6",
      info: "#2f64d2",
      markdownHeading: "#0a8e70",
      markdownCode: "#0f87a2",
      selected: "#378e23",
      error: "#cd3048",
      notice: "#a27612",
      diffAdded: "#378e23",
      diffRemoved: "#cd3048",
      toolBg: { pending: "#e4e4e4", success: "#daf2dc", error: "#f5dade" },
      badge: { bg: "#dedede", label: "#7d4bc6" },
      running: "#0082aa",
      success: "#378e23",
      failed: "#cd3048",
      panel: "#e1e1e1",
      panelAlt: "#dedede",
      panelUser: "#d0d0d0",
      border: "#c8c8cd",
      thinking: "#7d4bc6",
    },
  },

  "grok-night": {
    id: "grok-night",
    label: "Grok Night",
    colors: {
      bg: "#141414",
      fg: "#e1e1e1",
      textSubtle: "#585858",
      textMuted: "#6c6c6c",
      textLabel: "#a0a0a0",
      title: "#bb9af7",
      spinner: "#bb9af7",
      accent: "#bb9af7",
      info: "#7aa2f7",
      markdownHeading: "#1abc9c",
      markdownCode: "#3a95ab",
      selected: "#9ece6a",
      error: "#f7768e",
      notice: "#e0af68",
      diffAdded: "#9ece6a",
      diffRemoved: "#f7768e",
      toolBg: { pending: "#1c1c1c", success: "#063806", error: "#420e14" },
      badge: { bg: "#242424", label: "#bb9af7" },
      running: "#7dcfff",
      success: "#9ece6a",
      failed: "#f7768e",
      panel: "#202020",
      panelAlt: "#242424",
      panelUser: "#2c2c2c",
      border: "#323237",
      thinking: "#bb9af7",
    },
  },

  "gruvbox-dark": {
    id: "gruvbox-dark",
    label: "Gruvbox Dark",
    colors: {
      bg: "#282828",
      fg: "#ebdbb2",
      textSubtle: "#756c5f",
      textMuted: "#83786b",
      textLabel: "#a89984",
      title: "#fabd2f",
      spinner: "#83a598",
      accent: "#83a598",
      info: "#fabd2f",
      markdownHeading: "#fabd2f",
      markdownCode: "#8ec07c",
      selected: "#8ec07c",
      error: "#fb4934",
      notice: "#fe8019",
      diffAdded: "#b8bb26",
      diffRemoved: "#fb4934",
      toolBg: { pending: "#32302f", success: "#3c3836", error: "#3c2f2f" },
      badge: { bg: "#3c3836", label: "#d3869b" },
      running: "#458588",
      success: "#98971a",
      failed: "#cc241d",
      panel: "#3c3836",
      panelAlt: "#32302f",
      panelUser: "#414141",
      border: "#504945",
      thinking: "#d3869b",
    },
  },

  "gruvbox-light": {
    id: "gruvbox-light",
    label: "Gruvbox Light",
    colors: {
      bg: "#fbf1c7",
      fg: "#3c3836",
      textSubtle: "#988e7a",
      textMuted: "#928374",
      textLabel: "#7c6f64",
      title: "#b57614",
      spinner: "#076678",
      accent: "#076678",
      info: "#b57614",
      markdownHeading: "#b57614",
      markdownCode: "#427b58",
      selected: "#427b58",
      error: "#9d0006",
      notice: "#af3a03",
      diffAdded: "#79740e",
      diffRemoved: "#9d0006",
      toolBg: { pending: "#f2e5bc", success: "#ebdbb2", error: "#f3d9d4" },
      badge: { bg: "#ebdbb2", label: "#b16286" },
      running: "#458588",
      success: "#79740e",
      failed: "#9d0006",
      panel: "#ebdbb2",
      panelAlt: "#f2e5bc",
      panelUser: "#f0e7bf",
      border: "#d5c4a1",
      thinking: "#b16286",
    },
  },

  kanagawa: {
    id: "kanagawa",
    label: "Kanagawa",
    colors: {
      bg: "#1F1F28",
      fg: "#DCD7BA",
      textSubtle: "#66666f",
      textMuted: "#898983",
      textLabel: "#aaa99a",
      title: "#957FB8",
      spinner: "#7E9CD8",
      accent: "#D27E99",
      info: "#76946A",
      markdownHeading: "#957FB8",
      markdownCode: "#98BB6C",
      selected: "#98BB6C",
      error: "#E82424",
      notice: "#D7A657",
      diffAdded: "#98BB6C",
      diffRemoved: "#E82424",
      toolBg: { pending: "#363646", success: "#252E25", error: "#362020" },
      badge: { bg: "#363646", label: "#957FB8" },
      running: "#7E9CD8",
      success: "#98BB6C",
      failed: "#E82424",
      panel: "#2A2A37",
      panelAlt: "#363646",
      panelUser: "#393941",
      border: "#54546D",
      thinking: "#957FB8",
    },
  },

  "kanagawa-dragon": {
    id: "kanagawa-dragon",
    label: "Kanagawa Dragon",
    colors: {
      bg: "#181616",
      fg: "#c8c093",
      textSubtle: "#5c625c",
      textMuted: "#737c73",
      textLabel: "#92978f",
      title: "#c4b28a",
      spinner: "#8ba4b0",
      accent: "#8ba4b0",
      info: "#c4b28a",
      markdownHeading: "#c4b28a",
      markdownCode: "#8a9a7b",
      selected: "#8a9a7b",
      error: "#E82424",
      notice: "#FF9E3B",
      diffAdded: "#76946A",
      diffRemoved: "#C34043",
      toolBg: { pending: "#1D1C19", success: "#282727", error: "#2a2022" },
      badge: { bg: "#282727", label: "#a292a3" },
      running: "#8ba4b0",
      success: "#76946A",
      failed: "#C34043",
      panel: "#282727",
      panelAlt: "#1D1C19",
      panelUser: "#333131",
      border: "#393836",
      thinking: "#c4b28a",
    },
  },

  monokai: {
    id: "monokai",
    label: "Monokai",
    colors: {
      bg: "#272822",
      fg: "#fdfff1",
      textSubtle: "#6e6e60",
      textMuted: "#a6a69a",
      textLabel: "#ccccbe",
      title: "#ae81ff",
      spinner: "#66d9ef",
      accent: "#a6e22e",
      info: "#fd971f",
      markdownHeading: "#f92672",
      markdownCode: "#a6e22e",
      selected: "#a6e22e",
      error: "#f92672",
      notice: "#e6db74",
      diffAdded: "#a6e22e",
      diffRemoved: "#f92672",
      toolBg: { pending: "#3e3d32", success: "#1a3a1a", error: "#3a1a1a" },
      badge: { bg: "#3e3d32", label: "#ae81ff" },
      running: "#66d9ef",
      success: "#a6e22e",
      failed: "#f92672",
      panel: "#1e1f1c",
      panelAlt: "#3e3d32",
      panelUser: "#40413c",
      border: "#3e3d32",
      thinking: "#ae81ff",
    },
  },

  nightowl: {
    id: "nightowl",
    label: "Night Owl",
    colors: {
      bg: "#011627",
      fg: "#d6deeb",
      textSubtle: "#456278",
      textMuted: "#587790",
      textLabel: "#7491a8",
      title: "#7fdbca",
      spinner: "#82AAFF",
      accent: "#c792ea",
      info: "#82AAFF",
      markdownHeading: "#82AAFF",
      markdownCode: "#c5e478",
      selected: "#c5e478",
      error: "#EF5350",
      notice: "#ecc48d",
      diffAdded: "#c5e478",
      diffRemoved: "#EF5350",
      toolBg: { pending: "#0b253a", success: "#0a2e1a", error: "#2d1b1b" },
      badge: { bg: "#0b253a", label: "#7fdbca" },
      running: "#82AAFF",
      success: "#c5e478",
      failed: "#EF5350",
      panel: "#0b253a",
      panelAlt: "#0b253a",
      panelUser: "#1f3140",
      border: "#5f7e97",
      thinking: "#7fdbca",
    },
  },

  nord: {
    id: "nord",
    label: "Nord",
    colors: {
      bg: "#2e3440",
      fg: "#d8dee9",
      textSubtle: "#70798b",
      textMuted: "#788394",
      textLabel: "#81a1c1",
      title: "#88c0d0",
      spinner: "#5e81ac",
      accent: "#5e81ac",
      info: "#ebcb8b",
      markdownHeading: "#88c0d0",
      markdownCode: "#a3be8c",
      selected: "#a3be8c",
      error: "#bf616a",
      notice: "#d08770",
      diffAdded: "#a3be8c",
      diffRemoved: "#bf616a",
      toolBg: { pending: "#3b4252", success: "#364238", error: "#46343b" },
      badge: { bg: "#3b4252", label: "#b48ead" },
      running: "#5e81ac",
      success: "#a3be8c",
      failed: "#bf616a",
      panel: "#3b4252",
      panelAlt: "#434c5e",
      panelUser: "#474c56",
      border: "#4c566a",
      thinking: "#b48ead",
    },
  },

  "one-dark": {
    id: "one-dark",
    label: "One Dark",
    colors: {
      bg: "#282c34",
      fg: "#abb2bf",
      textSubtle: "#6b727d",
      textMuted: "#737c8a",
      textLabel: "#8992a1",
      title: "#c678dd",
      spinner: "#61afef",
      accent: "#61afef",
      info: "#e5c07b",
      markdownHeading: "#e5c07b",
      markdownCode: "#56b6c2",
      selected: "#98c379",
      error: "#e06c75",
      notice: "#d19a66",
      diffAdded: "#98c379",
      diffRemoved: "#e06c75",
      toolBg: { pending: "#353b45", success: "#33403b", error: "#442f36" },
      badge: { bg: "#353b45", label: "#c678dd" },
      running: "#61afef",
      success: "#98c379",
      failed: "#e06c75",
      panel: "#353b45",
      panelAlt: "#3e4451",
      panelUser: "#41454c",
      border: "#4b5263",
      thinking: "#c678dd",
    },
  },

  "one-light": {
    id: "one-light",
    label: "One Light",
    colors: {
      bg: "#f9f9f9",
      fg: "#2a2c33",
      textSubtle: "#94959b",
      textMuted: "#a0a1a7",
      textLabel: "#696c77",
      title: "#a626a4",
      spinner: "#4078f2",
      accent: "#4078f2",
      info: "#c18401",
      markdownHeading: "#c18401",
      markdownCode: "#0184bc",
      selected: "#50a14f",
      error: "#e45649",
      notice: "#986801",
      diffAdded: "#50a14f",
      diffRemoved: "#e45649",
      toolBg: { pending: "#f0f0f1", success: "#e6f1e6", error: "#f5e3e1" },
      badge: { bg: "#f0f0f1", label: "#a626a4" },
      running: "#4078f2",
      success: "#50a14f",
      failed: "#e45649",
      panel: "#ececed",
      panelAlt: "#e5e5e6",
      panelUser: "#f0f0f0",
      border: "#d0d0d2",
      thinking: "#a626a4",
    },
  },

  "osaka-jade": {
    id: "osaka-jade",
    label: "Osaka Jade",
    colors: {
      bg: "#111c18",
      fg: "#c1c497",
      textSubtle: "#586658",
      textMuted: "#53685b",
      textLabel: "#9aa88a",
      title: "#2dd5b7",
      spinner: "#2dd5b7",
      accent: "#549e6a",
      info: "#2dd5b7",
      markdownHeading: "#2dd5b7",
      markdownCode: "#63b07a",
      selected: "#549e6a",
      error: "#ff5345",
      notice: "#e5c736",
      diffAdded: "#63b07a",
      diffRemoved: "#ff5345",
      toolBg: { pending: "#1a2520", success: "#15241c", error: "#241515" },
      badge: { bg: "#1a2520", label: "#d2689c" },
      running: "#2dd5b7",
      success: "#549e6a",
      failed: "#ff5345",
      panel: "#1a2520",
      panelAlt: "#23372b",
      panelUser: "#23372b",
      border: "#3d4a44",
      thinking: "#d2689c",
    },
  },

  palenight: {
    id: "palenight",
    label: "Palenight",
    colors: {
      bg: "#292d3e",
      fg: "#a6accd",
      textSubtle: "#6b7191",
      textMuted: "#757c9b",
      textLabel: "#878eac",
      title: "#c792ea",
      spinner: "#82aaff",
      accent: "#89ddff",
      info: "#f78c6c",
      markdownHeading: "#c792ea",
      markdownCode: "#c3e88d",
      selected: "#c3e88d",
      error: "#f07178",
      notice: "#ffcb6b",
      diffAdded: "#c3e88d",
      diffRemoved: "#f07178",
      toolBg: { pending: "#32364a", success: "#2e3c2b", error: "#3c2b2b" },
      badge: { bg: "#32364a", label: "#c792ea" },
      running: "#82aaff",
      success: "#c3e88d",
      failed: "#f07178",
      panel: "#1e2132",
      panelAlt: "#32364a",
      panelUser: "#424655",
      border: "#32364a",
      thinking: "#c792ea",
    },
  },

  rosepine: {
    id: "rosepine",
    label: "Rosé Pine",
    colors: {
      bg: "#191724",
      fg: "#e0def4",
      textSubtle: "#625f76",
      textMuted: "#9a96b5",
      textLabel: "#aca8c5",
      title: "#c4a7e7",
      spinner: "#9ccfd8",
      accent: "#ebbcba",
      info: "#9ccfd8",
      markdownHeading: "#c4a7e7",
      markdownCode: "#31748f",
      selected: "#31748f",
      error: "#eb6f92",
      notice: "#f6c177",
      diffAdded: "#31748f",
      diffRemoved: "#eb6f92",
      toolBg: { pending: "#26233a", success: "#1f2d3a", error: "#3a1f2d" },
      badge: { bg: "#26233a", label: "#c4a7e7" },
      running: "#9ccfd8",
      success: "#31748f",
      failed: "#eb6f92",
      panel: "#232135",
      panelAlt: "#26233a",
      panelUser: "#34323e",
      border: "#403d52",
      thinking: "#c4a7e7",
    },
  },

  "solarized-dark": {
    id: "solarized-dark",
    label: "Solarized Dark",
    colors: {
      bg: "#002b36",
      fg: "#839496",
      textSubtle: "#4f666c",
      textMuted: "#586e75",
      textLabel: "#60777e",
      title: "#b58900",
      spinner: "#268bd2",
      accent: "#268bd2",
      info: "#cb4b16",
      markdownHeading: "#b58900",
      markdownCode: "#2aa198",
      selected: "#859900",
      error: "#dc322f",
      notice: "#cb4b16",
      diffAdded: "#859900",
      diffRemoved: "#dc322f",
      toolBg: { pending: "#073642", success: "#183c37", error: "#402c32" },
      badge: { bg: "#073642", label: "#6c71c4" },
      running: "#268bd2",
      success: "#859900",
      failed: "#dc322f",
      panel: "#073642",
      panelAlt: "#0b3a45",
      panelUser: "#1e444e",
      border: "#194955",
      thinking: "#6c71c4",
    },
  },

  "solarized-light": {
    id: "solarized-light",
    label: "Solarized Light",
    colors: {
      bg: "#fdf6e3",
      fg: "#586e75",
      textSubtle: "#a0aaaa",
      textMuted: "#89999a",
      textLabel: "#768b8f",
      title: "#b58900",
      spinner: "#268bd2",
      accent: "#268bd2",
      info: "#cb4b16",
      markdownHeading: "#b58900",
      markdownCode: "#2aa198",
      selected: "#859900",
      error: "#dc322f",
      notice: "#cb4b16",
      diffAdded: "#859900",
      diffRemoved: "#dc322f",
      toolBg: { pending: "#eee8d5", success: "#e5eed4", error: "#f2ddda" },
      badge: { bg: "#eee8d5", label: "#6c71c4" },
      running: "#268bd2",
      success: "#859900",
      failed: "#dc322f",
      panel: "#eee8d5",
      panelAlt: "#e7e1cf",
      panelUser: "#f2ecd9",
      border: "#d8d1bf",
      thinking: "#6c71c4",
    },
  },

  synthwave84: {
    id: "synthwave84",
    label: "Synthwave '84",
    colors: {
      bg: "#262335",
      fg: "#ffffff",
      textSubtle: "#5d67a1",
      textMuted: "#848bbd",
      textLabel: "#959bc1",
      title: "#ff7edb",
      spinner: "#36f9f6",
      accent: "#b084eb",
      info: "#ff8b39",
      markdownHeading: "#ff7edb",
      markdownCode: "#72f1b8",
      selected: "#36f9f6",
      error: "#fe4450",
      notice: "#fede5d",
      diffAdded: "#72f1b8",
      diffRemoved: "#fe4450",
      toolBg: { pending: "#1e1a29", success: "#1a3a2a", error: "#3a1a2a" },
      badge: { bg: "#2a2139", label: "#b084eb" },
      running: "#36f9f6",
      success: "#72f1b8",
      failed: "#fe4450",
      panel: "#1e1a29",
      panelAlt: "#2a2139",
      panelUser: "#322a42",
      border: "#495495",
      thinking: "#b084eb",
    },
  },

  "tokyo-day": {
    id: "tokyo-day",
    label: "Tokyo Day",
    colors: {
      bg: "#e1e2e7",
      fg: "#3760bf",
      textSubtle: "#a4a6ae",
      textMuted: "#8c93a4",
      textLabel: "#76819e",
      title: "#7847bd",
      spinner: "#2e7de9",
      accent: "#2e7de9",
      info: "#8c6c3e",
      markdownHeading: "#8c6c3e",
      markdownCode: "#007197",
      selected: "#587539",
      error: "#f52a65",
      notice: "#b15c00",
      diffAdded: "#587539",
      diffRemoved: "#f52a65",
      toolBg: { pending: "#cbccd1", success: "#c7d8cb", error: "#dec7cf" },
      badge: { bg: "#cbccd1", label: "#9854f1" },
      running: "#2e7de9",
      success: "#587539",
      failed: "#f52a65",
      panel: "#cbccd1",
      panelAlt: "#c4c8da",
      panelUser: "#cccdd2",
      border: "#b4b5b9",
      thinking: "#9854f1",
    },
  },

  "tokyo-night": {
    id: "tokyo-night",
    label: "Tokyo Night",
    colors: {
      bg: "#1a1b26",
      fg: "#c0caf5",
      textSubtle: "#5a6285",
      textMuted: "#828bb8",
      textLabel: "#969fc5",
      title: "#bb9af7",
      spinner: "#7aa2f7",
      accent: "#7aa2f7",
      info: "#e0af68",
      markdownHeading: "#e0af68",
      markdownCode: "#73daca",
      selected: "#9ece6a",
      error: "#f7768e",
      notice: "#ff9e64",
      diffAdded: "#9ece6a",
      diffRemoved: "#f7768e",
      toolBg: { pending: "#24283b", success: "#243638", error: "#3a2734" },
      badge: { bg: "#24283b", label: "#bb9af7" },
      running: "#7aa2f7",
      success: "#9ece6a",
      failed: "#f7768e",
      panel: "#24283b",
      panelAlt: "#2f354d",
      panelUser: "#353640",
      border: "#3b4261",
      thinking: "#bb9af7",
    },
  },

  vesper: {
    id: "vesper",
    label: "Vesper",
    colors: {
      bg: "#101010",
      fg: "#ffffff",
      textSubtle: "#5c5c5c",
      textMuted: "#a0a0a0",
      textLabel: "#a0a0a0",
      title: "#ffc799",
      spinner: "#ffc799",
      accent: "#ffc799",
      info: "#ffc799",
      markdownHeading: "#ffc799",
      markdownCode: "#a0a0a0",
      selected: "#99ffe4",
      error: "#ff8080",
      notice: "#ffc799",
      diffAdded: "#99ffe4",
      diffRemoved: "#ff8080",
      toolBg: { pending: "#1a1a1a", success: "#123025", error: "#321e1e" },
      badge: { bg: "#202020", label: "#ffc799" },
      running: "#ffc799",
      success: "#99ffe4",
      failed: "#ff8080",
      panel: "#1d1d1d",
      panelAlt: "#202020",
      panelUser: "#282828",
      border: "#505050",
      thinking: "#5c5c5c",
    },
  },
};

// Display order aligned with kon
const BUILTIN_THEME_ORDER: string[] = [
  "amp-dark",
  "amp-light",
  "ayu",
  "catppuccin-frappe",
  "catppuccin-latte",
  "catppuccin-macchiato",
  "catppuccin-mocha",
  "dracula",
  "everforest",
  "flexoki",
  "github-dark",
  "github-light",
  "grok-day",
  "grok-night",
  "gruvbox-dark",
  "gruvbox-light",
  "kanagawa",
  "kanagawa-dragon",
  "monokai",
  "nightowl",
  "nord",
  "one-dark",
  "one-light",
  "osaka-jade",
  "palenight",
  "rosepine",
  "solarized-dark",
  "solarized-light",
  "synthwave84",
  "tokyo-day",
  "tokyo-night",
  "vesper",
];

let customThemes: Record<string, RawThemeConfig> = {};

const THEME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;

function failThemeValidation(message: string): never {
  throw new Error(message); // effect-shape-allow: synchronous custom theme validation reports malformed user files.
}

function themeRecord(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return failThemeValidation(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function themeString(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) return failThemeValidation(`${key} must be a non-empty string`);
  return value.trim();
}

function resolveCustomColor(
  value: unknown,
  key: string,
  variables: Record<string, unknown>,
  resolving: Set<string> = new Set(),
): string {
  const color = themeString(value, key);
  if (HEX_COLOR_PATTERN.test(color)) return color;
  if (!(color in variables)) {
    return failThemeValidation(`${key} must be a #RRGGBB color or a variable name; got ${JSON.stringify(color)}`);
  }
  if (resolving.has(color)) return failThemeValidation(`${key} references a circular variable: ${color}`);
  resolving.add(color);
  const resolved = resolveCustomColor(variables[color], `vars.${color}`, variables, resolving);
  resolving.delete(color);
  return resolved;
}

function parseCustomTheme(value: unknown): RawThemeConfig {
  const root = themeRecord(value, "theme");
  const name = themeString(root.name, "name");
  if (!THEME_NAME_PATTERN.test(name)) {
    return failThemeValidation(
      `name must start with a letter or digit and contain only letters, digits, ".", "_", or "-"; got ${JSON.stringify(name)}`,
    );
  }
  const label = root.label === undefined ? name : themeString(root.label, "label");
  const variables = root.vars === undefined ? {} : themeRecord(root.vars, "vars");
  for (const [variable, variableValue] of Object.entries(variables)) {
    resolveCustomColor(variableValue, `vars.${variable}`, variables);
  }
  const colors = themeRecord(root.colors, "colors");
  const toolBg = themeRecord(colors.toolBg, "colors.toolBg");
  const badge = themeRecord(colors.badge, "colors.badge");
  const color = (key: string): string => resolveCustomColor(colors[key], `colors.${key}`, variables);
  const nestedColor = (parent: Record<string, unknown>, parentKey: string, key: string): string =>
    resolveCustomColor(parent[key], `colors.${parentKey}.${key}`, variables);

  return {
    id: name,
    label,
    colors: {
      bg: color("bg"),
      fg: color("fg"),
      textSubtle: color("textSubtle"),
      textMuted: color("textMuted"),
      textLabel: color("textLabel"),
      title: color("title"),
      spinner: color("spinner"),
      accent: color("accent"),
      info: color("info"),
      markdownHeading: color("markdownHeading"),
      markdownCode: color("markdownCode"),
      selected: color("selected"),
      error: color("error"),
      notice: color("notice"),
      diffAdded: color("diffAdded"),
      diffRemoved: color("diffRemoved"),
      toolBg: {
        pending: nestedColor(toolBg, "toolBg", "pending"),
        success: nestedColor(toolBg, "toolBg", "success"),
        error: nestedColor(toolBg, "toolBg", "error"),
      },
      badge: {
        bg: nestedColor(badge, "badge", "bg"),
        label: nestedColor(badge, "badge", "label"),
      },
      running: color("running"),
      success: color("success"),
      failed: color("failed"),
      panel: color("panel"),
      panelAlt: color("panelAlt"),
      panelUser: color("panelUser"),
      border: color("border"),
      thinking: color("thinking"),
    },
  };
}

/**
 * Loads validated user themes from `<configDir>/themes/*.json`.
 * A valid user theme overrides a bundled theme with the same name.
 */
export function loadCustomThemes(configDir: string): string[] {
  customThemes = {};
  const warnings: string[] = [];
  const themesDir = path.join(configDir, "themes");
  if (!existsSync(themesDir)) return warnings;

  let entries: Dirent[];
  try {
    entries = readdirSync(themesDir, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  } catch (error) {
    warnings.push(`Custom theme warning (${themesDir}): ${error instanceof Error ? error.message : String(error)}.`);
    return warnings;
  }

  const sources = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    const filePath = path.join(themesDir, entry.name);
    try {
      const isFile = entry.isFile() || (entry.isSymbolicLink() && statSync(filePath).isFile());
      if (!isFile) continue;
      const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
      const theme = parseCustomTheme(parsed);
      const existingSource = sources.get(theme.id);
      if (existingSource) {
        warnings.push(
          `Custom theme warning (${filePath}): duplicate theme name ${JSON.stringify(theme.id)}; keeping ${existingSource}.`,
        );
        continue;
      }
      customThemes[theme.id] = theme;
      sources.set(theme.id, filePath);
    } catch (error) {
      warnings.push(`Custom theme warning (${filePath}): ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  return warnings;
}

export function resetCustomThemes(): void {
  customThemes = {};
}

function orderedThemeIds(): string[] {
  const customOnly = Object.keys(customThemes)
    .filter((id) => !BUILTIN_THEMES[id])
    .sort((left, right) => left.localeCompare(right));
  return [...BUILTIN_THEME_ORDER, ...customOnly];
}

/**
 * Returns the ordered list of theme IDs.
 */
export function getThemeIds(): string[] {
  return orderedThemeIds();
}

/**
 * Returns an ordered list of `[id, label]` tuples for building selection UIs.
 */
export function getThemeOptions(): Array<[string, string]> {
  return orderedThemeIds().map((id) => [id, (customThemes[id] ?? BUILTIN_THEMES[id]).label]);
}

/**
 * Returns a deep copy of the requested theme. Throws if the ID is unknown.
 */
export function getTheme(themeId: string): ThemeConfig {
  const theme = customThemes[themeId] ?? BUILTIN_THEMES[themeId];
  if (!theme) {
    throw new Error(`Unknown theme: ${themeId}`); // effect-shape-allow: sync theme lookup validates caller-provided theme id.
  }
  // Deep copy to prevent external mutation
  return structuredClone({ ...theme, colors: resolveThemeColors(theme) });
}
