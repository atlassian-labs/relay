import type { Config } from "../../config";
import { getPluginSettingRaw } from "../../config";
import {
  coercePluginSettingValue,
  listRelayPlugins,
  type PluginRunner,
  type RelayCommandDiagnostic,
} from "../../plugins";
import type { ListItem, SlashCommand } from "../autocomplete";
import { nativeSlashCommandNames } from "./native-slash-commands";

export interface PluginCommandMapping {
  readonly name: string;
  readonly invocationName: string;
  readonly description?: string;
  readonly argumentPlaceholder?: string;
  readonly diagnostics?: readonly RelayCommandDiagnostic[];
}

export interface PluginShortcutMapping {
  readonly key: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly kind?: "keybinding" | "autocomplete";
}

export interface PluginSettingSummary {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly value: boolean | number | string;
}

export interface PluginMcpServerSummary {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
}

export type PluginSettingsItem =
  | {
      readonly type: "system";
      readonly enabled: boolean;
    }
  | {
      readonly type: "plugin";
      readonly id: string;
      readonly name: string;
      readonly path: string;
      readonly source: string;
      readonly description?: string;
      readonly author?: string;
      readonly enabled: boolean;
      readonly disabledByGlobal: boolean;
      readonly commands: readonly PluginCommandMapping[];
      readonly shortcuts: readonly PluginShortcutMapping[];
      readonly settings: readonly PluginSettingSummary[];
      readonly mcpServers: readonly PluginMcpServerSummary[];
      readonly mcpRestartNeeded: boolean;
    };

const AUTHOR_OVERRIDES = new Map<string, string>([["hackernews-welcome", "Kutsav"]]);

export interface BuildPluginItemsOptions {
  readonly agentCommands?: readonly SlashCommand[];
}

export function pluginSourceKind(source: string): "bundled" | "local" {
  return source === "bundled" ? "bundled" : "local";
}

export function pluginSourceLabel(source: string): string {
  return source === "bundled" ? "bundled" : `local (${source})`;
}

export function buildPluginItems(
  cwd: string,
  config: Config,
  pluginRunner?: PluginRunner | null,
  options: BuildPluginItemsOptions = {},
): ListItem<PluginSettingsItem>[] {
  const listed = listRelayPlugins({ cwd, config });
  const nativeCommandNames = nativeSlashCommandNames({
    disabledBuiltinCommands: config.ui.disabled_builtin_slash_commands,
  });
  const agentCommandNames = new Set(options.agentCommands?.map((command) => command.name.toLowerCase()) ?? []);
  const pluginAuthor = (entry: (typeof listed.entries)[number]) => entry.author ?? AUTHOR_OVERRIDES.get(entry.name);
  const pluginDescription = (entry: (typeof listed.entries)[number]) => {
    const metadata = [pluginAuthor(entry), entry.description].filter(Boolean).join(" · ").toLowerCase();
    if (metadata) return metadata;
    return entry.source === "bundled" ? `bundled · ${entry.name}` : `${entry.source} · ${entry.path}`;
  };
  const commandsForPlugin = (pluginId: string): readonly PluginCommandMapping[] =>
    pluginRunner?.commands
      .list({ nativeCommandNames, agentCommandNames })
      .filter((entry) => entry.plugin.id === pluginId)
      .map((entry) => ({
        name: entry.name,
        invocationName: entry.invocationName,
        ...(entry.command.description ? { description: entry.command.description } : {}),
        ...(entry.command.argumentPlaceholder ? { argumentPlaceholder: entry.command.argumentPlaceholder } : {}),
        ...(entry.diagnostics ? { diagnostics: entry.diagnostics } : {}),
      })) ?? [];
  const shortcutsForPlugin = (pluginId: string): readonly PluginShortcutMapping[] => {
    const keybindings =
      pluginRunner?.keybindings
        .list()
        .filter((entry) => entry.plugin.id === pluginId)
        .map((entry) => ({
          key: entry.key,
          ...(entry.binding.description ? { description: entry.binding.description } : {}),
          enabled: entry.binding.enabled?.() ?? true,
          kind: "keybinding" as const,
        })) ?? [];
    const autocompleteTriggers = (pluginRunner?.editor.listAutocompleteProviders() ?? [])
      .filter((entry) => entry.plugin.id === pluginId && entry.provider.trigger)
      .map((entry) => ({
        key: entry.provider.trigger ?? "",
        description: "autocomplete trigger",
        enabled: true,
        kind: "autocomplete" as const,
      }));
    return [...keybindings, ...autocompleteTriggers];
  };
  const settingsForPlugin = (pluginId: string, pluginName: string): readonly PluginSettingSummary[] =>
    pluginRunner
      ?.allPluginSettings()
      .filter((entry) => entry.plugin.id === pluginId)
      .map((entry) => ({
        key: entry.key,
        title: entry.definition.title,
        description: entry.definition.description,
        value: coercePluginSettingValue(getPluginSettingRaw(pluginId, pluginName, entry.key), entry.definition),
      })) ?? [];
  const mcpServersForPlugin = (pluginId: string): readonly PluginMcpServerSummary[] =>
    pluginRunner?.mcp
      .listServerEntries()
      .filter((entry) => entry.plugin.id === pluginId)
      .map((entry) => ({
        name: entry.server.name,
        command: entry.server.command,
        ...(entry.server.args ? { args: entry.server.args } : {}),
      })) ?? [];
  return [
    {
      value: { type: "system", enabled: config.plugins.enabled },
      label: `plugins: ${config.plugins.enabled ? "on" : "off"}`,
      description: "load local relay plugins",
      active: config.plugins.enabled,
    },
    ...listed.entries.map((entry) => ({
      value: {
        type: "plugin" as const,
        id: entry.id,
        name: entry.name,
        path: entry.path,
        source: entry.source,
        ...(entry.description ? { description: entry.description } : {}),
        ...(pluginAuthor(entry) ? { author: pluginAuthor(entry) } : {}),
        enabled: entry.enabled,
        disabledByGlobal: !config.plugins.enabled,
        commands: commandsForPlugin(entry.id),
        shortcuts: shortcutsForPlugin(entry.id),
        settings: settingsForPlugin(entry.id, entry.name),
        mcpServers: mcpServersForPlugin(entry.id),
        mcpRestartNeeded: pluginRunner?.mcp.status().restartNeeded ?? false,
      },
      label: `${entry.name}: ${entry.enabled ? "on" : "off"}`,
      description: pluginDescription(entry),
      active: entry.enabled,
    })),
  ];
}
