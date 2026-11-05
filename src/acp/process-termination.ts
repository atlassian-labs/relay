import { Duration, Effect, Fiber } from "effect";
import { errorMessage } from "../effect/errors";
import { type RelayChildProcess } from "../platform/process";
import { nowMs } from "../platform/time";
import { getRelayLogger } from "../logging/logger";

const PROCESS_TERMINATION_GRACE_MS = 50;
const PROCESS_FORCE_KILL_WAIT_MS = 25;

/**
 * Reports whether spawned ACP agents should run in their own detached POSIX process group.
 *
 * @returns True on POSIX platforms, where detaching keeps agents off Relay's controlling TTY.
 */
export function shouldDetachFromControllingTerminal(): boolean {
  return process.platform !== "win32";
}

/**
 * Signals the detached POSIX process group, falling back to the launcher process when needed.
 *
 * @param proc - Spawned ACP launcher process.
 * @param detachedFromTerminal - Whether the process owns a detached POSIX process group.
 * @param [signal="SIGTERM"] - Signal to send.
 */
function terminateProcess(
  proc: RelayChildProcess,
  detachedFromTerminal: boolean,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (detachedFromTerminal && typeof proc.pid === "number") {
    try {
      // A detached POSIX child leads its own process group; a negative PID signals the group.
      process.kill(-proc.pid, signal);
      return;
    } catch (cause) {
      getRelayLogger().debug("acp.process_group.kill.error", { signal, error: errorMessage(cause) });
    }
  }

  proc.kill(signal);
}

/**
 * Checks whether the launcher process, or its detached POSIX process group, still exists.
 *
 * @param proc - Spawned ACP launcher process.
 * @param detachedFromTerminal - Whether to probe the detached POSIX process group.
 * @returns Whether the launcher process or process group still exists.
 */
function processGroupExists(proc: RelayChildProcess, detachedFromTerminal: boolean): boolean {
  if (!detachedFromTerminal || typeof proc.pid !== "number") {
    return proc.exitCode === null && proc.signalCode === null;
  }

  try {
    process.kill(-proc.pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Sends a graceful SIGTERM to the ACP process group and tears down the child's stdio.
 *
 * @param proc - Spawned ACP launcher process, or null when nothing was spawned.
 */
export function terminateChildProcess(proc: RelayChildProcess | null): Effect.Effect<void> {
  return Effect.sync(() => {
    if (!proc) {
      return;
    }

    terminateProcess(proc, shouldDetachFromControllingTerminal());
    proc.stdin.destroy();
    proc.stdout.destroy();
    proc.stderr.destroy();
  }).pipe(Effect.catch(() => Effect.void));
}

/**
 * Synchronously SIGKILLs the ACP process group and tears down the child's stdio.
 *
 * Unlike {@link terminateChildProcess}, this never waits and is safe to call from a
 * non-Effect shutdown fallback such as a signal handler.
 *
 * @param proc - Spawned ACP launcher process.
 */
export function forceKillChildProcess(proc: RelayChildProcess): void {
  try {
    terminateProcess(proc, shouldDetachFromControllingTerminal(), "SIGKILL");
  } catch (cause) {
    getRelayLogger().debug("acp.process.force_kill.error", { error: errorMessage(cause) });
  }

  for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
    try {
      stream.destroy();
    } catch {}
  }
}

/**
 * Waits out the grace window, extends it for lingering descendants, then SIGKILLs the group if it survives.
 *
 * @param proc - Spawned ACP launcher process.
 * @param exitFiber - Fiber that resolves when the child's exit/error event fires.
 * @param terminationStartedAt - Millisecond timestamp captured when graceful termination began.
 */
export function awaitProcessTermination(
  proc: RelayChildProcess,
  exitFiber: Fiber.Fiber<void, never>,
  terminationStartedAt: number,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    // Wait for the child's exit event, or give up once the grace window elapses.
    const exitedDuringGracePeriod = yield* Effect.race(
      Fiber.join(exitFiber).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(true)),
      ),
      Effect.sleep(Duration.millis(PROCESS_TERMINATION_GRACE_MS)).pipe(Effect.as(false)),
    );
    const detachedFromTerminal = shouldDetachFromControllingTerminal();
    let processGroupStillAlive = processGroupExists(proc, detachedFromTerminal);

    // A launcher can exit promptly while its descendants keep the group alive; wait out the rest of the window.
    if (exitedDuringGracePeriod && processGroupStillAlive) {
      const remainingGraceMs = Math.max(0, PROCESS_TERMINATION_GRACE_MS - (nowMs() - terminationStartedAt));
      if (remainingGraceMs > 0) {
        yield* Effect.sleep(Duration.millis(remainingGraceMs));
      }

      processGroupStillAlive = processGroupExists(proc, detachedFromTerminal);
    }

    if (!exitedDuringGracePeriod || processGroupStillAlive) {
      // Escalate to SIGKILL and give the child's exit event a brief moment to fire.
      getRelayLogger().warn("acp.process.force_kill", { pid: proc.pid ?? null });
      yield* Effect.sync(() => {
        terminateProcess(proc, detachedFromTerminal, "SIGKILL");
      }).pipe(Effect.catch(() => Effect.void));

      yield* Effect.sleep(Duration.millis(PROCESS_FORCE_KILL_WAIT_MS));

      yield* Effect.race(
        Fiber.join(exitFiber).pipe(
          Effect.asVoid,
          Effect.catch(() => Effect.void),
        ),
        Effect.sleep(Duration.millis(1)),
      );
    }
  });
}
