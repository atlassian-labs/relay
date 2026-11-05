import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  IDENTITY_RECHECK_INTERVAL_MS,
  identityRecheckDue,
  payloadVersionFromCache,
  readTelemetryConsent,
  recordIdentityCheck,
  telemetryConsentExists,
  writeTelemetryConsent,
} from "../src/telemetry-storage";

const roots: string[] = [];

function root(): string {
  const value = path.join(tmpdir(), `relay-telemetry-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(value, { recursive: true });
  roots.push(value);
  return value;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("telemetry identity recheck", () => {
  test("is due when no check has been recorded", () => {
    expect(identityRecheckDue(root(), 1_000)).toBe(true);
  });

  test("becomes due after 24 hours", () => {
    const configDir = root();
    const checkedAtMs = 10_000;
    recordIdentityCheck(configDir, checkedAtMs);

    expect(readFileSync(path.join(configDir, "user-id-last-checked"), "utf-8")).toBe(String(checkedAtMs));
    expect(identityRecheckDue(configDir, checkedAtMs + IDENTITY_RECHECK_INTERVAL_MS - 1)).toBe(false);
    expect(identityRecheckDue(configDir, checkedAtMs + IDENTITY_RECHECK_INTERVAL_MS)).toBe(true);
  });

  test("is due for malformed or future timestamps", () => {
    const configDir = root();
    const checkPath = path.join(configDir, "user-id-last-checked");
    writeFileSync(checkPath, "not-a-timestamp");
    expect(identityRecheckDue(configDir, 1_000)).toBe(true);
    writeFileSync(checkPath, "1001");
    expect(identityRecheckDue(configDir, 1_000)).toBe(true);
  });
});

describe("telemetry consent persistence", () => {
  test("returns null when no consent file exists", () => {
    expect(readTelemetryConsent(root())).toBeNull();
  });

  test("telemetryConsentExists returns false for fresh directory", () => {
    expect(telemetryConsentExists(root())).toBe(false);
  });

  test("persists and reads true consent", () => {
    const configDir = root();
    writeTelemetryConsent(configDir, true);
    expect(telemetryConsentExists(configDir)).toBe(true);
    expect(readTelemetryConsent(configDir)).toBe(true);
  });

  test("persists and reads false consent", () => {
    const configDir = root();
    writeTelemetryConsent(configDir, false);
    expect(telemetryConsentExists(configDir)).toBe(true);
    expect(readTelemetryConsent(configDir)).toBe(false);
  });

  test("can change consent from false to true", () => {
    const configDir = root();
    writeTelemetryConsent(configDir, false);
    expect(readTelemetryConsent(configDir)).toBe(false);
    writeTelemetryConsent(configDir, true);
    expect(readTelemetryConsent(configDir)).toBe(true);
  });

  test("returns null for malformed consent file", () => {
    const configDir = root();
    writeFileSync(path.join(configDir, "telemetry-consent"), "maybe");
    expect(readTelemetryConsent(configDir)).toBeNull();
  });
});

describe("telemetry payload version", () => {
  test("uses installedVersion only", () => {
    const configDir = root();
    mkdirSync(path.join(configDir, "cache"), { recursive: true });
    writeFileSync(
      path.join(configDir, "cache", "version-update.json"),
      JSON.stringify({ installedVersion: "2026.29.1+abc", latestVersion: "2099.1.1" }),
    );

    expect(payloadVersionFromCache(configDir)).toBe("2026.29.1+abc");
  });

  test("falls back to dev for missing or malformed cache", () => {
    const configDir = root();
    expect(payloadVersionFromCache(configDir)).toBe("dev");
    mkdirSync(path.join(configDir, "cache"), { recursive: true });
    writeFileSync(path.join(configDir, "cache", "version-update.json"), "not-json");
    expect(payloadVersionFromCache(configDir)).toBe("dev");
  });
});
