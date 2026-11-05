import { Effect } from "effect";
import type { JsonObject, PromptRequest } from "./sdk";

/** `_meta` key Alta advertises (and accepts on `session/prompt`) for active-turn steering. */
export const ALTA_STEER_META_KEY = "alta/steer" as const;
/** Legacy Alta-specific ext method that pre-dates the `_meta`-advertised steering capability. */
export const ALTA_LEGACY_STEER_METHOD = "_alta/session/steer" as const;

export interface ActiveTurnInputConnection {
  readonly prompt: (params: PromptRequest) => Effect.Effect<unknown, unknown>;
  readonly sendCustomRequest: (method: string, params: JsonObject) => Effect.Effect<unknown, unknown>;
}

export interface ActiveTurnInputResult {
  readonly accepted: boolean;
  readonly reason?: string;
}

export interface ActiveTurnInputAdapter {
  readonly send: (params: {
    readonly connection: ActiveTurnInputConnection;
    readonly sessionId: string;
    readonly text: string;
  }) => Effect.Effect<ActiveTurnInputResult, unknown>;
}

interface ActiveTurnInputExtension {
  /** Returns an adapter when the agent advertises the matching capability, otherwise `null`. */
  readonly resolve: (initializeResult: unknown) => ActiveTurnInputAdapter | null;
}

const activeTurnInputExtensions: readonly ActiveTurnInputExtension[] = [
  {
    resolve: (initializeResult) =>
      hasAgentMetaCapability(initializeResult, ALTA_STEER_META_KEY) ? steerMetaAdapter() : null,
  },
  {
    resolve: (initializeResult) =>
      hasAgentExtension(initializeResult, ALTA_LEGACY_STEER_METHOD) ? legacyExtAdapter() : null,
  },
];

function steerMetaAdapter(): ActiveTurnInputAdapter {
  return {
    send: ({ connection, sessionId, text }) =>
      Effect.map(
        connection.prompt({
          sessionId,
          prompt: [{ type: "text", text }],
          _meta: { [ALTA_STEER_META_KEY]: {} },
        }),
        steerMetaResult,
      ),
  };
}

function legacyExtAdapter(): ActiveTurnInputAdapter {
  return {
    send: ({ connection, sessionId, text }) =>
      Effect.map(
        connection.sendCustomRequest(ALTA_LEGACY_STEER_METHOD, { sessionId, prompt: [{ type: "text", text }] }),
        activeTurnInputResult,
      ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function agentCapabilities(result: unknown): Record<string, unknown> | null {
  return isRecord(result) && isRecord(result.agentCapabilities) ? result.agentCapabilities : null;
}

function hasAgentExtension(result: unknown, method: string): boolean {
  const capabilities = agentCapabilities(result);
  return capabilities !== null && isRecord(capabilities.extensions) && Object.hasOwn(capabilities.extensions, method);
}

function hasAgentMetaCapability(result: unknown, key: string): boolean {
  const capabilities = agentCapabilities(result);
  return capabilities !== null && isRecord(capabilities._meta) && Object.hasOwn(capabilities._meta, key);
}

function steerOutcome(value: unknown): ActiveTurnInputResult {
  if (isRecord(value) && typeof value.accepted === "boolean") {
    return value.accepted
      ? { accepted: true }
      : { accepted: false, reason: typeof value.reason === "string" ? value.reason : undefined };
  }
  return { accepted: false, reason: "Invalid active-turn input response" };
}

/** Parse the response of the legacy `_alta/session/steer` ext request. */
export function activeTurnInputResult(value: unknown): ActiveTurnInputResult {
  return steerOutcome(value);
}

/** Parse the `session/prompt` response of a steer request advertised via `_meta["alta/steer"]`. */
export function steerMetaResult(value: unknown): ActiveTurnInputResult {
  const meta = isRecord(value) && isRecord(value._meta) ? value._meta[ALTA_STEER_META_KEY] : undefined;
  return steerOutcome(meta);
}

export function resolveActiveTurnInputAdapter(initializeResult: unknown): ActiveTurnInputAdapter | null {
  for (const extension of activeTurnInputExtensions) {
    const adapter = extension.resolve(initializeResult);
    if (adapter) return adapter;
  }
  return null;
}
