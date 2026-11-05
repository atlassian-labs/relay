import * as path from "path";
import childSessionCollaborationPrompt from "./builtin-prompts/child-session-collaboration.md" with { type: "text" };
import handoffPrompt from "./builtin-prompts/handoff.md" with { type: "text" };
import reviewPrompt from "./builtin-prompts/review.md" with { type: "text" };
import { existsSync, readFileSync } from "./platform/fs";
import { getConfigDir } from "./platform/paths";

export const PROMPT_TEMPLATE_IDS = [
  "child-session-collaboration",
  "handoff",
  "review",
  "relay-plugins",
  "relay-themes",
] as const;

export type PromptTemplateId = (typeof PROMPT_TEMPLATE_IDS)[number];

const CURRENT_CHILD_SESSION_PROMPT_VERSION = 4;

const DEFAULT_PROMPT_TEMPLATES: Readonly<Partial<Record<PromptTemplateId, string>>> = {
  "child-session-collaboration": childSessionCollaborationPrompt,
  handoff: handoffPrompt,
  review: reviewPrompt,
};

export const CHILD_SESSION_REMINDER_RELATIVE_PATH = path.join("prompts", "child-session-collaboration.md");
export const DEFAULT_CHILD_SESSION_REMINDER_TEMPLATE = childSessionCollaborationPrompt;

let loadedPromptTemplates: Readonly<Partial<Record<PromptTemplateId, string>>> | null = null;

export function getPromptTemplatePath(id: PromptTemplateId): string {
  return path.join(getConfigDir(), "prompts", `${id}.md`);
}

export function loadPromptTemplates(warn: (message: string) => void = () => undefined): void {
  const loaded: Partial<Record<PromptTemplateId, string>> = {};
  for (const id of PROMPT_TEMPLATE_IDS) {
    const filePath = getPromptTemplatePath(id);
    try {
      if (existsSync(filePath)) {
        const template = readFileSync(filePath, "utf-8");
        const childPromptVersion =
          id === "child-session-collaboration"
            ? Number(template.match(/<child_session_collaboration\s+version="(\d+)">/u)?.[1])
            : undefined;
        if (
          childPromptVersion !== undefined &&
          Number.isFinite(childPromptVersion) &&
          childPromptVersion < CURRENT_CHILD_SESSION_PROMPT_VERSION
        ) {
          warn(
            `Ignoring outdated child-session prompt override version ${childPromptVersion} at ${filePath}; using built-in version ${CURRENT_CHILD_SESSION_PROMPT_VERSION}`,
          );
          continue;
        }
        loaded[id] = template;
      }
    } catch (error) {
      warn(
        `Unable to load prompt override at ${filePath}; using the built-in prompt: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  loadedPromptTemplates = loaded;
}

export function getPromptTemplate(id: PromptTemplateId, builtInTemplate?: string): string {
  if (!loadedPromptTemplates) loadPromptTemplates();
  return loadedPromptTemplates?.[id] ?? builtInTemplate ?? DEFAULT_PROMPT_TEMPLATES[id] ?? "";
}

export function resetPromptTemplates(): void {
  loadedPromptTemplates = null;
}

export function getChildSessionReminderTemplatePath(): string {
  return getPromptTemplatePath("child-session-collaboration");
}

export function loadChildSessionReminderTemplate(): string {
  loadPromptTemplates();
  return getPromptTemplate("child-session-collaboration");
}

export function getChildSessionReminderTemplate(): string {
  return getPromptTemplate("child-session-collaboration");
}
