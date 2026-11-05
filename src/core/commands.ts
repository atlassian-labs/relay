export type CommandOrigin = "relay" | "agent" | "plugin";
export type CommandKind = "action" | "prompt" | "skill" | "unknown";

export type CommandInvocation =
  | { readonly syntax: "slash"; readonly composable: false }
  | { readonly syntax: "mention"; readonly sigil: string; readonly composable: true };

/**
 * Shared description of a user-invocable command or prompt capability.
 *
 * Semantic kind and invocation are separate: a skill exposed as `/review`
 * remains a non-composable slash invocation. Classification is optional for
 * compatibility with old caches and third-party plugins; Relay's runtime
 * providers populate it explicitly.
 */
export interface CommandDescriptor {
  name: string;
  description: string;
  origin?: CommandOrigin;
  kind?: CommandKind;
  invocation?: CommandInvocation;
  /** Raw ACP command input metadata, when the command was agent-published. */
  input?: unknown;
  /** Raw ACP extension metadata, preserved for future negotiated classification. */
  meta?: Readonly<Record<string, unknown>>;
}

export function isComposableCommand(command: CommandDescriptor): boolean {
  return command.invocation?.composable === true;
}
