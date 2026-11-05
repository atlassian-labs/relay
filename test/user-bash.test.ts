import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { executeUserBashEffect } from "../src/user-bash";
import { runTestEffect } from "./lib/effect";

describe("executeUserBashEffect", () => {
  test("streams stdout and returns completed output", async () => {
    const chunks: string[] = [];
    const result = await runTestEffect(
      executeUserBashEffect("printf 'hello\\r\\nworld'", process.cwd(), (chunk) => chunks.push(chunk)),
    );

    expect(result).toEqual({ output: "hello\nworld", exitCode: 0, cancelled: false });
    expect(chunks.join("")).toBe("hello\nworld");
  });

  test("reports non-zero exit codes without failing the Effect", async () => {
    const result = await runTestEffect(executeUserBashEffect("exit 7", process.cwd(), () => undefined));

    expect(result).toEqual({ output: "", exitCode: 7, cancelled: false });
  });

  test("passes environment overrides to the shell process", async () => {
    const result = await runTestEffect(
      executeUserBashEffect('printf "$RELAY_USER_BASH_TEST"', process.cwd(), () => undefined, undefined, {
        env: { RELAY_USER_BASH_TEST: "from-plugin" },
      }),
    );

    expect(result).toEqual({ output: "from-plugin", exitCode: 0, cancelled: false });
  });

  test("cancels a running process through AbortSignal", async () => {
    const controller = new AbortController();
    const result = runTestEffect(executeUserBashEffect("sleep 5", process.cwd(), () => undefined, controller.signal));

    controller.abort();

    await expect(result).resolves.toMatchObject({ exitCode: undefined, cancelled: true });
  });

  test("interrupting the Effect kills a running process", async () => {
    const fiber = await runTestEffect(
      Effect.forkDetach(executeUserBashEffect("sleep 5", process.cwd(), () => undefined)),
    );

    await runTestEffect(Fiber.interrupt(fiber));
  });
});
