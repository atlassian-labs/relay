import { getPromptTemplate } from "../prompt-templates";
import { builtinSkillMetadata } from "./metadata";
import skillInstructions from "./relay-themes/SKILL.md" with { type: "text" };
import themesReference from "./relay-themes/references/themes.md" with { type: "text" };
import { wrapBuiltinSkillPrompt } from "./prompt";
import type { BuiltinSkill } from "./types";

const metadata = builtinSkillMetadata("relay-themes")!;
const content = `${skillInstructions.trim()}\n\n---\n\n# Bundled Relay Themes Reference\n\n${themesReference.trim()}`;

export const relayThemesBuiltinSkill: BuiltinSkill = {
  ...metadata,
  createPrompt(args) {
    return wrapBuiltinSkillPrompt(metadata, getPromptTemplate("relay-themes", content), args.trim());
  },
};
