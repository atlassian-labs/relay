import { Duration, Effect } from "effect";
import { runEffect } from "./effect/runtime";

export interface FlushTelemetryWithinBudgetOptions {
  /** Starts the telemetry flush operation. */
  readonly flush: () => Promise<void>;
  /** Maximum time to wait before allowing shutdown to continue. */
  readonly timeoutMs: number;
}

/**
 * Waits for the telemetry transport's own bounded flush before exiting the process.
 *
 * Process-exit callers must not impose a shorter outer timeout: pending telemetry is
 * removed before transmission, so exiting while the request is in flight loses counts.
 * Flush failures remain best-effort and never block shutdown with an error.
 */
export function flushTelemetryBeforeExit(flush: () => Promise<void>): Promise<void> {
  return flush().catch(() => undefined);
}

/**
 * Waits for telemetry to flush without allowing a rejected or stuck flush to block shutdown.
 *
 * @param options - Telemetry flush operation and shutdown budget.
 */
export function flushTelemetryWithinBudget(options: FlushTelemetryWithinBudgetOptions): Promise<void> {
  const flush = Effect.tryPromise({
    try: options.flush,
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.catch(() => Effect.void));
  return runEffect(Effect.race(flush, Effect.sleep(Duration.millis(options.timeoutMs))).pipe(Effect.asVoid));
}
