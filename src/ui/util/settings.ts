import { CONFIG_SETTINGS, type ConfigSetting, type EditableConfigKey } from "../../config/schema";
import type { Config } from "../../config";
import { getPluginSettingRaw } from "../../config";
import type { RelayPluginInfo, RelayPluginSettingDefinition } from "../../plugins/types";
import { coercePluginSettingValue } from "../../plugins/types";
import type { ListItem } from "../autocomplete";
import type { SessionConfigOptionState } from "../state";
import { isThoughtLevelConfigOption, REASONING_EFFORT_TITLE } from "./reasoning-effort";

export type SettingsSubmenuId = "themes" | "notifications";

export type AcpConfigOptionValueItem = {
  readonly type: "acp-config-option-value";
  readonly option: SessionConfigOptionState;
  readonly value: string;
};

export type PluginSettingEntry = {
  readonly plugin: RelayPluginInfo;
  readonly key: string;
  readonly definition: RelayPluginSettingDefinition;
};

export type SettingsItem =
  | { type: "setting"; setting: ConfigSetting }
  | { type: "submenu"; id: SettingsSubmenuId; title: string; description: string }
  | { type: "acp-config-option"; option: SessionConfigOptionState }
  | {
      type: "plugin-setting";
      plugin: RelayPluginInfo;
      key: string;
      definition: RelayPluginSettingDefinition;
      currentValue: boolean | number | string;
    };

const SETTINGS_MENU_KEYS = new Set<EditableConfigKey>([
  "ui.theme",
  "notifications.terminal_enabled",
  "notifications.sound_enabled",
  "notifications.volume",
]);

export type SettingValueChoice = {
  readonly value: boolean | number | string;
  readonly description?: string;
};

const NATIVE_ACP_CONFIG_OPTION_IDS = new Set(["mode", "model"]);
const NATIVE_ACP_CONFIG_OPTION_CATEGORIES = new Set(["mode", "model"]);
const REASONING_EFFORT_CAPTION = "choose how much reasoning effort the agent uses before responding";

export const SETTING_VALUE_CHOICES: Partial<Record<EditableConfigKey, readonly SettingValueChoice[]>> = {
  "ui.tool_result_preview_lines": [0, 1, 5, 10, 15].map((value) => ({ value })),
  "ui.thinking_preview_lines": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0].map((value) => ({ value })),
  "ui.sticky_prompt_header_lines": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0].map((value) => ({ value })),
  "ui.prompt_marker": [
    { value: ">", description: "simple ASCII default marker" },
    { value: "❯", description: "zsh-style marker" },
    { value: "#", description: "hash marker" },
    { value: "›", description: "minimal chevron marker" },
    { value: "$", description: "classic shell marker" },
    { value: "", description: "hide the prompt marker" },
  ],
  "ui.selection_marker": [
    { value: "→", description: "right arrow default marker" },
    { value: "›", description: "minimal chevron marker" },
    { value: "❯", description: "zsh-style chevron marker" },
    { value: ">", description: "simple ASCII marker" },
    { value: "•", description: "bullet marker" },
    { value: "", description: "hide the selection marker" },
  ],
  "ui.editor_style": [
    { value: "codex", description: "unframed composer with a prompt marker" },
    { value: "pi", description: "agent-colored top and bottom composer borders" },
  ],
  "notifications.volume": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((value) => ({ value })),
  "ui.terminal_title_prompt_source": [
    { value: "smart", description: "Prefer the latest meaningful prompt; ignore low-signal follow-ups" },
    { value: "first", description: "Always use the first user prompt in the thread" },
    { value: "last", description: "Always use the latest user prompt in the thread" },
  ],
};

export function getConfigValue(config: Config, key: EditableConfigKey): boolean | number | string {
  switch (key) {
    case "ui.theme":
      return config.ui.theme;
    case "ui.thread_worktree_location":
      return config.ui.thread_worktree_location;
    case "ui.terminal_title_prompt_source":
      return config.ui.terminal_title_prompt_source;
    case "ui.prompt_marker":
      return config.ui.prompt_marker;
    case "ui.selection_marker":
      return config.ui.selection_marker;
    case "ui.editor_style":
      return config.ui.editor_style;
    case "ui.mermaid_rendering":
      return config.ui.mermaid_rendering;
    case "ui.tool_result_preview_lines":
      return config.ui.tool_result_preview_lines;
    case "ui.thinking_preview_lines":
      return config.ui.thinking_preview_lines;
    case "ui.show_thinking":
      return config.ui.show_thinking;
    case "ui.sticky_prompt_header_lines":
      return config.ui.sticky_prompt_header_lines;
    case "ui.succinct_tool_results":
      return config.ui.succinct_tool_results;
    case "ui.show_tips":
      return config.ui.show_tips;
    case "ui.vim_keybindings":
      return config.ui.vim_keybindings;
    case "notifications.terminal_enabled":
      return config.notifications.terminal_enabled;
    case "notifications.sound_enabled":
      return config.notifications.sound_enabled;
    case "notifications.volume":
      return config.notifications.volume;
    case "ui.slash_panel_position":
      return config.ui.slash_panel_position;
    case "telemetry.analytics_enabled":
      return config.telemetry.analytics_enabled;
  }
}

export function formatSettingValue(setting: ConfigSetting, value: boolean | number | string): string {
  if (setting.type === "boolean") return value ? "on" : "off";
  if (setting.key === "notifications.volume" && typeof value === "number") return `${Math.round(value * 100)}%`;
  if (setting.key === "ui.thinking_preview_lines" && value === 0) return "no truncation";
  if (setting.key === "ui.sticky_prompt_header_lines" && value === 0) return "disabled";
  if (setting.key === "ui.tool_result_preview_lines" && value === 0) return "off";
  if ((setting.key === "ui.prompt_marker" || setting.key === "ui.selection_marker") && value === "") return "none";
  return String(value);
}

function formatSettingsCaption(description: string): string {
  return description.toLowerCase().replace(/[.。]+$/, "");
}

export function formatAcpConfigOptionTitle(option: SessionConfigOptionState): string {
  if (isThoughtLevelConfigOption(option)) return REASONING_EFFORT_TITLE;
  return option.name;
}

export function formatAcpConfigOptionValue(option: SessionConfigOptionState, value: string): string {
  return option.options.find((choice) => choice.value === value)?.name ?? value;
}

export function formatAcpConfigOptionCaption(option: SessionConfigOptionState): string {
  const description = option.description?.trim();
  if (isThoughtLevelConfigOption(option) && (!description || description.toLowerCase() === option.name.toLowerCase())) {
    return REASONING_EFFORT_CAPTION;
  }
  return formatSettingsCaption(description || option.name);
}

export function buildAcpConfigOptionValueItems(option: SessionConfigOptionState): ListItem<AcpConfigOptionValueItem>[] {
  const currentValue = typeof option.currentValue === "string" ? option.currentValue : "";
  return option.options.map((choice) => ({
    value: { type: "acp-config-option-value", option, value: choice.value },
    label: choice.name || choice.value,
    description: choice.description ?? "",
    active: choice.value === currentValue,
  }));
}

export function formatPluginSettingValue(
  definition: RelayPluginSettingDefinition,
  value: boolean | number | string,
): string {
  if (definition.type === "boolean") return value ? "on" : "off";
  return String(value);
}

export function nextPluginSettingValue(
  current: boolean | number | string,
  definition: RelayPluginSettingDefinition,
): boolean | number | string {
  switch (definition.type) {
    case "boolean":
      return !current;
    case "choice": {
      const choices = definition.choices?.() ?? [];
      if (choices.length === 0) return current;
      const currentIndex = typeof current === "string" ? choices.indexOf(current) : -1;
      return choices[(currentIndex + 1) % choices.length];
    }
    case "integer": {
      const min = definition.min ?? 0;
      const max = definition.max;
      const next = (typeof current === "number" ? current : Number(definition.default)) + 1;
      return max !== undefined && next > max ? min : next;
    }
    case "number": {
      const min = definition.min ?? 0;
      const max = definition.max;
      const step = 0.1;
      const next =
        Math.round(((typeof current === "number" ? current : Number(definition.default)) + step) * 100) / 100;
      return max !== undefined && next > max ? min : next;
    }
  }
}

function settingListItem(config: Config, setting: ConfigSetting): ListItem<SettingsItem> {
  const value = getConfigValue(config, setting.key);
  return {
    value: { type: "setting", setting },
    label: `${setting.title.toLowerCase()}: ${formatSettingValue(setting, value)}`,
    description: formatSettingsCaption(setting.description),
    active: setting.type === "boolean" && value === true,
  };
}

function sortSettingsItems(items: ListItem<SettingsItem>[]): ListItem<SettingsItem>[] {
  return [...items].sort((left, right) => left.label.localeCompare(right.label));
}

function acpConfigOptionListItem(option: SessionConfigOptionState): ListItem<SettingsItem> {
  const title = formatAcpConfigOptionTitle(option);
  const currentValue = typeof option.currentValue === "string" ? option.currentValue : "";
  return {
    value: { type: "acp-config-option", option },
    label: `${title.toLowerCase()}: ${formatAcpConfigOptionValue(option, currentValue)}`,
    description: formatAcpConfigOptionCaption(option),
  };
}

function isGenericSettingsAcpConfigOption(option: SessionConfigOptionState): boolean {
  if (option.type !== "select" || option.options.length === 0) return false;
  if (NATIVE_ACP_CONFIG_OPTION_IDS.has(option.id)) return false;
  if (option.category && NATIVE_ACP_CONFIG_OPTION_CATEGORIES.has(option.category)) return false;
  if (isThoughtLevelConfigOption(option)) return false;
  return true;
}

export function buildNotificationSettingsItems(config: Config): ListItem<SettingsItem>[] {
  const notificationKeys = new Set<EditableConfigKey>([
    "notifications.terminal_enabled",
    "notifications.sound_enabled",
    "notifications.volume",
  ]);
  return sortSettingsItems(
    CONFIG_SETTINGS.filter((setting) => notificationKeys.has(setting.key)).map((setting) =>
      settingListItem(config, setting),
    ),
  );
}

export function buildSettingsItems(
  config: Config,
  pluginSettings: PluginSettingEntry[] = [],
  options: { acpConfigOptions?: readonly SessionConfigOptionState[] } = {},
): ListItem<SettingsItem>[] {
  const settingsItems = CONFIG_SETTINGS.filter((setting) => !SETTINGS_MENU_KEYS.has(setting.key)).map((setting) =>
    settingListItem(config, setting),
  );

  const themeItem: ListItem<SettingsItem> = {
    value: {
      type: "submenu",
      id: "themes",
      title: "Themes",
      description: "choose the UI theme",
    },
    label: `themes: ${config.ui.theme}`,
    description: "choose the UI theme",
  };

  const notificationsItem: ListItem<SettingsItem> = {
    value: {
      type: "submenu",
      id: "notifications",
      title: "Notifications",
      description: "configure notification channels",
    },
    label: "notifications",
    description: "configure notification channels",
  };

  const acpConfigItems = (options.acpConfigOptions ?? [])
    .filter((option) => isGenericSettingsAcpConfigOption(option))
    .map((option) => acpConfigOptionListItem(option));

  const pluginSettingItems: ListItem<SettingsItem>[] = pluginSettings.map(({ plugin, key, definition }) => {
    const raw = getPluginSettingRaw(plugin.id, plugin.name, key);
    const currentValue = coercePluginSettingValue(raw, definition);
    return {
      value: { type: "plugin-setting" as const, plugin, key, definition, currentValue },
      label: `${plugin.name}: ${definition.title.toLowerCase()}: ${formatPluginSettingValue(definition, currentValue)}`,
      description: formatSettingsCaption(definition.description),
      active: definition.type === "boolean" && currentValue === true,
    };
  });

  return [
    ...sortSettingsItems([themeItem, notificationsItem, ...acpConfigItems, ...settingsItems]),
    ...sortSettingsItems(pluginSettingItems),
  ];
}

function nextFromChoices(current: number, choices: readonly SettingValueChoice[]): number {
  const values = choices.map((choice) => choice.value).filter((value): value is number => typeof value === "number");
  const currentIndex = values.indexOf(current);
  if (currentIndex < 0) return values[0] ?? current;
  return values[(currentIndex + 1) % values.length] ?? current;
}

export function nextSettingValue(config: Config, setting: ConfigSetting): boolean | number | string {
  const current = getConfigValue(config, setting.key);
  switch (setting.type) {
    case "boolean":
      return !current;
    case "choice": {
      const choices = setting.choices?.() ?? [];
      if (choices.length === 0) return current;
      const currentIndex = typeof current === "string" ? choices.indexOf(current) : -1;
      return choices[(currentIndex + 1) % choices.length];
    }
    case "integer": {
      const valueChoices = SETTING_VALUE_CHOICES[setting.key];
      if (valueChoices && typeof current === "number") return nextFromChoices(current, valueChoices);
      const min = setting.min ?? 0;
      const max = setting.max;
      const next = (typeof current === "number" ? current : Number(setting.default)) + 1;
      return max !== undefined && next > max ? min : next;
    }
    case "number": {
      const valueChoices = SETTING_VALUE_CHOICES[setting.key];
      if (valueChoices && typeof current === "number") return nextFromChoices(current, valueChoices);
      const min = setting.min ?? 0;
      const max = setting.max;
      const step = setting.key === "notifications.volume" ? 0.1 : 1;
      const next = Math.round(((typeof current === "number" ? current : Number(setting.default)) + step) * 100) / 100;
      return max !== undefined && next > max ? min : next;
    }
  }
}

export function nextAcpConfigOptionValue(option: SessionConfigOptionState): string {
  const current = typeof option.currentValue === "string" ? option.currentValue : "";
  const currentIndex = option.options.findIndex((choice) => choice.value === current);
  return option.options[(currentIndex + 1) % option.options.length]?.value ?? current;
}
