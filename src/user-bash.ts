/**
 * Local bash command execution with streaming output and cancellation.
 *
 * Used by the ! and !! editor prefixes to run shell commands from the TUI.
 * Output streams to a callback for live rendering; the full result is returned
 * on completion.
 */

// effect-shape-allow: user bash execution is a local platform adapter boundary.
import { spawn } from "child_process";
import { Effect } from "effect";
import { RelayError } from "./effect/errors";

function shellCommand(command: string): { shell: string; args: string[] } {
  if (process.platform === "win32") {
    // effect-shape-allow: shell selection is the platform boundary for local user bash.
    return { shell: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  // effect-shape-allow: shell selection is the platform boundary for local user bash.
  return { shell: process.env.SHELL || "/bin/sh", args: ["-c", command] };
}

function killProcess(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
  try {
    if (process.platform !== "win32" && proc.pid !== undefined) {
      process.kill(-proc.pid, signal);
      return;
    }

    proc.kill(signal);
  } catch {
    // Process already exited.
  }
}

export interface UserBashResult {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
}

export interface UserBashExecutionOptions {
  readonly env?: Readonly<Record<string, string>>;
}

export function executeUserBashEffect(
  command: string,
  cwd: string,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
  options?: UserBashExecutionOptions,
): Effect.Effect<UserBashResult, RelayError> {
  return Effect.callback<UserBashResult, RelayError>((resume) => {
    const shell = shellCommand(command);
    const proc = spawn(shell.shell, shell.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: {
        // effect-shape-allow: subprocess environment forwarding is the platform boundary for local user bash.
        ...process.env,
        TERM: "dumb",
        ...(options?.env ?? {}),
      },
    });

    const chunks: string[] = [];

    const handleData = (data: Buffer) => {
      const text = data.toString("utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      chunks.push(text);
      onChunk(text);
    };

    proc.stdout.on("data", handleData);
    proc.stderr.on("data", handleData);

    const onAbort = () => {
      if (process.platform === "win32") {
        killProcess(proc, "SIGKILL");
        return;
      }
      killProcess(proc, "SIGTERM");
      const forceKill = () => killProcess(proc, "SIGKILL");
      // effect-shape-allow: SIGKILL grace timer is tied to platform process teardown.
      setTimeout(forceKill, 500);
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    proc.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      const cancelled = signal?.aborted ?? false;
      resume(
        Effect.succeed({
          output: chunks.join(""),
          exitCode: cancelled ? undefined : (code ?? undefined),
          cancelled,
        }),
      );
    });

    proc.on("error", (err) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      const errorText = `Failed to run bash command: ${err.message}\n`;
      chunks.push(errorText);
      onChunk(errorText);
      resume(
        Effect.succeed({
          output: chunks.join(""),
          exitCode: undefined,
          cancelled: signal?.aborted ?? false,
        }),
      );
    });

    return Effect.sync(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      killProcess(proc, "SIGKILL");
    });
  });
}

/**
 * Execute a bash command in the given working directory.
 *
 * Streams sanitized output chunks via `onChunk` for live UI updates.
 * Supports cancellation through an `AbortSignal`.
 */
export function executeUserBash(
  command: string,
  cwd: string,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
  options?: UserBashExecutionOptions,
): Promise<UserBashResult> {
  // effect-shape-allow: compatibility bridge for current async UI call sites; remove after UI Effect migration.
  return Effect.runPromise(executeUserBashEffect(command, cwd, onChunk, signal, options));
}
