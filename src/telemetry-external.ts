import { currentEnv } from "./platform/env";
import {
  TelemetryRuntime,
  TelemetryStateCore,
  type RelayTelemetry,
  type TelemetryIdentity,
  type TelemetryPolicy,
} from "./telemetry-core";
import { readOrCreateAnonymousUserId, readTelemetryConsent } from "./telemetry-storage";
import { VERSION } from "./version";

export * from "./telemetry-core";

/**
 * External builds never send telemetry until the user has made an explicit
 * consent decision, so the first-run consent prompt applies to them only.
 */
export const TELEMETRY_CONSENT_REQUIRED = true;

/**
 * True when an environment flag explicitly disables telemetry. Such a user has
 * already opted out, so the consent prompt is skipped entirely.
 */
export function telemetryEnvDisabled(env: NodeJS.ProcessEnv = currentEnv()): boolean {
  return envFlagEnabled(env.DO_NOT_TRACK) || envFlagEnabled(env.RELAY_TELEMETRY_DISABLED);
}

/**
 * Telemetry is disabled when:
 * 1. An environment flag explicitly disables it (DO_NOT_TRACK, RELAY_TELEMETRY_DISABLED), OR
 * 2. The user has not consented (consent file is missing or set to false).
 *
 * The consent file (`~/.config/relay/telemetry-consent`) is the single source
 * of truth. The config setting (`telemetry.analytics_enabled`) is a UI
 * convenience: changing it via `/settings` or manually editing `config.toml`
 * syncs to the consent file on startup and when toggled via the settings API.
 *
 * This ensures GDPR-compliant default-off behavior: telemetry only runs when
 * the user has taken an explicit affirmative action to enable it.
 */
export function telemetryDisabled(env: NodeJS.ProcessEnv = currentEnv()): boolean {
  if (telemetryEnvDisabled(env)) return true;
  // Consent-based: disabled unless the user has explicitly opted in.
  const configDir = env.RELAY_CONFIG_DIR;
  if (!configDir) return true;
  return readTelemetryConsent(configDir) !== true;
}

export function resolveExternalIdentity(configDir: string): TelemetryIdentity {
  return {
    userId: null,
    userIdType: null,
    anonymousId: readOrCreateAnonymousUserId(configDir),
  };
}

const externalPolicy: TelemetryPolicy = {
  telemetryDisabled,
  resolveIdentity: resolveExternalIdentity,
  payloadVersion: () => VERSION,
};

const runtime = new TelemetryRuntime(externalPolicy);

export class TelemetryState extends TelemetryStateCore {
  constructor(configDir: string) {
    super(configDir, externalPolicy);
  }
}

export function initializeTelemetry(configDir: string): RelayTelemetry {
  return runtime.initialize(configDir);
}

export function getTelemetry(): RelayTelemetry {
  return runtime.get();
}

export function flushTelemetry(): Promise<void> {
  return runtime.flush();
}

function envFlagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
