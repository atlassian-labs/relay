import * as path from "node:path";
import { nextEventLoopTurn, nowMs } from "../platform/time";
import { agentLabelForLaunch, getTelemetry, telemetryRuntimeId, type TelemetryEndedReason } from "../telemetry";

import { Duration, Effect, Fiber } from "effect";

import * as acp from "./sdk";
import { primaryStartupErrorFromStderr } from "./startup-error";
import {
  resolveActiveTurnInputAdapter,
  type ActiveTurnInputAdapter,
  type ActiveTurnInputResult,
} from "./active-turn-input";
import type { AgentBehaviorProfile } from "./agent-profile";
import { defaultAgentBehaviorProfile } from "./profiles/default";
import { ApprovalResponse, type ApprovalOption, type ApprovalSelection } from "../core/events";
import { isPromptSubmission, promptInputText, type PromptInput } from "../core/prompt-submission";
import type { ThinkingLevel } from "../core/thinking";
import type { FileChanges, Usage } from "../core/types";
import {
  AcpClientNotConnectedError,
  AcpProtocolError,
  AcpNoActiveSessionError,
  AcpRequestError,
  RelayError,
  errorMessage,
} from "../effect/errors";
import { runEffect } from "../effect/runtime";
import { getRelayLogPath, getRelayLogger } from "../logging/logger";
import { ACP_CLIENT_VERSION } from "../version";
import type { CommandDescriptor } from "../core/commands";
import type { ElicitationSchema } from "../core/conversation";
import {
  agentLifecycleCapabilitiesForInitializeResult,
  authMethodsForInitializeResult,
  relayClientCapabilities,
  supportsAuthLogoutForInitializeResult,
  supportsImagePromptsForInitializeResult,
  type RelayAuthMethod,
} from "./capabilities";
import { buildPromptContent } from "./prompt-content";
import { createAcpTransport } from "./transport";
import type { AcpLaunchOptions, AcpProcessExitEvent, AcpTransport, AcpTransportConnection } from "./transport";

export type { AcpLaunchOptions, AcpProcessExitEvent } from "./transport";

export interface AcpClientOptions extends AcpLaunchOptions {
  readonly agentBehaviorProfile?: AgentBehaviorProfile;
  readonly agentName?: string;
}

export interface AcpSessionInfo {
  readonly sessionId: string;
  readonly title?: string;
  readonly updatedAt?: string | null;
  readonly cwd?: string;
  readonly additionalDirectories?: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
}

export interface AcpSessionResult {
  readonly sessionId?: string;
  readonly configOptions?: unknown;
  readonly modes?: unknown;
  readonly models?: unknown;
  readonly availableCommands?: CommandDescriptor[];
}

export interface LoadSessionHistoryOptions {
  /** Called once with the replayed history if it goes quiet before the load response arrives. The final result's
   * `updates` always starts with exactly these updates. */
  readonly onHistoryReady?: (updates: readonly acp.RelaySessionUpdate[]) => void;
}

export interface AcpLoadedSessionHistory {
  readonly result: AcpSessionResult;
  readonly updates: readonly acp.RelaySessionUpdate[];
}

export interface AcpSessionUpdateEnvelope {
  readonly sessionId?: string;
  readonly metadata?: Record<string, unknown>;
}

export type AcpCapturedSessionUpdateHandler = (
  update: acp.RelaySessionUpdate,
  envelope: AcpSessionUpdateEnvelope,
) => void;

type LoadingSessionHistoryUpdate = {
  readonly update: acp.RelaySessionUpdate;
  readonly envelope: AcpSessionUpdateEnvelope;
};

type LoadingSessionHistory = {
  readonly updates: LoadingSessionHistoryUpdate[];
  readonly sessionIds: Set<string>;
};

type AvailableCommandsSnapshot = {
  readonly commands: CommandDescriptor[];
  readonly sessionId?: string;
  readonly version: number;
};

type PendingAvailableCommandsSnapshot = Omit<AvailableCommandsSnapshot, "version"> & {
  readonly update: acp.RelaySessionUpdate;
  readonly envelope: AcpSessionUpdateEnvelope;
};

export type AcpActiveTurnInputResult = ActiveTurnInputResult;

const ACP_AUTH_REQUIRED_CODE = -32000;

export function isAcpAuthRequiredError(error: unknown): boolean {
  return (
    error instanceof AcpRequestError &&
    error.code === ACP_AUTH_REQUIRED_CODE &&
    /auth(?:entication)?\s+required/i.test(error.message)
  );
}

export interface AcpToolApprovalRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly preview?: string;
  readonly options: readonly ApprovalOption[];
  readonly respond: (response: ApprovalSelection) => void;
}

export type AcpElicitationResponse =
  | { readonly action: "accept"; readonly content: Record<string, unknown> }
  | { readonly action: "decline" }
  | { readonly action: "cancel" };

export interface AcpElicitationRequest {
  readonly mode: "form" | "url";
  readonly message: string;
  readonly requestedSchema?: ElicitationSchema;
  readonly url?: string;
  readonly elicitationId?: string;
  readonly toolCallId?: string;
  readonly respond: (response: AcpElicitationResponse) => void;
}

export interface AcpToolState {
  readonly toolCallId: string;
  readonly title: string;
  readonly kind?: string;
  readonly status?: string;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly content?: unknown;
  readonly locations?: ReadonlyArray<{
    readonly path?: string;
    readonly line?: number;
    readonly startLine?: number;
    readonly endLine?: number;
  }>;
}

export interface AcpClientCallbacks {
  readonly onSessionUpdate: (update: acp.RelaySessionUpdate, envelope?: AcpSessionUpdateEnvelope) => void;
  readonly onPermissionRequest: (request: AcpToolApprovalRequest) => void;
  readonly onElicitationRequest?: (request: AcpElicitationRequest) => void;
  readonly onAvailableCommands?: (commands: CommandDescriptor[]) => void;
  readonly onProcessExit?: (event: AcpProcessExitEvent) => void;
}

const PATH_SCALAR_KEYS = new Set([
  "path",
  "file",
  "file_path",
  "filepath",
  "filename",
  "folder_path",
  "new_path",
  "source",
  "target",
  "destination",
  "target_file",
  "source_file",
]);
const PATH_ARRAY_KEYS = new Set(["paths", "file_paths", "filepaths", "files"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RelayError };

function valid<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function invalid(message: string): ValidationResult<never> {
  return { ok: false, error: new RelayError({ message }) };
}

function validationEffect<T>(result: ValidationResult<T>): Effect.Effect<T, RelayError> {
  return result.ok ? Effect.succeed(result.value) : Effect.fail(result.error);
}

function stringArray(value: unknown): ValidationResult<string[]> {
  if (value === undefined || value === null) return valid([]);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return invalid("Invalid ACP MCP server args; expected an array of strings");
  }
  return valid([...value]);
}

function envVariables(value: unknown): ValidationResult<Array<{ readonly name: string; readonly value: string }>> {
  if (value === undefined || value === null) return valid([]);
  if (Array.isArray(value)) {
    const entries: Array<{ readonly name: string; readonly value: string }> = [];
    for (const entry of value) {
      if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.value !== "string") {
        return invalid("Invalid ACP MCP server env; expected name/value entries");
      }
      entries.push({ name: entry.name, value: entry.value });
    }
    return valid(entries);
  }
  if (isRecord(value)) {
    const entries: Array<{ readonly name: string; readonly value: string }> = [];
    for (const [name, entryValue] of Object.entries(value)) {
      if (typeof entryValue !== "string") {
        return invalid("Invalid ACP MCP server env; expected string values");
      }
      entries.push({ name, value: entryValue });
    }
    return valid(entries);
  }
  return invalid("Invalid ACP MCP server env; expected an object or name/value entries");
}

function httpHeaders(value: unknown): ValidationResult<Array<{ readonly name: string; readonly value: string }>> {
  if (value === undefined || value === null) return valid([]);
  if (!Array.isArray(value)) {
    return invalid("Invalid ACP MCP server headers; expected name/value entries");
  }
  const entries: Array<{ readonly name: string; readonly value: string }> = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.value !== "string") {
      return invalid("Invalid ACP MCP server headers; expected name/value entries");
    }
    entries.push({ name: entry.name, value: entry.value });
  }
  return valid(entries);
}

function acpMcpServer(value: unknown): ValidationResult<acp.McpServer> {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) {
    return invalid("Invalid ACP MCP server; expected a named server object");
  }

  const meta = isRecord(value._meta) ? { _meta: value._meta } : {};
  if (typeof value.command === "string") {
    const args = stringArray(value.args);
    if (!args.ok) return args;
    const env = envVariables(value.env);
    if (!env.ok) return env;
    return valid({
      name: value.name,
      command: value.command,
      args: args.value,
      env: env.value,
      ...meta,
    });
  }

  if ((value.type === "http" || value.type === "sse") && typeof value.url === "string") {
    const headers = httpHeaders(value.headers);
    if (!headers.ok) return headers;
    return valid({
      type: value.type,
      name: value.name,
      url: value.url,
      headers: headers.value,
      ...meta,
    });
  }

  const serverId = typeof value.serverId === "string" ? value.serverId : value.id;
  if (value.type === "acp" && typeof serverId === "string") {
    return valid({ type: "acp", name: value.name, serverId, ...meta });
  }

  return invalid(`Invalid ACP MCP server "${value.name}"; expected stdio command, http/sse url, or acp server id`);
}

function acpMcpServers(values: readonly unknown[]): ValidationResult<acp.McpServer[]> {
  const servers: acp.McpServer[] = [];
  for (const value of values) {
    const server = acpMcpServer(value);
    if (!server.ok) return server;
    servers.push(server.value);
  }
  return valid(servers);
}

function jsonString(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toDisplayPath(value: string, cwd?: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;

  if (cwd && path.isAbsolute(trimmed)) {
    const relative = path.relative(cwd, trimmed);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative || ".";
  }

  return trimmed;
}

function normalizeToolValue(value: unknown, key?: string, cwd?: string): unknown {
  if (typeof value === "string")
    return key && PATH_SCALAR_KEYS.has(key.toLowerCase()) ? toDisplayPath(value, cwd) : value;
  if (Array.isArray(value)) {
    if (key && PATH_ARRAY_KEYS.has(key.toLowerCase())) {
      return value.map((item) => (typeof item === "string" ? toDisplayPath(item, cwd) : item));
    }
    return value.map((item) => normalizeToolValue(item, undefined, cwd));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, normalizeToolValue(entryValue, entryKey, cwd)]),
    );
  }
  return value;
}

const STDERR_EDGE_LINES = 25;
const SESSION_HISTORY_REPLAY_COMPATIBILITY_QUIET_MS = 75;
const SESSION_HISTORY_REPLAY_COMPATIBILITY_MAX_MS = 1_000;
const SESSION_HISTORY_REPLAY_POLL_MS = 5;
const AVAILABLE_COMMANDS_SNAPSHOT_LIMIT = 20;

function stripStderrControls(raw: string): string {
  return (
    raw
      // oxlint-disable-next-line no-control-regex
      .replace(/\x1B(?:\][^\x07]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g, "")
      // oxlint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
  );
}

export function summarizeStderr(raw: string): string {
  const trimmed = stripStderrControls(raw).trim();
  if (!trimmed) return "";
  const lines = trimmed.split(/\r?\n/u);
  const visibleLineLimit = STDERR_EDGE_LINES * 2;
  if (lines.length <= visibleLineLimit) return lines.join("\n");

  const hiddenLineCount = lines.length - visibleLineLimit;
  return [
    ...lines.slice(0, STDERR_EDGE_LINES),
    `... ${hiddenLineCount} ${hiddenLineCount === 1 ? "line" : "lines"} hidden ...`,
    ...lines.slice(-STDERR_EDGE_LINES),
  ].join("\n");
}

export { primaryStartupErrorFromStderr } from "./startup-error";

export function formatToolArgs(input?: unknown, cwd?: string): string {
  if (input === undefined || input === null) return "";
  const normalized = normalizeToolValue(input, undefined, cwd);
  if (!isRecord(normalized)) return jsonString(normalized);
  const entries = Object.entries(normalized);
  if (entries.length === 0) return "";
  return entries.map(([key, value]) => `${key}: ${typeof value === "string" ? value : jsonString(value)}`).join("\n");
}

function inlineToolValue(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return jsonString(value).replace(/\n\s*/g, " ");
}

function formatRecordToolOutput(record: Record<string, unknown>): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return "{}";
  return entries.map(([key, value]) => `${key}: ${inlineToolValue(value)}`).join("\n");
}

export function formatToolOutput(output?: unknown, cwd?: string): string {
  if (output === undefined || output === null) return "";
  const normalized = normalizeToolValue(output, undefined, cwd);
  if (typeof normalized === "string") return normalized;
  if (isRecord(normalized)) {
    for (const key of ["text", "message", "result", "output", "content"] as const) {
      if (typeof normalized[key] === "string") return normalized[key];
    }

    const stdout = typeof normalized.stdout === "string" ? normalized.stdout : "";
    const stderr = typeof normalized.stderr === "string" ? normalized.stderr : "";
    if (stdout.trim() || stderr.trim()) return [stdout, stderr].filter((text) => text.trim()).join("\n");

    return formatRecordToolOutput(normalized);
  }
  return jsonString(normalized);
}

export function formatToolPreview(toolName: string, input?: unknown, cwd?: string): string {
  const payload = formatToolArgs(input, cwd);
  return payload ? `${toolName}\n${payload}` : toolName;
}

export function acpStatusToToolStatus(status?: string): "pending" | "running" | "success" | "error" | "approval" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "in_progress":
      return "running";
    case "pending":
    case undefined:
    default:
      return "pending";
  }
}

export function tryExtractFileChanges(_toolName: string, _rawOutput: unknown): FileChanges | undefined {
  return undefined;
}

function numberFromKeys(record: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value !== 0) return value;
  }
  return 0;
}

function usageFromRecord(value: Record<string, unknown>): Usage | null {
  const usage = {
    input_tokens: numberFromKeys(value, ["inputTokens", "input_tokens"]),
    output_tokens: numberFromKeys(value, ["outputTokens", "output_tokens"]),
    cache_read_tokens: numberFromKeys(value, ["cachedReadTokens", "cache_read_tokens", "cachedInputTokens"]),
    cache_write_tokens: numberFromKeys(value, ["cachedWriteTokens", "cache_write_tokens", "cacheCreationInputTokens"]),
  };
  return usage.input_tokens > 0 ||
    usage.output_tokens > 0 ||
    usage.cache_read_tokens > 0 ||
    usage.cache_write_tokens > 0
    ? usage
    : null;
}

export function usageFromAcp(value: unknown): Usage | null {
  if (!isRecord(value)) return null;
  // Spec usage is top-level on PromptResponse; Alta temporarily emitted it under _meta.usage.
  const meta = isRecord(value._meta) ? value._meta : null;
  return (
    usageFromRecord(value) ??
    (isRecord(value.usage) ? usageFromRecord(value.usage) : null) ??
    (meta && isRecord(meta.usage) ? usageFromRecord(meta.usage) : null)
  );
}

export function formatSlashCommands(commands: unknown): CommandDescriptor[] {
  if (!Array.isArray(commands)) return [];
  return commands.flatMap((item): CommandDescriptor[] => {
    if (!isRecord(item)) return [];
    const nameRaw = typeof item.name === "string" ? item.name : "";
    const name = nameRaw.startsWith("/") ? nameRaw.slice(1) : nameRaw;
    if (!name) return [];
    return [
      {
        name,
        description: typeof item.description === "string" ? item.description : "",
        origin: "agent",
        kind: "unknown",
        invocation: { syntax: "slash", composable: false },
        ...(Object.prototype.hasOwnProperty.call(item, "input") ? { input: item.input } : {}),
        ...(isRecord(item._meta) ? { meta: item._meta } : isRecord(item.meta) ? { meta: item.meta } : {}),
      },
    ];
  });
}

function commandsFromAvailableCommandsUpdate(update: acp.RelaySessionUpdate): CommandDescriptor[] | null {
  if (update.sessionUpdate !== "available_commands_update") return null;
  return formatSlashCommands(update.availableCommands);
}

export function latestAvailableCommandsFromUpdates(
  updates: readonly acp.RelaySessionUpdate[],
): CommandDescriptor[] | null {
  for (let index = updates.length - 1; index >= 0; index -= 1) {
    const commands = commandsFromAvailableCommandsUpdate(updates[index]);
    if (commands) return commands;
  }
  return null;
}

function sessionResult(value: unknown): AcpSessionResult {
  if (!isRecord(value)) return {};
  const hasAvailableCommands = Object.prototype.hasOwnProperty.call(value, "availableCommands");
  const availableCommands = formatSlashCommands(value.availableCommands);
  return {
    sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
    configOptions: value.configOptions,
    modes: value.modes,
    models: value.models,
    availableCommands: hasAvailableCommands ? availableCommands : undefined,
  };
}

function isElicitationSchema(value: unknown): value is ElicitationSchema {
  return isRecord(value) && value.type === "object";
}

type ElicitationContentValue = string | number | boolean | string[];

function elicitationContentValue(value: unknown): ElicitationContentValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return [...value];
  return String(value ?? "");
}

function sdkElicitationResponse(response: AcpElicitationResponse): acp.CreateElicitationResponse {
  if (response.action !== "accept") return response;
  return {
    action: "accept",
    content: Object.fromEntries(
      Object.entries(response.content).map(([key, value]) => [key, elicitationContentValue(value)]),
    ),
  };
}

function approvalOption(value: unknown): ApprovalOption | undefined {
  if (!isRecord(value) || typeof value.optionId !== "string") return undefined;
  return {
    optionId: value.optionId,
    name: typeof value.name === "string" && value.name.trim() ? value.name : value.optionId,
    kind: typeof value.kind === "string" ? value.kind : undefined,
  };
}

function approvalOptions(value: unknown): ApprovalOption[] {
  if (!Array.isArray(value)) return [];
  return value.map(approvalOption).filter((option): option is ApprovalOption => option !== undefined);
}

function selectedPermissionOptionId(options: readonly ApprovalOption[], response: ApprovalSelection): string | null {
  if (typeof response !== "string") {
    return options.some((option) => option.optionId === response.optionId) ? response.optionId : null;
  }
  const desiredPrefix = response === ApprovalResponse.APPROVE ? "allow" : "reject";
  return options.find((option) => (option.kind ?? option.optionId).startsWith(desiredPrefix))?.optionId ?? null;
}

function sessionInfo(value: unknown): AcpSessionInfo | undefined {
  if (!isRecord(value) || typeof value.sessionId !== "string") return undefined;
  const metadata = isRecord(value.metadata) ? value.metadata : undefined;
  const meta = isRecord(value._meta) ? value._meta : undefined;
  const additionalDirectories = sessionAdditionalDirectories(value.additionalDirectories);
  return {
    sessionId: value.sessionId,
    title: typeof value.title === "string" ? value.title : undefined,
    updatedAt: typeof value.updatedAt === "string" || value.updatedAt === null ? value.updatedAt : undefined,
    cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
    ...(metadata ? { metadata: { ...metadata } } : {}),
    ...(meta ? { _meta: { ...meta } } : {}),
  };
}

function sessionAdditionalDirectories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((directory): directory is string => typeof directory === "string" && path.isAbsolute(directory));
}

function requestAdditionalDirectories(cwd: string, directories: readonly string[] | undefined): string[] {
  if (!directories || directories.length === 0) return [];
  const seen = new Set([path.resolve(cwd)]);
  const result: string[] = [];
  for (const directory of directories) {
    const resolved = path.resolve(directory);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function listSessionsResponseSessions(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.sessions)) return value.sessions;
  return [];
}

function listSessionsResponseNextCursor(value: unknown): string | null {
  if (!isRecord(value) || typeof value.nextCursor !== "string") return null;
  return value.nextCursor.length > 0 ? value.nextCursor : null;
}

function waitForSessionHistoryReplayToSettle(loading: LoadingSessionHistory): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const startedAt = nowMs();
    let lastUpdateCount = loading.updates.length;
    let quietSince = startedAt;

    while (nowMs() - startedAt < SESSION_HISTORY_REPLAY_COMPATIBILITY_MAX_MS) {
      yield* Effect.sleep(Duration.millis(SESSION_HISTORY_REPLAY_POLL_MS));

      const currentTime = nowMs();
      if (loading.updates.length !== lastUpdateCount) {
        lastUpdateCount = loading.updates.length;
        quietSince = currentTime;
        continue;
      }
      if (currentTime - quietSince >= SESSION_HISTORY_REPLAY_COMPATIBILITY_QUIET_MS) return;
    }
  });
}

// Agents may stream stored history long before the load response (e.g. while MCP servers connect). Resolve once
// history has arrived and gone quiet, as long as every update so far belongs to the requested session. Returns the
// checked updates, snapshotted in the same step as the check so nothing unchecked can slip in between.
function waitForEarlySessionHistory(loading: LoadingSessionHistory): Effect.Effect<acp.RelaySessionUpdate[], never> {
  return Effect.gen(function* () {
    let lastUpdateCount = 0;
    let quietSince = nowMs();
    let hasTranscriptRow = false;
    while (true) {
      yield* Effect.sleep(Duration.millis(SESSION_HISTORY_REPLAY_POLL_MS));
      const count = loading.updates.length;
      if (count !== lastUpdateCount) {
        // Agents publish commands up front; wait for actual transcript rows. Only the new updates need checking.
        for (let i = lastUpdateCount; i < count && !hasTranscriptRow; i++) {
          hasTranscriptRow = loading.updates[i].update.sessionUpdate !== "available_commands_update";
        }
        lastUpdateCount = count;
        quietSince = nowMs();
      } else if (hasTranscriptRow && nowMs() - quietSince >= SESSION_HISTORY_REPLAY_COMPATIBILITY_QUIET_MS) {
        if (
          loading.updates.every(({ envelope }) => !envelope.sessionId || loading.sessionIds.has(envelope.sessionId))
        ) {
          return loading.updates.map((entry) => entry.update);
        }
        return yield* Effect.never;
      }
    }
  });
}

function connected(connection: acp.ClientSideConnection | null, operation: string) {
  return connection ? Effect.succeed(connection) : Effect.fail(new AcpClientNotConnectedError({ operation }));
}

function activeSession(currentSessionId: string | null, providedSessionId: string | undefined, operation: string) {
  const sessionId = providedSessionId ?? currentSessionId;
  return sessionId ? Effect.succeed(sessionId) : Effect.fail(new AcpNoActiveSessionError({ operation }));
}

function newSessionRequest(
  cwd: string,
  mcpServers: readonly acp.McpServer[],
  metadata?: Record<string, unknown>,
  additionalDirectories: readonly string[] = [],
): acp.RelayNewSessionRequest {
  return {
    cwd,
    ...(additionalDirectories.length > 0 ? { additionalDirectories: [...additionalDirectories] } : {}),
    mcpServers: [...mcpServers],
    ...(metadata ? { metadata, _meta: metadata } : {}),
  };
}

function loadSessionRequest(
  sessionId: string,
  cwd: string,
  mcpServers: readonly acp.McpServer[],
  additionalDirectories: readonly string[] = [],
): acp.RelayLoadSessionRequest {
  return {
    sessionId,
    cwd,
    ...(additionalDirectories.length > 0 ? { additionalDirectories: [...additionalDirectories] } : {}),
    mcpServers: [...mcpServers],
  };
}

function resumeSessionRequest(
  sessionId: string,
  cwd: string,
  mcpServers: readonly acp.McpServer[],
  additionalDirectories: readonly string[] = [],
): acp.ResumeSessionRequest {
  return {
    sessionId,
    cwd,
    ...(additionalDirectories.length > 0 ? { additionalDirectories: [...additionalDirectories] } : {}),
    mcpServers: [...mcpServers],
  };
}

function forkSessionRequest(
  sessionId: string,
  cwd: string,
  mcpServers: readonly acp.McpServer[],
  metadata?: Record<string, unknown>,
  additionalDirectories: readonly string[] = [],
): acp.RelayForkSessionRequest {
  return {
    sessionId,
    cwd,
    ...(additionalDirectories.length > 0 ? { additionalDirectories: [...additionalDirectories] } : {}),
    mcpServers: [...mcpServers],
    ...(metadata ? { metadata, _meta: metadata } : {}),
  };
}

function promptRequest(
  sessionId: string,
  prompt: acp.PromptRequest["prompt"],
  metadata?: Record<string, unknown>,
): acp.RelayPromptRequest {
  return {
    sessionId,
    prompt,
    ...(metadata ? { metadata, _meta: metadata } : {}),
  };
}

function stringConfigOptionRequest(
  sessionId: string,
  configId: string,
  value: string,
): acp.SetSessionConfigOptionRequest {
  return { sessionId, configId, value };
}

function updateSessionId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = value.sessionId ?? value.session_id;
  return typeof sessionId === "string" ? sessionId : undefined;
}

function endedReasonForProcessExit(event: AcpProcessExitEvent): TelemetryEndedReason {
  if (event.expected || event.reason === "dispose") return "normal";
  if (event.reason === "error") return "error";
  if (typeof event.code === "number" && event.code !== 0) return "error";
  return "abandoned";
}

function unsupportedProtocolVersionError(agentProtocolVersion: number): AcpProtocolError {
  return new AcpProtocolError({
    message: `Unsupported ACP protocol version ${agentProtocolVersion}; Relay supports ${acp.PROTOCOL_VERSION}`,
  });
}

export class AcpClient {
  private connection: acp.ClientSideConnection | null = null;
  private transportConnection: AcpTransportConnection | null = null;
  private currentSessionId: string | null = null;
  private activeTurnInputAdapter: ActiveTurnInputAdapter | null = null;
  private sessionLoadSupported = false;
  private sessionListSupported = false;
  private sessionDeleteSupported = false;
  private sessionForkSupported = false;
  private sessionResumeSupported = false;
  private sessionCloseSupported = false;
  private additionalDirectoriesSupported = false;
  private sessionListProvidedByProfile = false;
  private sessionForkProvidedByProfile = false;
  private supportsImagePrompts = false;
  private authMethodsAvailable: RelayAuthMethod[] = [];
  private authLogoutSupported = false;
  private initialized = false;
  private disposed = false;
  private readonly pendingInteractions = new Set<() => void>();
  private readonly callbacks: AcpClientCallbacks;
  private readonly workspaceCwd: string;
  private readonly agentBehaviorProfile: AgentBehaviorProfile;
  private readonly mcpServersResult: ValidationResult<readonly acp.McpServer[]>;
  private readonly sessionCwd: string;
  private readonly agentCommand: string | undefined;
  private readonly agentArgs: readonly string[];
  private readonly agentEnv: Readonly<Record<string, string>> | undefined;
  private readonly transport: AcpTransport;
  private readonly telemetryRuntimeId = telemetryRuntimeId();
  private readonly telemetryAgent: string;
  private telemetryStarted = false;
  private loadingSessionHistory: LoadingSessionHistory | null = null;
  private pendingAvailableCommands: PendingAvailableCommandsSnapshot[] | null = null;
  private availableCommandsVersion = 0;
  private latestAvailableCommands: AvailableCommandsSnapshot | null = null;
  private readonly availableCommandsSnapshots: AvailableCommandsSnapshot[] = [];
  private readonly capturedSessionUpdateHandlers = new Map<string, Set<AcpCapturedSessionUpdateHandler>>();

  constructor(callbacks: AcpClientCallbacks, opts: AcpClientOptions) {
    this.callbacks = callbacks;
    this.workspaceCwd = opts.cwd;
    this.agentBehaviorProfile = opts.agentBehaviorProfile ?? defaultAgentBehaviorProfile;
    this.sessionCwd = opts.cwd;
    this.agentCommand = opts.command;
    this.agentArgs = opts.args ?? [];
    this.agentEnv = opts.env;
    this.mcpServersResult = acpMcpServers(opts.mcpServers ?? []);
    this.transport = createAcpTransport(opts, { onProcessExit: (event) => this.handleProcessExit(event) });
    this.telemetryAgent = agentLabelForLaunch({
      agentName: opts.agentName,
      command: opts.command,
      args: opts.args,
      transport: this.transport.kind,
      profileId: this.agentBehaviorProfile.id,
    });
    getRelayLogger().info("acp.client.create", {
      cwd: this.workspaceCwd,
      transport: this.transport.kind,
      command: opts.command ? path.basename(opts.command) : "",
      argCount: opts.args?.length ?? 0,
      behaviorProfile: this.agentBehaviorProfile.id,
    });
  }

  private resetLifecycleCapabilities(): void {
    this.sessionLoadSupported = false;
    this.sessionListSupported = false;
    this.sessionDeleteSupported = false;
    this.sessionForkSupported = false;
    this.sessionResumeSupported = false;
    this.sessionCloseSupported = false;
    this.additionalDirectoriesSupported = false;
    this.sessionListProvidedByProfile = false;
    this.sessionForkProvidedByProfile = false;
    this.supportsImagePrompts = false;
    this.authMethodsAvailable = [];
    this.authLogoutSupported = false;
  }

  private handleProcessExit(event: AcpProcessExitEvent): void {
    const connected = this.initialized && !this.disposed;
    this.finishTelemetryRuntime(endedReasonForProcessExit(event));
    this.initialized = false;
    this.resetLifecycleCapabilities();
    this.callbacks.onProcessExit?.({ ...event, connected });
  }

  private startTelemetryRuntime(): void {
    if (this.telemetryStarted) return;
    this.telemetryStarted = true;
    getTelemetry().startRuntime(this.telemetryRuntimeId, this.telemetryAgent);
  }

  private finishTelemetryRuntime(reason: TelemetryEndedReason): void {
    if (!this.telemetryStarted) return;
    this.telemetryStarted = false;
    getTelemetry().finishRuntime(this.telemetryRuntimeId, reason);
  }

  get sessionId(): string | null {
    return this.currentSessionId;
  }

  diagnosticLogPaths(): { readonly relay: string | null; readonly stderr: string | null } {
    return { relay: getRelayLogPath(), stderr: this.transportConnection?.diagnosticLogPath ?? null };
  }

  supportsSessionLoad(): boolean {
    return this.sessionLoadSupported;
  }

  supportsSessionResume(): boolean {
    return this.sessionResumeSupported;
  }

  supportsSessionClose(): boolean {
    return this.sessionCloseSupported;
  }

  supportsSessionDelete(): boolean {
    return this.sessionDeleteSupported;
  }

  supportsAdditionalDirectories(): boolean {
    return this.additionalDirectoriesSupported;
  }

  supportsSessionList(): boolean {
    return this.sessionListSupported;
  }

  supportsSessionFork(): boolean {
    return this.sessionForkSupported;
  }

  authMethods(): readonly RelayAuthMethod[] {
    return this.authMethodsAvailable;
  }

  supportedAuthMethods(): readonly RelayAuthMethod[] {
    return this.authMethodsAvailable.filter((method) => method.supported);
  }

  supportsAuthLogout(): boolean {
    return this.authLogoutSupported;
  }

  captureSessionUpdates(sessionId: string, handler: AcpCapturedSessionUpdateHandler): () => void {
    let handlers = this.capturedSessionUpdateHandlers.get(sessionId);
    if (!handlers) {
      handlers = new Set();
      this.capturedSessionUpdateHandlers.set(sessionId, handlers);
    }
    handlers.add(handler);
    return () => {
      const currentHandlers = this.capturedSessionUpdateHandlers.get(sessionId);
      if (!currentHandlers) return;
      currentHandlers.delete(handler);
      if (currentHandlers.size === 0) this.capturedSessionUpdateHandlers.delete(sessionId);
    };
  }

  static scoped(callbacks: AcpClientCallbacks, opts: AcpClientOptions) {
    return Effect.acquireRelease(
      Effect.gen(function* () {
        const client = new AcpClient(callbacks, opts);
        yield* client.connectEffect();
        return client;
      }),
      (client) => client.disposeEffect(),
    );
  }

  private mcpServersEffect(): Effect.Effect<readonly acp.McpServer[], RelayError> {
    return validationEffect(this.mcpServersResult);
  }

  private publishAvailableCommands(commands: CommandDescriptor[], sessionId?: string): void {
    this.availableCommandsVersion += 1;
    const snapshot = {
      commands,
      ...(sessionId ? { sessionId } : {}),
      version: this.availableCommandsVersion,
    } satisfies AvailableCommandsSnapshot;
    this.latestAvailableCommands = snapshot;
    this.availableCommandsSnapshots.push(snapshot);
    while (this.availableCommandsSnapshots.length > AVAILABLE_COMMANDS_SNAPSHOT_LIMIT) {
      this.availableCommandsSnapshots.shift();
    }
    this.callbacks.onAvailableCommands?.(commands);
  }

  private newerAvailableCommandsSnapshot(sinceVersion: number): AvailableCommandsSnapshot | null {
    const latest = this.latestAvailableCommands;
    return latest && latest.version > sinceVersion ? latest : null;
  }

  private newerAvailableCommandsForResult(
    result: AcpSessionResult,
    sinceVersion: number,
  ): AvailableCommandsSnapshot | null {
    for (let index = this.availableCommandsSnapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = this.availableCommandsSnapshots[index];
      if (snapshot.version <= sinceVersion) return null;
      if (snapshot.sessionId && result.sessionId && snapshot.sessionId !== result.sessionId) continue;
      return snapshot;
    }
    return null;
  }

  private pendingAvailableCommandsForResult(
    result: AcpSessionResult,
    pending: readonly PendingAvailableCommandsSnapshot[] | null = this.pendingAvailableCommands,
  ): PendingAvailableCommandsSnapshot | null {
    if (!pending) return null;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const snapshot = pending[index];
      if (snapshot.sessionId && result.sessionId && snapshot.sessionId !== result.sessionId) continue;
      return snapshot;
    }
    return null;
  }

  private replayPendingAvailableCommandUpdates(
    result: AcpSessionResult,
    pending: readonly PendingAvailableCommandsSnapshot[],
  ): void {
    for (const snapshot of pending) {
      if (snapshot.sessionId && result.sessionId && snapshot.sessionId !== result.sessionId) continue;
      getTelemetry().recordSessionUpdate(this.telemetryRuntimeId, snapshot.update);
      this.callbacks.onSessionUpdate(snapshot.update, snapshot.envelope);
    }
  }

  connectEffect = Effect.fn("AcpClient.connect")(() =>
    Effect.gen({ self: this }, function* () {
      if (this.connection) return;
      yield* this.mcpServersEffect();

      getRelayLogger().info("acp.connect.start", {
        cwd: this.workspaceCwd,
        transport: this.transport.kind,
      });
      this.disposed = false;
      this.initialized = false;
      this.resetLifecycleCapabilities();
      const transportConnection = yield* this.transport.connect();
      this.transportConnection = transportConnection;
      const stream = transportConnection.stream;

      const clientImpl: acp.Client = {
        sessionUpdate: (params) =>
          Effect.sync(() => {
            const notification = params;
            const update = notification.update;
            const updateRecord: Record<string, unknown> = update;
            const metadataRecords = [
              notification.metadata,
              notification._meta,
              updateRecord.metadata,
              updateRecord._meta,
            ].filter(isRecord);
            const metadata = metadataRecords.length > 0 ? Object.assign({}, ...metadataRecords) : undefined;
            const envelope: AcpSessionUpdateEnvelope = {
              sessionId: updateSessionId(notification) ?? updateSessionId(update),
              metadata,
            };
            const loadingSessionHistory = this.loadingSessionHistory;
            if (loadingSessionHistory) {
              loadingSessionHistory.updates.push({ update, envelope });
              return;
            }
            const captureHandlers = envelope.sessionId
              ? this.capturedSessionUpdateHandlers.get(envelope.sessionId)
              : this.capturedSessionUpdateHandlers.size === 1
                ? [...this.capturedSessionUpdateHandlers.values()][0]
                : undefined;
            if (captureHandlers && captureHandlers.size > 0) {
              for (const handler of Array.from(captureHandlers)) handler(update, envelope);
              return;
            }
            const isAvailableCommandsUpdate = update.sessionUpdate === "available_commands_update";
            if (isAvailableCommandsUpdate && this.pendingAvailableCommands) {
              this.pendingAvailableCommands.push({
                commands: formatSlashCommands(update.availableCommands),
                update,
                envelope,
                ...(envelope.sessionId ? { sessionId: envelope.sessionId } : {}),
              });
              return;
            }
            if (envelope.sessionId && this.currentSessionId && envelope.sessionId !== this.currentSessionId) return;
            getTelemetry().recordSessionUpdate(this.telemetryRuntimeId, update);
            this.callbacks.onSessionUpdate(update, envelope);
            if (isAvailableCommandsUpdate) {
              this.publishAvailableCommands(formatSlashCommands(update.availableCommands), envelope.sessionId);
            }
          }),
        requestPermission: (params) =>
          // effect-shape-allow: temporary UI approval callback bridge until scoped interaction service migration.
          Effect.callback<acp.RequestPermissionResponse, never>((resume) => {
            let active = true;
            const cancel = () => {
              if (!active) return;
              active = false;
              this.pendingInteractions.delete(cancel);
              resume(Effect.succeed({ outcome: { outcome: "cancelled" } }));
            };
            this.pendingInteractions.add(cancel);
            const rawParams: unknown = params;
            const data = isRecord(rawParams) ? rawParams : {};
            const toolCall = isRecord(data.toolCall) ? data.toolCall : {};
            const options = approvalOptions(data.options);
            if (options.length === 0) {
              active = false;
              this.pendingInteractions.delete(cancel);
              resume(Effect.succeed({ outcome: { outcome: "cancelled" } }));
              return Effect.sync(() => undefined);
            }
            this.callbacks.onPermissionRequest({
              toolCallId: String(toolCall.toolCallId ?? ""),
              toolName: String(toolCall.title ?? toolCall.kind ?? "tool"),
              preview: formatToolPreview(
                String(toolCall.title ?? toolCall.kind ?? "tool"),
                toolCall.rawInput,
                this.sessionCwd,
              ),
              options,
              respond: (response) => {
                if (!active || this.disposed) return;
                active = false;
                this.pendingInteractions.delete(cancel);
                const optionId = selectedPermissionOptionId(options, response);
                resume(
                  Effect.succeed({
                    outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" },
                  }),
                );
              },
            });
            return Effect.sync(() => {
              active = false;
              this.pendingInteractions.delete(cancel);
            });
          }),
        unstable_createElicitation: (params) =>
          // effect-shape-allow: temporary UI elicitation callback bridge until scoped interaction service migration.
          Effect.callback<acp.CreateElicitationResponse, never>((resume) => {
            if (!this.callbacks.onElicitationRequest) {
              resume(Effect.succeed({ action: "cancel" }));
              return;
            }
            let active = true;
            const cancel = () => {
              if (!active) return;
              active = false;
              this.pendingInteractions.delete(cancel);
              resume(Effect.succeed({ action: "cancel" }));
            };
            this.pendingInteractions.add(cancel);
            const rawParams: unknown = params;
            const data = isRecord(rawParams) ? rawParams : {};
            this.callbacks.onElicitationRequest({
              mode: data.mode === "url" ? "url" : "form",
              message: String(data.message ?? "Input requested"),
              requestedSchema: isElicitationSchema(data.requestedSchema) ? data.requestedSchema : undefined,
              url: typeof data.url === "string" ? data.url : undefined,
              elicitationId: typeof data.elicitationId === "string" ? data.elicitationId : undefined,
              toolCallId: typeof data.toolCallId === "string" ? data.toolCallId : undefined,
              respond: (response) => {
                if (!active || this.disposed) return;
                active = false;
                this.pendingInteractions.delete(cancel);
                resume(Effect.succeed(sdkElicitationResponse(response)));
              },
            });
            return Effect.sync(() => {
              active = false;
              this.pendingInteractions.delete(cancel);
            });
          }),
      };

      const connection = yield* acp.ClientSideConnection.make(() => clientImpl, stream);
      this.connection = connection;
      const initializeStartedAt = nowMs();
      getRelayLogger().info("acp.initialize.start", { protocolVersion: acp.PROTOCOL_VERSION });
      const initializeResult = yield* connection
        .initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: relayClientCapabilities(),
          clientInfo: { name: "relay", version: ACP_CLIENT_VERSION },
        })
        .pipe(
          Effect.catch((err) =>
            Effect.gen({ self: this }, function* () {
              yield* transportConnection.waitForStartupOutput();
              getRelayLogger().error("acp.initialize.error", {
                elapsedMs: nowMs() - initializeStartedAt,
                error: errorMessage(err),
              });
              const startupOutput = transportConnection.startupOutput();
              const hint = summarizeStderr(startupOutput);
              const base = primaryStartupErrorFromStderr(startupOutput) || errorMessage(err);
              const message = hint ? `${base}\n\nAgent output:\n${hint}` : base;
              const failure = new RelayError({ message, cause: err });
              yield* connection.close();
              yield* this.transport.dispose();
              this.connection = null;
              this.transportConnection = null;
              return yield* Effect.fail(failure);
            }),
          ),
        );
      if (initializeResult.protocolVersion !== acp.PROTOCOL_VERSION) {
        const failure = unsupportedProtocolVersionError(initializeResult.protocolVersion);
        getRelayLogger().error("acp.initialize.unsupported_protocol_version", {
          requestedProtocolVersion: acp.PROTOCOL_VERSION,
          agentProtocolVersion: initializeResult.protocolVersion,
        });
        yield* connection.close();
        yield* this.transport.dispose();
        this.connection = null;
        this.transportConnection = null;
        return yield* Effect.fail(failure);
      }
      getRelayLogger().info("acp.initialize.ready", { elapsedMs: nowMs() - initializeStartedAt });
      this.initialized = true;
      this.startTelemetryRuntime();
      const lifecycleCapabilities = agentLifecycleCapabilitiesForInitializeResult(initializeResult);
      this.sessionLoadSupported = lifecycleCapabilities.loadSession;
      this.sessionListSupported = lifecycleCapabilities.listSessions;
      this.sessionDeleteSupported = lifecycleCapabilities.deleteSessions;
      this.sessionForkSupported = lifecycleCapabilities.forkSession;
      this.sessionResumeSupported = lifecycleCapabilities.resumeSession;
      this.sessionCloseSupported = lifecycleCapabilities.closeSession;
      this.additionalDirectoriesSupported = lifecycleCapabilities.additionalDirectories;

      // -----------------------------------------------------------------------
      // Temporary Rovo Dev ACP compatibility
      // Remove profile-provided lifecycle support once Rovo advertises native
      // session/list and session/fork. Native ACP capabilities take precedence.
      // -----------------------------------------------------------------------
      this.sessionListProvidedByProfile =
        !this.sessionListSupported &&
        this.sessionLoadSupported &&
        this.agentBehaviorProfile.sessionLifecycleFacade?.listSessions !== undefined;
      this.sessionForkProvidedByProfile =
        !this.sessionForkSupported &&
        this.sessionLoadSupported &&
        this.agentBehaviorProfile.sessionLifecycleFacade?.forkSession !== undefined;
      this.sessionListSupported ||= this.sessionListProvidedByProfile;
      this.sessionForkSupported ||= this.sessionForkProvidedByProfile;

      this.activeTurnInputAdapter = resolveActiveTurnInputAdapter(initializeResult);
      this.supportsImagePrompts = supportsImagePromptsForInitializeResult(initializeResult);
      this.authMethodsAvailable = authMethodsForInitializeResult(
        initializeResult,
        this.agentCommand
          ? {
              command: this.agentCommand,
              args: this.agentArgs,
              ...(this.agentEnv ? { env: this.agentEnv } : {}),
            }
          : undefined,
      );
      this.authLogoutSupported = supportsAuthLogoutForInitializeResult(initializeResult);
    }),
  );

  authenticateEffect = Effect.fn("AcpClient.authenticate")((methodId: string) =>
    Effect.gen({ self: this }, function* () {
      const connection = yield* connected(this.connection, "authenticate");
      const method = this.authMethodsAvailable.find((entry) => entry.id === methodId);
      if (!method) {
        return yield* Effect.fail(new RelayError({ message: `ACP auth method "${methodId}" was not advertised` }));
      }
      if (!method.supported) {
        return yield* Effect.fail(
          new RelayError({ message: method.unsupportedReason ?? `ACP auth method "${methodId}" is not supported` }),
        );
      }
      return yield* connection.authenticate({ methodId });
    }),
  );

  logoutEffect = Effect.fn("AcpClient.logout")(() =>
    Effect.gen({ self: this }, function* () {
      const connection = yield* connected(this.connection, "logout");
      if (!this.authLogoutSupported) {
        return yield* Effect.fail(new RelayError({ message: "ACP agent did not advertise logout support" }));
      }
      return yield* connection.logout({});
    }),
  );

  newSessionEffect = Effect.fn("AcpClient.newSession")((cwd: string, additionalDirectories?: readonly string[]) =>
    Effect.gen({ self: this }, function* () {
      const connection = yield* connected(this.connection, "newSession");
      const mcpServers = yield* this.mcpServersEffect();
      const sessionAdditionalDirectories = this.additionalDirectoriesSupported
        ? requestAdditionalDirectories(cwd, additionalDirectories)
        : [];
      const startedAt = nowMs();
      const commandVersionBeforeRequest = this.availableCommandsVersion;
      const pendingAvailableCommands: PendingAvailableCommandsSnapshot[] = [];
      this.pendingAvailableCommands = pendingAvailableCommands;
      getRelayLogger().info("acp.session.new.start", { cwd });
      const response = yield* connection
        .newSession(newSessionRequest(cwd, mcpServers, undefined, sessionAdditionalDirectories))
        .pipe(
          Effect.tapError((error) =>
            Effect.sync(() =>
              getRelayLogger().error("acp.session.new.error", {
                cwd,
                elapsedMs: nowMs() - startedAt,
                error: errorMessage(error),
              }),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (this.pendingAvailableCommands === pendingAvailableCommands) this.pendingAvailableCommands = null;
            }),
          ),
        );
      const parsedResult = sessionResult(response);
      const pendingCommands = this.pendingAvailableCommandsForResult(parsedResult, pendingAvailableCommands);
      const newerSnapshot = this.newerAvailableCommandsSnapshot(commandVersionBeforeRequest);
      const newerCommands =
        pendingCommands ?? this.newerAvailableCommandsForResult(parsedResult, commandVersionBeforeRequest);
      const result = newerCommands ? { ...parsedResult, availableCommands: newerCommands.commands } : parsedResult;
      if (result.sessionId) this.currentSessionId = result.sessionId;
      this.replayPendingAvailableCommandUpdates(result, pendingAvailableCommands);
      if (pendingCommands || result.availableCommands !== undefined || newerSnapshot) {
        this.publishAvailableCommands(result.availableCommands ?? [], result.sessionId);
      }
      getRelayLogger().info("acp.session.new.ready", {
        sessionId: result.sessionId ?? null,
        elapsedMs: nowMs() - startedAt,
      });
      return result;
    }),
  );

  forkSessionEffect = Effect.fn("AcpClient.forkSession")(
    (cwd: string, sessionId?: string, additionalDirectories?: readonly string[]) =>
      Effect.gen({ self: this }, function* () {
        const sourceSessionId = yield* activeSession(this.currentSessionId, sessionId, "forkSession");
        const startedAt = nowMs();
        getRelayLogger().info("acp.session.fork.start", { sessionId: sourceSessionId, cwd });

        let result: AcpSessionResult;
        if (!this.sessionForkProvidedByProfile) {
          const connection = yield* connected(this.connection, "forkSession");
          const mcpServers = yield* this.mcpServersEffect();
          const sessionAdditionalDirectories = this.additionalDirectoriesSupported
            ? requestAdditionalDirectories(cwd, additionalDirectories)
            : [];
          const response = yield* connection
            .forkSession(forkSessionRequest(sourceSessionId, cwd, mcpServers, undefined, sessionAdditionalDirectories))
            .pipe(
              Effect.tapError((error) =>
                Effect.sync(() =>
                  getRelayLogger().error("acp.session.fork.error", {
                    sessionId: sourceSessionId,
                    cwd,
                    elapsedMs: nowMs() - startedAt,
                    error: errorMessage(error),
                  }),
                ),
              ),
            );
          result = sessionResult(response);
        } else {
          const sessionForkFacade = this.agentBehaviorProfile.sessionLifecycleFacade?.forkSession;
          if (!sessionForkFacade) {
            return yield* Effect.fail(new RelayError({ message: "Profile session/fork facade is unavailable" }));
          }
          result = yield* Effect.tryPromise({
            try: () =>
              Promise.resolve(
                sessionForkFacade({
                  sessionId: sourceSessionId,
                  cwd,
                  agentEnv: this.agentEnv,
                }),
              ).then(sessionResult),
            catch: (cause) =>
              new RelayError({
                message: "Failed to fork locally persisted ACP session",
                cause,
              }),
          });
        }

        if (!result.sessionId) {
          return yield* Effect.fail(new AcpProtocolError({ message: "ACP session/fork response missing sessionId" }));
        }
        getRelayLogger().info("acp.session.fork.ready", {
          sourceSessionId,
          sessionId: result.sessionId,
          elapsedMs: nowMs() - startedAt,
          facade: this.sessionForkProvidedByProfile,
        });
        return result;
      }),
  );

  listSessionsEffect = Effect.fn("AcpClient.listSessions")(() =>
    Effect.gen({ self: this }, function* () {
      if (!this.sessionListProvidedByProfile) {
        const connection = yield* connected(this.connection, "listSessions");
        const sessions: unknown[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | null = null;

        const requestForCursor = (cursorValue: string | null): acp.ListSessionsRequest => ({
          ...(cursorValue === null ? {} : { cursor: cursorValue }),
        });

        while (true) {
          const result = yield* connection.listSessions(requestForCursor(cursor));
          sessions.push(...listSessionsResponseSessions(result));

          const nextCursor = listSessionsResponseNextCursor(result);
          if (nextCursor === null || seenCursors.has(nextCursor)) break;

          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }

        return sessions.map(sessionInfo).filter((session): session is AcpSessionInfo => session !== undefined);
      }

      const sessionListFacade = this.agentBehaviorProfile.sessionLifecycleFacade?.listSessions;
      if (!sessionListFacade) {
        return yield* Effect.fail(new RelayError({ message: "Profile session/list facade is unavailable" }));
      }
      return yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            sessionListFacade({
              cwd: this.workspaceCwd,
              agentEnv: this.agentEnv,
            }),
          ).then((sessions) => [...sessions]),
        catch: (cause) =>
          new RelayError({
            message: "Failed to list locally persisted ACP sessions",
            cause,
          }),
      });
    }),
  );

  deleteSessionEffect = Effect.fn("AcpClient.deleteSession")((sessionId: string) =>
    Effect.gen({ self: this }, function* () {
      const connection = yield* connected(this.connection, "deleteSession");
      yield* connection.deleteSession({ sessionId });
      if (this.currentSessionId === sessionId) this.currentSessionId = null;
    }),
  );

  closeSessionEffect = Effect.fn("AcpClient.closeSession")((sessionId: string) =>
    Effect.gen({ self: this }, function* () {
      const connection = yield* connected(this.connection, "closeSession");
      if (!this.sessionCloseSupported) {
        return yield* Effect.fail(new RelayError({ message: "ACP agent did not advertise session/close" }));
      }
      yield* connection.closeSession({ sessionId });
      if (this.currentSessionId === sessionId) this.currentSessionId = null;
    }),
  );

  loadSessionEffect = Effect.fn("AcpClient.loadSession")(
    (sessionId: string, cwd: string, additionalDirectories?: readonly string[]) =>
      Effect.gen({ self: this }, function* () {
        const connection = yield* connected(this.connection, "loadSession");
        const mcpServers = yield* this.mcpServersEffect();
        const sessionAdditionalDirectories = this.additionalDirectoriesSupported
          ? requestAdditionalDirectories(cwd, additionalDirectories)
          : [];
        while (this.loadingSessionHistory) yield* Effect.tryPromise(() => nextEventLoopTurn());
        const previousSessionId = this.currentSessionId;
        const updates: LoadingSessionHistoryUpdate[] = [];
        const sessionIds = new Set([sessionId]);
        const loadingSessionHistory: LoadingSessionHistory = {
          sessionIds,
          updates,
        };
        this.currentSessionId = sessionId;
        this.loadingSessionHistory = loadingSessionHistory;
        const startedAt = nowMs();
        const commandVersionBeforeRequest = this.availableCommandsVersion;
        getRelayLogger().info("acp.session.load.start", { sessionId, cwd });
        const result = yield* connection
          .loadSession(loadSessionRequest(sessionId, cwd, mcpServers, sessionAdditionalDirectories))
          .pipe(
            Effect.catch((error) => {
              this.currentSessionId = previousSessionId;
              getRelayLogger().error("acp.session.load.error", {
                sessionId,
                cwd,
                elapsedMs: nowMs() - startedAt,
                error: errorMessage(error),
              });
              return Effect.fail(error);
            }),
            Effect.ensuring(
              Effect.sync(() => {
                if (this.loadingSessionHistory === loadingSessionHistory) this.loadingSessionHistory = null;
              }),
            ),
          );
        const parsedLoaded = sessionResult(result);
        this.currentSessionId = parsedLoaded.sessionId ?? sessionId;
        sessionIds.add(this.currentSessionId);
        for (const entry of updates.filter(
          (item) => !item.envelope.sessionId || sessionIds.has(item.envelope.sessionId),
        )) {
          getTelemetry().recordSessionUpdate(this.telemetryRuntimeId, entry.update);
          this.callbacks.onSessionUpdate(entry.update, entry.envelope);
          if (entry.update.sessionUpdate === "available_commands_update") {
            this.publishAvailableCommands(formatSlashCommands(entry.update.availableCommands), this.currentSessionId);
          }
        }
        const newerSnapshot = this.newerAvailableCommandsSnapshot(commandVersionBeforeRequest);
        const newerCommands = this.newerAvailableCommandsForResult(
          { ...parsedLoaded, sessionId: this.currentSessionId },
          commandVersionBeforeRequest,
        );
        const loaded = newerCommands ? { ...parsedLoaded, availableCommands: newerCommands.commands } : parsedLoaded;
        if (
          (!newerCommands || newerCommands.version !== newerSnapshot?.version) &&
          (loaded.availableCommands !== undefined || newerSnapshot)
        ) {
          this.publishAvailableCommands(loaded.availableCommands ?? [], this.currentSessionId);
        }
        getRelayLogger().info("acp.session.load.ready", {
          requestedSessionId: sessionId,
          sessionId: this.currentSessionId,
          elapsedMs: nowMs() - startedAt,
        });
        return loaded;
      }),
  );

  resumeSessionEffect = Effect.fn("AcpClient.resumeSession")(
    (sessionId: string, cwd: string, additionalDirectories?: readonly string[]) =>
      Effect.gen({ self: this }, function* () {
        const connection = yield* connected(this.connection, "resumeSession");
        if (!this.sessionResumeSupported) {
          return yield* Effect.fail(new RelayError({ message: "ACP agent did not advertise session/resume" }));
        }
        const mcpServers = yield* this.mcpServersEffect();
        const sessionAdditionalDirectories = this.additionalDirectoriesSupported
          ? requestAdditionalDirectories(cwd, additionalDirectories)
          : [];
        const startedAt = nowMs();
        getRelayLogger().info("acp.session.resume.start", { sessionId, cwd });
        const response = yield* connection
          .resumeSession(resumeSessionRequest(sessionId, cwd, mcpServers, sessionAdditionalDirectories))
          .pipe(
            Effect.tapError((error) =>
              Effect.sync(() =>
                getRelayLogger().error("acp.session.resume.error", {
                  sessionId,
                  cwd,
                  elapsedMs: nowMs() - startedAt,
                  error: errorMessage(error),
                }),
              ),
            ),
          );
        const result = { ...sessionResult(response), sessionId } satisfies AcpSessionResult;
        this.currentSessionId = sessionId;
        getRelayLogger().info("acp.session.resume.ready", {
          sessionId,
          elapsedMs: nowMs() - startedAt,
        });
        return result;
      }),
  );

  loadSessionHistoryEffect = Effect.fn("AcpClient.loadSessionHistory")(
    (
      sessionId: string,
      cwd: string,
      additionalDirectories?: readonly string[],
      options: LoadSessionHistoryOptions = {},
    ) =>
      Effect.gen({ self: this }, function* () {
        const connection = yield* connected(this.connection, "loadSessionHistory");
        while (this.loadingSessionHistory) yield* Effect.tryPromise(() => nextEventLoopTurn());
        const previousSessionId = this.currentSessionId;
        const updates: LoadingSessionHistoryUpdate[] = [];
        const sessionIds = new Set([sessionId]);
        const loadingSessionHistory: LoadingSessionHistory = {
          sessionIds,
          updates,
        };
        this.currentSessionId = sessionId;
        this.loadingSessionHistory = loadingSessionHistory;
        const sessionAdditionalDirectories = this.additionalDirectoriesSupported
          ? requestAdditionalDirectories(cwd, additionalDirectories)
          : [];
        const startedAt = nowMs();
        getRelayLogger().info("acp.session.history.load.start", { sessionId, cwd });
        const { onHistoryReady } = options;
        const earlyHistory = onHistoryReady
          ? yield* waitForEarlySessionHistory(loadingSessionHistory).pipe(
              Effect.flatMap((early) =>
                Effect.sync(() => {
                  getRelayLogger().info("acp.session.history.early", {
                    sessionId,
                    updateCount: early.length,
                    elapsedMs: nowMs() - startedAt,
                  });
                  onHistoryReady(early);
                }),
              ),
              Effect.forkChild,
            )
          : undefined;
        return yield* connection.loadSession(loadSessionRequest(sessionId, cwd, [], sessionAdditionalDirectories)).pipe(
          Effect.tap(() => (earlyHistory ? Fiber.interrupt(earlyHistory) : Effect.void)),
          Effect.flatMap((result) =>
            Effect.gen({ self: this }, function* () {
              const loaded = sessionResult(result);
              this.currentSessionId = loaded.sessionId ?? sessionId;
              if (loaded.availableCommands !== undefined) {
                this.publishAvailableCommands(loaded.availableCommands, this.currentSessionId);
              }
              sessionIds.add(this.currentSessionId);
              yield* waitForSessionHistoryReplayToSettle(loadingSessionHistory);
              const replayUpdates = updates
                .filter((entry) => !entry.envelope.sessionId || sessionIds.has(entry.envelope.sessionId))
                .map((entry) => entry.update);
              const replayCommands = latestAvailableCommandsFromUpdates(replayUpdates);
              const effectiveLoaded = replayCommands ? { ...loaded, availableCommands: replayCommands } : loaded;
              if (replayCommands) this.publishAvailableCommands(replayCommands, this.currentSessionId);
              getRelayLogger().info("acp.session.history.load.ready", {
                requestedSessionId: sessionId,
                sessionId: this.currentSessionId,
                updateCount: replayUpdates.length,
                elapsedMs: nowMs() - startedAt,
              });
              return { result: effectiveLoaded, updates: replayUpdates } satisfies AcpLoadedSessionHistory;
            }),
          ),
          Effect.catch((error) => {
            this.currentSessionId = previousSessionId;
            getRelayLogger().error("acp.session.history.load.error", {
              sessionId,
              cwd,
              elapsedMs: nowMs() - startedAt,
              error: errorMessage(error),
            });
            return Effect.fail(error);
          }),
          Effect.ensuring(
            Effect.suspend(() => {
              this.loadingSessionHistory = null;
              return earlyHistory ? Fiber.interrupt(earlyHistory) : Effect.void;
            }),
          ),
        );
      }),
  );

  promptEffect = Effect.fn("AcpClient.prompt")(
    (input: PromptInput, sessionId?: string, metadata?: Record<string, unknown>) =>
      Effect.gen({ self: this }, function* () {
        const connection = yield* connected(this.connection, "prompt");
        const activeSessionId = yield* activeSession(this.currentSessionId, sessionId, "prompt");
        const prompt = yield* buildPromptContent(promptInputText(input), {
          includeImages: this.supportsImagePrompts,
          cwd: this.sessionCwd,
          images: isPromptSubmission(input) ? input.images : [],
          systemReminders: isPromptSubmission(input) ? (input.systemReminders ?? []) : [],
          ...(this.agentBehaviorProfile.promptContentPolicy
            ? { policy: this.agentBehaviorProfile.promptContentPolicy }
            : {}),
        });
        const imageCount = prompt.filter((block) => block.type === "image").length;
        if (imageCount > 0) {
          getRelayLogger().info("acp.prompt.images.attached", { sessionId: activeSessionId, imageCount });
        }
        getTelemetry().recordMessage(this.telemetryRuntimeId);
        return yield* connection.prompt(promptRequest(activeSessionId, prompt, metadata));
      }),
  );

  sendActiveTurnInputEffect = Effect.fn("AcpClient.sendActiveTurnInput")((text: string, sessionId?: string) =>
    Effect.gen({ self: this }, function* () {
      const connection = yield* connected(this.connection, "sendActiveTurnInput");
      const adapter = this.activeTurnInputAdapter;
      if (!adapter)
        return { accepted: false, reason: "Active-turn input is not supported" } satisfies AcpActiveTurnInputResult;
      const activeSessionId = yield* activeSession(this.currentSessionId, sessionId, "sendActiveTurnInput");
      return yield* adapter.send({ connection, sessionId: activeSessionId, text });
    }),
  );

  cancelEffect = Effect.fn("AcpClient.cancel")((sessionId?: string) =>
    Effect.gen({ self: this }, function* () {
      const connection = yield* connected(this.connection, "cancel");
      const activeSessionId = sessionId ?? this.currentSessionId;
      if (!activeSessionId) return;
      for (const cancel of Array.from(this.pendingInteractions)) cancel();
      this.pendingInteractions.clear();
      yield* connection.cancel({ sessionId: activeSessionId });
    }),
  );

  setSessionModeEffect = Effect.fn("AcpClient.setSessionMode")((modeId: string, sessionId?: string) =>
    Effect.gen({ self: this }, function* () {
      const connection = yield* connected(this.connection, "setSessionMode");
      const activeSessionId = yield* activeSession(this.currentSessionId, sessionId, "setSessionMode");
      yield* connection.setSessionMode({ sessionId: activeSessionId, modeId });
    }),
  );

  setSessionModelEffect = Effect.fn("AcpClient.setSessionModel")(
    (modelId: string, configId = "model", sessionId?: string) =>
      Effect.gen({ self: this }, function* () {
        const connection = yield* connected(this.connection, "setSessionModel");
        const activeSessionId = yield* activeSession(this.currentSessionId, sessionId, "setSessionModel");
        const legacySetModelMethod = this.agentBehaviorProfile.sessionLifecycleFacade?.legacySetModelMethod;
        if (!legacySetModelMethod) {
          const response = yield* connection.setSessionConfigOption(
            stringConfigOptionRequest(activeSessionId, configId, modelId),
          );
          return sessionResult(response);
        }

        // Temporary Rovo Dev ACP compatibility: remove this custom-method path
        // once Rovo supports session/set_config_option for model selection.
        const response = yield* connection.sendCustomRequest(legacySetModelMethod, {
          sessionId: activeSessionId,
          modelId,
        });
        return sessionResult(response);
      }),
  );

  setSessionThinkingLevelEffect = Effect.fn("AcpClient.setSessionThinkingLevel")(
    (thinkingLevel: ThinkingLevel, configId: string, sessionId?: string) =>
      Effect.gen({ self: this }, function* () {
        const connection = yield* connected(this.connection, "setSessionThinkingLevel");
        const activeSessionId = yield* activeSession(this.currentSessionId, sessionId, "setSessionThinkingLevel");
        const response = yield* connection.setSessionConfigOption(
          stringConfigOptionRequest(activeSessionId, configId, thinkingLevel),
        );
        return sessionResult(response);
      }),
  );

  setSessionConfigOptionEffect = Effect.fn("AcpClient.setSessionConfigOption")(
    (configId: string, value: boolean | number | string, sessionId?: string) =>
      Effect.gen({ self: this }, function* () {
        const connection = yield* connected(this.connection, "setSessionConfigOption");
        const activeSessionId = yield* activeSession(this.currentSessionId, sessionId, "setSessionConfigOption");
        const response = yield* connection.setSessionConfigOption(
          typeof value === "boolean"
            ? { sessionId: activeSessionId, configId, value, type: "boolean" }
            : stringConfigOptionRequest(activeSessionId, configId, String(value)),
        );
        return sessionResult(response);
      }),
  );

  disposeEffect = Effect.fn("AcpClient.dispose")(() =>
    Effect.gen({ self: this }, function* () {
      this.disposed = true;
      for (const cancel of Array.from(this.pendingInteractions)) cancel();
      this.pendingInteractions.clear();
      this.capturedSessionUpdateHandlers.clear();
      const connection = this.connection;
      yield* this.transport.dispose();
      this.finishTelemetryRuntime("normal");
      if (connection) yield* connection.close();
      this.connection = null;
      this.transportConnection = null;
      this.currentSessionId = null;
      this.activeTurnInputAdapter = null;
      this.initialized = false;
      this.resetLifecycleCapabilities();
    }),
  );

  connect(): Promise<void> {
    return runEffect(this.connectEffect());
  }

  newSession(cwd: string, additionalDirectories?: readonly string[]): Promise<AcpSessionResult> {
    return runEffect(this.newSessionEffect(cwd, additionalDirectories));
  }

  forkSession(cwd: string, sessionId?: string, additionalDirectories?: readonly string[]): Promise<AcpSessionResult> {
    return runEffect(this.forkSessionEffect(cwd, sessionId, additionalDirectories));
  }

  listSessions(): Promise<AcpSessionInfo[]> {
    return runEffect(this.listSessionsEffect());
  }

  deleteSession(sessionId: string): Promise<void> {
    return runEffect(this.deleteSessionEffect(sessionId));
  }

  closeSession(sessionId: string): Promise<void> {
    return runEffect(this.closeSessionEffect(sessionId));
  }

  loadSession(sessionId: string, cwd: string, additionalDirectories?: readonly string[]): Promise<AcpSessionResult> {
    return runEffect(this.loadSessionEffect(sessionId, cwd, additionalDirectories));
  }

  loadSessionHistory(
    sessionId: string,
    cwd: string,
    additionalDirectories?: readonly string[],
    options?: LoadSessionHistoryOptions,
  ): Promise<AcpLoadedSessionHistory> {
    return runEffect(this.loadSessionHistoryEffect(sessionId, cwd, additionalDirectories, options));
  }

  resumeSession(sessionId: string, cwd: string, additionalDirectories?: readonly string[]): Promise<AcpSessionResult> {
    return runEffect(this.resumeSessionEffect(sessionId, cwd, additionalDirectories));
  }

  prompt(input: PromptInput, sessionId?: string): Promise<unknown> {
    return runEffect(this.promptEffect(input, sessionId));
  }

  supportsActiveTurnInput(): boolean {
    return this.activeTurnInputAdapter !== null;
  }

  sendActiveTurnInput(text: string, sessionId?: string): Promise<AcpActiveTurnInputResult> {
    return runEffect(this.sendActiveTurnInputEffect(text, sessionId));
  }

  authenticate(methodId: string): Promise<acp.AuthenticateResponse> {
    return runEffect(this.authenticateEffect(methodId));
  }

  logout(): Promise<acp.LogoutResponse> {
    return runEffect(this.logoutEffect());
  }

  cancel(sessionId?: string): Promise<void> {
    return runEffect(this.cancelEffect(sessionId));
  }

  setSessionMode(modeId: string, sessionId?: string): Promise<void> {
    return runEffect(this.setSessionModeEffect(modeId, sessionId));
  }

  setSessionModel(modelId: string, configId?: string, sessionId?: string): Promise<AcpSessionResult> {
    return runEffect(this.setSessionModelEffect(modelId, configId, sessionId));
  }

  setSessionThinkingLevel(
    thinkingLevel: ThinkingLevel,
    configId: string,
    sessionId?: string,
  ): Promise<AcpSessionResult> {
    return runEffect(this.setSessionThinkingLevelEffect(thinkingLevel, configId, sessionId));
  }

  setSessionConfigOption(
    configId: string,
    value: boolean | number | string,
    sessionId?: string,
  ): Promise<AcpSessionResult> {
    return runEffect(this.setSessionConfigOptionEffect(configId, value, sessionId));
  }

  /**
   * Forces synchronous transport teardown when graceful disposal exceeds the shutdown budget.
   */
  forceDispose(): void {
    this.disposed = true;
    for (const cancel of Array.from(this.pendingInteractions)) cancel();
    this.pendingInteractions.clear();
    this.capturedSessionUpdateHandlers.clear();
    this.transport.forceDispose?.();
    this.finishTelemetryRuntime("normal");
  }

  disposeAsync(): Promise<void> {
    return runEffect(this.disposeEffect());
  }

  dispose(): void {
    void this.disposeAsync();
  }
}
