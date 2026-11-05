import type { AcpSessionInfo } from "../../acp/client";
import { readAltaSessionListMeta } from "../../acp/profiles/alta";
import {
  nextBlockId,
  type ChatBlock,
  type SessionCommandOption,
  type SessionConfigOptionState,
  type SessionConfigSelectOption,
  type SessionConfigValue,
  type SessionModeOption,
  type SessionModelOption,
  type SessionThinkingLevelOption,
} from "../state";
import type { AppStateContextValue } from "./app-state";
import { createUsage } from "../../core/types";
import { isThinkingConfigOption, parseThinkingLevel, thinkingLevelLabel } from "../../core/thinking";
import { nowMs } from "../../platform/time";

export function formatSessionAge(updatedAt?: string | null): string {
  if (!updatedAt) return "unknown";
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return "unknown";

  const diffMs = Math.max(0, nowMs() - ts);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (diffMs < minute) return "now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h`;
  if (diffMs < week) return `${Math.floor(diffMs / day)}d`;
  return `${Math.floor(diffMs / week)}w`;
}

export function getSessionWorkspaceLabel(session: AcpSessionInfo): string {
  if (!session.cwd) return "";
  const normalized = session.cwd.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

export function sessionListLabel(session: AcpSessionInfo): string {
  const baseTitle = session.title?.trim() || session.sessionId;
  return baseTitle.replace(/\r\n|\n|\r/g, "\\n");
}

function altaSessionListDetail(session: AcpSessionInfo): string | undefined {
  const meta = readAltaSessionListMeta(session);
  if (meta?.cwdExists === false) return "missing workspace";
  return meta?.workspaceScope === "same-project" ? "same project" : undefined;
}

function sessionListDescriptionDetail(session: AcpSessionInfo): string {
  return [getSessionWorkspaceLabel(session), altaSessionListDetail(session)].filter(Boolean).join(" · ");
}

export function sessionListDescriptionColumns(session: AcpSessionInfo): readonly string[] {
  const age = formatSessionAge(session.updatedAt);
  return [age === "unknown" ? "" : age, sessionListDescriptionDetail(session)];
}

export function sessionListDescription(session: AcpSessionInfo): string {
  return sessionListDescriptionColumns(session).filter(Boolean).join(" · ");
}

export function resetSessionState(app: AppStateContextValue) {
  app.clearBlocks();
  app.setState("fileChanges", []);
  app.setState("totalUsage", createUsage());
  app.setState("lastUsage", null);
  app.setState("contextTokens", null);
  app.setState("turn", 0);
  app.setState("toolCallCount", 0);
  app.setState("generationSeconds", 0);
  app.setState("elapsedSeconds", 0);
  app.setState("lastAcpActivityKind", null);
  app.setState("lastAcpActivityLabel", "");
  app.setState("lastAcpActivityAt", null);
  app.setState("latestPromptTitleIntent", null);
  app.setState("statusText", "");
  app.setState("running", false);
  app.setState("spinnerActive", false);
  app.setState("spinnerLabel", "");
  app.setCurrentBlockId(null);
  app.setState("startupTip", "");
  app.setState("statusHint", null);
  app.setState("thinkingLevel", "");
  app.setState("thinkingConfigId", "");
  app.setState("availableThinkingLevels", []);
  app.setState("availableCommands", []);
  app.setState("sessionConfigOptions", []);
  app.setState("pendingQueue", []);
  app.setState("pendingUserBashResults", []);
  app.setState("userBashMode", false);
  app.setState("userBashRunning", false);
}

export function addWelcomeBlocks(addBlock: (block: ChatBlock) => void, _cwd: string) {
  addBlock({
    type: "info",
    id: nextBlockId(),
    content: "",
    variant: "session",
  });
}

export type SessionCapabilitiesResult = {
  readonly configOptions?: unknown;
  readonly models?: unknown;
  readonly modes?: unknown;
  readonly availableCommands?: unknown;
};

type ModelCapabilities = {
  readonly currentModelId?: unknown;
  readonly availableModels?: unknown;
};

type ModeCapabilities = {
  readonly currentModeId?: unknown;
  readonly availableModes?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asModelCapabilities(value: unknown): ModelCapabilities {
  return asRecord(value) ?? {};
}

function asModeCapabilities(value: unknown): ModeCapabilities {
  return asRecord(value) ?? {};
}

function stringField(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function toSessionConfigValue(value: unknown): SessionConfigValue | undefined {
  return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number"
    ? value
    : undefined;
}

function normalizeSessionConfigSelectOption(value: unknown): SessionConfigSelectOption | null {
  const entry = asRecord(value);
  if (!entry) return null;
  const optionValue = stringField(entry.value) ?? stringField(entry.id) ?? stringField(entry.modelId);
  if (!optionValue) return null;
  return {
    value: optionValue,
    name: stringField(entry.name) ?? optionValue,
    description: typeof entry.description === "string" ? entry.description : undefined,
  };
}

function normalizeSessionConfigSelectOptions(options: unknown): SessionConfigSelectOption[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((entry) => {
    const group = asRecord(entry);
    const groupOptions = group && Array.isArray(group.options) ? group.options : null;
    return (groupOptions ?? [entry]).flatMap((option) => normalizeSessionConfigSelectOption(option) ?? []);
  });
}

function normalizeSessionConfigOption(value: unknown): SessionConfigOptionState | null {
  const entry = asRecord(value);
  if (!entry) return null;
  const id = stringField(entry.id) ?? "";
  const category = stringField(entry.category);
  if (!id && !category) return null;
  const type = stringField(entry.type) ?? (Array.isArray(entry.options) ? "select" : "unknown");
  const currentValue = toSessionConfigValue(entry.currentValue);
  return {
    id,
    name: (stringField(entry.name) ?? id) || category || type,
    description: typeof entry.description === "string" ? entry.description : undefined,
    category,
    type,
    ...(currentValue !== undefined ? { currentValue } : {}),
    options: normalizeSessionConfigSelectOptions(entry.options),
    raw: { ...entry },
  };
}

export function normalizeSessionConfigOptions(configOptions: unknown): SessionConfigOptionState[] {
  if (!Array.isArray(configOptions)) return [];
  return configOptions.flatMap((entry) => normalizeSessionConfigOption(entry) ?? []);
}

export function sessionConfigOptionByCategory(
  configOptions: readonly SessionConfigOptionState[],
  category: string,
): SessionConfigOptionState | null {
  return configOptions.find((option) => option.category === category) ?? null;
}

function sessionConfigOptionByCategoryOrId(
  configOptions: readonly SessionConfigOptionState[],
  category: string,
  legacyId: string,
): SessionConfigOptionState | null {
  return (
    sessionConfigOptionByCategory(configOptions, category) ??
    configOptions.find((option) => option.id === legacyId) ??
    null
  );
}

function toSessionModelOption(value: unknown): SessionModelOption | null {
  const entry = asRecord(value);
  if (!entry) return null;
  const modelId =
    typeof entry.modelId === "string"
      ? entry.modelId
      : typeof entry.value === "string"
        ? entry.value
        : typeof entry.id === "string"
          ? entry.id
          : typeof entry.fullId === "string"
            ? entry.fullId
            : null;
  if (!modelId) return null;
  return {
    modelId,
    name: typeof entry.name === "string" ? entry.name : modelId,
    description: typeof entry.description === "string" ? entry.description : undefined,
  };
}

function toConfigModelOption(value: SessionConfigSelectOption): SessionModelOption {
  return {
    modelId: value.value,
    name: value.name,
    description: value.description,
  };
}

function modelConfigOption(configOptions: readonly SessionConfigOptionState[]): SessionConfigOptionState | null {
  return sessionConfigOptionByCategoryOrId(configOptions, "model", "model");
}

function configOptionId(option: SessionConfigOptionState | null): string | null {
  const id = option?.id.trim() ?? "";
  return id || null;
}

function legacyModelConfigId(models: ModelCapabilities): string {
  return typeof models.currentModelId === "string" || Array.isArray(models.availableModels) ? "model" : "";
}

function thinkingConfigOption(configOptions: readonly SessionConfigOptionState[]): SessionConfigOptionState | null {
  return (
    configOptions.find(
      (option) =>
        isThinkingConfigOption(option.category, option.id) &&
        option.type === "select" &&
        configOptionId(option) !== null,
    ) ?? null
  );
}

function toThinkingLevelOption(value: unknown): SessionThinkingLevelOption | null {
  const entry = asRecord(value);
  if (!entry) return null;
  const id = parseThinkingLevel(entry.value) ?? parseThinkingLevel(entry.id);
  if (!id) return null;
  return {
    id,
    name: typeof entry.name === "string" ? entry.name : thinkingLevelLabel(id),
    description: typeof entry.description === "string" ? entry.description : undefined,
  };
}

function toSessionModeOption(value: unknown): SessionModeOption | null {
  const entry = asRecord(value);
  if (!entry || typeof entry.id !== "string") return null;
  return {
    id: entry.id,
    name: typeof entry.name === "string" ? entry.name : entry.id,
    description: typeof entry.description === "string" ? entry.description : undefined,
  };
}

function toSessionCommandOption(value: unknown): SessionCommandOption | null {
  const entry = asRecord(value);
  if (!entry || typeof entry.name !== "string" || !entry.name) return null;
  return {
    name: entry.name,
    description: typeof entry.description === "string" ? entry.description : "",
  };
}

function clearModelState(app: AppStateContextValue): void {
  app.setState("modelConfigId", "");
  app.setState("availableModels", []);
  app.setState("modelId", "");
}

function applyModelConfigState(
  app: AppStateContextValue,
  modelConfig: SessionConfigOptionState | null,
  legacyModels: ModelCapabilities,
  options: { readonly replace?: boolean } = {},
): void {
  const applyCurrentModelId = (modelId: string) => {
    app.setState("modelId", modelId);
  };

  if (modelConfig) {
    app.setState("modelConfigId", configOptionId(modelConfig) ?? "");
    app.setState(
      "availableModels",
      modelConfig.options.map((entry) => toConfigModelOption(entry)),
    );
    if (typeof modelConfig.currentValue === "string") applyCurrentModelId(modelConfig.currentValue);
    else if (options.replace) app.setState("modelId", "");
    return;
  }

  app.setState("modelConfigId", legacyModelConfigId(legacyModels));
  app.setState(
    "availableModels",
    Array.isArray(legacyModels.availableModels)
      ? legacyModels.availableModels.flatMap((entry) => toSessionModelOption(entry) ?? [])
      : [],
  );
  if (typeof legacyModels.currentModelId === "string") applyCurrentModelId(legacyModels.currentModelId);
  else if (options.replace) app.setState("modelId", "");
}

function applyThinkingConfigState(app: AppStateContextValue, thinkingConfig: SessionConfigOptionState | null): void {
  if (thinkingConfig) {
    app.setState("thinkingConfigId", configOptionId(thinkingConfig) ?? "");
    app.setState(
      "availableThinkingLevels",
      thinkingConfig.options.flatMap((entry) => toThinkingLevelOption(entry) ?? []),
    );
    app.setState("thinkingLevel", parseThinkingLevel(thinkingConfig.currentValue) ?? "");
    return;
  }

  app.setState("thinkingConfigId", "");
  app.setState("availableThinkingLevels", []);
  app.setState("thinkingLevel", "");
}

export function applySessionConfigOptions(app: AppStateContextValue, configOptions: unknown): void {
  const previousHadModelConfig = modelConfigOption(app.state.sessionConfigOptions) !== null;
  const normalizedConfigOptions = normalizeSessionConfigOptions(configOptions);
  const nextModelConfig = modelConfigOption(normalizedConfigOptions);
  app.setState("sessionConfigOptions", normalizedConfigOptions);
  if (nextModelConfig) applyModelConfigState(app, nextModelConfig, {});
  else if (previousHadModelConfig) clearModelState(app);
  applyThinkingConfigState(app, thinkingConfigOption(normalizedConfigOptions));
}

function updateStoredSessionConfigOptionValue(
  app: AppStateContextValue,
  optionId: string,
  value: unknown,
): SessionConfigOptionState | null {
  const existing = app.state.sessionConfigOptions.find((option) => option.id === optionId) ?? null;
  if (!existing) return null;
  const currentValue = toSessionConfigValue(value);
  if (currentValue === undefined) return existing;
  app.setState("sessionConfigOptions", (options) =>
    options.map((option) =>
      option.id === optionId ? { ...option, currentValue, raw: { ...option.raw, currentValue } } : option,
    ),
  );
  return { ...existing, currentValue, raw: { ...existing.raw, currentValue } };
}

export function sessionCapabilitiesWithConfigOptionValue(
  capabilities: SessionCapabilitiesResult | undefined,
  optionId: string,
  value: unknown,
): SessionCapabilitiesResult | null {
  const currentValue = toSessionConfigValue(value);
  if (!optionId || currentValue === undefined) return null;
  const configOptions = normalizeSessionConfigOptions(capabilities?.configOptions);
  let matched = false;
  const nextConfigOptions = configOptions.map((option) => {
    if (option.id !== optionId) return option;
    matched = true;
    return { ...option, currentValue, raw: { ...option.raw, currentValue } };
  });
  if (!matched) return null;
  return { ...(capabilities ?? {}), configOptions: nextConfigOptions };
}

export function sessionCapabilitiesWithConfigOptionUpdate(
  capabilities: SessionCapabilitiesResult | undefined,
  update: unknown,
): SessionCapabilitiesResult | null {
  const data = asRecord(update);
  if (!data) return null;
  if ("configOptions" in data && data.configOptions !== undefined) {
    return { ...(capabilities ?? {}), configOptions: data.configOptions };
  }

  const optionId = stringField(data.optionId) ?? stringField(data.id);
  if (!optionId) return null;
  const optionRecord = asRecord(data.option);
  const value = data.value ?? optionRecord?.value;
  return sessionCapabilitiesWithConfigOptionValue(capabilities, optionId, value);
}

export function applySessionConfigOptionUpdate(app: AppStateContextValue, update: unknown): boolean {
  const data = asRecord(update);
  if (!data) return false;
  if (Array.isArray(data.configOptions)) {
    applySessionConfigOptions(app, data.configOptions);
    return true;
  }

  const optionId = stringField(data.optionId) ?? stringField(data.id);
  if (!optionId) return false;
  const optionRecord = asRecord(data.option);
  const value = data.value ?? optionRecord?.value;
  const storedOption = updateStoredSessionConfigOptionValue(app, optionId, value);
  if (storedOption) {
    if (storedOption.category === "model" && typeof value === "string") {
      app.setState("modelId", value);
    } else if (isThinkingConfigOption(storedOption.category, storedOption.id)) {
      app.setState("thinkingLevel", parseThinkingLevel(value) ?? "");
    }
    return true;
  }

  const modelConfig = sessionConfigOptionByCategory(app.state.sessionConfigOptions, "model");
  const modelConfigId = configOptionId(modelConfig) ?? app.state.modelConfigId;
  if (modelConfigId && optionId === modelConfigId && typeof value === "string") {
    app.setState("modelId", value);
    return true;
  }

  const thinkingConfig = app.state.sessionConfigOptions.find((option) =>
    isThinkingConfigOption(option.category, option.id),
  );
  const thinkingConfigId = configOptionId(thinkingConfig ?? null) ?? app.state.thinkingConfigId;
  if (thinkingConfigId && optionId === thinkingConfigId) {
    app.setState("thinkingLevel", parseThinkingLevel(value) ?? "");
    return true;
  }

  return false;
}

export interface ApplySessionCapabilitiesOptions {
  readonly replace?: boolean;
}

function applyModeCapabilities(
  app: AppStateContextValue,
  modes: ModeCapabilities,
  options: ApplySessionCapabilitiesOptions,
): void {
  app.setState(
    "availableModes",
    Array.isArray(modes.availableModes)
      ? modes.availableModes.flatMap((entry) => toSessionModeOption(entry) ?? [])
      : [],
  );
  if (typeof modes.currentModeId === "string") app.setState("modeId", modes.currentModeId);
  else if (options.replace) app.setState("modeId", "");
}

export function applySessionCapabilities(
  app: AppStateContextValue,
  sessionResult: SessionCapabilitiesResult | undefined,
  options: ApplySessionCapabilitiesOptions = {},
) {
  const replace = options.replace === true;

  if (sessionResult?.configOptions !== undefined) {
    const previousHadModelConfig = modelConfigOption(app.state.sessionConfigOptions) !== null;
    const configOptions = normalizeSessionConfigOptions(sessionResult.configOptions);
    const modelConfig = modelConfigOption(configOptions);
    app.setState("sessionConfigOptions", configOptions);
    if (modelConfig || sessionResult.models !== undefined || replace) {
      applyModelConfigState(app, modelConfig, asModelCapabilities(sessionResult.models), options);
    } else if (previousHadModelConfig) {
      clearModelState(app);
    }
    applyThinkingConfigState(app, thinkingConfigOption(configOptions));
  } else {
    if (replace) {
      app.setState("sessionConfigOptions", []);
      applyThinkingConfigState(app, null);
    }
    if (sessionResult?.models !== undefined) {
      applyModelConfigState(app, null, asModelCapabilities(sessionResult.models), options);
    } else if (replace) {
      clearModelState(app);
    }
  }

  if (sessionResult?.modes !== undefined) {
    applyModeCapabilities(app, asModeCapabilities(sessionResult.modes), options);
  } else if (replace) {
    applyModeCapabilities(app, {}, options);
  }

  if (sessionResult?.availableCommands !== undefined) {
    app.setState(
      "availableCommands",
      Array.isArray(sessionResult.availableCommands)
        ? sessionResult.availableCommands.flatMap((entry) => toSessionCommandOption(entry) ?? [])
        : [],
    );
  } else if (replace) {
    app.setState("availableCommands", []);
  }
}

export * as SessionContext from "./session";
