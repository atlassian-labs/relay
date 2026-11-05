import { getPromptTemplate } from "../prompt-templates";
import { builtinSkillMetadata } from "./metadata";
import skillInstructions from "./relay-plugins/SKILL.md" with { type: "text" };
import extensionsReference from "./relay-plugins/references/extensions.md" with { type: "text" };
import { wrapBuiltinSkillPrompt } from "./prompt";
import type { BuiltinSkill } from "./types";

const metadata = builtinSkillMetadata("relay-plugins")!;
const content = `${skillInstructions.trim()}\n\n---\n\n# Bundled Relay Extensions Reference\n\n${extensionsReference.trim()}`;

export const relayPluginsBuiltinSkill: BuiltinSkill = {
  ...metadata,
  createPrompt(args) {
    return wrapBuiltinSkillPrompt(metadata, getPromptTemplate("relay-plugins", content), args.trim());
  },
};
