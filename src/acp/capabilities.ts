import type { AuthMethod, ClientCapabilities, InitializeResponse } from "./sdk";

export interface AgentLifecycleCapabilities {
  readonly loadSession: boolean;
  readonly listSessions: boolean;
  readonly deleteSessions: boolean;
  readonly forkSession: boolean;
  readonly resumeSession: boolean;
  readonly closeSession: boolean;
  readonly additionalDirectories: boolean;
}

export interface RelayClientCapabilitySupport {
  readonly capabilityId: string;
  readonly requestHandler: string;
  readonly uxPath: string;
}

export type RelayAuthMethodType = "agent" | "env_var" | "terminal";

export interface RelayAuthEnvVar {
  readonly name: string;
  readonly label?: string;
  readonly secret: boolean;
  readonly optional: boolean;
}

export interface RelayAuthTerminalCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly label?: string;
}

export interface RelayAuthMethod {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly type: RelayAuthMethodType;
  readonly link?: string;
  readonly vars?: readonly RelayAuthEnvVar[];
  readonly terminal?: RelayAuthTerminalCommand;
  readonly supported: boolean;
  readonly unsupportedReason?: string;
}

export interface RelayAuthTerminalAgentCommand {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

interface TerminalAuthMeta {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly label?: string;
}

export interface RelayClientCapabilityOptions {
  readonly altaSubagentLiveStreaming?: boolean;
}

function buildRelayClientCapabilities(options: RelayClientCapabilityOptions = {}): ClientCapabilities {
  return {
    auth: { terminal: true },
    elicitation: { form: {} },
    _meta: {
      "terminal-auth": true,
      ...(options.altaSubagentLiveStreaming === false ? {} : { "alta/subagent": { liveStreaming: true } }),
    },
  };
}

const RELAY_CLIENT_CAPABILITIES = buildRelayClientCapabilities();

export const RELAY_CLIENT_CAPABILITY_SUPPORT = [
  {
    capabilityId: "auth.terminal",
    requestHandler: "authenticateWithAcpMethod terminal auth runner",
    uxPath: "src/ui/util/terminal-auth.ts",
  },
  {
    capabilityId: "elicitation.form",
    requestHandler: "AcpClientCallbacks.onElicitationRequest",
    uxPath: "src/ui/app/elicitation.ts",
  },
] as const satisfies readonly RelayClientCapabilitySupport[];

type AgentCapabilities = NonNullable<InitializeResponse["agentCapabilities"]>;
type SessionCapabilities = NonNullable<AgentCapabilities["sessionCapabilities"]>;
type PromptCapabilities = NonNullable<AgentCapabilities["promptCapabilities"]>;
type AgentAuthCapabilities = NonNullable<AgentCapabilities["auth"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function advertisedCapabilityPaths(value: unknown, prefix: readonly string[] = []): string[] {
  if (value === undefined || value === null || value === false) return [];
  if (Array.isArray(value)) return value.length > 0 && prefix.length > 0 ? [prefix.join(".")] : [];
  if (typeof value !== "object") return prefix.length > 0 ? [prefix.join(".")] : [];
  if (!isRecord(value)) return [];

  const paths = Object.entries(value)
    .filter(([key]) => key !== "_meta")
    .flatMap(([key, child]) => advertisedCapabilityPaths(child, [...prefix, key]))
    .sort();

  return paths.length > 0 ? paths : prefix.length > 0 ? [prefix.join(".")] : [];
}

export function relayClientCapabilities(options: RelayClientCapabilityOptions = {}): ClientCapabilities {
  return options.altaSubagentLiveStreaming === false
    ? buildRelayClientCapabilities(options)
    : RELAY_CLIENT_CAPABILITIES;
}

export function relayAdvertisedClientCapabilityIds(
  capabilities: ClientCapabilities = RELAY_CLIENT_CAPABILITIES,
): readonly string[] {
  return advertisedCapabilityPaths(capabilities);
}

function agentCapabilitiesFromInitializeResult(
  initializeResult: InitializeResponse | unknown,
): AgentCapabilities | null {
  if (!isRecord(initializeResult) || !isRecord(initializeResult.agentCapabilities)) return null;
  return initializeResult.agentCapabilities as AgentCapabilities;
}

function sessionCapabilitiesFromAgentCapabilities(capabilities: AgentCapabilities | null): SessionCapabilities | null {
  return isRecord(capabilities?.sessionCapabilities) ? (capabilities.sessionCapabilities as SessionCapabilities) : null;
}

function promptCapabilitiesFromAgentCapabilities(capabilities: AgentCapabilities | null): PromptCapabilities | null {
  return isRecord(capabilities?.promptCapabilities) ? (capabilities.promptCapabilities as PromptCapabilities) : null;
}

function authCapabilitiesFromAgentCapabilities(capabilities: AgentCapabilities | null): AgentAuthCapabilities | null {
  return isRecord(capabilities?.auth) ? (capabilities.auth as AgentAuthCapabilities) : null;
}

function supportsSessionCapability(value: unknown): boolean {
  // ACP 1.1 advertises session capabilities as `{}`-like objects. `true` is
  // retained for older agents and tests that predate the current schema.
  return value === true || isRecord(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function singleLineStringOrUndefined(value: unknown): string | undefined {
  return stringOrUndefined(value)?.replace(/\s+/g, " ");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function stringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function terminalAuthMeta(method: AuthMethod): TerminalAuthMeta | undefined {
  const meta = isRecord(method._meta) ? method._meta["terminal-auth"] : undefined;
  if (!isRecord(meta)) return undefined;
  const command = stringOrUndefined(meta.command);
  if (!command) return undefined;
  const env = stringRecord(meta.env);
  const label = singleLineStringOrUndefined(meta.label);
  return {
    command,
    args: stringArray(meta.args),
    ...(env ? { env } : {}),
    ...(label ? { label } : {}),
  };
}

function authMethodType(method: AuthMethod): RelayAuthMethodType {
  if (terminalAuthMeta(method)) return "terminal";
  if ("type" in method && (method.type === "env_var" || method.type === "terminal")) return method.type;
  return "agent";
}

function authMethodLink(method: AuthMethod): string | undefined {
  if (!("link" in method)) return undefined;
  const raw = singleLineStringOrUndefined(method.link);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function relayAuthEnvVars(method: AuthMethod): RelayAuthEnvVar[] {
  if (!("vars" in method) || !Array.isArray(method.vars)) return [];
  return method.vars.flatMap((envVar) => {
    if (!isRecord(envVar) || typeof envVar.name !== "string" || !envVar.name.trim()) return [];
    return [
      {
        name: envVar.name.trim(),
        label: singleLineStringOrUndefined(envVar.label),
        secret: envVar.secret !== false,
        optional: envVar.optional === true,
      },
    ];
  });
}

function terminalCommandForAuthMethod(
  method: AuthMethod,
  agentCommand: RelayAuthTerminalAgentCommand | undefined,
): RelayAuthTerminalCommand | undefined {
  const meta = terminalAuthMeta(method);
  if (meta) return meta;
  if (!("type" in method) || method.type !== "terminal" || !agentCommand) return undefined;
  const methodEnv = "env" in method ? stringRecord(method.env) : undefined;
  return {
    command: agentCommand.command,
    args: [...(agentCommand.args ?? []), ...("args" in method ? stringArray(method.args) : [])],
    ...(agentCommand.env || methodEnv ? { env: { ...agentCommand.env, ...methodEnv } } : {}),
  };
}

function unsupportedAuthReason(type: RelayAuthMethodType, terminal?: RelayAuthTerminalCommand): string | undefined {
  if (type === "agent") return undefined;
  if (type === "env_var") {
    return "Relay cannot pass new environment variables to an already-running ACP agent.";
  }
  if (!terminal) return "Relay cannot run this terminal ACP auth method because no command was advertised.";
  return "Relay does not support terminal ACP auth methods yet.";
}

function relayAuthMethod(method: AuthMethod, agentCommand?: RelayAuthTerminalAgentCommand): RelayAuthMethod {
  const type = authMethodType(method);
  const vars = relayAuthEnvVars(method);
  const terminal = terminalCommandForAuthMethod(method, agentCommand);
  const supported = type === "agent" || (type === "terminal" && Boolean(terminal));
  return {
    id: method.id,
    name: method.name,
    description: singleLineStringOrUndefined(method.description),
    type,
    link: authMethodLink(method),
    ...(vars.length > 0 ? { vars } : {}),
    ...(terminal ? { terminal } : {}),
    supported,
    ...(supported ? {} : { unsupportedReason: unsupportedAuthReason(type, terminal) }),
  };
}

export function agentLifecycleCapabilitiesForInitializeResult(
  initializeResult: InitializeResponse | unknown,
): AgentLifecycleCapabilities {
  const capabilities = agentCapabilitiesFromInitializeResult(initializeResult);
  if (!capabilities) {
    return {
      loadSession: false,
      listSessions: false,
      deleteSessions: false,
      forkSession: false,
      resumeSession: false,
      closeSession: false,
      additionalDirectories: false,
    };
  }
  const sessionCapabilities = sessionCapabilitiesFromAgentCapabilities(capabilities);
  return {
    loadSession: capabilities.loadSession === true,
    listSessions: supportsSessionCapability(sessionCapabilities?.list),
    deleteSessions: supportsSessionCapability(sessionCapabilities?.delete),
    forkSession: supportsSessionCapability(sessionCapabilities?.fork),
    resumeSession: supportsSessionCapability(sessionCapabilities?.resume),
    closeSession: supportsSessionCapability(sessionCapabilities?.close),
    additionalDirectories: supportsSessionCapability(sessionCapabilities?.additionalDirectories),
  };
}

export function supportsImagePromptsForInitializeResult(initializeResult: InitializeResponse | unknown): boolean {
  return (
    promptCapabilitiesFromAgentCapabilities(agentCapabilitiesFromInitializeResult(initializeResult))?.image === true
  );
}

export function authMethodsForInitializeResult(
  initializeResult: InitializeResponse | unknown,
  agentCommand?: RelayAuthTerminalAgentCommand,
): RelayAuthMethod[] {
  if (!isRecord(initializeResult) || !Array.isArray(initializeResult.authMethods)) return [];
  return initializeResult.authMethods.flatMap((method) =>
    isRecord(method) && typeof method.id === "string" && typeof method.name === "string"
      ? [relayAuthMethod(method as AuthMethod, agentCommand)]
      : [],
  );
}

export function supportsAuthLogoutForInitializeResult(initializeResult: InitializeResponse | unknown): boolean {
  return supportsSessionCapability(
    authCapabilitiesFromAgentCapabilities(agentCapabilitiesFromInitializeResult(initializeResult))?.logout,
  );
}
