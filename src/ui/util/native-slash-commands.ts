import { BUILTIN_SKILL_METADATA } from "../../builtin-skills/metadata";
import { builtinSlashCommandNameSet, normalizeBuiltinSlashCommandName } from "../../core/slash-commands";
import type { SlashCommand } from "../autocomplete";
import type { AppState } from "../state";

export interface NativeSlashCommand extends SlashCommand {
  aliases?: readonly string[];
  showAliasesInMenu?: boolean;
  requiresSession?: boolean;
  preferNativeOverAgent?: boolean;
}

export interface NativeSlashCommandOptions {
  readonly disabledBuiltinCommands?: readonly string[];
}

export type NativeSlashCommandListOptions = NativeSlashCommandOptions;

export type NativeSlashCommandNameOptions = NativeSlashCommandOptions;

const BUILTIN_SKILL_NAMES: ReadonlySet<string> = new Set(BUILTIN_SKILL_METADATA.map(({ name }) => name));

export const NATIVE_SLASH_COMMANDS: readonly NativeSlashCommand[] = [
  { name: "new", description: "Start new thread [title]", aliases: ["thread", "worktree"] },
  { name: "tree", description: "Show conversation tree", preferNativeOverAgent: true },
  { name: "subagents", description: "List and inspect subagents", preferNativeOverAgent: true },
  { name: "children", description: "List linked child sessions", preferNativeOverAgent: true },
  {
    name: "fork",
    description: "Fork current thread",
    requiresSession: true,
    preferNativeOverAgent: true,
  },
  { name: "threads", description: "Open thread sidebar" },
  {
    name: "resume",
    description: "Resume previous session",
    aliases: ["sessions"],
    showAliasesInMenu: true,
    preferNativeOverAgent: true,
  },
  { name: "login", description: "Authenticate ACP agent", preferNativeOverAgent: true },
  { name: "logout", description: "Logout ACP agent", preferNativeOverAgent: true },
  { name: "edit", description: "Open prompt in external editor", preferNativeOverAgent: true },
  { name: "diff", description: "Show working tree diff", preferNativeOverAgent: true },
  { name: "export", description: "Export conversation to Markdown", preferNativeOverAgent: true },
  ...BUILTIN_SKILL_METADATA.map(({ name, description }) => ({
    name,
    description,
    requiresSession: true,
    preferNativeOverAgent: true,
  })),
  {
    name: "handoff",
    description: "Create a focused handoff thread",
    requiresSession: true,
    preferNativeOverAgent: true,
  },
  {
    name: "mode",
    description: "Switch session mode",
    requiresSession: true,
    preferNativeOverAgent: true,
  },
  {
    name: "models",
    description: "List or switch models",
    aliases: ["model"],
    requiresSession: true,
    preferNativeOverAgent: true,
  },
  {
    name: "thinking",
    description: "Set thinking level",
    aliases: ["effort"],
    showAliasesInMenu: true,
    requiresSession: true,
    preferNativeOverAgent: true,
  },
  { name: "settings", description: "Open interactive settings" },
  { name: "mcp", description: "Show enabled MCP servers", preferNativeOverAgent: true },
  { name: "plugins", description: "Toggle Relay plugins" },
  {
    name: "yoloo",
    description: "Client-side auto-approval for all requests, including unsafe commands",
  },
  { name: "reload", description: "Reload Relay plugins" },
  { name: "copy", description: "Copy last response to clipboard" },
  { name: "exit", description: "Quit", aliases: ["quit"], showAliasesInMenu: true },
];

function activeThreadHasSession(state: AppState): boolean {
  return state.threads.some((thread) => thread.id === state.activeThreadId && !thread.archived && !!thread.sessionId);
}

function commandMatchesName(command: NativeSlashCommand, name: string): boolean {
  return command.name === name || (command.aliases ?? []).includes(name);
}

function commandDisabled(command: NativeSlashCommand, disabledNames: ReadonlySet<string>): boolean {
  return disabledNames.has(command.name) || (command.aliases ?? []).some((alias) => disabledNames.has(alias));
}

function disabledNames(options: NativeSlashCommandOptions): Set<string> {
  return builtinSlashCommandNameSet(options.disabledBuiltinCommands ?? []);
}

export function isBuiltinSlashCommandDisabled(
  commandName: string,
  disabledBuiltinCommands: readonly string[] = [],
): boolean {
  const normalized = normalizeBuiltinSlashCommandName(commandName);
  if (!normalized) return false;
  const disabled = builtinSlashCommandNameSet(disabledBuiltinCommands);
  if (disabled.has(normalized)) return true;
  const command = NATIVE_SLASH_COMMANDS.find((item) => commandMatchesName(item, normalized));
  return command ? commandDisabled(command, disabled) : false;
}

export function nativeSlashCommandCapabilityAvailable(commandName: string, state: AppState): boolean {
  const baseName = nativeSlashCommandBaseName(commandName) ?? commandName.toLowerCase();
  switch (baseName) {
    case "fork":
      return state.sessionForkAvailable && activeThreadHasSession(state);
    case "resume":
      return (state.sessionLoadAvailable && state.sessionListAvailable) || state.sessionResumeAvailable;
    case "login":
      return state.authMethods.length > 0;
    case "logout":
      return state.authLogoutAvailable;
    case "models":
    case "model":
      return state.availableModels.length > 0;
    case "thinking":
    case "effort":
      return state.availableThinkingLevels.length > 0;
    case "modes":
    case "mode":
      return state.availableModes.length > 0;
    default:
      return true;
  }
}

function nativeSlashCommandAvailable(
  command: NativeSlashCommand,
  state: AppState | null | undefined,
  disabled: ReadonlySet<string>,
): boolean {
  if (commandDisabled(command, disabled)) return false;
  if (!state) return true;
  if (!nativeSlashCommandCapabilityAvailable(command.name, state)) return false;
  return (command.aliases ?? []).every((alias) => nativeSlashCommandCapabilityAvailable(alias, state));
}

export function nativeSlashCommands(
  state?: AppState | null,
  options: NativeSlashCommandListOptions = {},
): SlashCommand[] {
  const disabled = disabledNames(options);
  return NATIVE_SLASH_COMMANDS.filter((command) => nativeSlashCommandAvailable(command, state, disabled)).flatMap(
    ({ name, description, aliases, showAliasesInMenu }) => {
      const classification = {
        origin: "relay" as const,
        kind: BUILTIN_SKILL_NAMES.has(name) ? ("skill" as const) : ("action" as const),
        invocation: { syntax: "slash" as const, composable: false as const },
      };
      return [
        { name, description, ...classification },
        ...(showAliasesInMenu ? (aliases ?? []).map((alias) => ({ name: alias, description, ...classification })) : []),
      ];
    },
  );
}

export function nativeSlashCommandNames(options: NativeSlashCommandNameOptions = {}): Set<string> {
  const disabled = disabledNames(options);
  const names = new Set<string>();
  for (const command of NATIVE_SLASH_COMMANDS) {
    if (commandDisabled(command, disabled)) continue;
    names.add(command.name);
    for (const alias of command.aliases ?? []) names.add(alias);
  }
  return names;
}

export function nativeSlashCommandBaseName(
  commandName: string,
  options: NativeSlashCommandOptions = {},
): string | null {
  const normalized = commandName.toLowerCase();
  const disabled = disabledNames(options);
  const command = NATIVE_SLASH_COMMANDS.find(
    (item) => !commandDisabled(item, disabled) && commandMatchesName(item, normalized),
  );
  return command?.name ?? null;
}

export function nativePreferredAgentCommandNames(options: NativeSlashCommandOptions = {}): Set<string> {
  const disabled = disabledNames(options);
  const names = new Set<string>();
  for (const command of NATIVE_SLASH_COMMANDS) {
    if (!command.preferNativeOverAgent || commandDisabled(command, disabled)) continue;
    names.add(command.name);
    for (const alias of command.aliases ?? []) names.add(alias);
  }
  return names;
}

export function nativeSlashCommandRequiresSession(
  commandName: string,
  options: NativeSlashCommandOptions = {},
): boolean {
  const baseName = nativeSlashCommandBaseName(commandName, options) ?? commandName.toLowerCase();
  const disabled = disabledNames(options);
  return NATIVE_SLASH_COMMANDS.some(
    (command) =>
      !commandDisabled(command, disabled) &&
      command.requiresSession &&
      (command.name === baseName || command.aliases?.includes(baseName)),
  );
}
