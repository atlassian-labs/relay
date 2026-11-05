#!/usr/bin/env bun

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { Key } from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getConfigDir } from "../src/config/index";
import { getThemeOptions, loadCustomThemes } from "../src/config/themes";

interface CommonTheme {
  relayId: string;
  relayLabel: string;
  ghosttyName: string;
  herdrName?: string;
}

const RELAY_TO_HERDR_THEME_CANDIDATES: Record<string, readonly string[]> = {
  "catppuccin-frappe": ["catppuccin"],
  "catppuccin-latte": ["catppuccin-latte"],
  "catppuccin-macchiato": ["catppuccin"],
  "catppuccin-mocha": ["catppuccin"],
  dracula: ["dracula"],
  "gruvbox-dark": ["gruvbox"],
  "gruvbox-light": ["gruvbox-light"],
  kanagawa: ["kanagawa"],
  nord: ["nord"],
  "one-dark": ["one-dark"],
  "one-light": ["one-light"],
  rosepine: ["rose-pine"],
  "solarized-dark": ["solarized"],
  "solarized-light": ["solarized-light"],
  "tokyo-day": ["tokyo-night-day"],
  "tokyo-night": ["tokyo-night"],
  vesper: ["vesper"],
};

const RELAY_TO_GHOSTTY_THEME_CANDIDATES: Record<string, readonly string[]> = {
  "amp-dark": ["amp-dark"],
  "amp-light": ["amp-light"],
  ayu: ["Ayu"],
  "catppuccin-frappe": ["Catppuccin Frappe"],
  "catppuccin-latte": ["Catppuccin Latte"],
  "catppuccin-macchiato": ["Catppuccin Macchiato"],
  "catppuccin-mocha": ["Catppuccin Mocha"],
  dracula: ["Dracula"],
  everforest: ["Everforest Dark Hard"],
  flexoki: ["Flexoki Dark"],
  "github-dark": ["GitHub Dark", "GitHub Dark Default"],
  "github-light": ["GitHub Light Default", "GitHub"],
  "gruvbox-dark": ["Gruvbox Dark"],
  "gruvbox-light": ["Gruvbox Light"],
  kanagawa: ["Kanagawa Wave"],
  "kanagawa-dragon": ["Kanagawa Dragon"],
  monokai: ["Monokai Classic", "Monokai Remastered", "Monokai Pro"],
  nightowl: ["Night Owl"],
  nord: ["Nord"],
  "one-dark": ["one-dark", "Atom One Dark"],
  "one-light": ["one-light", "Atom One Light"],
  "osaka-jade": ["osaka-jade"],
  palenight: ["palenight", "Pale Night Hc"],
  rosepine: ["Rose Pine"],
  "solarized-dark": ["Builtin Solarized Dark", "iTerm2 Solarized Dark"],
  "solarized-light": ["Builtin Solarized Light", "iTerm2 Solarized Light"],
  "tokyo-day": ["TokyoNight Day"],
  "tokyo-night": ["TokyoNight Night", "TokyoNight"],
  vesper: ["Vesper"],
};

function usage(): void {
  console.log(`Usage: bun run scripts/sync-ghostty-relay-theme.ts [theme]

Lists themes available in both Ghostty and Relay. Themes also supported by Herdr
are listed first and, when selected, additionally write:
  ~/.config/herdr/config.toml   [theme].name = "<Herdr theme name>"
  ~/.config/ghostty/config      theme = <Ghostty theme name>
  ~/.config/relay/config.toml   [ui].theme = "<relay-theme-id>"

Options:
  --list       Print common themes only
  --help       Show this help

Interactive mode supports Up/Down, j/k, Home/End, Enter, q/Esc.
Pass a theme id/name/label to apply non-interactively.`);
}

function normalizeThemeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "")
    .trim();
}

function stripGhosttyThemeSource(value: string): string {
  return value.replace(/\s+\((?:resources|user)\)$/u, "").trim();
}

function listGhosttyThemes(): string[] {
  const result = Bun.spawnSync(["ghostty", "+list-themes"], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`ghostty +list-themes failed${stderr ? `: ${stderr}` : ""}`);
  }

  const text = new TextDecoder().decode(result.stdout);
  return [
    ...new Set(
      text
        .split(/\r?\n/u)
        .map((line) => stripGhosttyThemeSource(line.trim()))
        .filter(Boolean),
    ),
  ];
}

function findGhosttyTheme(
  relayId: string,
  relayLabel: string,
  ghosttyByNormalized: Map<string, string>,
): string | undefined {
  const candidates = [...(RELAY_TO_GHOSTTY_THEME_CANDIDATES[relayId] ?? []), relayId, relayLabel];

  for (const candidate of candidates) {
    const ghosttyName = ghosttyByNormalized.get(normalizeThemeName(candidate));
    if (ghosttyName) return ghosttyName;
  }

  return undefined;
}

function findHerdrTheme(relayId: string): string | undefined {
  return RELAY_TO_HERDR_THEME_CANDIDATES[relayId]?.[0];
}

function commonThemes(): CommonTheme[] {
  loadCustomThemes(getConfigDir());
  const ghosttyThemes = listGhosttyThemes();
  const ghosttyByNormalized = new Map<string, string>();
  for (const theme of ghosttyThemes) {
    const normalized = normalizeThemeName(theme);
    if (!ghosttyByNormalized.has(normalized)) ghosttyByNormalized.set(normalized, theme);
  }

  return getThemeOptions()
    .map(([relayId, relayLabel]) => {
      const ghosttyName = findGhosttyTheme(relayId, relayLabel, ghosttyByNormalized);
      return ghosttyName ? { relayId, relayLabel, ghosttyName, herdrName: findHerdrTheme(relayId) } : null;
    })
    .filter((theme): theme is CommonTheme => theme !== null)
    .sort(
      (left, right) =>
        Number(Boolean(right.herdrName)) - Number(Boolean(left.herdrName)) ||
        left.relayLabel.localeCompare(right.relayLabel),
    );
}

function configHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
}

function backupTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
}

function writeBackup(filePath: string, content: string): string | null {
  if (!content) return null;
  const backupPath = `${filePath}.${backupTimestamp()}.bak`;
  fs.writeFileSync(backupPath, content, "utf-8");
  return backupPath;
}

function atomicWriteText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function reloadHerdrConfig(): string | null {
  try {
    const result = Bun.spawnSync(["herdr", "server", "reload-config"], { stdout: "pipe", stderr: "pipe" });
    if (result.success) return null;
    const stderr = new TextDecoder().decode(result.stderr).trim();
    return stderr || "herdr server reload-config failed";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function setGhosttyTheme(content: string, ghosttyName: string): string {
  const line = `theme = ${ghosttyName}`;
  if (/^\s*theme\s*=.*$/mu.test(content)) return content.replace(/^\s*theme\s*=.*$/mu, line);
  return `${content.trimEnd()}${content.trimEnd() ? "\n" : ""}${line}\n`;
}

function setHerdrTheme(content: string, herdrName: string): string {
  const lines = content.split(/\r?\n/u);
  const themeStart = lines.findIndex((line) => /^\s*\[theme\]\s*$/u.test(line));
  if (themeStart === -1)
    return `${content.trimEnd()}${content.trimEnd() ? "\n\n" : ""}[theme]\nname = "${herdrName}"\n`;

  const themeEnd = lines.findIndex((line, index) => index > themeStart && /^\s*\[.+\]\s*$/u.test(line));
  const end = themeEnd === -1 ? lines.length : themeEnd;
  for (let index = themeStart + 1; index < end; index += 1) {
    if (/^\s*name\s*=\s*/u.test(lines[index] ?? "")) {
      lines[index] = `name = "${herdrName}"`;
      return lines.join("\n");
    }
  }

  lines.splice(themeStart + 1, 0, `name = "${herdrName}"`);
  return lines.join("\n");
}

function setRelayTheme(content: string, relayId: string): string {
  const lines = content.split(/\r?\n/u);
  let uiStart = -1;
  let uiEnd = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\[ui\]\s*$/u.test(lines[index] ?? "")) {
      uiStart = index;
      break;
    }
  }

  if (uiStart === -1) return `${content.trimEnd()}${content.trimEnd() ? "\n\n" : ""}[ui]\ntheme = "${relayId}"\n`;

  for (let index = uiStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[.+\]\s*$/u.test(lines[index] ?? "")) {
      uiEnd = index;
      break;
    }
  }

  for (let index = uiStart + 1; index < uiEnd; index += 1) {
    if (/^\s*theme\s*=\s*/u.test(lines[index] ?? "")) {
      lines[index] = `theme = "${relayId}"`;
      return lines.join("\n");
    }
  }

  lines.splice(uiStart + 1, 0, `theme = "${relayId}"`);
  return lines.join("\n");
}

function isHerdrSectionStart(themes: CommonTheme[], index: number): boolean {
  return index > 0 && !themes[index]?.herdrName && Boolean(themes[index - 1]?.herdrName);
}

async function chooseThemeByNumberPrompt(themes: CommonTheme[]): Promise<CommonTheme> {
  for (let index = 0; index < themes.length; index += 1) {
    const theme = themes[index] as CommonTheme;
    if (isHerdrSectionStart(themes, index)) console.log("    ─────────────────────────────");
    console.log(`${String(index + 1).padStart(2, " ")}. ${theme.relayLabel}`);
  }

  const rl = createInterface({ input, output });
  try {
    while (true) {
      const answer = (await rl.question(`Select a theme [1-${themes.length}]: `)).trim();
      const index = Number(answer);
      if (Number.isInteger(index) && index >= 1 && index <= themes.length) return themes[index - 1] as CommonTheme;
      console.log("Invalid selection.");
    }
  } finally {
    rl.close();
  }
}

function renderThemePicker(themes: CommonTheme[], selectedIndex: number): void {
  output.write("\x1b[H\x1b[2J");
  output.write("Select a common Relay/Ghostty theme (Herdr-compatible themes first)\n");
  output.write("Use ↑/↓ or j/k, Enter to apply, q/Esc to cancel.\n\n");

  for (let index = 0; index < themes.length; index += 1) {
    const theme = themes[index] as CommonTheme;
    if (isHerdrSectionStart(themes, index)) output.write("  ─────────────────────────────\n");
    const line = `${index === selectedIndex ? "›" : " "} ${theme.relayLabel}`;
    output.write(index === selectedIndex ? `\x1b[7m${line}\x1b[0m\n` : `${line}\n`);
  }
}

async function chooseThemeInteractively(themes: CommonTheme[]): Promise<CommonTheme> {
  let selectedIndex = 0;
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write("\x1b[?1049h\x1b[?25l");
  renderThemePicker(themes, selectedIndex);

  return await new Promise<CommonTheme>((resolve, reject) => {
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
      output.write("\x1b[?25h\x1b[?1049l");
    };

    const moveSelection = (nextIndex: number) => {
      selectedIndex = (nextIndex + themes.length) % themes.length;
      renderThemePicker(themes, selectedIndex);
    };

    const onKeypress = (_sequence: string, key: Key) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Cancelled."));
        return;
      }

      switch (key.name) {
        case "up":
        case "k":
          moveSelection(selectedIndex - 1);
          return;
        case "down":
        case "j":
          moveSelection(selectedIndex + 1);
          return;
        case "home":
          moveSelection(0);
          return;
        case "end":
          moveSelection(themes.length - 1);
          return;
        case "return":
        case "enter": {
          const selected = themes[selectedIndex] as CommonTheme;
          cleanup();
          resolve(selected);
          return;
        }
        case "escape":
        case "q":
          cleanup();
          reject(new Error("Cancelled."));
          return;
        case undefined:
          return;
      }
    };

    input.on("keypress", onKeypress);
  });
}

async function chooseTheme(themes: CommonTheme[], requested: string | undefined): Promise<CommonTheme> {
  if (requested) {
    const normalized = normalizeThemeName(requested);
    const match = themes.find(
      (theme) =>
        normalizeThemeName(theme.relayId) === normalized ||
        normalizeThemeName(theme.relayLabel) === normalized ||
        normalizeThemeName(theme.ghosttyName) === normalized,
    );
    if (!match) throw new Error(`No common Relay/Ghostty theme matched ${JSON.stringify(requested)}.`);
    return match;
  }

  if (!input.isTTY || !output.isTTY) return await chooseThemeByNumberPrompt(themes);
  return await chooseThemeInteractively(themes);
}

async function main(): Promise<void> {
  const arg = process.argv.slice(2).find((value) => !value.startsWith("--"));
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }

  const themes = commonThemes();
  if (themes.length === 0) throw new Error("No common themes found between Relay and Ghostty.");

  if (process.argv.includes("--list")) {
    for (let index = 0; index < themes.length; index += 1) {
      const theme = themes[index] as CommonTheme;
      if (isHerdrSectionStart(themes, index)) console.log("─────────────────────────────");
      console.log(theme.relayLabel);
    }
    return;
  }

  const selected = await chooseTheme(themes, arg);
  const relayConfigPath = path.join(configHome(), "relay", "config.toml");
  const ghosttyConfigPath = path.join(configHome(), "ghostty", "config");
  const herdrConfigPath = path.join(configHome(), "herdr", "config.toml");

  const relayContent = fs.existsSync(relayConfigPath) ? fs.readFileSync(relayConfigPath, "utf-8") : "";
  const ghosttyContent = fs.existsSync(ghosttyConfigPath) ? fs.readFileSync(ghosttyConfigPath, "utf-8") : "";
  const herdrContent =
    selected.herdrName && fs.existsSync(herdrConfigPath) ? fs.readFileSync(herdrConfigPath, "utf-8") : "";

  const relayBackup = writeBackup(relayConfigPath, relayContent);
  const ghosttyBackup = writeBackup(ghosttyConfigPath, ghosttyContent);
  const herdrBackup = selected.herdrName ? writeBackup(herdrConfigPath, herdrContent) : null;

  atomicWriteText(relayConfigPath, setRelayTheme(relayContent, selected.relayId));
  atomicWriteText(ghosttyConfigPath, setGhosttyTheme(ghosttyContent, selected.ghosttyName));
  if (selected.herdrName) atomicWriteText(herdrConfigPath, setHerdrTheme(herdrContent, selected.herdrName));
  const herdrReloadError = selected.herdrName ? reloadHerdrConfig() : null;

  console.log(`Applied ${selected.relayLabel}.`);
  if (selected.herdrName) console.log(`Herdr:   ${herdrConfigPath} -> theme.name = "${selected.herdrName}"`);
  if (selected.herdrName && herdrReloadError) {
    console.log(`Herdr reload skipped: ${herdrReloadError}`);
  } else if (selected.herdrName) {
    console.log("Herdr:   reloaded running server config");
  }
  console.log(`Relay:   ${relayConfigPath} -> ui.theme = "${selected.relayId}"`);
  console.log(`Ghostty: ${ghosttyConfigPath} -> theme = ${selected.ghosttyName}`);
  if (herdrBackup) console.log(`Herdr backup:   ${herdrBackup}`);
  if (relayBackup) console.log(`Relay backup:   ${relayBackup}`);
  if (ghosttyBackup) console.log(`Ghostty backup: ${ghosttyBackup}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
