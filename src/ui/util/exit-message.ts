import type { FileChanges } from "../../core/types";
import type { ColorsConfig } from "../../config/themes";
import { nowMs } from "../../platform/time";
import { RELAY_LOGO_LINES } from "./relay-logo";

const EXIT_LOGO = RELAY_LOGO_LINES;

export function formatExitDuration(seconds: number): string {
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

export function hexToAnsi(hex: string): string {
  if (!hex || !hex.startsWith("#") || hex.length < 7) return "";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return "";
  return `\x1b[38;2;${r};${g};${b}m`;
}

export interface ExitMessageOptions {
  colors: ColorsConfig;
  sessionStartedAt: number | null;
  fileChanges: FileChanges[];
  sessionId?: string | null;
  now?: number;
}

export function buildExitMessage(opts: ExitMessageOptions): string {
  const reset = "\x1b[0m";
  const textLabel = hexToAnsi(opts.colors.textLabel);
  const accent = hexToAnsi(opts.colors.accent);
  const infoLines: string[] = [];

  if (opts.sessionStartedAt !== null) {
    const secs = ((opts.now ?? nowMs()) - opts.sessionStartedAt) / 1000;
    infoLines.push(`Time ${formatExitDuration(secs)}`);
  }

  if (opts.fileChanges.length > 0) {
    const map = new Map<string, { added: number; removed: number }>();
    for (const fc of opts.fileChanges) {
      const existing = map.get(fc.path);
      if (existing) map.set(fc.path, { added: existing.added + fc.added, removed: existing.removed + fc.removed });
      else map.set(fc.path, { added: fc.added, removed: fc.removed });
    }
    let totalAdded = 0;
    let totalRemoved = 0;
    for (const value of map.values()) {
      totalAdded += value.added;
      totalRemoved += value.removed;
    }
    infoLines.push(`Changed ${map.size} file${map.size !== 1 ? "s" : ""}  +${totalAdded}  -${totalRemoved}`);
  }

  if (opts.sessionId) infoLines.push(`${textLabel}To resume:${reset} ${accent}relay -r ${opts.sessionId}${reset}`);

  if (infoLines.length === 0) return "";

  const lines = ["", ...EXIT_LOGO.map((line) => `  ${line}`), "", ...infoLines.map((line) => `  ${line}`), ""];
  return `${lines.join("\n")}\n`;
}

export function printExitMessage(opts: ExitMessageOptions): void {
  const message = buildExitMessage(opts);
  if (message) process.stdout.write(message);
}

export * as ExitMessage from "./exit-message";
