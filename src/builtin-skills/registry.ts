import { reviewBuiltinSkill } from "./review";
import { relayPluginsBuiltinSkill } from "./relay-plugins";
import { relayThemesBuiltinSkill } from "./relay-themes";
import type { BuiltinSkill } from "./types";

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  reviewBuiltinSkill,
  relayPluginsBuiltinSkill,
  relayThemesBuiltinSkill,
];

export function findBuiltinSkill(name: string): BuiltinSkill | null {
  const normalized = name.replace(/^\/+/, "").trim().toLowerCase();
  return BUILTIN_SKILLS.find((skill) => skill.name === normalized) ?? null;
}
