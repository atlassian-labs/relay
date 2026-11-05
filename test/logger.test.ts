import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { initializeRelayLogger, parseRelayLogLevel, sanitizeForLog, type RelayLogger } from "../src/logging/logger";

const tmpRoots: string[] = [];
let activeLogger: RelayLogger | null = null;

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-logger-test-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await activeLogger?.close();
  activeLogger = null;
  while (tmpRoots.length > 0) fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe("Relay logger", () => {
  test("parses supported log levels", () => {
    expect(parseRelayLogLevel("debug")).toBe("debug");
    expect(parseRelayLogLevel("TRACE")).toBe("trace");
    expect(parseRelayLogLevel("verbose")).toBeNull();
  });

  test("writes JSONL entries at or above the configured level", async () => {
    const root = tmpRoot();
    const logger = initializeRelayLogger({ configDir: root, level: "info" });
    activeLogger = logger;
    logger.debug("hidden.debug");
    logger.info("visible.info", { agentName: "alta" });
    await logger.close();

    expect(logger.path).not.toBeNull();
    const lines = fs
      .readFileSync(logger.path!, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; data?: Record<string, unknown> });

    expect(lines.some((line) => line.event === "logging.ready")).toBe(true);
    expect(lines.some((line) => line.event === "visible.info")).toBe(true);
    expect(lines.some((line) => line.event === "hidden.debug")).toBe(false);
  });

  test("filters the initial ready entry with the configured level", async () => {
    const root = tmpRoot();
    const logger = initializeRelayLogger({ configDir: root, level: "warn" });
    activeLogger = logger;
    logger.warn("visible.warn");
    await logger.close();

    expect(logger.path).not.toBeNull();
    const lines = fs
      .readFileSync(logger.path!, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string });

    expect(lines.map((line) => line.event)).toEqual(["visible.warn"]);
  });

  test("redacts sensitive fields", () => {
    expect(
      sanitizeForLog({
        token: "abc",
        nested: { authorization: "Bearer abc", ok: true },
      }),
    ).toEqual({
      token: "[REDACTED]",
      nested: { authorization: "[REDACTED]", ok: true },
    });
  });
});
