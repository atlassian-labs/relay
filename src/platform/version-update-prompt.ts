import {
  ANSI,
  applyStartupPromptKey,
  renderStartupPrompt,
  runStartupPrompt,
  type StartupPromptConfig,
} from "./startup-prompt";
import type { VersionUpdateInfo } from "./version-check";

export type VersionUpdatePromptSelection = "update" | "skip";

export interface VersionUpdatePromptState {
  highlighted: VersionUpdatePromptSelection;
  selection: VersionUpdatePromptSelection | null;
}

function buildVersionUpdateConfig(update: VersionUpdateInfo): StartupPromptConfig<VersionUpdatePromptSelection> {
  return {
    header: [
      `${ANSI.CYAN}${ANSI.BOLD}  🌟 Update available!${ANSI.RESET} ${ANSI.DIM}${update.currentVersion} -> ${update.version}${ANSI.RESET}`,
    ],
    options: [
      { value: "update", label: `Update now (runs \`${update.updateCommand}\`)` },
      { value: "skip", label: "Skip" },
    ],
    initialHighlight: "update",
    skipValue: "skip",
    marker: "›",
    numbered: true,
  };
}

export function renderVersionUpdatePrompt(
  update: VersionUpdateInfo,
  _currentVersion = update.currentVersion,
  highlighted: VersionUpdatePromptSelection = "update",
): string {
  return renderStartupPrompt(buildVersionUpdateConfig(update), highlighted);
}

export function renderVersionUpdateCompleteMessage(version: string): string {
  return `Relay updated to version ${version}. Please start again.`;
}

export function applyVersionUpdatePromptKey(state: VersionUpdatePromptState, key: string): VersionUpdatePromptState {
  const update: VersionUpdateInfo = { version: "", currentVersion: "", updateCommand: "" };
  return applyStartupPromptKey(state, key, buildVersionUpdateConfig(update));
}

export async function runVersionUpdatePrompt(update: VersionUpdateInfo): Promise<VersionUpdatePromptSelection> {
  return runStartupPrompt(buildVersionUpdateConfig(update));
}
