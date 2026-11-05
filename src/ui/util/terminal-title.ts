import * as path from "node:path";
import type { ChatBlock } from "../state";
import {
  promptTitleIntentFromUserBlock,
  type UserPromptTitleIntent,
  type UserPromptTitleQuality,
} from "./user-message";

export const DEFAULT_TERMINAL_TITLE = "relay";
export const MAX_TERMINAL_TITLE_CHARS = 240;
export const NEEDS_INPUT_TERMINAL_TITLE_PREFIX = "Needs input";
export const TERMINAL_TITLE_ACTIVITY_GRACE_MS = 2_000;
export const TERMINAL_TITLE_PROMPT_SOURCES = ["smart", "first", "last"] as const;
export type TerminalTitlePromptSource = (typeof TERMINAL_TITLE_PROMPT_SOURCES)[number];
export const DEFAULT_TERMINAL_TITLE_PROMPT_SOURCE: TerminalTitlePromptSource = "smart";

const ESC = "\u001b";
const BEL = "\u0007";
const OSC_8BIT = "\u009d";
const CSI_8BIT = "\u009b";
const ST_8BIT = "\u009c";

export interface SanitizeTerminalTitleOptions {
  readonly fallback?: string;
  readonly maxLength?: number;
  readonly allowEmpty?: boolean;
}

export interface TerminalTitleOutput {
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface TerminalTitleState {
  readonly cwd: string;
  readonly connecting?: boolean;
  readonly running?: boolean;
  readonly spinnerActive?: boolean;
  readonly active?: boolean;
  readonly spinnerFrame?: string;
  readonly blocks?: readonly ChatBlock[];
  readonly actionRequired?: boolean;
  readonly latestPromptTitleIntent?: UserPromptTitleIntent | null;
  readonly sessionTitle?: string;
  readonly terminalTitlePromptSource?: TerminalTitlePromptSource;
}

export interface TerminalTitleManager {
  set(title: string): boolean;
  update(state: TerminalTitleState): boolean;
  clear(): boolean;
}

export interface TerminalTitleActivityTrackerInput {
  readonly nowMs: number;
  readonly scopeKey: string;
  readonly active: boolean;
  readonly actionRequired: boolean;
  readonly activitySequence: number;
}

export interface TerminalTitleActivityTracker {
  isActive(input: TerminalTitleActivityTrackerInput): boolean;
  reset(): void;
}

function isDisallowedTerminalTitleCodePoint(codePoint: number): boolean {
  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  return (
    codePoint === 0x00ad ||
    codePoint === 0x034f ||
    codePoint === 0x061c ||
    codePoint === 0x180e ||
    (codePoint >= 0x180b && codePoint <= 0x180f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xfff9 && codePoint <= 0xfffb) ||
    (codePoint >= 0x1bca0 && codePoint <= 0x1bca3) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function oscTerminatorLength(input: string, index: number): number {
  if (input[index] === BEL || input[index] === ST_8BIT) return 1;
  return input[index] === ESC && input[index + 1] === "\\" ? 2 : 0;
}

function skipOscSequence(input: string, start: number): number {
  let index = start;
  while (index < input.length) {
    const terminatorLength = oscTerminatorLength(input, index);
    if (terminatorLength > 0) return index + terminatorLength;
    index += 1;
  }
  return input.length;
}

function skipCsiSequence(input: string, start: number): number {
  let index = start;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
    index += 1;
  }
  return input.length;
}

function skipEscSequence(input: string, start: number): number {
  let index = start;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code >= 0x30 && code <= 0x7e) return index + 1;
    index += 1;
  }
  return input.length;
}

function stripTerminalControlSequences(input: string): string {
  let stripped = "";
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (char === ESC) {
      const next = input[index + 1];
      if (next === "]") {
        index = skipOscSequence(input, index + 2);
        continue;
      }
      if (next === "[") {
        index = skipCsiSequence(input, index + 2);
        continue;
      }
      index = skipEscSequence(input, index + 1);
      continue;
    }
    if (char === OSC_8BIT) {
      index = skipOscSequence(input, index + 1);
      continue;
    }
    if (char === CSI_8BIT) {
      index = skipCsiSequence(input, index + 1);
      continue;
    }
    stripped += char;
    index += 1;
  }
  return stripped;
}

function fallbackTerminalTitle(options: SanitizeTerminalTitleOptions, maxLength: number): string {
  const fallback = options.fallback ?? DEFAULT_TERMINAL_TITLE;
  if (fallback === "") return "";
  return sanitizeTerminalTitle(fallback, { maxLength, allowEmpty: true, fallback: "" });
}

export function sanitizeTerminalTitle(input: string, options: SanitizeTerminalTitleOptions = {}): string {
  const maxLength = Math.max(1, options.maxLength ?? MAX_TERMINAL_TITLE_CHARS);
  const allowEmpty = options.allowEmpty ?? false;
  const stripped = stripTerminalControlSequences(input);
  let sanitized = "";
  let charsWritten = 0;
  let pendingSpace = false;

  for (const char of stripped) {
    if (/\s/u.test(char)) {
      pendingSpace = sanitized.length > 0;
      continue;
    }

    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || isDisallowedTerminalTitleCodePoint(codePoint)) continue;

    if (pendingSpace) {
      const remaining = maxLength - charsWritten;
      if (remaining > 1) {
        sanitized += " ";
        charsWritten += 1;
      }
      pendingSpace = false;
    }

    if (charsWritten >= maxLength) break;
    sanitized += char;
    charsWritten += 1;
  }

  if (sanitized.length > 0 || allowEmpty) return sanitized;
  return fallbackTerminalTitle(options, maxLength);
}

export function workspaceTerminalTitleLabel(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/g, "");
  const basename = normalized.includes("\\") ? path.win32.basename(normalized) : path.basename(normalized);
  return sanitizeTerminalTitle(basename, { fallback: DEFAULT_TERMINAL_TITLE });
}

export function hasPendingTerminalTitleAction(blocks: readonly ChatBlock[] = []): boolean {
  return blocks.some((block) => {
    if (block.type === "tool") return block.status === "approval" && typeof block.resolveApproval === "function";
    if (block.type === "elicitation") return block.status === "pending" && typeof block.respond === "function";
    return false;
  });
}

export function isTerminalTitleActive(state: TerminalTitleState): boolean {
  return state.active ?? Boolean(state.connecting || state.running || state.spinnerActive);
}

export function shouldAnimateTerminalTitleSpinner(
  state: Pick<TerminalTitleState, "actionRequired" | "connecting" | "running" | "spinnerActive">,
): boolean {
  if (state.actionRequired) return false;
  return Boolean(state.connecting || state.running || state.spinnerActive);
}

function truncateTerminalTitleLabel(input: string, maxLength = 50): string {
  const sanitized = sanitizeTerminalTitle(input, { allowEmpty: true, fallback: "" });
  if (sanitized.length <= maxLength) return sanitized;
  if (maxLength <= 3) return sanitized.slice(0, maxLength);
  return `${sanitized.slice(0, maxLength - 3).trimEnd()}...`;
}

interface TerminalTitlePromptCandidate {
  readonly label: string;
  readonly quality: UserPromptTitleQuality;
}

function terminalTitlePromptCandidate(intent: UserPromptTitleIntent): TerminalTitlePromptCandidate | null {
  const label = truncateTerminalTitleLabel(intent.label);
  if (!label || intent.quality === "empty") return null;
  return {
    label,
    quality: intent.quality,
  };
}

function latestPromptTitleCandidate(state: TerminalTitleState): TerminalTitlePromptCandidate | null {
  return state.latestPromptTitleIntent ? terminalTitlePromptCandidate(state.latestPromptTitleIntent) : null;
}

function userBlockTerminalTitleCandidate(
  block: Extract<ChatBlock, { type: "user" }>,
): TerminalTitlePromptCandidate | null {
  const intent = promptTitleIntentFromUserBlock(block);
  return intent ? terminalTitlePromptCandidate(intent) : null;
}

function latestUserPromptTitle(blocks: readonly ChatBlock[] = []): string {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.type !== "user") continue;

    const candidate = userBlockTerminalTitleCandidate(block);
    if (candidate) return candidate.label;
  }
  return "";
}

function firstUserPromptTitle(blocks: readonly ChatBlock[] = []): string {
  for (const block of blocks) {
    if (block.type !== "user") continue;

    const candidate = userBlockTerminalTitleCandidate(block);
    if (candidate) return candidate.label;
  }
  return "";
}

function latestPromptCandidateWithQuality(
  state: TerminalTitleState,
  quality: UserPromptTitleQuality,
): TerminalTitlePromptCandidate | null {
  const candidate = latestPromptTitleCandidate(state);
  return candidate?.quality === quality ? candidate : null;
}

function latestBlockCandidateWithQuality(
  blocks: readonly ChatBlock[],
  quality: UserPromptTitleQuality,
): TerminalTitlePromptCandidate | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.type !== "user") continue;

    const candidate = userBlockTerminalTitleCandidate(block);
    if (candidate?.quality === quality) return candidate;
  }
  return null;
}

function smartUserPromptTitleCandidate(state: TerminalTitleState): TerminalTitlePromptCandidate | null {
  const blocks = state.blocks ?? [];
  return (
    latestPromptCandidateWithQuality(state, "strong") ??
    latestBlockCandidateWithQuality(blocks, "strong") ??
    latestPromptCandidateWithQuality(state, "fallback") ??
    latestBlockCandidateWithQuality(blocks, "fallback")
  );
}

function promptTitleForSource(state: TerminalTitleState): string {
  const source = state.terminalTitlePromptSource ?? DEFAULT_TERMINAL_TITLE_PROMPT_SOURCE;
  if (source === "first")
    return firstUserPromptTitle(state.blocks) || truncateTerminalTitleLabel(state.latestPromptTitleIntent?.label ?? "");
  if (source === "last")
    return (
      truncateTerminalTitleLabel(state.latestPromptTitleIntent?.label ?? "") || latestUserPromptTitle(state.blocks)
    );
  return smartUserPromptTitleCandidate(state)?.label ?? "";
}

function shouldUseSessionTitleFallback(sessionTitle: string): boolean {
  return sessionTitle !== "New thread" && sessionTitle !== "New worktree thread";
}

function preferredTerminalTitleLabel(state: TerminalTitleState): string {
  const source = state.terminalTitlePromptSource ?? DEFAULT_TERMINAL_TITLE_PROMPT_SOURCE;
  if (source !== "smart") return promptTitleForSource(state);

  const promptCandidate = smartUserPromptTitleCandidate(state);
  if (promptCandidate?.quality === "strong") return promptCandidate.label;

  const sessionTitle = state.sessionTitle?.trim();
  if (sessionTitle && shouldUseSessionTitleFallback(sessionTitle)) return truncateTerminalTitleLabel(sessionTitle);

  return promptCandidate?.label ?? "";
}

function joinTerminalTitleSegments(segments: readonly string[]): string {
  return segments.filter((segment) => segment.trim()).join(" · ");
}

export function createTerminalTitleActivityTracker(
  graceMs: number = TERMINAL_TITLE_ACTIVITY_GRACE_MS,
): TerminalTitleActivityTracker {
  const boundedGraceMs = Math.max(0, graceMs);
  let initialized = false;
  let keepAliveUntilMs = 0;
  let previousScopeKey = "";
  let previousVisibleActive = false;
  let previousActivitySequence = 0;

  const resetForScope = (input: TerminalTitleActivityTrackerInput): void => {
    initialized = true;
    keepAliveUntilMs = 0;
    previousScopeKey = input.scopeKey;
    previousVisibleActive = input.active || input.actionRequired;
    previousActivitySequence = input.activitySequence;
  };

  const extendKeepAlive = (nowMs: number): void => {
    if (boundedGraceMs <= 0) return;
    keepAliveUntilMs = Math.max(keepAliveUntilMs, nowMs + boundedGraceMs);
  };

  return {
    isActive(input: TerminalTitleActivityTrackerInput): boolean {
      if (!initialized || input.scopeKey !== previousScopeKey) {
        resetForScope(input);
        return input.active;
      }

      if (input.activitySequence !== previousActivitySequence) {
        previousActivitySequence = input.activitySequence;
        if (!input.active && !input.actionRequired) extendKeepAlive(input.nowMs);
      }

      const visibleActive = input.active || input.actionRequired;
      if (previousVisibleActive && !visibleActive) extendKeepAlive(input.nowMs);
      previousVisibleActive = visibleActive;

      if (input.active) return true;
      if (input.actionRequired) return false;
      if (keepAliveUntilMs > input.nowMs) return true;

      keepAliveUntilMs = 0;
      return false;
    },
    reset(): void {
      initialized = false;
      keepAliveUntilMs = 0;
      previousScopeKey = "";
      previousVisibleActive = false;
      previousActivitySequence = 0;
    },
  };
}

export function terminalTitleForState(state: TerminalTitleState): string {
  const workspace = workspaceTerminalTitleLabel(state.cwd);
  const preferredLabel = preferredTerminalTitleLabel(state);
  const label = joinTerminalTitleSegments(preferredLabel ? [preferredLabel, workspace] : [workspace]);
  const actionRequired = state.actionRequired ?? hasPendingTerminalTitleAction(state.blocks);
  if (actionRequired)
    return sanitizeTerminalTitle(joinTerminalTitleSegments([NEEDS_INPUT_TERMINAL_TITLE_PREFIX, label]));

  if (isTerminalTitleActive(state)) {
    const spinnerFrame = sanitizeTerminalTitle(state.spinnerFrame ?? "", { allowEmpty: true, fallback: "" });
    return sanitizeTerminalTitle(spinnerFrame ? `${spinnerFrame} ${label}` : label);
  }

  return sanitizeTerminalTitle(label);
}

export function encodeOsc0Title(title: string): string {
  return `\x1b]0;${title}\x07`;
}

export function createTerminalTitleManager(output: TerminalTitleOutput = process.stdout): TerminalTitleManager {
  let lastTitle: string | undefined;
  let hasManagedTitle = false;

  const canWrite = () => output.isTTY === true;

  const writeTitle = (title: string, allowEmpty: boolean): boolean => {
    if (!canWrite()) return false;
    const sanitized = sanitizeTerminalTitle(title, { allowEmpty });
    if (sanitized === lastTitle) return false;
    output.write(encodeOsc0Title(sanitized));
    lastTitle = sanitized;
    hasManagedTitle = true;
    return true;
  };

  return {
    set(title: string): boolean {
      return writeTitle(title, false);
    },
    update(state: TerminalTitleState): boolean {
      return writeTitle(terminalTitleForState(state), false);
    },
    clear(): boolean {
      if (!canWrite() || !hasManagedTitle || lastTitle === "") return false;
      output.write(encodeOsc0Title(""));
      lastTitle = "";
      return true;
    },
  };
}
