import { isThinkingConfigOption, parseThinkingLevel } from "../core/thinking";

export interface SessionConfigurationResult {
  readonly configOptions?: unknown;
  readonly models?: unknown;
  readonly sessionId?: string;
}

type NormalizedSelectOption = {
  readonly value: string;
};

type NormalizedConfigOption = {
  readonly id: string;
  readonly category?: string;
  readonly type: string;
  readonly currentValue?: unknown;
  readonly options: readonly NormalizedSelectOption[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function normalizeSelectOptions(value: unknown): NormalizedSelectOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = isRecord(entry) ? entry : null;
    const entries = record && Array.isArray(record.options) ? record.options : [entry];
    return entries.flatMap((candidate) => {
      if (!isRecord(candidate)) return [];
      const optionValue = stringValue(candidate.value) ?? stringValue(candidate.id) ?? stringValue(candidate.modelId);
      return optionValue ? [{ value: optionValue }] : [];
    });
  });
}

function normalizeConfigOptions(value: unknown): NormalizedConfigOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = stringValue(entry.id) ?? "";
    const category = stringValue(entry.category);
    if (!id && !category) return [];
    return [
      {
        id,
        ...(category ? { category } : {}),
        type: stringValue(entry.type) ?? (Array.isArray(entry.options) ? "select" : "unknown"),
        ...(Object.hasOwn(entry, "currentValue") ? { currentValue: entry.currentValue } : {}),
        options: normalizeSelectOptions(entry.options),
      },
    ];
  });
}

function modelConfigOption(result: SessionConfigurationResult | undefined): NormalizedConfigOption | undefined {
  const options = normalizeConfigOptions(result?.configOptions);
  return options.find((entry) => entry.category === "model") ?? options.find((entry) => entry.id === "model");
}

function thinkingConfigOption(result: SessionConfigurationResult | undefined): NormalizedConfigOption | undefined {
  return normalizeConfigOptions(result?.configOptions).find(
    (entry) => isThinkingConfigOption(entry.category, entry.id) && entry.type === "select",
  );
}

function hasLegacyModelCapabilities(models: unknown): boolean {
  return isRecord(models) && (typeof models.currentModelId === "string" || Array.isArray(models.availableModels));
}

export function currentModelIdFromSessionResult(result: SessionConfigurationResult | undefined): string | undefined {
  const currentValue = modelConfigOption(result)?.currentValue;
  if (typeof currentValue === "string") return currentValue;
  return isRecord(result?.models) ? stringValue(result.models.currentModelId) : undefined;
}

export function modelConfigIdFromSessionResult(result: SessionConfigurationResult | undefined): string | undefined {
  const id = stringValue(modelConfigOption(result)?.id);
  if (id) return id;
  return hasLegacyModelCapabilities(result?.models) ? "model" : undefined;
}

export function availableModelIdsFromSessionResult(result: SessionConfigurationResult | undefined): string[] {
  const config = modelConfigOption(result);
  if (config) return config.options.map((entry) => entry.value);
  if (!isRecord(result?.models) || !Array.isArray(result.models.availableModels)) return [];
  return result.models.availableModels.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id =
      stringValue(entry.modelId) ?? stringValue(entry.id) ?? stringValue(entry.value) ?? stringValue(entry.fullId);
    return id ? [id] : [];
  });
}

export function currentThinkingLevelFromSessionResult(
  result: SessionConfigurationResult | undefined,
): string | undefined {
  return parseThinkingLevel(thinkingConfigOption(result)?.currentValue);
}

export function thinkingConfigIdFromSessionResult(result: SessionConfigurationResult | undefined): string | undefined {
  return stringValue(thinkingConfigOption(result)?.id);
}

export function availableThinkingLevelsFromSessionResult(result: SessionConfigurationResult | undefined): string[] {
  return (
    thinkingConfigOption(result)?.options.flatMap((entry) => {
      const level = parseThinkingLevel(entry.value);
      return level ? [level] : [];
    }) ?? []
  );
}
