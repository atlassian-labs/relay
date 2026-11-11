// ---------------------------------------------------------------------------
// Config system
// ---------------------------------------------------------------------------

import * as fs from "fs";
import * as path from "path";
import { getCacheDir, getConfigDir, getLegacyConfigDir, CONFIG_DIR_NAME } from "../platform/paths";
import * as toml from "toml";
import { Effect, type Scope } from "effect";
import { RelayError } from "../effect/errors";
import { getRelayLogger, parseRelayLogLevel, type RelayLogLevel } from "../logging/logger";
import { loadPromptTemplates, resetPromptTemplates } from "../prompt-templates";
import { normalizeBuiltinSlashCommandName } from "../core/slash-commands";
import { parseThinkingLevel, type ThinkingLevel } from "../core/thinking";
import {
  MAX_CHILD_SESSION_TASK_TYPES,
  MAX_CHILD_SESSION_TASK_TYPE_DESCRIPTION_LENGTH,
  MAX_CHILD_SESSION_TASK_TYPE_KEYWORDS,
  normalizeChildSessionTaskTypeKeyword,
  normalizeChildSessionTaskTypeName,
  type ChildSessionTaskType,
} from "../core/child-session-task-types";

import {
  builtinAgentCanonicalName,
  builtinAgentNames,
  isBuiltinAgentName,
  isBuiltinStockRunner,
  resolveBuiltinAgentRunner,
} from "./builtin-agents";
import { getConfigSetting, type EditableConfigKey } from "./schema";
import { type ColorsConfig, getTheme, getThemeIds, loadCustomThemes, resetCustomThemes } from "./themes";
import { writeTelemetryConsent } from "../telemetry-storage";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export { CONFIG_DIR_NAME, getCacheDir, getConfigDir, getLegacyConfigDir };
export {
  CHILD_SESSION_REMINDER_RELATIVE_PATH,
  DEFAULT_CHILD_SESSION_REMINDER_TEMPLATE,
  getChildSessionReminderTemplate,
  getChildSessionReminderTemplatePath,
  loadChildSessionReminderTemplate,
} from "../prompt-templates";

// ---------------------------------------------------------------------------
// Config schema interfaces
// ---------------------------------------------------------------------------

export interface MetaConfig {
  config_version: number;
}

export type AgentRunnerTransport = "stdio" | "websocket";
export type AgentRunnerWebSocketFraming = "json" | "ndjson";

export interface AgentRunnerConfig {
  command: string;
  args: string[];
  profile?: string;
  transport?: AgentRunnerTransport;
  url?: string;
  headers?: Record<string, string>;
  protocols?: string[];
  framing?: AgentRunnerWebSocketFraming;
  env?: Record<string, string>;
  preferred_model?: string;
  preferred_thinking_level?: ThinkingLevel;
}

export interface AgentsConfig {
  default: string;
  runners: Record<string, AgentRunnerConfig>;
}

export type TerminalTitlePromptSource = "smart" | "first" | "last";
export type EditorStyle = "codex" | "pi";
export type MermaidRenderingMode = "off" | "final" | "streaming";
export type SelectionMarker = "→" | "›" | "❯" | ">" | "•" | "";

export interface ToolCallGroupRuleConfig {
  tool_names: string[];
  singular: string;
  plural: string;
}

export interface ToolCallGroupsConfig {
  enabled: boolean;
  rules: ToolCallGroupRuleConfig[];
}

export interface UIConfig {
  theme: string;
  thread_worktree_location: "relay" | "repo";
  terminal_title_prompt_source: TerminalTitlePromptSource;
  prompt_marker: string;
  selection_marker: SelectionMarker;
  editor_style: EditorStyle;
  mermaid_rendering: MermaidRenderingMode;
  tool_result_preview_lines: number;
  thinking_preview_lines: number;
  show_thinking: boolean;
  succinct_tool_results: boolean;
  slash_panel_position: "bottom" | "top";
  show_tips: boolean;
  disabled_builtin_slash_commands: string[];
  vim_keybindings: boolean;
  sticky_prompt_header_lines: number;
  tool_call_groups: ToolCallGroupsConfig;
}

export interface NotificationsConfig {
  terminal_enabled: boolean;
  sound_enabled: boolean;
  volume: number;
}

export interface PluginsConfig {
  enabled: boolean;
  allow_project_plugins: boolean;
  paths: string[];
  trusted_workspaces: string[];
  disabled: string[];
}

export interface LoggingConfig {
  level: RelayLogLevel;
}

export interface TelemetryConfig {
  analytics_enabled: boolean;
}

export interface ConfigSchema {
  meta: MetaConfig;
  ui: UIConfig;
  notifications: NotificationsConfig;
  agents: AgentsConfig;
  plugins: PluginsConfig;
  logging: LoggingConfig;
  telemetry: TelemetryConfig;
  task_types: Record<string, ChildSessionTaskType>;
  plugin_settings: Record<string, Record<string, unknown>>;
}

export interface ConfigLoadResult {
  filePath: string;
  raw: Record<string, unknown> | null;
  config: Config;
  parseError: Error | null;
  warnings: string[];
  content: string | null;
}

export type ConfigChangeSource = "reload" | "watch" | "write";

export interface ConfigChange {
  config: Config;
  previousConfig: Config | null;
  parseError: Error | null;
  changed: boolean;
  source: ConfigChangeSource;
  warnings: string[];
}

export type ConfigListener = (change: ConfigChange) => void;

// ---------------------------------------------------------------------------
// Built-in default config data
// ---------------------------------------------------------------------------

export const CURRENT_CONFIG_VERSION = 3;

// Built-in agents need no runner entry, so a fresh config defines none.
const DEFAULT_AGENT_NAME = "rovo";

const DEFAULT_PROMPT_MARKER = ">";
const MAX_PROMPT_MARKER_LENGTH = 4;

const DEFAULT_CONFIG_DATA: ConfigSchema = {
  meta: {
    config_version: CURRENT_CONFIG_VERSION,
  },
  ui: {
    theme: "catppuccin-mocha",
    thread_worktree_location: "relay",
    terminal_title_prompt_source: "smart",
    prompt_marker: DEFAULT_PROMPT_MARKER,
    selection_marker: "→",
    editor_style: "codex",
    mermaid_rendering: "streaming",
    tool_result_preview_lines: 5,
    thinking_preview_lines: 1,
    show_thinking: true,
    succinct_tool_results: true,
    slash_panel_position: "bottom",
    show_tips: true,
    disabled_builtin_slash_commands: [],
    vim_keybindings: false,
    sticky_prompt_header_lines: 3,
    tool_call_groups: {
      enabled: false,
      rules: [],
    },
  },
  notifications: {
    terminal_enabled: true,
    sound_enabled: true,
    volume: 0.3,
  },
  plugins: {
    enabled: true,
    allow_project_plugins: false,
    paths: [],
    trusted_workspaces: [],
    disabled: [],
  },
  logging: {
    level: "info",
  },
  telemetry: {
    analytics_enabled: false,
  },
  task_types: {},
  agents: {
    default: DEFAULT_AGENT_NAME,
    runners: {},
  },
  plugin_settings: {},
};

// ---------------------------------------------------------------------------
// Default TOML template (written when no config file exists)
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_TOML = `[meta]
config_version = ${CURRENT_CONFIG_VERSION}

[ui]
theme = "catppuccin-mocha"
thread_worktree_location = "relay"
terminal_title_prompt_source = "smart"
prompt_marker = "${DEFAULT_PROMPT_MARKER}"
selection_marker = "→"
editor_style = "codex"
tool_result_preview_lines = 5
thinking_preview_lines = 1
show_thinking = true
succinct_tool_results = true
slash_panel_position = "bottom"
show_tips = true
disabled_builtin_slash_commands = []
vim_keybindings = false
sticky_prompt_header_lines = 3

# Consecutive configured tools can be folded into one summary row. Disabled by default.
# [ui.tool_call_groups]
# enabled = false
#
# [[ui.tool_call_groups.rules]]
# tool_names = ["read"]
# singular = "Read {count} file"
# plural = "Read {count} files"
#
# [[ui.tool_call_groups.rules]]
# tool_names = ["find"]
# singular = "Found {count} path"
# plural = "Found {count} paths"
#
# [[ui.tool_call_groups.rules]]
# tool_names = ["grep"]
# singular = "Searched {count} pattern"
# plural = "Searched {count} patterns"

[notifications]
terminal_enabled = true
sound_enabled = true
volume = 0.3

[logging]
level = "info"

[telemetry]
analytics_enabled = false

[plugins]
enabled = true
allow_project_plugins = false
paths = []
trusted_workspaces = []
disabled = []

[agents]
default = "${DEFAULT_AGENT_NAME}"
`;

const REMOVED_BUNDLED_PLUGIN_IDS = new Set([
  "bundled:a-shumer",
  "bundled:j-gonzalez",
  "bundled:review",
  "bundled:handoff",
]);

function filterRemovedPluginIds(pluginIds: readonly string[]): string[] {
  return pluginIds.filter((pluginId) => !REMOVED_BUNDLED_PLUGIN_IDS.has(pluginId));
}

// ---------------------------------------------------------------------------
// TOML serialization helpers
// ---------------------------------------------------------------------------

function tomlEscapeString(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

function tomlFormatValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return tomlEscapeString(value);
  if (Array.isArray(value)) return "[" + value.map(tomlFormatValue).join(", ") + "]";
  throw new TypeError(`Unsupported config value type for TOML serialization: ${typeof value}`); // effect-shape-allow: config serializer guards impossible internal value shapes.
}

function isTomlTableArray(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))
  );
}

function tomlDumpDict(data: Record<string, unknown>, table?: string, arrayTable = false): string {
  const lines: string[] = [];
  const scalarItems: Array<[string, unknown]> = [];
  const dictItems: Array<[string, Record<string, unknown>]> = [];
  const arrayTableItems: Array<[string, Record<string, unknown>[]]> = [];

  for (const [key, value] of Object.entries(data)) {
    if (isTomlTableArray(value)) {
      arrayTableItems.push([key, value]);
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      dictItems.push([key, value as Record<string, unknown>]);
    } else {
      scalarItems.push([key, value]);
    }
  }

  if (table !== undefined) lines.push(arrayTable ? `[[${table}]]` : `[${table}]`);
  for (const [key, value] of scalarItems) lines.push(`${key} = ${tomlFormatValue(value)}`);

  const appendNested = (nested: string): void => {
    if (!nested) return;
    if (lines.length > 0) lines.push("");
    lines.push(nested);
  };

  for (const [key, value] of dictItems) {
    appendNested(tomlDumpDict(value, table ? `${table}.${key}` : key));
  }
  for (const [key, values] of arrayTableItems) {
    const nestedTable = table ? `${table}.${key}` : key;
    for (const value of values) appendNested(tomlDumpDict(value, nestedTable, true));
  }

  return lines.join("\n");
}

function serializeConfigToml(data: Record<string, unknown>): string {
  return tomlDumpDict(data) + "\n";
}

function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

function deepMerge(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const merged = deepClone(base);
  for (const [key, value] of Object.entries(overrides)) {
    const currentValue = merged[key];
    if (
      currentValue !== null &&
      typeof currentValue === "object" &&
      !Array.isArray(currentValue) &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      merged[key] = deepMerge(currentValue as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      merged[key] = deepClone(value);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Config warnings
// ---------------------------------------------------------------------------

const _configWarnings: string[] = [];

function recordConfigWarning(message: string): void {
  _configWarnings.push(message);
}

function warningRecorder(warnings?: string[], options: { recordGlobal?: boolean } = {}): (message: string) => void {
  return (message: string) => {
    warnings?.push(message);
    if (options.recordGlobal !== false) recordConfigWarning(message);
  };
}

export function consumeConfigWarnings(): string[] {
  const warnings = [..._configWarnings];
  _configWarnings.length = 0;
  return warnings;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function section(data: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = data[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readBoolean(value: unknown, fallback: boolean, key: string, warn: (message: string) => void): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  warn(`Invalid boolean for ${key}; using ${fallback}.`);
  return fallback;
}

function readNumber(
  value: unknown,
  fallback: number,
  key: string,
  options: { min?: number; max?: number },
  warn: (message: string) => void,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warn(`Invalid number for ${key}; using ${fallback}.`);
    return fallback;
  }
  let next = value;
  if (options.min !== undefined) next = Math.max(options.min, next);
  if (options.max !== undefined) next = Math.min(options.max, next);
  return next;
}

function readInteger(
  value: unknown,
  fallback: number,
  key: string,
  options: { min?: number; max?: number },
  warn: (message: string) => void,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    warn(`Invalid integer for ${key}; using ${fallback}.`);
    return fallback;
  }
  return readNumber(value, fallback, key, options, warn);
}

function readTheme(value: unknown, fallback: string, key: string, warn: (message: string) => void): string {
  if (value === undefined) return fallback;
  if (typeof value === "string" && getThemeIds().includes(value)) return value;
  warn(`Invalid theme for ${key}; using ${fallback}.`);
  return fallback;
}

function hasTerminalControlCharacter(text: string): boolean {
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 32 || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function readPromptMarker(value: unknown, fallback: string, key: string, warn: (message: string) => void): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    warn(`Invalid prompt marker for ${key}; using ${fallback}.`);
    return fallback;
  }
  const marker = value.trim();
  if (
    (value !== "" && (!marker || marker !== value)) ||
    marker === "!" ||
    marker === "!!" ||
    [...marker].length > MAX_PROMPT_MARKER_LENGTH ||
    hasTerminalControlCharacter(marker)
  ) {
    warn(`Invalid prompt marker for ${key}; using ${fallback}.`);
    return fallback;
  }
  return marker;
}

function readStringArray(value: unknown, fallback: string[], key: string, warn: (message: string) => void): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) {
    warn(`Invalid string array for ${key}; using default value.`);
    return [...fallback];
  }
  const strings = value.filter((item): item is string => typeof item === "string");
  if (strings.length !== value.length) warn(`Invalid entries in ${key}; ignoring non-string values.`);
  return strings;
}

function readBuiltinSlashCommandNameArray(
  value: unknown,
  fallback: string[],
  key: string,
  warn: (message: string) => void,
): string[] {
  const values = readStringArray(value, fallback, key, warn);
  const normalized: string[] = [];
  for (const entry of values) {
    const commandName = normalizeBuiltinSlashCommandName(entry);
    if (!commandName) {
      warn(`Invalid slash command name in ${key}; ignoring ${JSON.stringify(entry)}.`);
      continue;
    }
    if (!normalized.includes(commandName)) normalized.push(commandName);
  }
  return normalized;
}

function readToolCallGroupsConfig(
  value: unknown,
  fallback: ToolCallGroupsConfig,
  warn: (message: string) => void,
): ToolCallGroupsConfig {
  if (value === undefined) {
    return {
      enabled: fallback.enabled,
      rules: fallback.rules.map((rule) => ({ ...rule, tool_names: [...rule.tool_names] })),
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warn("Invalid table for ui.tool_call_groups; using defaults.");
    return { enabled: fallback.enabled, rules: [] };
  }

  const data = value as Record<string, unknown>;
  const enabled = readBoolean(data.enabled, fallback.enabled, "ui.tool_call_groups.enabled", warn);
  if (data.rules !== undefined && !Array.isArray(data.rules)) {
    warn("Invalid array for ui.tool_call_groups.rules; ignoring rules.");
    return { enabled, rules: [] };
  }

  const rules: ToolCallGroupRuleConfig[] = [];
  const claimedNames = new Set<string>();
  for (const [index, rawRule] of (data.rules ?? []).entries()) {
    const key = `ui.tool_call_groups.rules[${index}]`;
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      warn(`Invalid table for ${key}; ignoring rule.`);
      continue;
    }
    const rule = rawRule as Record<string, unknown>;
    const toolNames = readStringArray(rule.tool_names, [], `${key}.tool_names`, warn)
      .map((name) => name.trim())
      .filter(Boolean);
    const singular = typeof rule.singular === "string" ? rule.singular.trim() : "";
    const plural = typeof rule.plural === "string" ? rule.plural.trim() : "";
    if (toolNames.length === 0) {
      warn(`${key}.tool_names must contain at least one non-empty tool name; ignoring rule.`);
      continue;
    }
    if ((singular.match(/\{count\}/g) ?? []).length !== 1 || (plural.match(/\{count\}/g) ?? []).length !== 1) {
      warn(`${key}.singular and ${key}.plural must each contain exactly one {count}; ignoring rule.`);
      continue;
    }
    const uniqueNames: string[] = [];
    for (const name of toolNames) {
      if (claimedNames.has(name)) {
        warn(`Duplicate tool name ${JSON.stringify(name)} in ${key}; first rule wins.`);
        continue;
      }
      claimedNames.add(name);
      if (!uniqueNames.includes(name)) uniqueNames.push(name);
    }
    if (uniqueNames.length > 0) rules.push({ tool_names: uniqueNames, singular, plural });
  }
  return { enabled, rules };
}

function readStringRecord(
  value: unknown,
  fallback: Record<string, string>,
  key: string,
  warn: (message: string) => void,
): Record<string, string> {
  if (value === undefined) return { ...fallback };
  if (!isRecord(value)) {
    warn(`Invalid string table for ${key}; using default value.`);
    return { ...fallback };
  }
  const entries: Array<[string, string]> = [];
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string") {
      entries.push([entryKey, entryValue]);
      continue;
    }
    warn(`Invalid entry in ${key}.${entryKey}; ignoring non-string value.`);
  }
  return Object.fromEntries(entries);
}

function validateAgentRunnerConfig(
  agentName: string,
  data: Record<string, unknown>,
  warn: (message: string) => void,
): AgentRunnerConfig | null {
  const transportRaw = typeof data.transport === "string" ? data.transport.trim() : "stdio";
  const transport: AgentRunnerTransport = transportRaw === "websocket" ? "websocket" : "stdio";
  if (transportRaw !== "stdio" && transportRaw !== "websocket") {
    warn(`Agent runner ${agentName} has invalid transport; using stdio.`);
  }

  const profile = typeof data.profile === "string" ? data.profile.trim() : "";
  const legacyRenderer = typeof data.renderer === "string" ? data.renderer.trim() : "";
  if (data.profile !== undefined && profile === "") {
    warn(`Agent runner ${agentName} has invalid profile; ignoring value.`);
  }
  if (data.renderer !== undefined && legacyRenderer === "") {
    warn(`Agent runner ${agentName} has invalid renderer; ignoring legacy value.`);
  }
  const configuredProfile = profile || legacyRenderer;
  const preferredModel = typeof data.preferred_model === "string" ? data.preferred_model.trim() : "";
  if (data.preferred_model !== undefined && preferredModel === "") {
    warn(`Agent runner ${agentName} has invalid preferred_model; ignoring value.`);
  }
  const preferredThinkingLevel = parseThinkingLevel(data.preferred_thinking_level);
  if (data.preferred_thinking_level !== undefined && !preferredThinkingLevel) {
    warn(`Agent runner ${agentName} has invalid preferred_thinking_level; ignoring value.`);
  }

  if (transport === "websocket") {
    const url = typeof data.url === "string" ? data.url.trim() : "";
    if (!url) {
      warn(`Agent runner ${agentName} is missing websocket url; ignoring runner.`);
      return null;
    }
    const headers = readStringRecord(data.headers, {}, `agents.runners.${agentName}.headers`, warn);
    const protocols = readStringArray(data.protocols, [], `agents.runners.${agentName}.protocols`, warn);
    const framingRaw = typeof data.framing === "string" ? data.framing.trim() : "json";
    const framing: AgentRunnerWebSocketFraming = framingRaw === "ndjson" ? "ndjson" : "json";
    if (framingRaw !== "json" && framingRaw !== "ndjson") {
      warn(`Agent runner ${agentName} has invalid framing; using json.`);
    }
    return {
      transport: "websocket",
      command: "",
      args: [],
      ...(configuredProfile ? { profile: configuredProfile } : {}),
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(protocols.length > 0 ? { protocols } : {}),
      ...(framing !== "json" ? { framing } : {}),
      ...(preferredModel ? { preferred_model: preferredModel } : {}),
      ...(preferredThinkingLevel ? { preferred_thinking_level: preferredThinkingLevel } : {}),
    };
  }

  const command = typeof data.command === "string" ? data.command.trim() : "";
  if (!command) {
    warn(`Agent runner ${agentName} is missing command; ignoring runner.`);
    return null;
  }
  const args = Array.isArray(data.args) ? data.args.map((value) => String(value)) : [];
  if (data.args !== undefined && !Array.isArray(data.args))
    warn(`Agent runner ${agentName} has invalid args; using [].`);
  const env = readStringRecord(data.env, {}, `agents.runners.${agentName}.env`, warn);
  return {
    command,
    args,
    ...(configuredProfile ? { profile: configuredProfile } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(preferredModel ? { preferred_model: preferredModel } : {}),
    ...(preferredThinkingLevel ? { preferred_thinking_level: preferredThinkingLevel } : {}),
  };
}

export function validateAgentsConfig(
  data: Record<string, unknown>,
  fallback: AgentsConfig,
  warn: (message: string) => void,
): AgentsConfig {
  const defaultAgent = typeof data.default === "string" ? data.default.trim() : fallback.default;
  if (data.default !== undefined && typeof data.default !== "string")
    warn(`Invalid string for agents.default; using ${fallback.default}.`);

  const runnersRaw = data.runners;
  const runnersRecord =
    runnersRaw && typeof runnersRaw === "object" && !Array.isArray(runnersRaw)
      ? (runnersRaw as Record<string, unknown>)
      : {};
  if (runnersRaw !== undefined && runnersRecord !== runnersRaw)
    warn("Invalid table for agents.runners; using default runners.");

  const runners: Record<string, AgentRunnerConfig> = {};
  for (const [name, value] of Object.entries(runnersRecord)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      warn(`Invalid agent runner config for ${name}; ignoring runner.`);
      continue;
    }
    const runner = validateAgentRunnerConfig(name, value as Record<string, unknown>, warn);
    if (runner) runners[name] = runner;
  }

  const finalRunners = Object.keys(runners).length > 0 ? runners : { ...fallback.runners };
  let finalDefault = defaultAgent;
  if (finalDefault && !finalRunners[finalDefault] && !isBuiltinAgentName(finalDefault)) {
    warn(`Unknown default agent ${finalDefault}; using ${fallback.default}.`);
    // A built-in fallback has no runner entry of its own, so accept it directly
    // rather than falling through to an arbitrary configured runner or "".
    finalDefault =
      finalRunners[fallback.default] || isBuiltinAgentName(fallback.default)
        ? fallback.default
        : (Object.keys(finalRunners)[0] ?? "");
  }

  return { default: finalDefault, runners: finalRunners };
}

function validateTaskTypesConfig(
  value: unknown,
  warn: (message: string) => void,
): Record<string, ChildSessionTaskType> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    warn("Invalid table for task_types; ignoring task types.");
    return {};
  }

  const result: Record<string, ChildSessionTaskType> = {};
  for (const [rawName, rawValue] of Object.entries(value).slice(0, MAX_CHILD_SESSION_TASK_TYPES)) {
    let name: string;
    try {
      name = normalizeChildSessionTaskTypeName(rawName);
    } catch {
      warn(`Invalid task type name ${JSON.stringify(rawName)}; ignoring task type.`);
      continue;
    }
    if (!isRecord(rawValue)) {
      warn(`Invalid task type ${name}; ignoring task type.`);
      continue;
    }
    const description = typeof rawValue.description === "string" ? rawValue.description.trim() : "";
    if (!description || [...description].length > MAX_CHILD_SESSION_TASK_TYPE_DESCRIPTION_LENGTH) {
      warn(
        `Task type ${name} requires a description of at most ${MAX_CHILD_SESSION_TASK_TYPE_DESCRIPTION_LENGTH} characters; ignoring task type.`,
      );
      continue;
    }
    const rawKeywords = Array.isArray(rawValue.keywords) ? rawValue.keywords : [];
    const keywords: string[] = [];
    for (const rawKeyword of rawKeywords.slice(0, MAX_CHILD_SESSION_TASK_TYPE_KEYWORDS)) {
      if (typeof rawKeyword !== "string") continue;
      try {
        const keyword = normalizeChildSessionTaskTypeKeyword(rawKeyword);
        if (!keywords.includes(keyword)) keywords.push(keyword);
      } catch {
        warn(`Invalid keyword in task_types.${name}.keywords; ignoring keyword.`);
      }
    }
    if (keywords.length === 0) {
      warn(`Task type ${name} requires at least one keyword; ignoring task type.`);
      continue;
    }
    const agent = typeof rawValue.agent === "string" ? rawValue.agent.trim() : "";
    const model = typeof rawValue.model === "string" ? rawValue.model.trim() : "";
    const thinkingLevel = parseThinkingLevel(rawValue.thinking_level);
    result[name] = {
      name,
      description,
      keywords,
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  }
  if (Object.keys(value).length > MAX_CHILD_SESSION_TASK_TYPES) {
    warn(`Only the first ${MAX_CHILD_SESSION_TASK_TYPES} task types are loaded.`);
  }
  return result;
}

function validateConfigSchema(
  data: Record<string, unknown>,
  warn: (message: string) => void = recordConfigWarning,
): ConfigSchema {
  const defaults = DEFAULT_CONFIG_DATA;
  const metaRaw = section(data, "meta");
  const uiRaw = section(data, "ui");
  const notifRaw = section(data, "notifications");
  const agentsRaw = section(data, "agents");
  const pluginsRaw = section(data, "plugins");
  const loggingRaw = section(data, "logging");

  return {
    meta: {
      config_version: readInteger(
        metaRaw.config_version,
        CURRENT_CONFIG_VERSION,
        "meta.config_version",
        { min: 1 },
        warn,
      ),
    },
    ui: {
      theme: readTheme(uiRaw.theme, defaults.ui.theme, "ui.theme", warn),
      thread_worktree_location: (() => {
        const raw = uiRaw.thread_worktree_location;
        if (typeof raw === "string" && (raw === "relay" || raw === "repo")) return raw;
        if (raw !== undefined)
          warn(`ui.thread_worktree_location: expected "relay" or "repo", got ${JSON.stringify(raw)}`);
        return defaults.ui.thread_worktree_location;
      })(),
      terminal_title_prompt_source: (() => {
        const raw = uiRaw.terminal_title_prompt_source;
        if (typeof raw === "string" && (raw === "smart" || raw === "first" || raw === "last")) return raw;
        if (raw !== undefined)
          warn(`ui.terminal_title_prompt_source: expected "smart", "first", or "last", got ${JSON.stringify(raw)}`);
        return defaults.ui.terminal_title_prompt_source;
      })(),
      prompt_marker: readPromptMarker(uiRaw.prompt_marker, defaults.ui.prompt_marker, "ui.prompt_marker", warn),
      selection_marker: (() => {
        const raw = uiRaw.selection_marker;
        if (raw === "→" || raw === "›" || raw === "❯" || raw === ">" || raw === "•" || raw === "") return raw;
        if (raw !== undefined)
          warn(`ui.selection_marker: expected "→", "›", "❯", ">", "•", or "", got ${JSON.stringify(raw)}`);
        return defaults.ui.selection_marker;
      })(),
      editor_style: (() => {
        const raw = uiRaw.editor_style;
        if (typeof raw === "string" && (raw === "codex" || raw === "pi")) return raw;
        if (raw !== undefined) warn(`ui.editor_style: expected "codex" or "pi", got ${JSON.stringify(raw)}`);
        return defaults.ui.editor_style;
      })(),
      mermaid_rendering: (() => {
        const raw = uiRaw.mermaid_rendering;
        if (typeof raw === "string" && (raw === "off" || raw === "final" || raw === "streaming")) return raw;
        if (raw !== undefined)
          warn(`ui.mermaid_rendering: expected "off", "final", or "streaming", got ${JSON.stringify(raw)}`);
        return defaults.ui.mermaid_rendering;
      })(),
      tool_result_preview_lines: readInteger(
        uiRaw.tool_result_preview_lines,
        defaults.ui.tool_result_preview_lines,
        "ui.tool_result_preview_lines",
        { min: 0 },
        warn,
      ),
      thinking_preview_lines: readInteger(
        uiRaw.thinking_preview_lines,
        defaults.ui.thinking_preview_lines,
        "ui.thinking_preview_lines",
        { min: 0, max: 10 },
        warn,
      ),
      show_thinking: readBoolean(uiRaw.show_thinking, defaults.ui.show_thinking, "ui.show_thinking", warn),
      succinct_tool_results: readBoolean(
        uiRaw.succinct_tool_results,
        defaults.ui.succinct_tool_results,
        "ui.succinct_tool_results",
        warn,
      ),
      slash_panel_position: (() => {
        const raw = uiRaw.slash_panel_position;
        if (typeof raw === "string" && (raw === "bottom" || raw === "top")) return raw;
        if (raw !== undefined) warn(`ui.slash_panel_position: expected "bottom" or "top", got ${JSON.stringify(raw)}`);
        return defaults.ui.slash_panel_position;
      })(),
      show_tips: readBoolean(uiRaw.show_tips, defaults.ui.show_tips, "ui.show_tips", warn),
      disabled_builtin_slash_commands: readBuiltinSlashCommandNameArray(
        uiRaw.disabled_builtin_slash_commands,
        defaults.ui.disabled_builtin_slash_commands,
        "ui.disabled_builtin_slash_commands",
        warn,
      ),
      vim_keybindings: readBoolean(uiRaw.vim_keybindings, defaults.ui.vim_keybindings, "ui.vim_keybindings", warn),
      sticky_prompt_header_lines: (() => {
        // Backward compat: accept the old boolean sticky_prompt_header key.
        const raw = uiRaw.sticky_prompt_header_lines ?? uiRaw.sticky_prompt_header;
        if (raw === true) return defaults.ui.sticky_prompt_header_lines;
        if (raw === false) return 0;
        return readInteger(
          raw,
          defaults.ui.sticky_prompt_header_lines,
          "ui.sticky_prompt_header_lines",
          { min: 0, max: 10 },
          warn,
        );
      })(),
      tool_call_groups: readToolCallGroupsConfig(uiRaw.tool_call_groups, defaults.ui.tool_call_groups, warn),
    },
    notifications: {
      terminal_enabled: readBoolean(
        notifRaw.terminal_enabled,
        defaults.notifications.terminal_enabled,
        "notifications.terminal_enabled",
        warn,
      ),
      sound_enabled: readBoolean(
        notifRaw.sound_enabled,
        defaults.notifications.sound_enabled,
        "notifications.sound_enabled",
        warn,
      ),
      volume: readNumber(
        notifRaw.volume,
        defaults.notifications.volume,
        "notifications.volume",
        { min: 0, max: 1 },
        warn,
      ),
    },
    plugins: {
      enabled: readBoolean(pluginsRaw.enabled, defaults.plugins.enabled, "plugins.enabled", warn),
      allow_project_plugins: readBoolean(
        pluginsRaw.allow_project_plugins,
        defaults.plugins.allow_project_plugins,
        "plugins.allow_project_plugins",
        warn,
      ),
      paths: readStringArray(pluginsRaw.paths, defaults.plugins.paths, "plugins.paths", warn),
      trusted_workspaces: readStringArray(
        pluginsRaw.trusted_workspaces,
        defaults.plugins.trusted_workspaces,
        "plugins.trusted_workspaces",
        warn,
      ),
      disabled: filterRemovedPluginIds(
        readStringArray(pluginsRaw.disabled, defaults.plugins.disabled, "plugins.disabled", warn),
      ),
    },
    logging: {
      level: (() => {
        const parsed = parseRelayLogLevel(loggingRaw.level);
        if (parsed) return parsed;
        if (loggingRaw.level !== undefined)
          warn(`Invalid logging level for logging.level; using ${defaults.logging.level}.`);
        return defaults.logging.level;
      })(),
    },
    telemetry: {
      analytics_enabled: readBoolean(
        section(data, "telemetry").analytics_enabled,
        defaults.telemetry.analytics_enabled,
        "telemetry.analytics_enabled",
        warn,
      ),
    },
    agents: validateAgentsConfig(agentsRaw, defaults.agents, warn),
    task_types: validateTaskTypesConfig(data.task_types, warn),
    plugin_settings: (() => {
      const raw = data.plugin_settings;
      if (!isRecord(raw)) return {};
      const result: Record<string, Record<string, unknown>> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (isRecord(value)) result[key] = value;
      }
      return result;
    })(),
  };
}

// ---------------------------------------------------------------------------
// Config class
// ---------------------------------------------------------------------------

export class Config {
  private _parsed: ConfigSchema;

  constructor(data: Record<string, unknown>, warn: (message: string) => void = recordConfigWarning) {
    const merged = Config.mergeWithDefaults(data);
    this._parsed = validateConfigSchema(merged, warn);
  }

  static mergeWithDefaults(data: Record<string, unknown>): Record<string, unknown> {
    return deepMerge(DEFAULT_CONFIG_DATA as unknown as Record<string, unknown>, data);
  }

  get ui(): UIConfig {
    return this._parsed.ui;
  }

  get notifications(): NotificationsConfig {
    return this._parsed.notifications;
  }

  get agents(): AgentsConfig {
    return this._parsed.agents;
  }

  get plugins(): PluginsConfig {
    return this._parsed.plugins;
  }

  get logging(): LoggingConfig {
    return this._parsed.logging;
  }

  get telemetry(): TelemetryConfig {
    return this._parsed.telemetry;
  }

  get task_types(): Record<string, ChildSessionTaskType> {
    return this._parsed.task_types;
  }

  get plugin_settings(): Record<string, Record<string, unknown>> {
    return this._parsed.plugin_settings;
  }

  /** Convenience accessor: resolved colors for the active theme. */
  get colors(): ColorsConfig {
    return getTheme(this._parsed.ui.theme).colors;
  }
}

// ---------------------------------------------------------------------------
// Config file paths / parsing
// ---------------------------------------------------------------------------

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Migrate legacy ~/.relay/ to the new XDG-compliant location.
 * Only runs when the legacy directory exists and the new one does not.
 */
function migrateConfigDir(): void {
  const newDir = getConfigDir();
  if (fs.existsSync(newDir)) return;
  const legacyDir = getLegacyConfigDir();
  if (!fs.existsSync(legacyDir)) return;

  fs.mkdirSync(path.dirname(newDir), { recursive: true });
  try {
    fs.renameSync(legacyDir, newDir);
  } catch {
    // Cross-device move: copy then remove.
    copyDirRecursive(legacyDir, newDir);
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
}

/**
 * Ensure the config directory exists, migrating from the legacy location if needed.
 * Idempotent — safe to call from all callers at all points.
 */
export function ensureConfigDir(): string {
  migrateConfigDir();
  const dir = getConfigDir();
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getConfigFilePath(): string {
  return path.join(getConfigDir(), "config.toml");
}

function ensureConfigFile(): string {
  const configFile = path.join(ensureConfigDir(), "config.toml");
  if (!fs.existsSync(configFile)) {
    fs.writeFileSync(configFile, DEFAULT_CONFIG_TOML, "utf-8");
  }
  return configFile;
}

function parseConfigFile(configFile: string): {
  raw: Record<string, unknown> | null;
  parseError: Error | null;
  content: string | null;
} {
  let text: string;
  try {
    text = fs.readFileSync(configFile, "utf-8");
  } catch (err) {
    return { raw: null, parseError: err instanceof Error ? err : new Error(String(err)), content: null };
  }

  try {
    return { raw: toml.parse(text) as Record<string, unknown>, parseError: null, content: text };
  } catch (err) {
    return { raw: null, parseError: err instanceof Error ? err : new Error(String(err)), content: text };
  }
}

function loadConfigResult(
  options: {
    fallbackConfig?: Config;
    createIfMissing?: boolean;
    reportParseError?: boolean;
    reportWarnings?: boolean;
    runMigrations?: boolean;
  } = {},
): ConfigLoadResult {
  const filePath = options.createIfMissing === false ? getConfigFilePath() : ensureConfigFile();
  const warnings: string[] = [];
  const warn = warningRecorder(warnings, { recordGlobal: options.reportWarnings !== false });
  if (options.reportWarnings !== false) {
    try {
      organizeConfigBackups(filePath);
    } catch (error) {
      warn(
        `Failed to organize config backups for ${filePath}: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }
  loadPromptTemplates(warn);
  const themeWarnings = loadCustomThemes(path.dirname(filePath));
  if (options.reportWarnings !== false) {
    for (const warning of themeWarnings) warn(warning);
  }
  const { raw, parseError, content } = parseConfigFile(filePath);
  let loadedContent = content;
  if (parseError) {
    const config = options.fallbackConfig ?? new Config({}, warn);
    if (options.reportParseError !== false) {
      warn(
        `Invalid config at ${filePath}: ${parseError}. ${options.fallbackConfig ? "Keeping previous runtime config." : "Falling back to built-in defaults."}`,
      );
      getRelayLogger().error("config.load.error", { filePath, error: parseError.message, warnings });
    }
    return { filePath, raw: null, config, parseError, warnings, content };
  }
  if (raw && content !== null && options.runMigrations !== false && options.reportWarnings !== false) {
    loadedContent = migrateConfigFileIfNeeded(filePath, raw, content, warn) ?? content;
  }
  return { filePath, raw, config: new Config(raw ?? {}, warn), parseError: null, warnings, content: loadedContent };
}

// ---------------------------------------------------------------------------
// Runtime config store
// ---------------------------------------------------------------------------

let _currentLoad: ConfigLoadResult | null = null;
const _configListeners = new Set<ConfigListener>();
function notifyConfigListeners(change: ConfigChange): void {
  for (const listener of [..._configListeners]) listener(change);
}

function maybeNotifyConfigListeners(change: ConfigChange, notifyUnchanged = false): void {
  if (change.changed || change.parseError || notifyUnchanged) notifyConfigListeners(change);
}

function configChangeFromLoads(
  previousLoad: ConfigLoadResult | null,
  nextLoad: ConfigLoadResult,
  source: ConfigChangeSource,
): ConfigChange {
  return {
    config: nextLoad.config,
    previousConfig: previousLoad?.config ?? null,
    parseError: nextLoad.parseError,
    changed: previousLoad?.content !== nextLoad.content,
    source,
    warnings: nextLoad.warnings,
  };
}

function commitConfigLoad(nextLoad: ConfigLoadResult, source: ConfigChangeSource): ConfigChange {
  const previousLoad = _currentLoad;
  _currentLoad = nextLoad;
  return configChangeFromLoads(previousLoad, nextLoad, source);
}

export function getConfig(): Config {
  if (_currentLoad === null) _currentLoad = loadConfigResult();
  return _currentLoad.config;
}

export function getConfigLoadResult(): ConfigLoadResult {
  if (_currentLoad === null) _currentLoad = loadConfigResult();
  return _currentLoad;
}

export function setConfig(config: Config): void {
  _currentLoad = {
    filePath: path.join(getConfigDir(), "config.toml"),
    raw: null,
    config,
    parseError: null,
    warnings: [],
    content: null,
  };
}

function loadCurrentConfig(options: { fallbackToPrevious: boolean; source: ConfigChangeSource }): ConfigChange {
  const previousConfig = _currentLoad?.config ?? null;
  const nextLoad = loadConfigResult({
    fallbackConfig: options.fallbackToPrevious ? (previousConfig ?? undefined) : undefined,
    createIfMissing: !options.fallbackToPrevious,
  });
  return commitConfigLoad(nextLoad, options.source);
}

export function reloadConfig(): Config {
  return loadCurrentConfig({ fallbackToPrevious: false, source: "reload" }).config;
}

export function loadConfigEffect(): Effect.Effect<ConfigLoadResult, RelayError> {
  return Effect.try({
    try: () => getConfigLoadResult(),
    catch: (cause) => new RelayError({ message: "Failed to load config", cause }),
  });
}

export function reloadConfigEffect(): Effect.Effect<Config, RelayError> {
  return Effect.try({
    try: reloadConfig,
    catch: (cause) => new RelayError({ message: "Failed to reload config", cause }),
  });
}

function reloadConfigAndNotify(options: {
  fallbackToPrevious: boolean;
  notifyUnchanged?: boolean;
  source: ConfigChangeSource;
}): Config {
  const change = loadCurrentConfig(options);
  maybeNotifyConfigListeners(change, options.notifyUnchanged);
  return change.config;
}

export function subscribeConfig(listener: ConfigListener): () => void {
  _configListeners.add(listener);
  return () => _configListeners.delete(listener);
}

export function resetConfig(): void {
  _currentLoad = null;
  _configWarnings.length = 0;
  _configListeners.clear();
  resetPromptTemplates();
  resetCustomThemes();
}

function normalizeMeta(data: Record<string, unknown>): void {
  let meta = data.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    meta = {};
    data.meta = meta;
  }
  meta.config_version = CURRENT_CONFIG_VERSION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeAgentRunnerProfiles(data: Record<string, unknown>): number {
  const agents = data.agents;
  if (!isRecord(agents) || !isRecord(agents.runners)) return 0;
  let changed = 0;
  for (const runner of Object.values(agents.runners)) {
    if (!isRecord(runner)) continue;
    const profile = typeof runner.profile === "string" && runner.profile.trim() ? runner.profile.trim() : "";
    const legacyRenderer = typeof runner.renderer === "string" && runner.renderer.trim() ? runner.renderer.trim() : "";
    if (!profile && legacyRenderer) {
      runner.profile = legacyRenderer;
      changed += 1;
    }
    if ("renderer" in runner) {
      delete runner.renderer;
      changed += 1;
    }
  }
  return changed;
}

function getMutableSection(data: Record<string, unknown>, key: string): Record<string, unknown> {
  const existingValue = data[key];
  if (isRecord(existingValue)) return existingValue;
  const value: Record<string, unknown> = {};
  data[key] = value;
  return value;
}

interface ConfigMigrationResult {
  fromVersion: number;
  toVersion: number;
  changes: string[];
}

const DEPRECATED_CONFIG_KEYS: Record<string, readonly string[]> = {
  ui: ["collapse_thinking", "agent_summaries"],
  notifications: ["enabled", "min_tool_calls", "min_duration_seconds", "terminal_method"],
};

function rawConfigVersion(data: Record<string, unknown>): number | null {
  const meta = data.meta;
  if (!isRecord(meta)) return null;
  const version = meta.config_version;
  if (typeof version !== "number" || !Number.isFinite(version) || !Number.isInteger(version)) return null;
  return Math.max(1, version);
}

function addMissingDefaults(
  data: Record<string, unknown>,
  sectionKey: "ui" | "notifications" | "plugins" | "logging" | "telemetry",
): number {
  const sectionDefaults = DEFAULT_CONFIG_DATA[sectionKey] as unknown as Record<string, unknown>;
  const sectionData = getMutableSection(data, sectionKey);
  let added = 0;
  for (const [key, value] of Object.entries(sectionDefaults)) {
    if (sectionData[key] !== undefined) continue;
    sectionData[key] = deepClone(value);
    added += 1;
  }
  return added;
}

function removeDeprecatedConfigKeys(data: Record<string, unknown>): number {
  let removed = 0;
  for (const [sectionKey, keys] of Object.entries(DEPRECATED_CONFIG_KEYS)) {
    const sectionData = data[sectionKey];
    if (!isRecord(sectionData)) continue;
    for (const key of keys) {
      if (!(key in sectionData)) continue;
      delete sectionData[key];
      removed += 1;
    }
  }
  return removed;
}

function normalizeRawPluginConfig(data: Record<string, unknown>): number {
  const plugins = data.plugins;
  if (!isRecord(plugins) || !Array.isArray(plugins.disabled)) return 0;
  const disabled = plugins.disabled.filter((item): item is string => typeof item === "string");
  const filtered = filterRemovedPluginIds(disabled);
  if (filtered.length === plugins.disabled.length && filtered.length === disabled.length) return 0;
  plugins.disabled = filtered;
  return 1;
}

function ensureRawAgentsConfig(data: Record<string, unknown>): number {
  const agents = getMutableSection(data, "agents");
  let changed = 0;
  if (agents.default === undefined) {
    agents.default = DEFAULT_CONFIG_DATA.agents.default;
    changed += 1;
  }
  if (!isRecord(agents.runners)) {
    agents.runners = {};
    changed += 1;
  }
  return changed;
}

function migrateConfigV1ToV2(data: Record<string, unknown>): string[] {
  const changes: string[] = [];
  const addedDefaults =
    addMissingDefaults(data, "ui") +
    addMissingDefaults(data, "notifications") +
    addMissingDefaults(data, "plugins") +
    addMissingDefaults(data, "logging") +
    addMissingDefaults(data, "telemetry");
  if (addedDefaults > 0) changes.push(`added ${addedDefaults} missing default field${addedDefaults === 1 ? "" : "s"}`);

  const removedDeprecated = removeDeprecatedConfigKeys(data);
  if (removedDeprecated > 0)
    changes.push(`removed ${removedDeprecated} deprecated field${removedDeprecated === 1 ? "" : "s"}`);

  if (normalizeRawPluginConfig(data) > 0) changes.push("removed stale bundled plugin ids");
  if (normalizeAgentRunnerProfiles(data) > 0) changes.push("moved legacy agent renderer fields to profile");
  if (ensureRawAgentsConfig(data) > 0) changes.push("normalized agent defaults");

  return changes;
}

function applyConfigMigrations(data: Record<string, unknown>): ConfigMigrationResult | null {
  const fromVersion = rawConfigVersion(data);
  if (fromVersion === null || fromVersion >= CURRENT_CONFIG_VERSION) return null;

  let version = fromVersion;
  const changes: string[] = [];
  if (version < 2) {
    changes.push(...migrateConfigV1ToV2(data));
    version = 2;
  }
  // Version 3 changed only the stock Atlas runners, which Relay no longer
  // generates, so upgrading from version 2 just updates the version number.
  if (version < 3) version = 3;

  normalizeMeta(data);
  if (changes.length === 0) changes.push("updated config version metadata");
  return { fromVersion, toVersion: Math.min(version, CURRENT_CONFIG_VERSION), changes };
}

function replaceRecordContents(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

const MAX_CONFIG_BACKUPS = 5;

function backupTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function configBackupOrder(configName: string, fileName: string): { timestamp: string; sequence: number } | null {
  if (fileName.startsWith(`${configName}.bak.`)) {
    const match = /^(\d{14})(?:\.(\d+))?$/.exec(fileName.slice(`${configName}.bak.`.length));
    if (!match?.[1]) return null;
    return { timestamp: match[1], sequence: Number(match[2] ?? 0) };
  }
  if (!fileName.startsWith(`${configName}.`) || !fileName.endsWith(".bak")) return null;
  const match = /^(\d{8})T(\d{6})Z(?:\.(\d+))?$/.exec(fileName.slice(configName.length + 1, -4));
  if (!match?.[1] || !match[2]) return null;
  return { timestamp: `${match[1]}${match[2]}`, sequence: Number(match[3] ?? 0) };
}

function isConfigBackupName(configName: string, fileName: string): boolean {
  return configBackupOrder(configName, fileName) !== null;
}

function moveLegacyConfigBackups(configFile: string, backupDir: string): void {
  const configDir = path.dirname(configFile);
  const configName = path.basename(configFile);
  const legacyPrefix = `${configName}.bak.`;
  const legacyNames = fs
    .readdirSync(configDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.startsWith(legacyPrefix) && isConfigBackupName(configName, entry.name),
    )
    .map((entry) => entry.name);
  if (legacyNames.length === 0) return;

  fs.mkdirSync(backupDir, { recursive: true });
  for (const legacyName of legacyNames) {
    const legacyPath = path.join(configDir, legacyName);
    let destination = path.join(backupDir, legacyName);
    for (let index = 1; fs.existsSync(destination); index += 1) {
      destination = path.join(backupDir, `${legacyName}.${index}`);
    }
    fs.renameSync(legacyPath, destination);
  }
}

function pruneConfigBackups(configFile: string, backupDir: string, preservePath?: string): void {
  if (!fs.existsSync(backupDir)) return;
  const configName = path.basename(configFile);
  const backups = fs
    .readdirSync(backupDir, { withFileTypes: true })
    .flatMap((entry) => {
      if (!entry.isFile()) return [];
      const order = configBackupOrder(configName, entry.name);
      return order ? [{ filePath: path.join(backupDir, entry.name), fileName: entry.name, ...order }] : [];
    })
    .sort(
      (left, right) =>
        right.timestamp.localeCompare(left.timestamp) ||
        right.sequence - left.sequence ||
        right.fileName.localeCompare(left.fileName),
    );
  const preservedCount = preservePath && backups.some((backup) => backup.filePath === preservePath) ? 1 : 0;
  const removable = preservePath ? backups.filter((backup) => backup.filePath !== preservePath) : backups;
  for (const backup of removable.slice(MAX_CONFIG_BACKUPS - preservedCount)) fs.unlinkSync(backup.filePath);
}

function organizeConfigBackups(configFile: string): void {
  const backupDir = path.join(path.dirname(configFile), "backups");
  moveLegacyConfigBackups(configFile, backupDir);
  pruneConfigBackups(configFile, backupDir);
}

function writeConfigBackup(configFile: string, content: string): string {
  const backupDir = path.join(path.dirname(configFile), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const baseName = `${path.basename(configFile)}.${backupTimestamp()}`;
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `.${index}`;
    const backupPath = path.join(backupDir, `${baseName}${suffix}.bak`);
    try {
      fs.writeFileSync(backupPath, content, { encoding: "utf-8", flag: "wx" });
      pruneConfigBackups(configFile, backupDir, backupPath);
      return backupPath;
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw error; // effect-shape-allow: config migration backup preserves original filesystem failure for caller warning.
    }
  }
  throw new Error(`Unable to create unique config backup in ${backupDir}`); // effect-shape-allow: config migration backup path collision exhaustion.
}

function formatConfigMigrationWarning(
  configFile: string,
  migration: ConfigMigrationResult,
  backupPath: string,
): string {
  const changeSummary = migration.changes.length > 0 ? ` Changes: ${migration.changes.join("; ")}.` : "";
  return `Config migration: updated ${configFile} from version ${migration.fromVersion} to ${migration.toVersion}.${changeSummary} Backup: ${backupPath}`;
}

function migrateConfigFileIfNeeded(
  configFile: string,
  raw: Record<string, unknown>,
  content: string,
  warn: (message: string) => void,
): string | null {
  const migrated = deepClone(raw);
  const migration = applyConfigMigrations(migrated);
  if (!migration) return null;

  try {
    const backupPath = writeConfigBackup(configFile, content);
    const migratedContent = serializeConfigToml(migrated);
    writeConfigTextAtomically({ configFilePath: configFile, content: migratedContent });
    replaceRecordContents(raw, migrated);
    warn(formatConfigMigrationWarning(configFile, migration, backupPath));
    getRelayLogger().warn("config.migration.applied", {
      filePath: configFile,
      backupPath,
      fromVersion: migration.fromVersion,
      toVersion: migration.toVersion,
      changes: migration.changes,
    });
    return migratedContent;
  } catch (error) {
    warn(`Config migration failed for ${configFile}: ${error instanceof Error ? error.message : String(error)}.`);
    getRelayLogger().error("config.migration.error", {
      filePath: configFile,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function writeConfigTextAtomically({ configFilePath, content }: { configFilePath: string; content: string }): void {
  // Renaming over a symlink replaces the link, so atomically replace its resolved target instead.
  const writePath = fs.lstatSync(configFilePath).isSymbolicLink() ? fs.realpathSync(configFilePath) : configFilePath;
  const dir = path.dirname(writePath);
  const tmpPath = path.join(dir, `.${path.basename(writePath)}.${process.pid}.${Date.now()}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, "w");
    fs.writeFileSync(fd, content, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, writePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    throw err; // effect-shape-allow: atomic config write preserves original filesystem failure for callers.
  }
}

export function updateConfigEffect(
  mutator: (data: Record<string, unknown>) => void,
): Effect.Effect<Config, RelayError> {
  return Effect.try({
    try: () => updateConfig(mutator),
    catch: (cause) => new RelayError({ message: "Failed to update config", cause }),
  });
}

export function startConfigWatcherEffect(): Effect.Effect<() => void, RelayError> {
  return Effect.try({
    try: startConfigWatcher,
    catch: (cause) => new RelayError({ message: "Failed to start config watcher", cause }),
  });
}

export function scopedConfigWatcher(): Effect.Effect<void, RelayError, Scope.Scope> {
  return Effect.acquireRelease(startConfigWatcherEffect(), (stop) => Effect.sync(stop)).pipe(Effect.asVoid);
}

export function updateConfig(mutator: (data: Record<string, unknown>) => void): Config {
  const configFile = ensureConfigFile();
  const parsed = parseConfigFile(configFile);
  if (parsed.parseError) throw new Error(`Cannot update invalid config at ${configFile}: ${parsed.parseError.message}`); // effect-shape-allow: synchronous config mutation API reports invalid external config.
  const data = parsed.raw ?? {};
  mutator(data);
  normalizeMeta(data);
  normalizeAgentRunnerProfiles(data);
  writeConfigTextAtomically({ configFilePath: configFile, content: serializeConfigToml(data) });
  return reloadConfigAndNotify({ fallbackToPrevious: false, notifyUnchanged: true, source: "write" });
}

function assertEditableConfigValue(key: EditableConfigKey, value: unknown): void {
  const setting = getConfigSetting(key);
  if (!setting) throw new Error(`Unknown editable config key: ${key}`); // effect-shape-allow: public sync settings API validates caller-provided key.
  switch (setting.type) {
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`); // effect-shape-allow: public sync settings API validates caller-provided value.
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`); // effect-shape-allow: public sync settings API validates caller-provided value.
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${key} must be an integer`); // effect-shape-allow: public sync settings API validates caller-provided value.
      break;
    case "choice": {
      const choices = setting.choices?.() ?? [];
      if (typeof value !== "string" || !choices.includes(value)) throw new Error(`Invalid value for ${key}: ${value}`); // effect-shape-allow: public sync settings API validates caller-provided value.
      return;
    }
  }
  if (typeof value === "number") {
    if (setting.min !== undefined && value < setting.min) throw new Error(`${key} must be >= ${setting.min}`); // effect-shape-allow: public sync settings API validates caller-provided value.
    if (setting.max !== undefined && value > setting.max) throw new Error(`${key} must be <= ${setting.max}`); // effect-shape-allow: public sync settings API validates caller-provided value.
  }
}

export function setConfigValue(key: EditableConfigKey, value: boolean | number | string): Config {
  assertEditableConfigValue(key, value);
  const config = updateConfig((data) => {
    const segments = key.split(".");
    const valueKey = segments.pop();
    if (!valueKey || segments.length === 0) throw new Error(`Invalid editable config key: ${key}`); // effect-shape-allow: public sync settings API validates caller-provided key.
    let parent = data;
    for (const segment of segments) {
      parent = getMutableSection(parent, segment);
    }
    parent[valueKey] = value;
  });
  // Keep the telemetry consent file in sync when analytics_enabled is toggled via /settings.
  if (key === "telemetry.analytics_enabled" && typeof value === "boolean") {
    writeTelemetryConsent(getConfigDir(), value);
  }
  return config;
}

export function setTheme(theme: string): Config {
  return setConfigValue("ui.theme", theme);
}

export function setTerminalNotificationsEnabled(enabled: boolean): Config {
  return setConfigValue("notifications.terminal_enabled", enabled);
}

export function setNotificationSoundsEnabled(enabled: boolean): Config {
  return setConfigValue("notifications.sound_enabled", enabled);
}

export function setNotificationVolume(volume: number): Config {
  return setConfigValue("notifications.volume", volume);
}

export function setPluginsEnabled(enabled: boolean): Config {
  return updateConfig((data) => {
    const plugins = getMutableSection(data, "plugins");
    plugins.enabled = enabled;
  });
}

export function setRelayPluginEnabled(pluginId: string, enabled: boolean): Config {
  const normalizedPluginId = pluginId.trim();
  if (!normalizedPluginId) throw new Error("Plugin id is required"); // effect-shape-allow: public sync plugin settings API validates caller-provided plugin id.
  return updateConfig((data) => {
    const plugins = getMutableSection(data, "plugins");
    const rawDisabled = plugins.disabled;
    const disabled = filterRemovedPluginIds(
      Array.isArray(rawDisabled)
        ? rawDisabled.filter((item): item is string => typeof item === "string")
        : [...DEFAULT_CONFIG_DATA.plugins.disabled],
    );
    plugins.disabled = enabled
      ? disabled.filter((item) => item !== normalizedPluginId)
      : [...new Set([...disabled, normalizedPluginId])];
  });
}

// ---------------------------------------------------------------------------
// Plugin settings
// ---------------------------------------------------------------------------

function pluginSettingsKey(pluginId: string, pluginName: string): string {
  const source = pluginId.split(":")[0] ?? "global";
  const safeName = pluginName.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${source}_${safeName}`;
}

export function getPluginSettingRaw(pluginId: string, pluginName: string, key: string): unknown {
  return getConfig().plugin_settings[pluginSettingsKey(pluginId, pluginName)]?.[key];
}

export function setPluginSettingValue(
  pluginId: string,
  pluginName: string,
  key: string,
  value: boolean | number | string,
): Config {
  const sectionKey = pluginSettingsKey(pluginId, pluginName);
  return updateConfig((data) => {
    const pluginSettings = getMutableSection(data, "plugin_settings");
    const pluginSection = getMutableSection(pluginSettings, sectionKey);
    pluginSection[key] = value;
  });
}

export interface SetChildSessionTaskTypeInput {
  readonly name: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly agent?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
}

export function setChildSessionTaskType(input: SetChildSessionTaskTypeInput): Config {
  const name = normalizeChildSessionTaskTypeName(input.name);
  const description = input.description.trim();
  if (!description) throw new Error("Task type description is required"); // effect-shape-allow: public sync settings API validates caller-provided task type.
  if ([...description].length > MAX_CHILD_SESSION_TASK_TYPE_DESCRIPTION_LENGTH) {
    throw new Error( // effect-shape-allow: public sync settings API validates caller-provided task type.
      `Task type description must be at most ${MAX_CHILD_SESSION_TASK_TYPE_DESCRIPTION_LENGTH} characters`,
    );
  }
  if (input.keywords.length === 0) throw new Error("At least one task type keyword is required"); // effect-shape-allow: public sync settings API validates caller-provided task type.
  if (input.keywords.length > MAX_CHILD_SESSION_TASK_TYPE_KEYWORDS) {
    throw new Error(`Task types may have at most ${MAX_CHILD_SESSION_TASK_TYPE_KEYWORDS} keywords`); // effect-shape-allow: public sync settings API validates caller-provided task type.
  }
  const keywords = input.keywords.map(normalizeChildSessionTaskTypeKeyword);
  if (new Set(keywords).size !== keywords.length) throw new Error("Task type keywords must be unique"); // effect-shape-allow: public sync settings API validates caller-provided task type.
  const agent = input.agent?.trim();
  const model = input.model?.trim();
  const thinkingLevel = parseThinkingLevel(input.thinkingLevel);
  return updateConfig((data) => {
    const taskTypes = getMutableSection(data, "task_types");
    if (!Object.hasOwn(taskTypes, name) && Object.keys(taskTypes).length >= MAX_CHILD_SESSION_TASK_TYPES) {
      throw new Error(`At most ${MAX_CHILD_SESSION_TASK_TYPES} task types may be configured`); // effect-shape-allow: public sync settings API validates caller-provided task type.
    }
    taskTypes[name] = {
      description,
      keywords,
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
    };
  });
}

export function removeChildSessionTaskType(value: string): Config {
  const name = normalizeChildSessionTaskTypeName(value);
  return updateConfig((data) => {
    if (!isRecord(data.task_types)) return;
    delete data.task_types[name];
    if (Object.keys(data.task_types).length === 0) delete data.task_types;
  });
}

const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function addAgentRunner(agentName: string, command: string, args: string[], profile?: string): Config {
  const normalizedName = agentName.trim();
  if (!normalizedName) throw new Error("Agent name is required"); // effect-shape-allow: public sync settings API validates caller-provided agent name.
  if (!AGENT_NAME_PATTERN.test(normalizedName)) {
    // effect-shape-allow: public sync settings API validates caller-provided agent name.
    throw new Error(
      `Invalid agent name "${normalizedName}". Use letters, digits, "_" or "-" and start with a letter or digit.`,
    );
  }
  if (!command.trim()) throw new Error("Command is required"); // effect-shape-allow: public sync settings API validates caller-provided command.
  const normalizedProfile = profile?.trim();
  return updateConfig((data) => {
    const agents = getMutableSection(data, "agents");
    const runners = getMutableSection(agents, "runners");
    runners[normalizedName] = {
      command,
      args,
      ...(normalizedProfile ? { profile: normalizedProfile } : {}),
    };
  });
}

function runnerConfigRecord(runner: AgentRunnerConfig): Record<string, unknown> {
  return {
    command: runner.command,
    args: [...runner.args],
    ...(runner.profile ? { profile: runner.profile } : {}),
    ...(runner.env ? { env: { ...runner.env } } : {}),
  };
}

function mutableRunnerForAgentPreference(
  data: Record<string, unknown>,
  agentName: string,
  options: { createBuiltinRunner: boolean },
): Record<string, unknown> | null {
  const agents = options.createBuiltinRunner
    ? getMutableSection(data, "agents")
    : isRecord(data.agents)
      ? data.agents
      : null;
  if (!agents) return null;
  const runners = options.createBuiltinRunner
    ? getMutableSection(agents, "runners")
    : isRecord(agents.runners)
      ? agents.runners
      : null;
  if (!runners) return null;
  const exactRunner = runners[agentName];
  if (isRecord(exactRunner)) return exactRunner;

  const builtin = resolveBuiltinAgentRunner(agentName);
  if (!builtin) return null;
  const canonicalRunner = runners[builtin.name];
  if (isRecord(canonicalRunner)) return canonicalRunner;
  if (!options.createBuiltinRunner) return null;

  const createdRunner = runnerConfigRecord(builtin.runner);
  runners[builtin.name] = createdRunner;
  return createdRunner;
}

export function setAgentPreferredModel(agentName: string, modelId: string | undefined): Config {
  const normalizedAgentName = agentName.trim();
  if (!normalizedAgentName) throw new Error("Agent name is required"); // effect-shape-allow: public sync settings API validates caller-provided agent name.
  const normalizedModelId = modelId?.trim();
  if (modelId !== undefined && !normalizedModelId) throw new Error("Preferred model must be a non-empty string"); // effect-shape-allow: public sync settings API validates caller-provided model.
  return updateConfig((data) => {
    const runner = mutableRunnerForAgentPreference(data, normalizedAgentName, {
      createBuiltinRunner: Boolean(normalizedModelId),
    });
    if (!runner) {
      if (normalizedModelId) throw new Error(`No agent runner configured for: ${normalizedAgentName}`); // effect-shape-allow: public sync settings API validates configured agent presence.
      return;
    }
    if (normalizedModelId) {
      runner.preferred_model = normalizedModelId;
      return;
    }
    delete runner.preferred_model;
  });
}

export function setAgentPreferredThinkingLevel(agentName: string, thinkingLevel: ThinkingLevel | undefined): Config {
  const normalizedAgentName = agentName.trim();
  if (!normalizedAgentName) throw new Error("Agent name is required"); // effect-shape-allow: public sync settings API validates caller-provided agent name.
  const normalizedThinkingLevel = parseThinkingLevel(thinkingLevel);
  if (thinkingLevel !== undefined && !normalizedThinkingLevel)
    throw new Error("Preferred thinking level must be a non-empty string"); // effect-shape-allow: public sync settings API validates caller-provided thinking level.
  return updateConfig((data) => {
    const runner = mutableRunnerForAgentPreference(data, normalizedAgentName, {
      createBuiltinRunner: Boolean(normalizedThinkingLevel),
    });
    if (!runner) {
      if (normalizedThinkingLevel) throw new Error(`No agent runner configured for: ${normalizedAgentName}`); // effect-shape-allow: public sync settings API validates configured agent presence.
      return;
    }
    if (normalizedThinkingLevel) {
      runner.preferred_thinking_level = normalizedThinkingLevel;
      return;
    }
    delete runner.preferred_thinking_level;
  });
}

const CONFIG_WATCH_DEBOUNCE_MS = 100;
const CONFIG_WATCH_SUCCESS_SETTLE_MS = 150;
const CONFIG_WATCH_MIN_STABLE_MS = CONFIG_WATCH_DEBOUNCE_MS + CONFIG_WATCH_SUCCESS_SETTLE_MS;
const CONFIG_WATCH_RETRY_DELAYS_MS = [150, 250] as const;

function configWatchStableDelayMs(configFile: string): number {
  try {
    const stats = fs.statSync(configFile);
    return Math.max(0, CONFIG_WATCH_MIN_STABLE_MS - (Date.now() - stats.mtimeMs));
  } catch {
    return 0;
  }
}

export function startConfigWatcher(): () => void {
  const configFile = ensureConfigFile();
  getConfigLoadResult();
  const configDir = path.dirname(configFile);
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  const scheduleTimer = (callback: () => void, delayMs: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      callback();
    }, delayMs);
    timer.unref?.();
  };

  const commitWatchLoad = (nextLoad: ConfigLoadResult): void => {
    const change = commitConfigLoad(nextLoad, "watch");
    maybeNotifyConfigListeners(change);
  };

  const loadQuietWatchCandidate = (): ConfigLoadResult =>
    loadConfigResult({
      fallbackConfig: _currentLoad?.config,
      createIfMissing: false,
      reportParseError: false,
      reportWarnings: false,
    });

  const scheduleSettledCommit = (attemptGeneration: number, candidate: ConfigLoadResult) => {
    scheduleTimer(
      () => {
        if (disposed || attemptGeneration !== generation) return;
        const settled = loadQuietWatchCandidate();
        if (settled.parseError) {
          runReloadAttempt(attemptGeneration, 0);
          return;
        }
        if (settled.content !== candidate.content) {
          scheduleSettledCommit(attemptGeneration, settled);
          return;
        }
        const finalLoad = loadConfigResult({
          fallbackConfig: _currentLoad?.config,
          createIfMissing: false,
        });
        commitWatchLoad(finalLoad);
      },
      Math.max(CONFIG_WATCH_SUCCESS_SETTLE_MS, configWatchStableDelayMs(configFile)),
    );
  };

  const runReloadAttempt = (attemptGeneration: number, retryIndex: number) => {
    if (disposed || attemptGeneration !== generation) return;
    const candidate = loadQuietWatchCandidate();
    if (!candidate.parseError) {
      scheduleSettledCommit(attemptGeneration, candidate);
      return;
    }

    const retryDelayMs = CONFIG_WATCH_RETRY_DELAYS_MS[retryIndex];
    if (retryDelayMs !== undefined) {
      scheduleTimer(() => runReloadAttempt(attemptGeneration, retryIndex + 1), retryDelayMs);
      return;
    }

    const finalLoad = loadConfigResult({
      fallbackConfig: _currentLoad?.config,
      createIfMissing: false,
      reportParseError: true,
    });
    commitWatchLoad(finalLoad);
  };

  const scheduleReload = () => {
    if (disposed) return;
    generation += 1;
    const scheduledGeneration = generation;
    scheduleTimer(() => runReloadAttempt(scheduledGeneration, 0), CONFIG_WATCH_DEBOUNCE_MS);
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(configDir, { persistent: false }, (_event, filename) => {
      if (filename === null || filename === undefined || filename.toString() === "config.toml") scheduleReload();
    });
  } catch {
    watcher = null;
  }
  const watchFileListener = (current: fs.Stats, previous: fs.Stats) => {
    if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) scheduleReload();
  };
  fs.watchFile(configFile, { interval: 50, persistent: false }, watchFileListener);
  scheduleReload();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    fs.unwatchFile(configFile, watchFileListener);
    watcher?.close();
  };
}

// TODO(acp-first): remove this Alta-specific startup normalization once runner
// configs no longer need provider-specific cleanup in Relay core.
function isAltaAgentRunCommand(command: string, args: readonly string[]): boolean {
  const normalizedCommand = command.trim();
  if (normalizedCommand.endsWith("/atlas") || normalizedCommand === "atlas") {
    return args[0] === "alta" && args[1] === "agent" && args[2] === "run";
  }
  if (normalizedCommand.endsWith("/alta") || normalizedCommand === "alta") {
    return args[0] === "agent" && args[1] === "run";
  }
  if (
    normalizedCommand.endsWith("/tsx") ||
    normalizedCommand === "tsx" ||
    normalizedCommand.endsWith("/bun") ||
    normalizedCommand === "bun" ||
    normalizedCommand.endsWith("/node") ||
    normalizedCommand === "node"
  ) {
    return args.some(
      (arg, index) => arg.endsWith("/alta.ts") && args[index + 1] === "agent" && args[index + 2] === "run",
    );
  }
  return false;
}

function removeAltaServerPortArgs(args: readonly string[]): string[] {
  const next: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--server-port") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--server-port=")) continue;
    next.push(arg);
  }
  return next;
}

function normalizeAgentRunnerArgs(command: string, args: readonly string[]): string[] {
  if (!isAltaAgentRunCommand(command, args)) return [...args];
  return removeAltaServerPortArgs(args);
}

const ATLASSIAN_ALTA_AGENT_PACKAGE_PREFIX = "@atlassian/alta-agent-";

function packageNameWithoutVersion(packageSpec: string): string {
  const normalized = packageSpec.startsWith("npm:") ? packageSpec.slice("npm:".length) : packageSpec;
  if (!normalized.startsWith("@")) return normalized.split("@")[0] ?? normalized;
  const versionIndex = normalized.indexOf("@", normalized.indexOf("/") + 1);
  return versionIndex === -1 ? normalized : normalized.slice(0, versionIndex);
}

function altaAgentPackageTitleAlias(arg: string): string | null {
  const packageName = packageNameWithoutVersion(arg.trim());
  if (!packageName.startsWith(ATLASSIAN_ALTA_AGENT_PACKAGE_PREFIX)) return null;
  const alias = packageName.slice(ATLASSIAN_ALTA_AGENT_PACKAGE_PREFIX.length);
  if (!/^[a-z0-9][a-z0-9-]*$/iu.test(alias)) return null;
  return alias.toLowerCase();
}

function internalSessionTitleAliasesForRunner(profile: string, runner: AgentRunnerConfig): string[] {
  if (profile.trim().toLowerCase() !== "alta" || (runner.transport ?? "stdio") === "websocket") return [];
  return [...new Set(runner.args.map(altaAgentPackageTitleAlias).filter((alias) => alias !== null))];
}

function profileForRunner(agentName: string, runner: AgentRunnerConfig): string {
  if (runner.profile) return runner.profile;
  const builtinProfile = builtinAgentCanonicalName(agentName);
  if (builtinProfile) return builtinProfile;
  if (agentName === "alta") return "alta";
  if ((runner.transport ?? "stdio") !== "websocket" && isAltaAgentRunCommand(runner.command, runner.args))
    return "alta";
  return agentName;
}

export function listAvailableAgentNames(): string[] {
  return [...new Set([...Object.keys(getConfig().agents.runners), ...builtinAgentNames()])];
}

export function getAgentPreferredModel(agentName: string): string | undefined {
  const normalizedAgentName = agentName.trim();
  if (!normalizedAgentName) return undefined;
  const runners = getConfig().agents.runners;
  return (
    runners[normalizedAgentName]?.preferred_model ??
    runners[builtinAgentCanonicalName(normalizedAgentName) ?? ""]?.preferred_model
  );
}

export function getAgentPreferredThinkingLevel(agentName: string): ThinkingLevel | undefined {
  const normalizedAgentName = agentName.trim();
  if (!normalizedAgentName) return undefined;
  const runners = getConfig().agents.runners;
  return (
    runners[normalizedAgentName]?.preferred_thinking_level ??
    runners[builtinAgentCanonicalName(normalizedAgentName) ?? ""]?.preferred_thinking_level
  );
}

interface ResolvedAgentRunner {
  readonly resolvedName: string;
  readonly runner: AgentRunnerConfig;
}

function resolveAgentRunner(configuredName: string): ResolvedAgentRunner | null {
  const config = getConfig();
  const configuredRunner = config.agents.runners[configuredName];
  const builtinCandidate = resolveBuiltinAgentRunner(configuredName);
  const useBuiltinRunner =
    !configuredRunner ||
    Boolean(builtinCandidate && isBuiltinStockRunner(configuredName, configuredRunner.command, configuredRunner.args));
  const builtin = useBuiltinRunner ? builtinCandidate : null;
  const runner =
    configuredRunner && builtin
      ? {
          ...builtin.runner,
          ...(configuredRunner.env ? { env: { ...builtin.runner.env, ...configuredRunner.env } } : {}),
        }
      : (configuredRunner ?? builtin?.runner);

  return runner ? { resolvedName: builtin?.name ?? configuredName, runner } : null;
}

export interface ResolvedAgentProfileMetadata {
  name: string;
  profile: string;
  internalSessionTitleAliases: string[];
}

export function resolveConfiguredAgentProfile(agentName: string): ResolvedAgentProfileMetadata | null {
  const configuredName = agentName.trim();
  if (!configuredName) return null;
  const resolved = resolveAgentRunner(configuredName);
  if (!resolved) return null;
  const profile = profileForRunner(resolved.resolvedName, resolved.runner);
  return {
    name: resolved.resolvedName,
    profile,
    internalSessionTitleAliases: internalSessionTitleAliasesForRunner(profile, resolved.runner),
  };
}

function commandRunnerFromShellCommand(commandString: string): AgentRunnerConfig | null {
  const [command, ...args] = commandString.trim().split(/\s+/);
  if (!command) return null;
  return { command, args };
}

function isInlineAltaAgentRunCommand(commandString: string): boolean {
  const normalized = commandString.replace(/["']/gu, "");
  return (
    /(?:^|\s)(?:\S*\/)?atlas\s+alta\s+agent\s+run(?:\s|$)/iu.test(normalized) ||
    /(?:^|\s)(?:\S*\/)?alta\s+agent\s+run(?:\s|$)/iu.test(normalized) ||
    /(?:^|\s)(?:\S*\/)?alta\.ts\s+agent\s+run(?:\s|$)/iu.test(normalized)
  );
}

function internalSessionTitleAliasesFromInlineCommand(profile: string, commandString: string): string[] {
  if (profile.trim().toLowerCase() !== "alta") return [];
  const aliases: string[] = [];
  for (const match of commandString.matchAll(/(?:npm:)?@atlassian\/alta-agent-[^\s"'`]+/giu)) {
    const alias = altaAgentPackageTitleAlias(match[0].replace(/[),;\]]+$/u, ""));
    if (alias) aliases.push(alias);
  }
  return [...new Set(aliases)];
}

export function resolveInlineAcpAgentProfile(agentName: string, commandString: string): ResolvedAgentProfileMetadata {
  const configuredProfile = resolveConfiguredAgentProfile(agentName);
  const inlineRunner = commandRunnerFromShellCommand(commandString);
  const fallbackName = agentName.trim() || "acp";
  const name = configuredProfile?.name ?? fallbackName;
  const tokenizedProfile = inlineRunner ? profileForRunner(name, inlineRunner) : fallbackName;
  const profile =
    configuredProfile?.profile ?? (isInlineAltaAgentRunCommand(commandString) ? "alta" : tokenizedProfile);
  const internalSessionTitleAliases = [
    ...(configuredProfile?.internalSessionTitleAliases ?? []),
    ...(inlineRunner ? internalSessionTitleAliasesForRunner(profile, inlineRunner) : []),
    ...internalSessionTitleAliasesFromInlineCommand(profile, commandString),
  ];
  return {
    name,
    profile,
    internalSessionTitleAliases: [...new Set(internalSessionTitleAliases)],
  };
}

export function resolveConfiguredAgent(agentName?: string): {
  name: string;
  command: string;
  args: string[];
  profile: string;
  internalSessionTitleAliases: string[];
  transport?: AgentRunnerTransport;
  url?: string;
  headers?: Record<string, string>;
  protocols?: string[];
  framing?: AgentRunnerWebSocketFraming;
  env?: Record<string, string>;
} | null {
  const config = getConfig();
  const configuredName = (agentName || config.agents.default).trim();
  if (!configuredName) return null;

  const resolved = resolveAgentRunner(configuredName);
  if (!resolved) {
    const configFile = getConfigLoadResult().filePath;
    const availableAgents = [...new Set([...Object.keys(config.agents.runners), ...builtinAgentNames()])];
    getRelayLogger().error("config.agent.resolve.error", {
      agentName: configuredName,
      reason: "runner not found",
      configFile,
      availableAgents,
    });
    // effect-shape-allow: sync CLI startup reports missing configured agent.
    throw new Error(
      `No agent runner configured for: ${configuredName}. Available agents: ${availableAgents.join(", ") || "none"}. Config file: ${configFile}`,
    );
  }

  const { resolvedName, runner } = resolved;
  const profile = profileForRunner(resolvedName, runner);

  return {
    name: resolvedName,
    command: runner.command,
    args: runner.transport === "websocket" ? [] : normalizeAgentRunnerArgs(runner.command, runner.args),
    profile,
    internalSessionTitleAliases: internalSessionTitleAliasesForRunner(profile, runner),
    ...(runner.transport ? { transport: runner.transport } : {}),
    ...(runner.url ? { url: runner.url } : {}),
    ...(runner.headers ? { headers: runner.headers } : {}),
    ...(runner.protocols ? { protocols: runner.protocols } : {}),
    ...(runner.framing ? { framing: runner.framing } : {}),
    ...(runner.env ? { env: runner.env } : {}),
  };
}
