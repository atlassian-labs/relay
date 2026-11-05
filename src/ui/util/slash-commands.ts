import type { AppState, UserSkillInvocationEcho } from "../state";
import type { SlashCommand } from "../autocomplete";
import { nativeSlashCommandCapabilityAvailable } from "./native-slash-commands";

export function slashCommandName(command: string): string {
  const trimmed = command.trimStart();
  if (!trimmed.startsWith("/")) return "";
  return trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

export function slashCommandUserMessage(command: string): string | undefined {
  const normalized = command.replace(/\r\n/g, "\n").trimStart().trimEnd();
  const match = normalized.match(/^\/\S+/);
  if (!match) return undefined;
  let userMessage = normalized.slice(match[0].length);
  userMessage = userMessage.replace(/^[\t ]+/u, "");
  if (userMessage.startsWith("\n")) userMessage = userMessage.slice(1);
  userMessage = userMessage.trimEnd();
  return userMessage.trim() ? userMessage : undefined;
}

export function findAgentAdvertisedSlashCommand(
  command: string,
  agentCommands: SlashCommand[],
): SlashCommand | undefined {
  const commandName = slashCommandName(command);
  if (!commandName) return undefined;
  return agentCommands.find((c) => c.name.toLowerCase() === commandName);
}

export function agentSlashSkillInvocationEcho(
  command: string,
  agentCommands: SlashCommand[],
): UserSkillInvocationEcho | null {
  const agentCommand = findAgentAdvertisedSlashCommand(command, agentCommands);
  if (!agentCommand) return null;
  const userMessage = slashCommandUserMessage(command);
  return {
    name: agentCommand.name,
    ...(userMessage === undefined ? {} : { userMessage }),
  };
}

export function isAgentAdvertisedSlashCommand(command: string, agentCommands: SlashCommand[]): boolean {
  return findAgentAdvertisedSlashCommand(command, agentCommands) !== undefined;
}

export function isNativeCapabilityAvailable(commandName: string, state: AppState): boolean {
  return nativeSlashCommandCapabilityAvailable(commandName, state);
}

export function shouldPreferNativeSlashCommand(
  commandName: string,
  state: AppState,
  nativePreferredAgentCommands: Set<string>,
): boolean {
  if (!nativePreferredAgentCommands.has(commandName)) return false;
  return isNativeCapabilityAvailable(commandName, state);
}

export function getVisibleSlashCommands(
  state: AppState | null,
  agentCommands: SlashCommand[],
  localCommands: SlashCommand[],
  nativePreferredAgentCommands: Set<string>,
): SlashCommand[] {
  const filteredAgentCommands = state
    ? agentCommands.filter((cmd) => {
        const name = cmd.name.toLowerCase();
        if (!nativePreferredAgentCommands.has(name)) return true;
        return !isNativeCapabilityAvailable(name, state);
      })
    : agentCommands;
  const agentCommandNames = new Set(filteredAgentCommands.map((cmd) => cmd.name.toLowerCase()));
  const filteredLocalCommands = localCommands.filter((cmd) => !agentCommandNames.has(cmd.name.toLowerCase()));
  return [...filteredAgentCommands, ...filteredLocalCommands];
}

export * as SlashCommands from "./slash-commands";
