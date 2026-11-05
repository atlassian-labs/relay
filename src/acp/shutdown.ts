import { Duration, Effect, Fiber } from "effect";
import { runEffect } from "../effect/runtime";

export interface AcpShutdownClient {
  disposeAsync(): Promise<void>;
  forceDispose?(): void;
}

export interface DisposeAcpClientsForShutdownOptions {
  /** Time to wait for graceful `disposeAsync` before escalating to `forceDispose`. */
  readonly disposeTimeoutMs: number;
  /** Time to wait for the graceful disposal to settle after `forceDispose` is called. */
  readonly forceSettleMs: number;
  /** Invoked for each graceful disposal that rejects; does not abort the remaining clients. */
  readonly onDisposeError?: (error: Error) => void;
  /** Invoked for each `forceDispose` that throws; does not abort the remaining clients. */
  readonly onForceDisposeError?: (error: Error) => void;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function notifyShutdownError(callback: ((error: Error) => void) | undefined, error: Error): void {
  try {
    callback?.(error);
  } catch {
    // Error observers must not interrupt the remaining shutdown cleanup.
  }
}

/**
 * Disposes ACP clients concurrently, then force-disposes them if the graceful shutdown budget expires.
 *
 * ```text
 * Start every disposeAsync concurrently
 *               │
 *               ├── All finish before disposeTimeoutMs
 *               │       └── return { forced: false }
 *               │
 *               └── Timeout expires
 *                       │
 *                       ├── call forceDispose on every client
 *                       │
 *                       ├── wait up to forceSettleMs
 *                       │
 *                       └── return { forced: true }
 * ```
 *
 * @param clients - ACP clients to dispose. Duplicate references are disposed once.
 * @param options - Shutdown budgets and optional disposal error handlers.
 * @returns Whether shutdown required the forced fallback.
 */
export function disposeAcpClientsForShutdown(
  clients: Iterable<AcpShutdownClient>,
  options: DisposeAcpClientsForShutdownOptions,
): Promise<{ readonly forced: boolean }> {
  const uniqueClients = [...new Set(clients)];

  return runEffect(
    Effect.gen(function* () {
      // Keep graceful disposal running while shutdown advances to the forced fallback.
      const disposeFiber = yield* Effect.forkDetach(
        Effect.forEach(
          uniqueClients,
          (client) =>
            Effect.tryPromise({
              try: () => client.disposeAsync(),
              catch: asError,
            }).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  notifyShutdownError(options.onDisposeError, error);
                }),
              ),
            ),
          { concurrency: "unbounded" },
        ),
      );
      const disposed = yield* Effect.race(
        Fiber.join(disposeFiber).pipe(Effect.as(true)),
        Effect.sleep(Duration.millis(options.disposeTimeoutMs)).pipe(Effect.as(false)),
      );

      if (disposed) {
        return { forced: false } as const;
      }

      for (const client of uniqueClients) {
        try {
          client.forceDispose?.();
        } catch (cause) {
          notifyShutdownError(options.onForceDisposeError, asError(cause));
        }
      }

      yield* Effect.race(
        Fiber.join(disposeFiber).pipe(Effect.asVoid),
        Effect.sleep(Duration.millis(options.forceSettleMs)),
      );

      return { forced: true } as const;
    }),
  );
}
