import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  initializeTelemetry,
  resolveExternalIdentity,
  TELEMETRY_CONSENT_REQUIRED,
  TelemetryState,
  telemetryDisabled,
  telemetryEnvDisabled,
} from "../src/telemetry-external";

const roots: string[] = [];
const originalCaptureFile = process.env.RELAY_TELEMETRY_CAPTURE_FILE;
const originalDoNotTrack = process.env.DO_NOT_TRACK;
const originalRelayDisabled = process.env.RELAY_TELEMETRY_DISABLED;
const originalHome = process.env.HOME;
const originalConfigDir = process.env.RELAY_CONFIG_DIR;

function root(): string {
  const value = path.join(tmpdir(), `relay-telemetry-external-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(value, { recursive: true });
  roots.push(value);
  return value;
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function capturedEvent(capture: string): Record<string, unknown> {
  const batch: unknown = JSON.parse(readFileSync(capture, "utf-8").trim());
  const events = isRecord(batch) && Array.isArray(batch.batch) ? batch.batch : [];
  const event = events[0];
  if (!isRecord(event)) throw new Error("missing captured event");
  return event;
}

afterEach(() => {
  setEnv("RELAY_TELEMETRY_CAPTURE_FILE", originalCaptureFile);
  setEnv("DO_NOT_TRACK", originalDoNotTrack);
  setEnv("RELAY_TELEMETRY_DISABLED", originalRelayDisabled);
  setEnv("HOME", originalHome);
  setEnv("RELAY_CONFIG_DIR", originalConfigDir);
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("external telemetry policy", () => {
  test("uses a stable anonymous user-id without scanning identity files", async () => {
    const dir = root();
    const capture = path.join(dir, "capture.jsonl");
    const configDir = path.join(dir, ".config");
    mkdirSync(path.join(configDir, "acli"), { recursive: true });
    mkdirSync(path.join(configDir, "twg"), { recursive: true });
    writeFileSync(
      path.join(configDir, "twg", "auth.conf"),
      "user=twg-user@atlassian.com\nuser-id=712020:twg-account-id-1234567890\n",
    );
    writeFileSync(
      path.join(configDir, "acli", "rovodev_config.yaml"),
      "version: 1\nprofile:\n  email: rovo-user@atlassian.com\n  accountId: 712020:rovo-account-id-1234567890\n",
    );
    // Consent must be granted for telemetry to emit events.
    writeFileSync(path.join(dir, "telemetry-consent"), "true");
    setEnv("HOME", dir);
    setEnv("RELAY_TELEMETRY_CAPTURE_FILE", capture);
    setEnv("RELAY_CONFIG_DIR", dir);
    setEnv("DO_NOT_TRACK", undefined);
    setEnv("RELAY_TELEMETRY_DISABLED", undefined);

    const state = new TelemetryState(dir);
    state.recordSlashCommand("/plugins");
    await state.flushPending();

    const event = capturedEvent(capture);
    expect(event.userId).toBeUndefined();
    expect(event.anonymousId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(readFileSync(path.join(dir, "user-id"), "utf-8")).toBe(String(event.anonymousId));
    expect(existsSync(path.join(dir, "anon-id"))).toBe(false);
    const properties = isRecord(event.properties) ? event.properties : {};
    expect(properties.userIdType).toBeUndefined();
  });

  test("replaces a preexisting internal identity with an anonymous UUID", () => {
    const configDir = root();
    writeFileSync(path.join(configDir, "user-id"), "internal-user@atlassian.com");

    const first = resolveExternalIdentity(configDir);
    const second = resolveExternalIdentity(configDir);

    expect(first.userId).toBeNull();
    expect(first.anonymousId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first.anonymousId).not.toBe("internal-user@atlassian.com");
    expect(second).toEqual(first);
    expect(readFileSync(path.join(configDir, "user-id"), "utf-8")).toBe(first.anonymousId);
  });

  test("honors both disable flags", () => {
    expect(telemetryDisabled({ DO_NOT_TRACK: "1" })).toBe(true);
    expect(telemetryDisabled({ DO_NOT_TRACK: "true" })).toBe(true);
    expect(telemetryDisabled({ RELAY_TELEMETRY_DISABLED: "yes" })).toBe(true);
    // DO_NOT_TRACK=0 does not disable via env, but consent still applies
    expect(telemetryDisabled({ DO_NOT_TRACK: "0" })).toBe(true);
  });

  test("is disabled when no consent file exists", () => {
    const dir = root();
    expect(telemetryDisabled({ RELAY_CONFIG_DIR: dir })).toBe(true);
  });

  // Privacy requires that the first-run prompt is answered before any
  // persistent identifier exists, so startup must not create `user-id` while
  // consent is still unrecorded.
  test("persists no anonymous user-id before consent is recorded", () => {
    const dir = root();
    setEnv("RELAY_CONFIG_DIR", dir);
    setEnv("DO_NOT_TRACK", undefined);
    setEnv("RELAY_TELEMETRY_DISABLED", undefined);

    initializeTelemetry(dir);

    expect(existsSync(path.join(dir, "user-id"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("is disabled when consent is false", () => {
    const dir = root();
    writeFileSync(path.join(dir, "telemetry-consent"), "false");
    expect(telemetryDisabled({ RELAY_CONFIG_DIR: dir })).toBe(true);
  });

  test("is enabled when consent is true", () => {
    const dir = root();
    writeFileSync(path.join(dir, "telemetry-consent"), "true");
    expect(telemetryDisabled({ RELAY_CONFIG_DIR: dir })).toBe(false);
  });

  test("env flag overrides consent", () => {
    const dir = root();
    writeFileSync(path.join(dir, "telemetry-consent"), "true");
    expect(telemetryDisabled({ RELAY_CONFIG_DIR: dir, DO_NOT_TRACK: "1" })).toBe(true);
    expect(telemetryDisabled({ RELAY_CONFIG_DIR: dir, RELAY_TELEMETRY_DISABLED: "true" })).toBe(true);
  });

  test("is disabled when RELAY_CONFIG_DIR is not set", () => {
    expect(telemetryDisabled({})).toBe(true);
  });

  test("telemetryEnvDisabled reports only the env flags, not consent", () => {
    const dir = root();
    expect(TELEMETRY_CONSENT_REQUIRED).toBe(true);
    // No consent file: telemetry is off, but the user has not opted out by env.
    expect(telemetryEnvDisabled({ RELAY_CONFIG_DIR: dir })).toBe(false);
    expect(telemetryEnvDisabled({ DO_NOT_TRACK: "1" })).toBe(true);
    expect(telemetryEnvDisabled({ RELAY_TELEMETRY_DISABLED: "true" })).toBe(true);
    expect(telemetryEnvDisabled({ DO_NOT_TRACK: "0" })).toBe(false);
  });
});
