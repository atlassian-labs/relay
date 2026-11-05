import * as fs from "./platform/fs";
import * as path from "node:path";
import { uuid } from "./platform/crypto";
import { currentEnv } from "./platform/env";
import {
  clearTimer,
  isoFromEpochMs,
  isoNow,
  nowMs,
  setRecurringTimer,
  setTimer,
  type TimerHandle,
} from "./platform/time";
import { getRelayLogger } from "./logging/logger";
import { VERSION } from "./version";

const ANALYTICS_URL = "https://as.atlassian.com/api/v1/batch";
const BASIC_AUTH_BLANK = "Basic QkxBTks6";
const HTTP_TIMEOUT_MS = 1_500;
const PRODUCT = "rovodev";
const SUBPRODUCT = "terminal";
// AS uses the Segment library name to classify the event source; this event is registered as client-side.
const ANALYTICS_LIBRARY_NAME = "analytics.js";
const TELEMETRY_INTERVAL_MS = 60 * 60 * 1_000;

export type TelemetryEndedReason = "normal" | "error" | "abandoned";

export interface TelemetryLaunchInfo {
  readonly agentName?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly transport?: string;
  readonly profileId?: string;
}

interface ActiveTelemetrySession {
  lastAccountedAtMs: number;
  agent: string;
}

interface PendingTelemetry {
  hours: Record<string, PendingHour>;
}

interface PendingHour {
  flushId: string;
  hour: string;
  activeSeconds: number;
  messageCount: number;
  toolCallCount: number;
  endedNormalCount: number;
  endedErrorCount: number;
  endedAbandonedCount: number;
  agents: Record<string, AgentUsage>;
  slashCommands: Record<string, number>;
}

interface AgentUsage {
  activeSeconds: number;
}

interface TrackSpec {
  action: string;
  actionSubject: string;
  attributes: Record<string, unknown>;
  messageId: string;
}

type UserIdType = "atlassianAccount" | "email";

export interface TelemetryIdentity {
  readonly userId: string | null;
  readonly userIdType: UserIdType | null;
  readonly anonymousId: string;
}

export interface TelemetryPolicy {
  readonly telemetryDisabled: (env: NodeJS.ProcessEnv) => boolean;
  readonly resolveIdentity: (configDir: string) => TelemetryIdentity;
  readonly payloadVersion: (configDir: string) => string;
}

export interface RelayTelemetry {
  startRuntime(runtimeId: string, agent: string): void;
  recordMessage(runtimeId: string): void;
  recordSessionUpdate(runtimeId: string, update: unknown): void;
  recordSlashCommand(command: string): void;
  finishRuntime(runtimeId: string, endedReason: TelemetryEndedReason): void;
  accountActiveRuntimes(): void;
  flushPending(): Promise<void>;
  dispose(): Promise<void>;
}

export class NoopTelemetry implements RelayTelemetry {
  startRuntime(_runtimeId: string, _agent: string): void {}
  recordMessage(_runtimeId: string): void {}
  recordSessionUpdate(_runtimeId: string, _update: unknown): void {}
  recordSlashCommand(_command: string): void {}
  finishRuntime(_runtimeId: string, _endedReason: TelemetryEndedReason): void {}
  accountActiveRuntimes(): void {}
  flushPending(): Promise<void> {
    return Promise.resolve();
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

export class TelemetryStateCore implements RelayTelemetry {
  private readonly sessions = new Map<string, ActiveTelemetrySession>();
  private flushTimer: TimerHandle | null = null;
  private disposed = false;

  constructor(
    private readonly configDir: string,
    private readonly policy: TelemetryPolicy,
  ) {}

  startRuntime(runtimeId: string, agent: string): void {
    if (this.disposed || this.disabled()) return;
    this.sessions.set(runtimeId, {
      lastAccountedAtMs: nowMs(),
      agent,
    });
  }

  recordMessage(runtimeId: string): void {
    if (this.disposed || this.disabled()) return;
    const agent = this.sessions.get(runtimeId)?.agent;
    if (!agent) return;
    this.mutatePending((pending) => {
      const hour = currentHour(pending);
      hour.messageCount = safeAdd(hour.messageCount, 1);
      hour.agents[agent] ??= { activeSeconds: 0 };
    });
  }

  recordSessionUpdate(runtimeId: string, update: unknown): void {
    if (!isToolCallUpdate(update)) return;
    this.recordToolCall(runtimeId);
  }

  recordSlashCommand(command: string): void {
    if (this.disposed || this.disabled()) return;
    const name = slashCommandTelemetryName(command);
    if (!name) return;
    this.mutatePending((pending) => {
      const hour = currentHour(pending);
      hour.slashCommands[name] = safeAdd(hour.slashCommands[name] ?? 0, 1);
    });
  }

  finishRuntime(runtimeId: string, endedReason: TelemetryEndedReason): void {
    if (this.disposed || this.disabled()) return;
    const session = this.sessions.get(runtimeId);
    if (!session) return;
    this.sessions.delete(runtimeId);
    this.accountDuration(session.lastAccountedAtMs, nowMs(), session.agent);
    this.mutatePending((pending) => {
      const hour = currentHour(pending);
      if (endedReason === "normal") hour.endedNormalCount = safeAdd(hour.endedNormalCount, 1);
      else if (endedReason === "error") hour.endedErrorCount = safeAdd(hour.endedErrorCount, 1);
      else hour.endedAbandonedCount = safeAdd(hour.endedAbandonedCount, 1);
    });
  }

  accountActiveRuntimes(): void {
    if (this.disposed || this.disabled()) return;
    const now = nowMs();
    for (const session of this.sessions.values()) {
      const start = session.lastAccountedAtMs;
      session.lastAccountedAtMs = now;
      this.accountDuration(start, now, session.agent);
    }
  }

  async flushPending(): Promise<void> {
    if (this.disposed) return;
    if (this.disabled()) {
      this.clearPending();
      return;
    }
    const pending = this.loadPending();
    if (!pending || !Object.values(pending.hours).some((hour) => hourHasUsage(hour))) return;
    // Match Twine: clear before posting so ambiguous failures cannot inflate usage via retries.
    this.clearPending();
    await this.emitUsageSummaries(pending);
  }

  startFlushInterval(): void {
    if (this.flushTimer || this.disposed || this.disabled()) return;
    this.flushTimer = setRecurringTimer(() => {
      this.accountActiveRuntimes();
      void this.flushPending();
    }, TELEMETRY_INTERVAL_MS);
    unrefTimer(this.flushTimer);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.flushTimer) clearTimer(this.flushTimer);
    this.flushTimer = null;
    this.sessions.clear();
  }

  private disabled(): boolean {
    return this.policy.telemetryDisabled(currentEnv());
  }

  private recordToolCall(runtimeId: string): void {
    if (this.disposed || this.disabled()) return;
    const agent = this.sessions.get(runtimeId)?.agent;
    if (!agent) return;
    this.mutatePending((pending) => {
      const hour = currentHour(pending);
      hour.toolCallCount = safeAdd(hour.toolCallCount, 1);
      hour.agents[agent] ??= { activeSeconds: 0 };
    });
  }

  private accountDuration(startMs: number, endMs: number, agent: string): void {
    if (endMs <= startMs) return;
    this.mutatePending((pending) => {
      for (const [hour, seconds] of splitDurationByHour(startMs, endMs)) {
        if (seconds <= 0) continue;
        const bucket = hourForKey(pending, hour);
        bucket.activeSeconds = safeAdd(bucket.activeSeconds, seconds);
        const agentUsage = (bucket.agents[agent] ??= { activeSeconds: 0 });
        agentUsage.activeSeconds = safeAdd(agentUsage.activeSeconds, seconds);
      }
    });
  }

  private pendingPath(): string {
    return path.join(this.configDir, "telemetry-pending.json");
  }

  private loadPending(): PendingTelemetry | null {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.pendingPath(), "utf-8"));
      return pendingFromUnknown(parsed);
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") return null;
      return null;
    }
  }

  private savePending(pending: PendingTelemetry): void {
    try {
      fs.mkdirSync(this.configDir, { recursive: true });
      fs.writeFileSync(this.pendingPath(), JSON.stringify(pending, null, 2), "utf-8");
    } catch {
      // Telemetry must never affect Relay execution.
    }
  }

  private clearPending(): void {
    try {
      fs.rmSync(this.pendingPath(), { force: true });
    } catch {
      // Telemetry must never affect Relay execution.
    }
  }

  private mutatePending(update: (pending: PendingTelemetry) => void): void {
    const pending = this.loadPending() ?? { hours: {} };
    update(pending);
    this.savePending(pending);
  }

  private async emitUsageSummaries(pending: PendingTelemetry): Promise<boolean> {
    const specs = Object.values(pending.hours)
      .filter((hour) => hourHasUsage(hour))
      .map((hour) => ({
        action: "summarized",
        actionSubject: "relay_hourly_usage",
        attributes: hourAttributes(hour),
        messageId: hour.flushId,
      })) satisfies TrackSpec[];
    if (specs.length === 0) return true;

    const batch = buildBatch(
      specs,
      this.policy.resolveIdentity(this.configDir),
      this.policy.payloadVersion(this.configDir),
    );
    const captureFile = currentEnv().RELAY_TELEMETRY_CAPTURE_FILE?.trim();
    if (captureFile) {
      return appendCapture(captureFile, batch);
    }

    const controller = new AbortController();
    const timeout = setTimer(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(ANALYTICS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: BASIC_AUTH_BLANK,
          "User-Agent": `relay-telemetry/${VERSION}`,
        },
        body: JSON.stringify(batch),
        signal: controller.signal,
      });
      if (response.ok) return true;
      getRelayLogger().debug("telemetry.emit.status", { status: response.status });
      return false;
    } catch (err) {
      getRelayLogger().debug("telemetry.emit.failed", { error: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      clearTimer(timeout);
    }
  }
}

export class TelemetryRuntime {
  private activeTelemetry: RelayTelemetry = new NoopTelemetry();

  constructor(private readonly policy: TelemetryPolicy) {}

  initialize(configDir: string): RelayTelemetry {
    if (this.policy.telemetryDisabled(currentEnv())) {
      this.activeTelemetry = new NoopTelemetry();
      return this.activeTelemetry;
    }
    const telemetry = new TelemetryStateCore(configDir, this.policy);
    telemetry.startFlushInterval();
    this.activeTelemetry = telemetry;
    getRelayLogger().info("telemetry.ready", { disabled: false });
    return telemetry;
  }

  get(): RelayTelemetry {
    return this.activeTelemetry;
  }

  flush(): Promise<void> {
    this.activeTelemetry.accountActiveRuntimes();
    return this.activeTelemetry.flushPending();
  }
}

export function telemetryRuntimeId(): string {
  return uuid();
}

export function agentLabelForLaunch(info: TelemetryLaunchInfo): string {
  const configuredName = sanitizeLabel(info.agentName ?? "");
  if (configuredName !== "unknown") return configuredName;

  const command = info.command?.trim();
  if (command) {
    const basename = path.basename(command).toLowerCase();
    const args = info.args ?? [];
    if (basename === "acli" && args[0] === "rovodev") return "Rovo Dev";
    if (basename.includes("claude")) return "Claude";
    if (basename.includes("codex")) return "Codex";
    if (basename.includes("cursor")) return "Cursor";
    if (basename.includes("alta") || args.some((arg) => arg.toLowerCase() === "alta")) return "Alta";
    return sanitizeLabel(basename);
  }

  const profile = sanitizeLabel(info.profileId ?? "");
  if (profile !== "unknown" && profile !== "default") return profile;
  if (info.transport === "websocket") return "websocket";
  return "unknown";
}

export function isToolCallUpdate(update: unknown): boolean {
  if (!isRecord(update)) return false;
  return update.sessionUpdate === "tool_call";
}

function splitDurationByHour(startMs: number, endMs: number): Array<readonly [string, number]> {
  let cursor = Math.floor(startMs / 1_000);
  const end = Math.floor(endMs / 1_000);
  const out: Array<readonly [string, number]> = [];
  while (cursor < end) {
    const hourStart = Math.floor(cursor / 3_600) * 3_600;
    const nextHour = hourStart + 3_600;
    const segmentEnd = Math.min(end, nextHour);
    const seconds = segmentEnd - cursor;
    if (seconds > 0) out.push([hourKey(hourStart), seconds]);
    cursor = segmentEnd;
  }
  return out;
}

function currentHour(pending: PendingTelemetry): PendingHour {
  return hourForKey(pending, currentHourKey());
}

function hourForKey(pending: PendingTelemetry, hour: string): PendingHour {
  return (pending.hours[hour] ??= newPendingHour(hour));
}

function newPendingHour(hour: string): PendingHour {
  return {
    flushId: uuid(),
    hour,
    activeSeconds: 0,
    messageCount: 0,
    toolCallCount: 0,
    endedNormalCount: 0,
    endedErrorCount: 0,
    endedAbandonedCount: 0,
    agents: {},
    slashCommands: {},
  };
}

function hourHasUsage(hour: PendingHour): boolean {
  return (
    hour.activeSeconds > 0 ||
    hour.messageCount > 0 ||
    hour.toolCallCount > 0 ||
    hour.endedNormalCount > 0 ||
    hour.endedErrorCount > 0 ||
    hour.endedAbandonedCount > 0 ||
    Object.values(hour.slashCommands).some((count) => count > 0)
  );
}

function hourAttributes(hour: PendingHour): Record<string, unknown> {
  const primaryAgent =
    Object.entries(hour.agents).sort((a, b) => b[1].activeSeconds - a[1].activeSeconds)[0]?.[0] ?? "unknown";
  const agentUsage = Object.entries(hour.agents).map(([agent, usage]) => ({
    agent,
    activeSeconds: usage.activeSeconds,
  }));
  const slashCommandUsage = Object.entries(hour.slashCommands)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([command, count]) => ({ command, count }));
  const slashCommandCount = slashCommandUsage.reduce((sum, command) => safeAdd(sum, command.count), 0);
  return {
    hour: hour.hour,
    activeSeconds: hour.activeSeconds,
    messageCount: hour.messageCount,
    toolCallCount: hour.toolCallCount,
    slashCommandCount,
    slashCommandUsage,
    endedNormalCount: hour.endedNormalCount,
    endedErrorCount: hour.endedErrorCount,
    endedAbandonedCount: hour.endedAbandonedCount,
    primaryAgent,
    agentUsage,
  };
}

function buildBatch(
  specs: readonly TrackSpec[],
  identity: TelemetryIdentity,
  payloadVersion: string,
): Record<string, unknown> {
  return {
    batch: specs.map((spec) => buildEvent(identity, spec, payloadVersion)),
    sentAt: timestampNow(),
  };
}

function buildEvent(identity: TelemetryIdentity, spec: TrackSpec, payloadVersion: string): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    relayVersion: payloadVersion,
    runtimeKind: "bun",
    clientSurface: "terminal",
    ...spec.attributes,
  };
  const properties: Record<string, unknown> = {
    source: "relay",
    action: spec.action,
    actionSubject: spec.actionSubject,
    attributes,
    product: PRODUCT,
    env: "prod",
    eventType: "track",
    subproduct: SUBPRODUCT,
    tenantIdType: "none",
    origin: "terminal",
  };
  if (identity.userId && identity.userIdType) properties.userIdType = identity.userIdType;

  return {
    timestamp: timestampNow(),
    integrations: {},
    event: `${spec.actionSubject} ${spec.action}`,
    type: "track",
    properties,
    context: {
      validationMode: "quiet",
      library: { name: ANALYTICS_LIBRARY_NAME, version: payloadVersion },
    },
    ...(identity.userId ? { userId: identity.userId } : { anonymousId: identity.anonymousId }),
    messageId: spec.messageId,
    _metadata: { runtime: "bun" },
  };
}

function appendCapture(filePath: string, batch: Record<string, unknown>): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(batch)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

function pendingFromUnknown(value: unknown): PendingTelemetry | null {
  if (!isRecord(value) || !isRecord(value.hours)) return null;
  const hours: Record<string, PendingHour> = {};
  for (const [key, rawHour] of Object.entries(value.hours)) {
    const hour = pendingHourFromUnknown(rawHour);
    if (hour) hours[key] = hour;
  }
  return { hours };
}

function pendingHourFromUnknown(value: unknown): PendingHour | null {
  if (!isRecord(value)) return null;
  const flushId = typeof value.flushId === "string" ? value.flushId : uuid();
  const hour = typeof value.hour === "string" ? value.hour : currentHourKey();
  const agents = agentsFromUnknown(value.agents);
  const slashCommands = slashCommandsFromUnknown(value.slashCommands);
  return {
    flushId,
    hour,
    activeSeconds: numberValue(value.activeSeconds),
    messageCount: numberValue(value.messageCount),
    toolCallCount: numberValue(value.toolCallCount),
    endedNormalCount: numberValue(value.endedNormalCount),
    endedErrorCount: numberValue(value.endedErrorCount),
    endedAbandonedCount: numberValue(value.endedAbandonedCount),
    agents,
    slashCommands,
  };
}

function agentsFromUnknown(value: unknown): Record<string, AgentUsage> {
  if (!isRecord(value)) return {};
  const agents: Record<string, AgentUsage> = {};
  for (const [agent, usage] of Object.entries(value)) {
    if (!isRecord(usage)) continue;
    agents[agent] = { activeSeconds: numberValue(usage.activeSeconds) };
  }
  return agents;
}

function slashCommandsFromUnknown(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const commands: Record<string, number> = {};
  for (const [rawCommand, rawCount] of Object.entries(value)) {
    const command = slashCommandTelemetryName(rawCommand);
    const count = numberValue(rawCount);
    if (!command || count <= 0) continue;
    commands[command] = safeAdd(commands[command] ?? 0, count);
  }
  return commands;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function safeAdd(value: number, delta: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + delta);
}

function sanitizeLabel(value: string): string {
  const cleaned = Array.from(value)
    .filter((ch) => /[a-z0-9 _.-]/i.test(ch))
    .join("")
    .slice(0, 80)
    .trim();
  return cleaned || "unknown";
}

function slashCommandTelemetryName(command: string): string | null {
  let normalized = command.trim().toLowerCase();
  if (normalized.startsWith("/")) normalized = normalized.slice(1);
  const firstToken = normalized.split(/\s+/, 1)[0] ?? "";
  const cleaned = Array.from(firstToken)
    .filter((ch) => /[a-z0-9_.:-]/i.test(ch))
    .join("")
    .slice(0, 80)
    .trim();
  return cleaned || null;
}

function timestampNow(): string {
  return isoNow();
}

function currentHourKey(): string {
  return hourKey(Math.floor(nowMs() / 1_000 / 3_600) * 3_600);
}

function hourKey(hourStartEpochSeconds: number): string {
  const iso = isoFromEpochMs(hourStartEpochSeconds * 1_000);
  return `${iso.slice(0, 13)}:00:00Z`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function unrefTimer(timer: TimerHandle): void {
  const maybeTimer = timer as { unref?: () => void };
  maybeTimer.unref?.();
}
