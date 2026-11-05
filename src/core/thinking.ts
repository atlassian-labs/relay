export const THINKING_CONFIG_CATEGORY = "thought_level";

export type ThinkingLevel = string;

export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return parseThinkingLevel(value) !== undefined;
}

export function isThinkingConfigCategory(value: unknown): value is typeof THINKING_CONFIG_CATEGORY {
  return value === THINKING_CONFIG_CATEGORY;
}

export function isThinkingConfigOption(category: unknown, id?: unknown): boolean {
  return category === THINKING_CONFIG_CATEGORY || id === THINKING_CONFIG_CATEGORY;
}

export function thinkingLevelLabel(thinkingLevel: ThinkingLevel): string {
  return thinkingLevel;
}
