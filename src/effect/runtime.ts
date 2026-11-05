import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";

const AppLayer = Layer.empty;
const appRuntime = ManagedRuntime.make(AppLayer);

export type AppEffect<A, E = never> = Effect.Effect<A, E, never>;

function causeToError(cause: Cause.Cause<unknown>): Error {
  const pretty = Cause.pretty(cause);
  return new Error(pretty.length > 0 ? pretty : "Effect failed");
}

function exitToPromise<A>(exit: Exit.Exit<A, unknown>): Promise<A> {
  if (Exit.isSuccess(exit)) return Promise.resolve(exit.value);
  return Promise.reject(causeToError(exit.cause));
}

// effect-shape-allow: process entrypoints and callback bridges need one Promise runner boundary.
export function runEffect<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  return appRuntime.runPromise(effect); // effect-shape-allow: process entrypoints and callback bridges need one Promise runner boundary.
}

// effect-shape-allow: Solid/OpenTUI event callbacks are Promise-shaped bridge boundaries.
export function runUiEffect<A, E>(effect: Effect.Effect<A, E, never>, onFailure?: (error: Error) => void): void {
  // effect-shape-allow: Solid/OpenTUI event callbacks are Promise-shaped bridge boundaries.
  void appRuntime.runPromiseExit(effect).then((exit) => {
    if (Exit.isFailure(exit)) onFailure?.(causeToError(exit.cause));
  });
}

// effect-shape-allow: long-lived callback/read-loop bridges need a supervised runner boundary.
export function runBackgroundEffect<A, E>(
  effect: Effect.Effect<A, E, never>,
  onFailure?: (error: Error) => void,
): void {
  // effect-shape-allow: long-lived callback/read-loop bridges need a supervised runner boundary.
  void appRuntime.runPromiseExit(effect).then((exit) => {
    if (Exit.isFailure(exit)) onFailure?.(causeToError(exit.cause));
  });
}

// effect-shape-allow: tests need a single reusable runner boundary.
export function runTestEffect<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  return appRuntime.runPromiseExit(effect).then(exitToPromise); // effect-shape-allow: tests need a single reusable runner boundary.
}
