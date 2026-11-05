import { BUILTIN_SKILL_METADATA } from "../../builtin-skills/metadata";

export const WEB_SLASH_COMMANDS: readonly (readonly [string, string])[] = [
  ["/new", "Start a new thread [title]"],
  ["/clear", "Clear the web transcript"],
  ["/cancel", "Interrupt the active turn"],
  ["/threads", "List threads"],
  ["/models", "List models"],
  ["/model", "Switch model: /model <id>"],
  ["/thinking", "Set thinking level: /thinking <level>"],
  ["/modes", "List modes"],
  ["/mode", "Switch mode: /mode <id>"],
  ["/copy", "Copy the last agent response"],
  ["/resume", "Resume a session by id"],
  ["/settings", "Use prompt controls for web settings"],
  ...BUILTIN_SKILL_METADATA.map((skill) => [`/${skill.name}`, skill.description] as const),
];
