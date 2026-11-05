/**
 * Cross-platform notification dispatcher.
 *
 * Plays .wav files using platform-native tools:
 * - macOS: afplay
 * - Linux: paplay / aplay / mpv / ffplay (first available)
 *
 * Also emits terminal notification events through OpenTUI's renderer
 * (`renderer.triggerNotification`), which picks the notification protocol from
 * detected terminal capabilities and OPENTUI_NOTIFICATION_* overrides. The renderer is injected via
 * `setTerminalNotifier` so this module stays decoupled from the TUI and remains
 * a no-op outside it.
 *
 * Notifications are fire-and-forget (non-blocking). Each channel is best-effort independently.
 */

// effect-shape-allow: notification playback/detection is a local platform adapter boundary.
import { execSync, spawn } from "child_process";
// effect-shape-allow: notification sound file probing is a local platform adapter boundary.
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { Effect } from "effect";
import { getConfig, getConfigDir, type Config } from "./config";
import { currentEnv } from "./platform/env";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationEvent = "completion" | "elicitation" | "permission" | "error";

export interface NotificationContext {
  readonly sessionId?: string | null;
  readonly cwd?: string;
  readonly query?: string;
  readonly response?: string;
  readonly summary?: string;
  readonly toolName?: string;
  readonly toolInput?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Sound file resolution
// ---------------------------------------------------------------------------

const SOUND_FILES: Record<NotificationEvent, string> = {
  completion: "completion.wav",
  elicitation: "elicitation.wav",
  permission: "elicitation.wav",
  error: "error.wav",
};

const TERMINAL_TITLE = "Relay";

/** Resolve sound path: user override in ~/.config/relay/sounds/ takes priority, else bundled. */
function soundPath(event: NotificationEvent): string {
  const filename = SOUND_FILES[event];

  // Check user override first
  // effect-shape-allow: notification sound override resolution is a platform boundary.
  const userPath = resolve(getConfigDir(), "sounds", filename);
  if (existsSync(userPath)) return userPath;

  // Fall back to bundled sounds
  const dir = dirname(new URL(import.meta.url).pathname);
  return resolve(dir, "sounds", filename);
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

let _platform: string | null = null;

function getPlatform(): string {
  if (_platform === null) {
    _platform = process.platform;
  }
  return _platform;
}

// ---------------------------------------------------------------------------
// Linux player detection (cached)
// ---------------------------------------------------------------------------

let _linuxPlayer: string | null | undefined = undefined;

function findLinuxPlayer(): string | null {
  if (_linuxPlayer !== undefined) return _linuxPlayer;

  for (const player of ["paplay", "aplay", "mpv", "ffplay"]) {
    try {
      const result = execSync(`which ${player}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      if (result.trim()) {
        _linuxPlayer = player;
        return _linuxPlayer;
      }
    } catch {
      // not found, try next
    }
  }
  _linuxPlayer = null;
  return null;
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

type RunCommand = (command: string, args: string[]) => void;

/**
 * Emits a terminal notification. Returns true when the terminal accepted it.
 * Backed by OpenTUI's `renderer.triggerNotification(message, title)` once the
 * TUI registers one via {@link setTerminalNotifier}; a no-op otherwise.
 */
export type TerminalNotifier = (title: string, message: string) => boolean;

const noopTerminalNotifier: TerminalNotifier = () => false;

let _terminalNotifier: TerminalNotifier = noopTerminalNotifier;

/**
 * Register the terminal notifier used for OSC notification events. The TUI wires
 * this to OpenTUI's renderer; pass `null` to reset to the no-op (e.g. on teardown).
 */
export function setTerminalNotifier(notifier: TerminalNotifier | null): void {
  _terminalNotifier = notifier ?? noopTerminalNotifier;
}

type NotifyEnvironment = {
  readonly config: Config;
  readonly disabledByEnvironment: () => boolean;
  readonly platform: string;
  readonly soundPath: (event: NotificationEvent) => string;
  readonly exists: (path: string) => boolean;
  readonly linuxPlayer: () => string | null;
  readonly run: RunCommand;
  readonly notifyTerminal: TerminalNotifier;
};

function disabledByEnvironment(): boolean {
  const value = currentEnv().RELAY_DISABLE_NOTIFICATIONS;
  return value === "1" || value === "true";
}

function run(command: string, args: string[]): void {
  const child = spawn(command, args, {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  child.unref();
}

function playMacos(filePath: string, volume: number, runCommand: RunCommand): void {
  runCommand("afplay", ["-v", String(volume), filePath]);
}

function playLinux(filePath: string, volume: number, linuxPlayer: () => string | null, runCommand: RunCommand): void {
  const player = linuxPlayer();
  if (!player) return;

  switch (player) {
    case "paplay":
      runCommand("paplay", [`--volume=${Math.round(volume * 65536)}`, filePath]);
      break;
    case "aplay":
      runCommand("aplay", [filePath]);
      break;
    case "mpv":
      runCommand("mpv", [
        "--no-video",
        "--no-terminal",
        "--script-opts=autoload-disabled=yes",
        `--volume=${volume * 100}`,
        filePath,
      ]);
      break;
    case "ffplay":
      runCommand("ffplay", [
        "-nodisp",
        "-autoexit",
        "-loglevel",
        "quiet",
        "-volume",
        String(Math.round(volume * 100)),
        filePath,
      ]);
      break;
  }
}

// ---------------------------------------------------------------------------
// Terminal notifications
// ---------------------------------------------------------------------------

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value;
}

function sanitizeTerminalText(value: string): string {
  let sanitized = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    sanitized += codePoint < 0x20 || codePoint === 0x7f || char === ";" ? " " : char;
  }
  return sanitized.replace(/\s+/g, " ").trim();
}

function eventMessage(event: NotificationEvent, context: NotificationContext): string {
  switch (event) {
    case "completion":
      return context.response || "Agent turn complete";
    case "elicitation":
      return context.summary || "Relay needs input";
    case "permission":
      return permissionSummary(context);
    case "error":
      return context.response ? `Relay prompt failed: ${context.response}` : "Relay prompt failed";
  }
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return "{}";
  }
}

function previewFromToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  if (Object.keys(input).length === 0) return "";
  for (const key of ["command", "cmd", "file_path", "filepath", "path", "preview"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return truncateText(compactJson(input), 80);
}

function permissionSummary(context: NotificationContext): string {
  if (context.summary) return context.summary;
  const toolName = context.toolName || "tool";
  const preview = previewFromToolInput(context.toolInput);
  return preview ? `Wants to run ${toolName}: ${truncateText(preview, 120)}` : `Wants to run ${toolName}`;
}

function sendTerminalNotification(
  event: NotificationEvent,
  context: NotificationContext,
  environment: NotifyEnvironment,
): void {
  const message = truncateText(sanitizeTerminalText(eventMessage(event, context)), 200);
  environment.notifyTerminal(TERMINAL_TITLE, message);
}

function sendSoundNotification(event: NotificationEvent, environment: NotifyEnvironment): void {
  const filePath = environment.soundPath(event);
  if (!environment.exists(filePath)) return;
  const volume = environment.config.notifications.volume;

  if (environment.platform === "darwin") {
    playMacos(filePath, volume, environment.run);
  } else if (environment.platform === "linux") {
    playLinux(filePath, volume, environment.linuxPlayer, environment.run);
  }
  // Windows: not supported (no common CLI audio player)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function defaultNotifyEnvironment(): NotifyEnvironment {
  return {
    config: getConfig(),
    disabledByEnvironment,
    platform: getPlatform(),
    soundPath,
    exists: existsSync,
    linuxPlayer: findLinuxPlayer,
    run,
    notifyTerminal: (title, message) => _terminalNotifier(title, message),
  };
}

export function notifyEffect(
  event: NotificationEvent,
  context: NotificationContext = {},
  environment = defaultNotifyEnvironment(),
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (environment.disabledByEnvironment()) return;

    if (environment.config.notifications.terminal_enabled) {
      try {
        sendTerminalNotification(event, context, environment);
      } catch {
        // terminal notifications are best-effort and must not block sound playback
      }
    }

    if (environment.config.notifications.sound_enabled) {
      try {
        sendSoundNotification(event, environment);
      } catch {
        // sound playback is best-effort and must not block terminal notifications
      }
    }
  }).pipe(Effect.catch(() => Effect.void));
}

/**
 * Dispatch a notification for the given event type.
 * Non-blocking, fire-and-forget. Silently ignores errors.
 */
export function notify(event: NotificationEvent, context: NotificationContext = {}): void {
  // effect-shape-allow: compatibility bridge for current synchronous UI call sites; remove after UI Effect migration.
  Effect.runSync(notifyEffect(event, context));
}
