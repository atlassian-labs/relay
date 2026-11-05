export type ComposerInputOwner =
  | "composer"
  | "queue"
  | "sidebar"
  | "expanded-sidebar"
  | "textarea-overlay"
  | "overlay"
  | "elicitation"
  | "approval"
  | "file-changes"
  | "plugin"
  | "token-usage"
  | "shortcut-reference"
  | "transcript"
  | "subagent-detail"
  | "connection-error";

export function isSoftComposerInputOwner(owner: ComposerInputOwner): boolean {
  return owner === "queue" || owner === "sidebar";
}

export function isSuspendedComposerInputOwner(owner: ComposerInputOwner): boolean {
  return owner !== "composer" && owner !== "textarea-overlay" && !isSoftComposerInputOwner(owner);
}

export function isComposerPromptFocused(owner: ComposerInputOwner): boolean {
  return owner === "composer" || owner === "textarea-overlay";
}

export function blocksChatScroll(owner: ComposerInputOwner): boolean {
  return owner !== "composer" && !isSoftComposerInputOwner(owner);
}
