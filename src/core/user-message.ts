import { skillInvocationDisplay } from "../skills";
import type { UserBlock, UserSkillInvocationEcho } from "./conversation";

export type UserPromptTitleQuality = "empty" | "low-signal" | "fallback" | "strong";
export type UserPromptTitleSource = "prompt" | "skill";
export type UserPromptTitleReason = "empty" | "low-signal" | "bare-skill" | "meaningful" | "acknowledgement-prefix";

export interface UserPromptTitleIntent {
  readonly label: string;
  readonly bareSkillTrigger: boolean;
  readonly quality: UserPromptTitleQuality;
  readonly source: UserPromptTitleSource;
  readonly reason: UserPromptTitleReason;
}

const LOW_SIGNAL_PROMPT_TITLE_LABELS = new Set([
  "again",
  "apply it",
  "continue",
  "do it",
  "go ahead",
  "implement it",
  "it",
  "lgtm",
  "looks good",
  "n",
  "no",
  "nope",
  "ok",
  "okay",
  "please",
  "proceed",
  "retry",
  "run it",
  "see",
  "sgtm",
  "sure",
  "thank you",
  "thanks",
  "that",
  "this",
  "y",
  "yeah",
  "yep",
  "yes",
]);

const ACKNOWLEDGEMENT_PREFIXES = [
  "thank you",
  "go ahead",
  "thanks",
  "please",
  "okay",
  "yeah",
  "yep",
  "yes",
  "sure",
  "nope",
  "ok",
] as const;

const TITLE_CONTEXT_MARKER_RE = /\[(?:image #\d+ [^\]]*|paste #\d+ (?:\+\d+ lines|\d+ chars)(?:\s-\s[^\]]*)?)\]/giu;

function normalizePromptTitleSignal(input: string): string {
  return input
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function compactPromptTitleLabel(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(TITLE_CONTEXT_MARKER_RE, " ").replace(/\s+/gu, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function acknowledgementPrefixPattern(prefix: string): RegExp {
  const prefixPattern = escapeRegExp(prefix).replace(/\\ /g, "\\s+");
  return new RegExp(`^${prefixPattern}(?:[\\s,.;:!\\-]+)([\\s\\S]+)$`, "iu");
}

function stripAcknowledgementPrefix(label: string): { label: string; stripped: boolean } {
  for (const prefix of ACKNOWLEDGEMENT_PREFIXES) {
    const match = label.match(acknowledgementPrefixPattern(prefix));
    const candidate = compactPromptTitleLabel(match?.[1] ?? "");
    if (candidate) return { label: candidate, stripped: true };
  }
  return { label, stripped: false };
}

function sentenceCaseLabel(value: string): string {
  const first = value[0]?.toLocaleUpperCase();
  return first ? `${first}${value.slice(1)}` : value;
}

function bareSkillTitle(name: string): string {
  const normalized = normalizeSkillInvocationName(name).replace(/-+/gu, " ").trim();
  return `${normalized ? sentenceCaseLabel(normalized) : "Skill"} session`;
}

function promptTitleIntent(input: {
  label: string;
  quality: UserPromptTitleQuality;
  source: UserPromptTitleSource;
  reason: UserPromptTitleReason;
  bareSkillTrigger: boolean;
}): UserPromptTitleIntent {
  return {
    label: input.label,
    bareSkillTrigger: input.bareSkillTrigger,
    quality: input.quality,
    source: input.source,
    reason: input.reason,
  };
}

export function hasSmartPromptTitleSignal(label: string): boolean {
  const normalized = normalizePromptTitleSignal(label);
  return normalized.length > 0 && !LOW_SIGNAL_PROMPT_TITLE_LABELS.has(normalized);
}

export function normalizeSkillInvocationName(value: string): string {
  return value
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[_\s]+/gu, "-")
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

export function normalizeSkillUserMessage(value: string | undefined): string {
  return (value ?? "").replace(/\r\n/g, "\n").trim();
}

export function slashSkillInvocationFromContent(content: string): UserSkillInvocationEcho | null {
  const normalized = content.replace(/\r\n/g, "\n").trimStart().trimEnd();
  const match = normalized.match(/^\/([^\s/]+)([\s\S]*)$/u);
  if (!match || !match[1]) return null;
  let userMessage = match[2] ?? "";
  userMessage = userMessage.replace(/^[\t ]+/u, "");
  if (userMessage.startsWith("\n")) userMessage = userMessage.slice(1);
  userMessage = userMessage.trimEnd();
  return {
    name: match[1],
    ...(userMessage.trim() ? { userMessage } : {}),
  };
}

export function userBlockSkillInvocation(
  block: Pick<UserBlock, "content" | "delivery" | "origin" | "skillInvocation">,
  options: { allowLocalSlash?: boolean } = {},
): UserSkillInvocationEcho | null {
  if (block.delivery === "current-turn-guidance") return null;
  if (block.skillInvocation) return block.skillInvocation;

  if (block.origin === "acp") {
    const parsed = skillInvocationDisplay(block.content, { allowPartial: true });
    if (parsed) {
      return {
        name: parsed.name,
        ...(parsed.userMessage === undefined ? {} : { userMessage: parsed.userMessage }),
      };
    }
  }

  return options.allowLocalSlash ? slashSkillInvocationFromContent(block.content) : null;
}

export function formatSkillInvocationIntent(skill: UserSkillInvocationEcho): string {
  const userMessage = skill.userMessage?.trim() ? skill.userMessage.replace(/\s+/g, " ").trim() : "";
  return `${skill.name}${userMessage ? ` — ${userMessage}` : ""}`;
}

export function formatSkillInvocationEchoPreview(skill: UserSkillInvocationEcho): string {
  return `[skill] ${formatSkillInvocationIntent(skill)}`;
}

export function formatUserBlockPreview(block: UserBlock): string | null {
  const skill = userBlockSkillInvocation(block);
  return skill ? formatSkillInvocationEchoPreview(skill) : null;
}

export function skillInvocationsMatch(
  left: UserSkillInvocationEcho | null,
  right: UserSkillInvocationEcho | null,
): boolean {
  if (!left || !right) return false;
  return (
    normalizeSkillInvocationName(left.name) === normalizeSkillInvocationName(right.name) &&
    normalizeSkillUserMessage(left.userMessage) === normalizeSkillUserMessage(right.userMessage)
  );
}

export function promptTitleIntentFromText(
  text: string,
  skillInvocation: UserSkillInvocationEcho | null | undefined,
): UserPromptTitleIntent {
  const bareSkillTrigger = Boolean(skillInvocation && !skillInvocation.userMessage?.trim());
  if (skillInvocation && bareSkillTrigger) {
    return promptTitleIntent({
      label: bareSkillTitle(skillInvocation.name),
      quality: "fallback",
      source: "skill",
      reason: "bare-skill",
      bareSkillTrigger,
    });
  }

  const source: UserPromptTitleSource = skillInvocation ? "skill" : "prompt";
  const rawLabel = skillInvocation ? formatSkillInvocationIntent(skillInvocation) : text;
  const compactLabel = compactPromptTitleLabel(rawLabel);
  if (!compactLabel) {
    return promptTitleIntent({
      label: "",
      quality: "empty",
      source,
      reason: "empty",
      bareSkillTrigger,
    });
  }

  if (skillInvocation) {
    return promptTitleIntent({
      label: compactLabel,
      quality: "strong",
      source,
      reason: "meaningful",
      bareSkillTrigger,
    });
  }

  const acknowledgementStripped = stripAcknowledgementPrefix(compactLabel);
  const candidateLabel = acknowledgementStripped.label;
  if (!hasSmartPromptTitleSignal(candidateLabel)) {
    return promptTitleIntent({
      label: candidateLabel,
      quality: "low-signal",
      source,
      reason: "low-signal",
      bareSkillTrigger,
    });
  }

  return promptTitleIntent({
    label: candidateLabel,
    quality: "strong",
    source,
    reason: acknowledgementStripped.stripped ? "acknowledgement-prefix" : "meaningful",
    bareSkillTrigger,
  });
}

export function promptTitleIntentFromUserBlock(
  block: Pick<UserBlock, "content" | "delivery" | "origin" | "skillInvocation">,
): UserPromptTitleIntent | null {
  if (block.delivery === "current-turn-guidance") return null;
  return promptTitleIntentFromText(block.content, userBlockSkillInvocation(block));
}
