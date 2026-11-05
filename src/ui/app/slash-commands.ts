import { getConfig } from "../../config";
import type { AppState, UserSkillInvocationEcho } from "../state";
import type { SlashCommand } from "../autocomplete";
import * as SlashCommandUtil from "../util/slash-commands";
import { nativePreferredAgentCommandNames, nativeSlashCommands } from "../util/native-slash-commands";

export const NATIVE_PREFERRED_AGENT_COMMANDS = nativePreferredAgentCommandNames();

export function disabledBuiltinSlashCommands(): readonly string[] {
  return getConfig().ui.disabled_builtin_slash_commands;
}

export function slashCommandName(command: string): string {
  return SlashCommandUtil.slashCommandName(command);
}

export function slashCommandUserMessage(command: string): string | undefined {
  return SlashCommandUtil.slashCommandUserMessage(command);
}

export function isAgentAdvertisedSlashCommand(command: string, state: AppState): boolean {
  return SlashCommandUtil.isAgentAdvertisedSlashCommand(command, state.availableCommands);
}

export function shouldPreferNativeSlashCommand(
  commandName: string,
  state: AppState,
  disabledBuiltinCommands: readonly string[] = disabledBuiltinSlashCommands(),
): boolean {
  return SlashCommandUtil.shouldPreferNativeSlashCommand(
    commandName,
    state,
    nativePreferredAgentCommandNames({ disabledBuiltinCommands }),
  );
}

export function agentSlashSkillInvocationEcho(
  command: string,
  commands: SlashCommand[],
): UserSkillInvocationEcho | null {
  return SlashCommandUtil.agentSlashSkillInvocationEcho(command, commands);
}

export function visibleSlashCommands(state: AppState | null, pluginCommands: SlashCommand[]): SlashCommand[] {
  const disabledBuiltinCommands = disabledBuiltinSlashCommands();
  const nonPluginCommands = SlashCommandUtil.getVisibleSlashCommands(
    state,
    state?.availableCommands ?? [],
    nativeSlashCommands(state, { disabledBuiltinCommands }),
    nativePreferredAgentCommandNames({ disabledBuiltinCommands }),
  );
  const pluginCommandNames = new Set(pluginCommands.map((command) => command.name.toLowerCase()));
  return [
    ...pluginCommands,
    ...nonPluginCommands.filter((command) => !pluginCommandNames.has(command.name.toLowerCase())),
  ];
}
