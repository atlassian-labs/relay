import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";

const BENCHMARK_ROOT = path.join(process.cwd(), "scripts", "perf", "chat-log-benchmark");
const IMPORT_PATTERN = /\bfrom\s+["']([^"']+)["']/g;

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [entryPath] : [];
  });
}

function internalImportTargets(filePath: string): string[] {
  const contents = fs.readFileSync(filePath, "utf8");
  return [...contents.matchAll(IMPORT_PATTERN)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => Boolean(specifier?.startsWith(".")))
    .map((specifier) => path.relative(BENCHMARK_ROOT, path.resolve(path.dirname(filePath), specifier)));
}

function expectNoImportInto(sourceDirectory: string, forbiddenDirectory: string): void {
  for (const filePath of sourceFiles(path.join(BENCHMARK_ROOT, sourceDirectory))) {
    for (const target of internalImportTargets(filePath)) {
      expect(target, `${path.relative(BENCHMARK_ROOT, filePath)} must not import ${target}`).not.toStartWith(
        forbiddenDirectory,
      );
    }
  }
}

describe("chat log benchmark dependency direction", () => {
  test("keeps the protocol independent from parent and child implementations", () => {
    expectNoImportInto("protocol", "parent");
    expectNoImportInto("protocol", "child");
  });

  test("keeps parent and child implementations isolated across the process boundary", () => {
    expectNoImportInto("parent", "child");
    expectNoImportInto("child", "parent");
  });

  test("keeps the public entrypoint independent from child implementation modules", () => {
    expect(internalImportTargets(path.join(BENCHMARK_ROOT, "index.ts"))).toEqual([
      "parent/run-parent",
      "protocol/options",
    ]);
  });
});
