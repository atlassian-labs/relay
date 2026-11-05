/**
 * Clipboard utilities - cross-platform clipboard copy.
 */

import { execSync } from "../../platform/process";

const defaultOscWriter = (data: string): void => {
  process.stdout.write(data);
};

let oscWriter: (data: string) => void = defaultOscWriter;

/**
 * Route the OSC 52 clipboard sequence through the given writer instead of
 * `process.stdout`. The TUI sets this to OpenTUI's serialized frame writer so
 * the sequence can't interleave with (and corrupt) a render flush. Pass null
 * to restore the direct `process.stdout` writer.
 */
export function setClipboardOscWriter(writer: ((data: string) => void) | null): void {
  oscWriter = writer ?? defaultOscWriter;
}

/**
 * Copy text to the system clipboard.
 * Tries OSC 52 first, then platform-specific commands.
 */
export function copyToClipboard(text: string): boolean {
  // Try OSC 52 (terminal-native clipboard)
  try {
    const b64 = Buffer.from(text).toString("base64");
    oscWriter(`\x1b]52;c;${b64}\x07`);
  } catch {
    // Ignore OSC 52 failures
  }

  // Platform-specific fallbacks
  const platform = process.platform;

  const commands: string[] = [];
  if (platform === "darwin") {
    commands.push("pbcopy");
  } else if (platform === "win32") {
    commands.push("clip");
  } else {
    // Linux - try multiple options
    commands.push("wl-copy", "xclip -selection clipboard", "xsel --clipboard --input");
  }

  for (const cmd of commands) {
    try {
      execSync(cmd, { input: text, stdio: ["pipe", "pipe", "pipe"] });
      return true;
    } catch {
      continue;
    }
  }

  return false;
}
