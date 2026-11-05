import { test } from "bun:test";
import { Effect } from "effect";
export { runTestEffect } from "../../src/effect/runtime";
import { runTestEffect } from "../../src/effect/runtime";

export function testEffect<A, E>(name: string, effect: Effect.Effect<A, E, never>): void {
  test(name, () => runTestEffect(effect));
}

export function effectTest<A, E>(name: string, body: () => Effect.Effect<A, E, never>): void {
  test(name, () => runTestEffect(body()));
}
