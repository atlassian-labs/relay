export interface BuiltinSkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly location: string;
}

export const BUILTIN_SKILL_METADATA = [
  {
    name: "review",
    description: "Review changes [commit|branch|PR], defaults to uncommitted",
    location: "relay://builtin-skills/review",
  },
  {
    name: "relay-plugins",
    description:
      "Create, modify, debug, and test Relay plugins and extensions. Use when a user asks to add Relay commands, keybindings, widgets, renderers, prompt hooks, settings, MCP integration, local policy, or other plugin behavior, whether as a local user plugin or a bundled plugin shipped through a plugin distribution repository.",
    location: "relay://builtin-skills/relay-plugins",
  },
  {
    name: "relay-themes",
    description:
      "Create, modify, validate, troubleshoot, and install custom Relay terminal themes. Use when a user asks for a Relay color scheme, wants to port an existing palette, needs a theme under ~/.config/relay/themes, or has custom-theme loading or validation warnings.",
    location: "relay://builtin-skills/relay-themes",
  },
] as const satisfies readonly BuiltinSkillMetadata[];

export function builtinSkillMetadata(name: string): BuiltinSkillMetadata | undefined {
  const normalized = name.replace(/^\/+/, "").trim().toLowerCase();
  return BUILTIN_SKILL_METADATA.find((item) => item.name === normalized);
}
