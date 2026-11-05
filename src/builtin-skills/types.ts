import type { RelayCommandContext } from "../plugins";
import type { BuiltinSkillMetadata } from "./metadata";

export interface BuiltinSkill extends BuiltinSkillMetadata {
  createPrompt(args: string, context: RelayCommandContext): string | Promise<string>;
}
