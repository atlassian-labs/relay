import {
  getAgentPreferredModel,
  getAgentPreferredThinkingLevel,
  setAgentPreferredModel,
  setAgentPreferredThinkingLevel,
} from "../../config";
import { isAcpAuthRequiredError } from "../../acp/client";
import type { AcpClient } from "../../acp/client";
import type { RelayAuthEnvVar, RelayAuthMethod } from "../../acp/capabilities";
import type { ThinkingLevel } from "../../core/thinking";
import { parseThinkingLevel, thinkingLevelLabel } from "../../core/thinking";
import { getRelayLogger } from "../../logging/logger";
import { AcpRequestError } from "../../effect/errors";
import { acpClientCapabilityFlags } from "../../application/acp-orchestration";
import { nextBlockId, type useApp } from "../state";
import {
  availableModelIdsFromSessionResult,
  availableThinkingLevelsFromSessionResult,
  currentModelIdFromSessionResult,
  currentThinkingLevelFromSessionResult,
  modelConfigIdFromSessionResult,
  thinkingConfigIdFromSessionResult,
} from "./acp-session";
import { store } from "./runtime-store";
import { showToast } from "./toast-controller";
import {
  applySessionCapabilities,
  sessionCapabilitiesWithConfigOptionValue,
  type SessionCapabilitiesResult,
} from "../context/session";

export { AGENT_CONNECT_TIMEOUT_MS, connectAcpClientWithTimeout } from "../../application/acp-orchestration";

export function applyAcpClientCapabilities(app: ReturnType<typeof useApp>, client: AcpClient | null): void {
  const capabilities = acpClientCapabilityFlags(client);
  app.setState("sessionForkAvailable", capabilities.sessionForkAvailable);
  app.setState("sessionListAvailable", capabilities.sessionListAvailable);
  app.setState("sessionLoadAvailable", capabilities.sessionLoadAvailable);
  app.setState("sessionResumeAvailable", capabilities.sessionResumeAvailable);
  app.setState("authMethods", [...capabilities.authMethods]);
  app.setState("authLogoutAvailable", capabilities.authLogoutAvailable);
  if (!client) {
    app.setState("authStatus", "unknown");
    app.setState("authMessage", "");
  }
}

export function supportedAcpAuthMethods(app: ReturnType<typeof useApp>): RelayAuthMethod[] {
  return app.state.authMethods.filter((method) => method.supported);
}

function authEnvVarLabel(envVar: RelayAuthEnvVar): string {
  return envVar.label && envVar.label !== envVar.name ? `${envVar.name} (${envVar.label})` : envVar.name;
}

function formatAuthEnvVars(envVars: readonly RelayAuthEnvVar[], optional: boolean): string | null {
  const matching = envVars.filter((envVar) => envVar.optional === optional).map(authEnvVarLabel);
  if (matching.length === 0) return null;
  return `${optional ? "Optional" : "Required"} environment variables: ${matching.join(", ")}`;
}

export function acpAuthMethodInstructions(method: RelayAuthMethod): string {
  if (method.supported) return `${method.name} can be started with /login ${method.id}.`;

  const lines = [`${method.name} (${method.id})`];
  if (method.description) lines.push(method.description);

  if (method.type === "env_var") {
    lines.push(method.unsupportedReason ?? "Relay cannot complete this env_var ACP auth method automatically.");
    const envVars = method.vars ?? [];
    const required = formatAuthEnvVars(envVars, false);
    const optional = formatAuthEnvVars(envVars, true);
    if (required) lines.push(required);
    if (optional) lines.push(optional);
    if (method.link) lines.push(`Credential URL: ${method.link}`);
    lines.push(`Set the variables in the agent process environment, restart Relay, then run /login ${method.id}.`);
    return lines.join("\n");
  }

  if (method.type === "terminal") {
    lines.push(method.unsupportedReason ?? "Relay does not support terminal ACP auth methods yet.");
    lines.push("Terminal auth requires ACP terminal client support, which Relay does not advertise yet.");
    return lines.join("\n");
  }

  lines.push(method.unsupportedReason ?? `ACP auth method "${method.id}" is not supported.`);
  return lines.join("\n");
}

export function acpAuthMethodsUnavailableMessage(methods: readonly RelayAuthMethod[]): string {
  if (methods.length === 0) return "This ACP agent did not advertise any auth methods.";
  const unsupported = methods.filter((method) => !method.supported);
  if (unsupported.length === 0) return "This ACP agent did not advertise any supported auth methods.";
  return [
    "This ACP agent only advertised auth methods Relay cannot complete automatically.",
    ...unsupported.map(acpAuthMethodInstructions),
  ].join("\n\n");
}

export function markAcpAuthRequired(app: ReturnType<typeof useApp>, error: unknown): boolean {
  if (!isAcpAuthRequiredError(error)) return false;
  const message = error instanceof Error ? error.message : "Authentication required";
  app.setState("authStatus", "required");
  app.setState("authMessage", message);
  return true;
}

export function acpAuthRequiredBlockContent(error: unknown): string {
  const message = error instanceof Error ? error.message : "Authentication required";
  return `${message}\nRun /login to authenticate, then retry your prompt.`;
}

export type AcpTerminalAuthRunner = (method: RelayAuthMethod) => Promise<void>;

export async function authenticateWithAcpMethod(
  app: ReturnType<typeof useApp>,
  client: AcpClient,
  methodId: string,
  runTerminalAuth?: AcpTerminalAuthRunner,
): Promise<RelayAuthMethod> {
  const method = client.authMethods().find((entry) => entry.id === methodId);
  if (!method) return Promise.reject(new Error(`ACP auth method "${methodId}" was not advertised`));
  if (!method.supported) {
    return Promise.reject(new Error(acpAuthMethodInstructions(method)));
  }
  if (method.type === "terminal") {
    if (!method.terminal) return Promise.reject(new Error(acpAuthMethodInstructions(method)));
    if (!runTerminalAuth) return Promise.reject(new Error("Terminal ACP auth is not available in this Relay context."));
    await runTerminalAuth(method);
  }
  await client.authenticate(method.id);
  app.setState("authStatus", "authenticated");
  app.setState("authMessage", "");
  return method;
}

export async function logoutAcpAuth(app: ReturnType<typeof useApp>, client: AcpClient): Promise<void> {
  if (!client.supportsAuthLogout()) return Promise.reject(new Error("ACP agent did not advertise logout support"));
  await client.logout();
  app.setState("authStatus", "unknown");
  app.setState("authMessage", "");
}

export interface ApplyPreferredSessionOptions {
  updateAppState?: boolean;
}

const PREFERRED_MODEL_APPLY_RETRY_DELAYS_MS = [25, 100, 250, 500] as const;

function acpRequestDetails(error: AcpRequestError): string {
  const data = error.data;
  if (!data || typeof data !== "object" || !("details" in data)) return "";
  const details = data.details;
  return typeof details === "string" ? details : "";
}

function isTransientAcpInternalError(error: unknown): boolean {
  if (!(error instanceof AcpRequestError)) return false;
  if (error.code !== undefined && error.code !== -32603) return false;
  return `${error.message}\n${acpRequestDetails(error)}`.toLowerCase().includes("internal error");
}

async function setPreferredSessionModelWithRetry(
  client: AcpClient,
  agentName: string,
  preferredModel: string,
  modelConfigId: string,
  sessionId: string | undefined,
): Promise<SessionCapabilitiesResult> {
  let failureCount = 0;
  while (true) {
    try {
      return await client.setSessionModel(preferredModel, modelConfigId, sessionId);
    } catch (err) {
      const delayMs = PREFERRED_MODEL_APPLY_RETRY_DELAYS_MS[failureCount];
      if (delayMs === undefined || !isTransientAcpInternalError(err)) return Promise.reject(err);
      failureCount += 1;
      getRelayLogger().warn("acp.session.preferred_model.retry", {
        agentName,
        sessionId: sessionId ?? null,
        modelId: preferredModel,
        configId: modelConfigId,
        attempt: failureCount + 1,
        delayMs,
        error: String(err),
      });
      await Bun.sleep(delayMs);
    }
  }
}

export async function applyPreferredModelForNewSession(
  app: ReturnType<typeof useApp>,
  client: AcpClient,
  agentName: string,
  sessionResult: { configOptions?: unknown; models?: unknown; sessionId?: string } | undefined,
  preferredModelOverride?: string,
  targetSessionId?: string,
  options: ApplyPreferredSessionOptions = {},
): Promise<SessionCapabilitiesResult | undefined> {
  const updateAppState = options.updateAppState ?? true;
  const preferredModel = preferredModelOverride ?? getAgentPreferredModel(agentName);
  if (!preferredModel) return;
  const availableModelIds = updateAppState
    ? app.state.availableModels.map((model) => model.modelId)
    : availableModelIdsFromSessionResult(sessionResult);
  if (availableModelIds.length > 0 && !availableModelIds.includes(preferredModel)) {
    try {
      setAgentPreferredModel(agentName, undefined);
    } catch (err) {
      if (updateAppState) {
        showToast(`Preferred model is unavailable, and stale preference was not cleared: ${err}`, "warning", 4000);
      }
    }
    if (updateAppState) {
      app.addBlock({
        type: "info",
        id: nextBlockId(),
        content: `Preferred model is no longer available; using ${app.state.modelId || "the default model"}.`,
        variant: "warning",
      });
    }
    return;
  }
  if (currentModelIdFromSessionResult(sessionResult) === preferredModel) return;
  const modelConfigId = updateAppState ? app.state.modelConfigId : modelConfigIdFromSessionResult(sessionResult);
  if (!modelConfigId) {
    if (updateAppState) {
      app.addBlock({
        type: "info",
        id: nextBlockId(),
        content: "Preferred model could not be applied because this agent did not advertise a model switcher.",
        variant: "warning",
      });
    }
    return;
  }
  const sessionId = targetSessionId ?? sessionResult?.sessionId;
  try {
    const nextSessionResult = await setPreferredSessionModelWithRetry(
      client,
      agentName,
      preferredModel,
      modelConfigId,
      sessionId,
    );
    const appliedSessionResult =
      nextSessionResult.configOptions === undefined
        ? (sessionCapabilitiesWithConfigOptionValue(
            { ...nextSessionResult, configOptions: sessionResult?.configOptions },
            modelConfigId,
            preferredModel,
          ) ?? nextSessionResult)
        : nextSessionResult;
    if (!updateAppState) return appliedSessionResult;
    if (sessionId && client.sessionId !== sessionId) return undefined;
    applySessionCapabilities(app, appliedSessionResult);
    app.setState("modelId", preferredModel);
    return appliedSessionResult;
  } catch (err) {
    if (!updateAppState) return;
    if (sessionId && client.sessionId !== sessionId) return;
    app.addBlock({
      type: "info",
      id: nextBlockId(),
      content: `Preferred model could not be applied; using ${app.state.modelId || "the default model"}: ${err}`,
      variant: "warning",
    });
  }
}

export async function applyPreferredThinkingLevelForNewSession(
  app: ReturnType<typeof useApp>,
  client: AcpClient,
  agentName: string,
  sessionResult: { configOptions?: unknown; sessionId?: string } | undefined,
  preferredThinkingLevelOverride?: ThinkingLevel,
  targetSessionId?: string,
  options: ApplyPreferredSessionOptions = {},
): Promise<SessionCapabilitiesResult | undefined> {
  const updateAppState = options.updateAppState ?? true;
  // The launch `--thinking-level` flag (a one-off override) wins over the configured preferred thinking level.
  const launchThinkingLevel = parseThinkingLevel(store.launchThinkingLevelOverride);
  const configThinkingLevel = preferredThinkingLevelOverride ?? getAgentPreferredThinkingLevel(agentName);
  const targetThinkingLevel = launchThinkingLevel ?? configThinkingLevel;
  if (!targetThinkingLevel) return;
  const fromLaunch = launchThinkingLevel !== undefined;

  const thinkingConfigId = updateAppState
    ? app.state.thinkingConfigId
    : thinkingConfigIdFromSessionResult(sessionResult);
  const availableThinkingLevels = updateAppState
    ? app.state.availableThinkingLevels.map((thinkingLevel) => thinkingLevel.id)
    : availableThinkingLevelsFromSessionResult(sessionResult);
  if (!thinkingConfigId || availableThinkingLevels.length === 0) return;
  if (!availableThinkingLevels.includes(targetThinkingLevel)) {
    // Clear a stale *configured* preference, but never persist/clear for a one-off launch override.
    if (!fromLaunch) {
      try {
        setAgentPreferredThinkingLevel(agentName, undefined);
      } catch (err) {
        if (updateAppState) {
          showToast(
            `Preferred thinking level is unavailable, and stale preference was not cleared: ${err}`,
            "warning",
            4000,
          );
        }
      }
    }
    if (updateAppState) {
      app.addBlock({
        type: "info",
        id: nextBlockId(),
        content: fromLaunch
          ? `Requested thinking level "${thinkingLevelLabel(targetThinkingLevel)}" is not available; using ${
              app.state.thinkingLevel ? thinkingLevelLabel(app.state.thinkingLevel) : "the default thinking level"
            }.`
          : `Preferred thinking level is no longer available; using ${
              app.state.thinkingLevel ? thinkingLevelLabel(app.state.thinkingLevel) : "the default thinking level"
            }.`,
        variant: "warning",
      });
    }
    return;
  }
  if (currentThinkingLevelFromSessionResult(sessionResult) === targetThinkingLevel) return;
  const sessionId = targetSessionId ?? sessionResult?.sessionId;
  try {
    const nextSessionResult = await client.setSessionThinkingLevel(targetThinkingLevel, thinkingConfigId, sessionId);
    const appliedSessionResult =
      nextSessionResult.configOptions === undefined
        ? (sessionCapabilitiesWithConfigOptionValue(
            { ...nextSessionResult, configOptions: sessionResult?.configOptions },
            thinkingConfigId,
            targetThinkingLevel,
          ) ?? nextSessionResult)
        : nextSessionResult;
    if (!updateAppState) return appliedSessionResult;
    if (sessionId && client.sessionId !== sessionId) return undefined;
    applySessionCapabilities(app, appliedSessionResult);
    app.setState("thinkingLevel", targetThinkingLevel);
    return appliedSessionResult;
  } catch (err) {
    if (!updateAppState) return;
    if (sessionId && client.sessionId !== sessionId) return;
    app.addBlock({
      type: "info",
      id: nextBlockId(),
      content: `${fromLaunch ? "Requested" : "Preferred"} thinking level could not be applied; using ${
        app.state.thinkingLevel ? thinkingLevelLabel(app.state.thinkingLevel) : "the default thinking level"
      }: ${err}`,
      variant: "warning",
    });
  }
}
