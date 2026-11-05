import * as path from "node:path";
import * as fs from "./platform/fs";
import { uuid } from "./platform/crypto";
import { nowMs } from "./platform/time";

const MAX_USER_ID_LENGTH = 256;
export const IDENTITY_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export function readCachedUserId(configDir: string): string | null {
  try {
    const value = fs.readFileSync(path.join(configDir, "user-id"), "utf-8").trim();
    return value.length > 0 && value.length <= MAX_USER_ID_LENGTH ? value : null;
  } catch {
    return null;
  }
}

export function cachedUserIdExists(configDir: string): boolean {
  return fs.existsSync(path.join(configDir, "user-id"));
}

export function isAnonymousUserId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

export function persistUserId(configDir: string, userId: string): void {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "user-id"), userId, "utf-8");
  } catch {
    // Telemetry identity persistence must never affect Relay execution.
  }
}

export function readOrCreateAnonymousUserId(configDir: string): string {
  const cached = readCachedUserId(configDir);
  if (cached && isAnonymousUserId(cached)) return cached;
  const userId = uuid();
  persistUserId(configDir, userId);
  return userId;
}

export function identityRecheckDue(configDir: string, currentMs: number = nowMs()): boolean {
  try {
    const value = fs.readFileSync(path.join(configDir, "user-id-last-checked"), "utf-8").trim();
    const checkedAtMs = Number(value);
    return (
      !Number.isSafeInteger(checkedAtMs) ||
      checkedAtMs < 0 ||
      checkedAtMs > currentMs ||
      currentMs - checkedAtMs >= IDENTITY_RECHECK_INTERVAL_MS
    );
  } catch {
    return true;
  }
}

export function recordIdentityCheck(configDir: string, checkedAtMs: number = nowMs()): void {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "user-id-last-checked"), String(checkedAtMs), "utf-8");
  } catch {
    // Telemetry identity persistence must never affect Relay execution.
  }
}

export function payloadVersionFromCache(configDir: string): string {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(configDir, "cache", "version-update.json"), "utf-8"));
    if (!isRecord(parsed) || typeof parsed.installedVersion !== "string") return "dev";
    const installedVersion = parsed.installedVersion.trim();
    return installedVersion && installedVersion !== "dev" ? installedVersion : "dev";
  } catch {
    return "dev";
  }
}

export const TELEMETRY_CONSENT_FILE = "telemetry-consent";

/**
 * Read persisted telemetry consent. Returns `true` (opted in), `false` (opted out),
 * or `null` (user has not been asked yet).
 */
export function readTelemetryConsent(configDir: string): boolean | null {
  try {
    const value = fs.readFileSync(path.join(configDir, TELEMETRY_CONSENT_FILE), "utf-8").trim().toLowerCase();
    if (value === "true") return true;
    if (value === "false") return false;
    return null;
  } catch {
    return null;
  }
}

/** Persist the user's telemetry consent choice. */
export function writeTelemetryConsent(configDir: string, enabled: boolean): void {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, TELEMETRY_CONSENT_FILE), String(enabled), "utf-8");
  } catch {
    // Consent persistence must never affect Relay execution.
  }
}

/** Check whether the consent file exists (i.e. the user has already been asked). */
export function telemetryConsentExists(configDir: string): boolean {
  return fs.existsSync(path.join(configDir, TELEMETRY_CONSENT_FILE));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
