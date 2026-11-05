import { renderPromptTemplate } from "./prompt-template";

export const CHILD_SESSION_TASK_TYPE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;
export const MAX_CHILD_SESSION_TASK_TYPES = 32;
export const MAX_CHILD_SESSION_TASK_TYPE_KEYWORDS = 32;
export const MAX_CHILD_SESSION_TASK_TYPE_KEYWORD_LENGTH = 64;
export const MAX_CHILD_SESSION_TASK_TYPE_DESCRIPTION_LENGTH = 500;

export interface ChildSessionTaskType {
  readonly name: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly agent?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
}

export interface MatchedChildSessionTaskType extends ChildSessionTaskType {
  readonly matchedKeywords: readonly string[];
}

function normalizedWords(value: string): string[] {
  return (
    value
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

export function normalizeChildSessionTaskTypeName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!CHILD_SESSION_TASK_TYPE_NAME_PATTERN.test(normalized)) {
    throw new Error('Task type name must use lowercase letters, digits, or "-" and be at most 32 characters'); // effect-shape-allow: pure task-type parser reports invalid caller input.
  }
  return normalized;
}

export function normalizeChildSessionTaskTypeKeyword(value: string): string {
  const normalized = normalizedWords(value).join(" ");
  if (!normalized) throw new Error("Task type keywords must contain at least one letter or digit"); // effect-shape-allow: pure task-type parser reports invalid caller input.
  if ([...normalized].length > MAX_CHILD_SESSION_TASK_TYPE_KEYWORD_LENGTH) {
    throw new Error(`Task type keywords must be at most ${MAX_CHILD_SESSION_TASK_TYPE_KEYWORD_LENGTH} characters`); // effect-shape-allow: pure task-type parser reports invalid caller input.
  }
  return normalized;
}

function includesWordSequence(words: readonly string[], sequence: readonly string[]): boolean {
  if (sequence.length === 0 || sequence.length > words.length) return false;
  for (let index = 0; index <= words.length - sequence.length; index += 1) {
    if (sequence.every((word, offset) => words[index + offset] === word)) return true;
  }
  return false;
}

function explicitlyRequestsRelayChildSessions(prompt: string): boolean {
  const words = normalizedWords(prompt);
  return [
    ["relay", "start", "session"],
    ["relay", "child", "session"],
    ["relay", "child", "sessions"],
    ["relay", "agent", "orchestration"],
    ["relay", "control", "plane", "orchestration"],
  ].some((sequence) => includesWordSequence(words, sequence));
}

export function matchChildSessionTaskTypes(
  prompt: string,
  taskTypes: Readonly<Record<string, ChildSessionTaskType>>,
): MatchedChildSessionTaskType[] {
  const promptWords = normalizedWords(prompt);
  if (promptWords.length === 0) return [];
  return Object.values(taskTypes).flatMap((taskType) => {
    const matchedKeywords = taskType.keywords.filter((keyword) =>
      includesWordSequence(promptWords, normalizedWords(keyword)),
    );
    return matchedKeywords.length > 0 ? [{ ...taskType, matchedKeywords }] : [];
  });
}

export interface ChildSessionCollaborationReminderInput {
  readonly template: string;
  readonly prompt: string;
  readonly taskTypes: Readonly<Record<string, ChildSessionTaskType>>;
  readonly currentSessionName: string;
}

function promptSafeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

export function childSessionCollaborationReminder(input: ChildSessionCollaborationReminderInput): string | undefined {
  if (!input.template.trim()) return undefined;
  const matches = matchChildSessionTaskTypes(input.prompt, input.taskTypes);
  if (matches.length === 0 && !explicitlyRequestsRelayChildSessions(input.prompt)) return undefined;
  const sessionJson = promptSafeJson({
    current: input.currentSessionName,
    parent: null,
    role: "parent",
  });
  const matchedTaskTypesJson = promptSafeJson({ taskTypes: matches });
  return renderPromptTemplate(input.template, {
    session_json: sessionJson,
    matched_task_types_json: matchedTaskTypesJson,
  }).trim();
}
