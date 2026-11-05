import type { BuiltinSkillMetadata } from "./metadata";

export function wrapBuiltinSkillPrompt(skill: BuiltinSkillMetadata, content: string, userMessage: string): string {
  return `<skill name="${skill.name}" location="${skill.location}">\n${content.trim()}\n</skill>${
    userMessage ? `\n\n${userMessage}` : ""
  }`;
}
