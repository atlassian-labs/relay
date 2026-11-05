import * as path from "node:path";
import { appendFileSync, mkdirSync } from "../platform/fs";
import { currentEnv } from "../platform/env";
import { isoNow } from "../platform/time";

export type RelayLogLevel = "error" | "warn" | "info" | "debug" | "trace";

const LEVELS: Record<RelayLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

const SENSITIVE_KEY_PATTERN = /(?:token|secret|password|authorization|cookie|api[_-]?key|access[_-]?key)/i;
const MAX_STRING_LENGTH = 2_000;

export interface RelayLogger {
  readonly path: string | null;
  readonly level: RelayLogLevel;
  setLevel(level: RelayLogLevel): void;
  enabled(level: RelayLogLevel): boolean;
  error(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  debug(event: string, data?: Record<string, unknown>): void;
  trace(event: string, data?: Record<string, unknown>): void;
  close(): Promise<void>;
}

type LogEntry = {
  readonly ts: string;
  readonly level: RelayLogLevel;
  readonly event: string;
  readonly data?: unknown;
};

class NoopRelayLogger implements RelayLogger {
  readonly path = null;
  level: RelayLogLevel = "error";

  setLevel(level: RelayLogLevel): void {
    this.level = level;
  }

  enabled(_level: RelayLogLevel): boolean {
    return false;
  }

  error(_event: string, _data?: Record<string, unknown>): void {}
  warn(_event: string, _data?: Record<string, unknown>): void {}
  info(_event: string, _data?: Record<string, unknown>): void {}
  debug(_event: string, _data?: Record<string, unknown>): void {}
  trace(_event: string, _data?: Record<string, unknown>): void {}

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class JsonlRelayLogger implements RelayLogger {
  private closed = false;

  constructor(
    readonly path: string,
    public level: RelayLogLevel,
  ) {}

  setLevel(level: RelayLogLevel): void {
    this.level = level;
  }

  enabled(level: RelayLogLevel): boolean {
    return LEVELS[level] <= LEVELS[this.level];
  }

  error(event: string, data?: Record<string, unknown>): void {
    this.write("error", event, data);
  }

  warn(event: string, data?: Record<string, unknown>): void {
    this.write("warn", event, data);
  }

  info(event: string, data?: Record<string, unknown>): void {
    this.write("info", event, data);
  }

  debug(event: string, data?: Record<string, unknown>): void {
    this.write("debug", event, data);
  }

  trace(event: string, data?: Record<string, unknown>): void {
    this.write("trace", event, data);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return Promise.resolve();
  }

  private write(level: RelayLogLevel, event: string, data?: Record<string, unknown>): void {
    if (this.closed || !this.enabled(level)) return;
    const entry: LogEntry = {
      ts: isoNow(),
      level,
      event,
      ...(data === undefined ? {} : { data: sanitizeForLog(data) }),
    };
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch {
      // Logging must never affect Relay execution.
    }
  }
}

let activeLogger: RelayLogger = new NoopRelayLogger();

export function parseRelayLogLevel(value: unknown): RelayLogLevel | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized in LEVELS ? (normalized as RelayLogLevel) : null;
}

export function relayLogLevelFromEnv(): RelayLogLevel | null {
  return parseRelayLogLevel(currentEnv().RELAY_LOG);
}

export function initializeRelayLogger(options: {
  readonly configDir: string;
  readonly level?: RelayLogLevel;
}): RelayLogger {
  const logsDir = path.join(options.configDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const stamp = isoNow().replace(/[:.]/g, "-");
  const logger = new JsonlRelayLogger(path.join(logsDir, `relay-${stamp}.ndjson`), options.level ?? "info");
  activeLogger = logger;
  logger.info("logging.ready", { path: logger.path, level: logger.level });
  return logger;
}

export function getRelayLogger(): RelayLogger {
  return activeLogger;
}

export function getRelayLogPath(): string | null {
  return activeLogger.path;
}

export function setRelayLogLevel(level: RelayLogLevel): void {
  activeLogger.setLevel(level);
}

export function sanitizeForLog(value: unknown): unknown {
  return sanitize(value, new WeakSet<object>(), undefined);
}

function sanitize(value: unknown, seen: WeakSet<object>, key: string | undefined): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]` : value;
  }
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen, undefined));

  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] = sanitize(entryValue, seen, entryKey);
  }
  return output;
}
