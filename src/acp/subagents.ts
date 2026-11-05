export const ALTA_SUBAGENT_META_KEY = "alta/subagent";

export type AltaSubagentStatus = "running" | "completed" | "failed" | "cancelled";

export interface AltaSubagentMetadata {
  readonly invokingToolCallId?: string;
  readonly childSessionId?: string;
  readonly parentSessionId?: string;
  readonly agentName?: string;
  readonly background?: boolean;
  readonly terminal?: boolean;
  readonly status?: AltaSubagentStatus;
}

export type AltaSubagentMetadataParseResult =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly metadata: AltaSubagentMetadata };

export interface AcpMetadataEnvelope {
  readonly metadata?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(record: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function subagentStatus(value: unknown): AltaSubagentStatus | undefined {
  switch (value) {
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
      return value;
    default:
      return undefined;
  }
}

function altaSubagentPayloadFromRecord(record: Record<string, unknown>): unknown {
  if (Object.hasOwn(record, ALTA_SUBAGENT_META_KEY)) return record[ALTA_SUBAGENT_META_KEY];
  const meta = isRecord(record._meta) ? record._meta : undefined;
  return meta && Object.hasOwn(meta, ALTA_SUBAGENT_META_KEY) ? meta[ALTA_SUBAGENT_META_KEY] : undefined;
}

export function parseAltaSubagentMetadata(
  update: unknown,
  envelope?: AcpMetadataEnvelope,
): AltaSubagentMetadataParseResult {
  const payloads: unknown[] = [];
  if (isRecord(envelope?.metadata)) payloads.push(altaSubagentPayloadFromRecord(envelope.metadata));
  if (isRecord(update)) payloads.push(altaSubagentPayloadFromRecord(update));

  const payload = payloads.find((entry) => entry !== undefined);
  if (payload === undefined) return { kind: "absent" };
  if (!isRecord(payload)) return { kind: "invalid" };

  const invokingToolCallId = stringValue(payload, "invokingToolCallId", "invoking_tool_call_id");
  const childSessionId = stringValue(payload, "childSessionId", "child_session_id");
  if (!invokingToolCallId && !childSessionId) return { kind: "invalid" };

  const parentSessionId = stringValue(payload, "parentSessionId", "parent_session_id");
  const agentName = stringValue(payload, "childAlias", "child_alias", "agent", "agentName", "agent_name");
  const terminal = payload.terminal === true;
  const status =
    subagentStatus(payload.terminalStatus) ?? subagentStatus(payload.status) ?? (terminal ? "completed" : undefined);
  return {
    kind: "valid",
    metadata: {
      ...(invokingToolCallId ? { invokingToolCallId } : {}),
      ...(childSessionId ? { childSessionId } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(agentName ? { agentName } : {}),
      ...(typeof payload.background === "boolean" ? { background: payload.background } : {}),
      ...(terminal ? { terminal: true } : {}),
      ...(status ? { status } : {}),
    },
  };
}
