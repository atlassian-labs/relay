import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  checkEffectShape,
  checkNewEffectShapeViolations,
  formatEffectShapeViolations,
} from "../../scripts/check-effect-shape";

const tempDirs: string[] = [];

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-effect-shape-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "src"));
  return dir;
}

function writeFixture(cwd: string, path: string, content: string): void {
  const absolutePath = join(cwd, path);
  mkdirSync(absolutePath.slice(0, absolutePath.lastIndexOf("/")), { recursive: true });
  writeFileSync(absolutePath, content);
}

describe("checkEffectShape", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports raw Promise usage in strict source files", () => {
    const cwd = fixtureDir();
    writeFixture(cwd, "src/acp/client.ts", "export const value = new Promise((resolve) => resolve(1));\n");

    const violations = checkEffectShape({ cwd });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: "src/acp/client.ts",
      line: 1,
      rule: { id: "no-new-promise" },
      text: "export const value = new Promise((resolve) => resolve(1));",
    });
  });

  test("allows explicitly documented bridge exceptions", () => {
    const cwd = fixtureDir();
    writeFixture(
      cwd,
      "src/acp/client.ts",
      "// effect-shape-allow: third-party callback adapter.\nexport const value = new Promise((resolve) => resolve(1));\n",
    );

    expect(checkEffectShape({ cwd })).toEqual([]);
  });

  test("does not allow accidental allow-token substrings", () => {
    const cwd = fixtureDir();
    writeFixture(
      cwd,
      "src/acp/client.ts",
      "// TODO: remove effect-shape-allow workaround later.\nexport const value = new Promise((resolve) => resolve(1));\n",
    );

    const violations = checkEffectShape({ cwd });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule.id).toBe("no-new-promise");
  });

  test("allows approved runtime runner boundaries", () => {
    const cwd = fixtureDir();
    mkdirSync(join(cwd, "src/effect"), { recursive: true });
    writeFixture(
      cwd,
      "src/effect/runtime.ts",
      "// effect-shape-allow: runtime owns Effect runner boundaries.\nexport const run = () => appRuntime.runPromise(effect);\n",
    );

    expect(checkEffectShape({ cwd })).toEqual([]);
  });

  test("rejects Effect runners hidden in domain source", () => {
    const cwd = fixtureDir();
    writeFixture(
      cwd,
      "src/acp/client.ts",
      "export const runPromise = () => Effect.runPromise(connect());\nexport const runFork = () => Effect.runFork(connect());\nexport const runCallback = () => Effect.runCallback(connect());\n",
    );

    const violations = checkEffectShape({ cwd });

    expect(violations.map((violation) => violation.rule.id)).toEqual([
      "effect-runner-boundary",
      "effect-runner-boundary",
      "effect-runner-boundary",
    ]);
  });

  test("rejects async work hidden in Effect.sync", () => {
    const cwd = fixtureDir();
    writeFixture(cwd, "src/config/index.ts", "export const bad = Effect.sync(() => readFile());\n");

    const violations = checkEffectShape({ cwd });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: "src/config/index.ts",
      line: 1,
      rule: { id: "no-effect-sync-async" },
    });
  });

  test("rejects succeeding an Effect with a Promise", () => {
    const cwd = fixtureDir();
    writeFixture(cwd, "src/config/index.ts", "export const bad = Effect.succeed(loadPromise);\n");

    const violations = checkEffectShape({ cwd });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: "src/config/index.ts",
      line: 1,
      rule: { id: "no-effect-succeed-promise" },
    });
  });

  test("rejects exported async service methods in strict source", () => {
    const cwd = fixtureDir();
    writeFixture(cwd, "src/config/index.ts", "export async function loadConfig() { return config; }\n");

    const violations = checkEffectShape({ cwd });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: "src/config/index.ts",
      line: 1,
      rule: { id: "no-exported-async-service-method" },
    });
  });

  test("requires local allow reason for Effect.async callback bridges", () => {
    const cwd = fixtureDir();
    writeFixture(cwd, "src/acp/client.ts", "export const bridge = Effect.async((resume) => resume(Effect.void));\n");

    const violations = checkEffectShape({ cwd });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: "src/acp/client.ts",
      line: 1,
      rule: { id: "effect-async-requires-local-allow" },
    });
  });

  test("rejects Effect.promise in strict source", () => {
    const cwd = fixtureDir();
    writeFixture(cwd, "src/config/index.ts", "export const bad = Effect.promise(() => readConfig());\n");

    const violations = checkEffectShape({ cwd });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: "src/config/index.ts",
      line: 1,
      rule: { id: "no-effect-promise-in-strict-source" },
    });
  });

  test("rejects nondeterministic platform calls in strict source", () => {
    const cwd = fixtureDir();
    writeFixture(cwd, "src/acp/client.ts", "export const id = randomUUID();\nexport const sample = Math.random();\n");

    const violations = checkEffectShape({ cwd });

    expect(violations.map((violation) => violation.rule.id)).toEqual([
      "no-direct-platform-time",
      "no-direct-platform-time",
    ]);
  });

  test("strict gate fails closed without a migration baseline", () => {
    const cwd = fixtureDir();
    writeFixture(cwd, "src/acp/client.ts", "export const value = new Promise((resolve) => resolve(1));\n");

    const strictViolations = checkNewEffectShapeViolations({ cwd });

    expect(strictViolations).toHaveLength(1);
    expect(strictViolations[0]?.rule.id).toBe("no-new-promise");
  });

  test("current repository has no strict Effect shape violations", () => {
    expect(checkNewEffectShapeViolations()).toEqual([]);
  });

  test("formats violation output with rule descriptions", () => {
    const cwd = fixtureDir();
    writeFixture(cwd, "src/config/index.ts", "export const env = process.env.HOME;\n");

    const output = formatEffectShapeViolations(checkEffectShape({ cwd }));

    expect(output).toContain("Effect shape violations found:");
    expect(output).toContain("src/config/index.ts:1 no-direct-process-env");
    expect(output).toContain("Use an Effect platform/config boundary instead of direct process.env in app code.");
  });
});
