import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { execFileSync } from "../../platform/process";
import { existsSync, readFileSync, rmSync } from "../../platform/fs";
import { cleanupPastedImagePath, readPromptImageFile, type PromptImageSource } from "../prompt-images";

export type ClipboardImagePlatform = NodeJS.Platform;
export type ClipboardCommandRunner = (command: string, args: readonly string[]) => Effect.Effect<Buffer, unknown>;

export interface ClipboardImageReadOptions {
  readonly platform?: ClipboardImagePlatform;
  readonly runCommand?: ClipboardCommandRunner;
  readonly tempFilePath?: string;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 1500;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
let clipboardTempFileCounter = 0;

export function readClipboardImage(options: ClipboardImageReadOptions = {}): Effect.Effect<PromptImageSource | null> {
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? runClipboardCommand;

  if (platform === "darwin") return readMacClipboardImage(runCommand, options.tempFilePath);
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd")
    return readUnixClipboardImage(runCommand);
  return Effect.succeed(null);
}

function readMacClipboardImage(
  runCommand: ClipboardCommandRunner,
  tempFilePath = path.join(os.tmpdir(), `relay-clipboard-image-${process.pid}-${++clipboardTempFileCounter}.png`),
): Effect.Effect<PromptImageSource | null> {
  return Effect.gen(function* () {
    yield* commandOrNull(runCommand, "osascript", macClipboardImageScriptArgs(tempFilePath));
    try {
      if (existsSync(tempFilePath)) {
        const bytes = readFileSync(tempFilePath);
        if (bytes.length > 0) return { bytes, filename: "clipboard.png" };
      }
    } finally {
      try {
        rmSync(tempFilePath, { force: true });
      } catch {}
    }

    const textBytes = yield* commandOrNull(runCommand, "pbpaste", []);
    return textBytes ? sourceFromClipboardText(textBytes.toString("utf8").trim()) : null;
  });
}

function readUnixClipboardImage(runCommand: ClipboardCommandRunner): Effect.Effect<PromptImageSource | null> {
  return Effect.gen(function* () {
    const imageCommands: Array<readonly [string, readonly string[]]> = [
      ["wl-paste", ["--type", "image/png"]],
      ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
    ];
    for (const [command, args] of imageCommands) {
      const bytes = yield* commandOrNull(runCommand, command, args);
      if (bytes && bytes.length > 0) return { bytes, filename: "clipboard.png" };
    }

    const textCommands: Array<readonly [string, readonly string[]]> = [
      ["wl-paste", ["--no-newline"]],
      ["xclip", ["-selection", "clipboard", "-o"]],
    ];
    for (const [command, args] of textCommands) {
      const bytes = yield* commandOrNull(runCommand, command, args);
      const source = bytes ? sourceFromClipboardText(bytes.toString("utf8").trim()) : null;
      if (source) return source;
    }

    return null;
  });
}

function macClipboardImageScriptArgs(tempFilePath: string): string[] {
  return [
    "-e",
    `set imagePath to POSIX file ${JSON.stringify(tempFilePath)}`,
    "-e",
    "try",
    "-e",
    "set imageData to the clipboard as «class PNGf»",
    "-e",
    "set fileRef to open for access imagePath with write permission",
    "-e",
    "write imageData to fileRef",
    "-e",
    "close access fileRef",
    "-e",
    "on error",
    "-e",
    "try",
    "-e",
    "close access imagePath",
    "-e",
    "end try",
    "-e",
    "end try",
  ];
}

function sourceFromClipboardText(text: string): PromptImageSource | null {
  if (!text) return null;
  return readPromptImageFile(cleanupPastedImagePath(text));
}

function commandOrNull(
  runCommand: ClipboardCommandRunner,
  command: string,
  args: readonly string[],
): Effect.Effect<Buffer | null> {
  return runCommand(command, args).pipe(Effect.catch(() => Effect.succeed(null)));
}

function runClipboardCommand(command: string, args: readonly string[]): Effect.Effect<Buffer, unknown> {
  return Effect.try({
    try: () =>
      execFileSync(command, [...args], {
        encoding: "buffer",
        timeout: DEFAULT_COMMAND_TIMEOUT_MS,
        maxBuffer: DEFAULT_MAX_BUFFER,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    catch: (error) => error,
  });
}
