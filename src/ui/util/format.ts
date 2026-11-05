import { getHomeEnv } from "../../platform/env";

/**
 * Strip emoji and other characters that many terminals render as replacement
 * diamonds or tofu. Covers all Supplementary Plane characters (U+10000+),
 * BMP emoji-adjacent ranges, variation selectors, ZWJ, and replacement chars.
 */
export function stripEmoji(text: string): string {
  return text.replace(/[\u{10000}-\u{10FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]|\uFFFD/gu, "");
}

export function stripTerminalControls(text: string): string {
  return (
    text
      // Tool output may include terminal control sequences; render them as inert text content.
      // oxlint-disable-next-line no-control-regex
      .replace(/\x1B(?:\][^\x07]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g, "")
      // oxlint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
  );
}

export function formatPath(p: string, home = getHomeEnv() ?? ""): string {
  if (home && p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

export function truncateTextEnd(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 3) return ".".repeat(maxWidth);
  return `${text.slice(0, maxWidth - 3)}...`;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;

  if (days > 0) return `${days}d ${remHours}h`;
  if (hours > 0) return `${hours}h ${remMins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${total}s`;
}

function formatCompactValue(value: number, divisor: number, suffix: string): string {
  const scaled = value / divisor;
  const text = scaled >= 10 ? Math.round(scaled).toString() : scaled.toFixed(1).replace(/\.0$/, "");
  return `${text}${suffix}`;
}

export function formatCompactNumber(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "-" : "";
  const absolute = Math.abs(rounded);

  if (absolute >= 1_000_000) return `${sign}${formatCompactValue(absolute, 1_000_000, "m")}`;
  if (absolute >= 1_000) return `${sign}${formatCompactValue(absolute, 1_000, "k")}`;
  return rounded.toString();
}

export * as Format from "./format";

/** Check whether a result text is a single non-empty line. */
export function isSingleLineResult(text: string): boolean {
  let nonEmpty = 0;
  for (const line of text.split("\n")) if (line.trim() && ++nonEmpty > 1) return false;
  return nonEmpty === 1;
}
