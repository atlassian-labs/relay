/**
 * Autocomplete providers & fuzzy matching.
 *
 * Provides:
 *  - FuzzyMatcher: case-insensitive subsequence fuzzy matching with scoring
 *  - SlashCommandProvider: triggers on `/` for slash command completion
 *  - FilePathProvider: triggers on `@` for file path completion
 */

import { execFile, spawnSync } from "../platform/process";
import { existsSync, readdirSync, statSync } from "../platform/fs";
import { join, basename, dirname, relative, sep, normalize, isAbsolute } from "path";
import { getHomeEnv } from "../platform/env";
import type { CommandDescriptor } from "../core/commands";
export { isComposableCommand } from "../core/commands";
export type {
  CommandOrigin as SlashCommandOrigin,
  CommandKind as SlashCommandKind,
  CommandInvocation as SlashCommandInvocation,
} from "../core/commands";

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

import { nativeSlashCommands } from "./util/native-slash-commands";
import type {
  RelayAutocompleteApplyContext,
  RelayAutocompleteApplyResult,
  RelayAutocompleteContext,
  RelayAutocompleteItem,
  RelayAutocompleteProviderResult,
  RelayAutocompleteResult,
} from "../plugins/types";

export interface FuzzyMatch {
  score: number;
  matched: boolean;
}

/**
 * Get the first letter of each "word" in a string for fuzzy bonus scoring.
 * Words are delimited by whitespace, hyphens, underscores, dots, slashes, etc.
 */
function getFirstLetters(text: string): Set<number> {
  const result = new Set<number>();
  const re = /[\s\-_./\\]+/g;
  let start = 0;
  let match: RegExpExecArray | null;
  if (text.length > 0) result.add(0); // first char is always a "first letter"
  while ((match = re.exec(text)) !== null) {
    const nextIdx = match.index + match[0].length;
    if (nextIdx < text.length) {
      result.add(nextIdx);
    }
  }
  return result;
}

/**
 * Fuzzy-match query against a candidate string.
 * Returns { matched, score }. Higher score = better match.
 */
export function fuzzyMatch(query: string, candidate: string): FuzzyMatch {
  if (!query) return { matched: true, score: 0 };
  const qLower = query.toLowerCase();
  const cLower = candidate.toLowerCase();

  // Check if query is a subsequence of candidate
  let qi = 0;
  const matchPositions: number[] = [];
  for (let ci = 0; ci < cLower.length && qi < qLower.length; ci++) {
    if (cLower[ci] === qLower[qi]) {
      matchPositions.push(ci);
      qi++;
    }
  }
  if (qi < qLower.length) return { matched: false, score: 0 };

  // Score: base = matched chars
  let score = matchPositions.length;

  // Bonus: first-letter-of-word matches
  const firstLetters = getFirstLetters(cLower);
  for (const pos of matchPositions) {
    if (firstLetters.has(pos)) score += 2;
  }

  // Bonus: fewer "gaps" (consecutive groups)
  let groups = 1;
  for (let i = 1; i < matchPositions.length; i++) {
    if (matchPositions[i] !== matchPositions[i - 1] + 1) groups++;
  }
  score += Math.max(0, 10 - groups * 2);

  // Bonus: prefix match
  if (matchPositions[0] === 0) score *= 1.2;

  return { matched: true, score };
}

// ---------------------------------------------------------------------------
// List item for display
// ---------------------------------------------------------------------------

export type ListItemTone = "accent" | "success" | "error" | "muted";

export interface ListItem<T = unknown> {
  value: T;
  label: string;
  /** Optional label used for filtering when the display label contains decorative prefixes. */
  searchLabel?: string;
  description: string;
  descriptionColumns?: readonly string[];
  active?: boolean;
  tone?: ListItemTone;
  tonePrefixLength?: number;
}

// ---------------------------------------------------------------------------
// Slash command definitions
// ---------------------------------------------------------------------------

export type SlashCommand = CommandDescriptor;

export const DEFAULT_SLASH_COMMANDS: SlashCommand[] = nativeSlashCommands();

// ---------------------------------------------------------------------------
// Slash command provider
// ---------------------------------------------------------------------------

export interface CompletionResult<T = unknown> {
  items: ListItem<T>[];
  /** Position in the input text where the token starts (for replacement). */
  tokenStart: number;
  /** The typed query/token text being replaced. */
  query: string;
  /** Optional exclusive end offset for plugin completions that replace a full cursor token. */
  replaceEnd?: number;
  applyCompletion?: (ctx: RelayAutocompleteApplyContext) => RelayAutocompleteApplyResult;
  kind?: "slash" | "slash-argument" | "file" | "plugin";
}

/**
 * Extracts the slash command token from text before the cursor.
 * Returns null if no slash trigger found.
 */
function extractSlashToken(
  text: string,
  cursorPos?: number,
): { token: string; start: number; isStartCommand: boolean } | null {
  const pos = cursorPos ?? text.length;
  const before = text.slice(0, pos);

  // Find the last `/` that's at start or after whitespace
  for (let i = before.length - 1; i >= 0; i--) {
    if (before[i] === "/") {
      if (i === 0 || /\s/.test(before[i - 1])) {
        const token = before.slice(i + 1);
        // No spaces in the token (otherwise it's not a command being typed)
        if (/\s/.test(token)) return null;
        return {
          token,
          start: i,
          isStartCommand: i === 0,
        };
      }
    }
  }
  return null;
}

/**
 * Get slash command suggestions.
 */
export function getSlashSuggestions(text: string, commands?: SlashCommand[]): CompletionResult<SlashCommand> | null {
  const info = extractSlashToken(text);
  if (!info) return null;

  const commandByName = new Map<string, SlashCommand>();
  for (const cmd of commands ?? DEFAULT_SLASH_COMMANDS) {
    const name = cmd.name.toLowerCase();
    if (!commandByName.has(name)) commandByName.set(name, cmd);
  }
  if (!info.isStartCommand) return null;
  const visibleCommands = [...commandByName.values()];

  const query = info.token.toLowerCase();
  const scored: { item: ListItem<SlashCommand>; score: number }[] = [];

  for (const cmd of visibleCommands) {
    const m = fuzzyMatch(query, cmd.name);
    if (m.matched) {
      scored.push({
        item: {
          value: cmd,
          label: `/${cmd.name}`,
          description: cmd.description.toLowerCase(),
        },
        score: m.score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
  if (scored.length === 0) return null;

  return {
    items: scored.map((s) => s.item),
    tokenStart: info.start,
    query,
    kind: "slash",
  };
}

/**
 * Returns the set of known slash command names (lowercased). When callers pass
 * a command list, it is treated as the complete visible set; otherwise the
 * ungated built-in defaults are used.
 */
export function getKnownSlashCommandNames(commands?: SlashCommand[]): Set<string> {
  const names = new Set<string>();
  for (const cmd of commands ?? DEFAULT_SLASH_COMMANDS) names.add(cmd.name.toLowerCase());
  return names;
}

/**
 * Apply a slash command completion: replace the typed prefix with the full command name.
 */
export function applySlashCompletion(
  text: string,
  completion: CompletionResult,
  selected: ListItem<SlashCommand>,
): string {
  const before = text.slice(0, completion.tokenStart);
  const after = text.slice(completion.tokenStart + 1 + completion.query.length);
  return `${before}${selected.label} ${after}`;
}

export interface SlashCommandArgumentTarget {
  readonly commandName: string;
  readonly argsPrefix: string;
  readonly tokenStart: number;
}

export function getSlashCommandArgumentTarget(
  text: string,
  commandNames: ReadonlySet<string>,
  cursorPos?: number,
): SlashCommandArgumentTarget | null {
  const pos = cursorPos ?? text.length;
  const beforeCursor = text.slice(0, pos);
  const leadingWhitespace = beforeCursor.match(/^\s*/u)?.[0].length ?? 0;
  if (beforeCursor[leadingWhitespace] !== "/") return null;

  const afterSlash = beforeCursor.slice(leadingWhitespace + 1);
  const match = afterSlash.match(/^(\S+)(\s+)([\s\S]*)$/u);
  if (!match) return null;

  const commandName = match[1].toLowerCase();
  if (!commandNames.has(commandName)) return null;
  const tokenStart = leadingWhitespace + 1 + match[1].length + match[2].length;
  return {
    commandName,
    argsPrefix: match[3],
    tokenStart,
  };
}

export function buildSlashCommandArgumentCompletion(
  target: SlashCommandArgumentTarget,
  items: readonly RelayAutocompleteItem[] | null,
): CompletionResult<RelayAutocompleteItem> | null {
  if (!items || items.length === 0) return null;
  return {
    items: items.map((item) => ({
      value: item,
      label: item.label,
      description: item.description ?? "",
    })),
    tokenStart: target.tokenStart,
    query: target.argsPrefix,
    kind: "plugin",
  };
}

// ---------------------------------------------------------------------------
// File path provider
// ---------------------------------------------------------------------------

/**
 * Extracts the file path token from text before cursor.
 * Triggers on `@` at start or after whitespace.
 */
function extractFileToken(text: string, cursorPos?: number): { token: string; start: number } | null {
  const pos = cursorPos ?? text.length;
  const before = text.slice(0, pos);

  for (let i = before.length - 1; i >= 0; i--) {
    if (before[i] === "@") {
      if (i === 0 || /\s/.test(before[i - 1])) {
        const token = before.slice(i + 1);
        if (/\s/.test(token)) return null;
        return { token, start: i };
      }
    }
  }
  return null;
}

function buildFileSuggestionResult(
  info: { token: string; start: number },
  cwd: string,
  paths: string[],
  maxResults: number,
): CompletionResult<string> | null {
  const query = info.token;
  const scored: { item: ListItem<string>; score: number }[] = [];
  for (const p of paths) {
    const rel = p.startsWith(cwd) ? relative(cwd, p) : p;
    const m = fuzzyMatch(query, rel);
    if (m.matched) {
      let isDir = false;
      try {
        isDir = statSync(join(cwd, rel)).isDirectory();
      } catch {}
      // Kon pattern: label = basename (with / for dirs), description = parent dir
      const name = basename(rel) + (isDir ? "/" : "");
      const parent = dirname(rel) || ".";
      scored.push({
        item: {
          value: p,
          label: name,
          description: parent,
        },
        score: m.score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return {
    items: scored.slice(0, maxResults).map((s) => s.item),
    tokenStart: info.start,
    query,
    kind: "file",
  };
}

/**
 * Get file path suggestions using `fd` (fast find) or a fallback glob.
 */
export function hasFileSuggestionToken(text: string, cursorPos?: number): boolean {
  return extractFileToken(text, cursorPos) !== null;
}

export function getFileSuggestions(
  text: string,
  cwd: string,
  maxResults: number = 20,
): CompletionResult<string> | null {
  const info = extractFileToken(text);
  if (!info) return null;

  return buildFileSuggestionResult(info, cwd, findFiles(info.token, cwd, maxResults), maxResults);
}

export function getFileSuggestionsDeferred(
  text: string,
  cwd: string,
  maxResults: number = 20,
  onResult: (result: CompletionResult<string> | null) => void,
): () => void {
  const info = extractFileToken(text);
  if (!info) {
    onResult(null);
    return () => {};
  }

  return findFilesDeferred(info.token, cwd, maxResults, (paths) => {
    onResult(buildFileSuggestionResult(info, cwd, paths, maxResults));
  });
}

/**
 * Apply a file path completion: replace the typed @prefix with the full path.
 */
export function applyFileCompletion(
  text: string,
  completion: CompletionResult,
  selected: ListItem<string>,
  cwd?: string,
): string {
  const before = text.slice(0, completion.tokenStart);
  const after = text.slice(completion.tokenStart + 1 + completion.query.length);
  // Build the relative path from the absolute value
  const absPath = selected.value;
  const relPath = cwd && absPath.startsWith(cwd) ? relative(cwd, absPath) : absPath;
  const isDir = relPath.endsWith("/") || selected.label.endsWith("/");
  const cleanRel = relPath.replace(/\/$/, "");
  return `${before}@${cleanRel}${isDir ? "/" : " "}${after}`;
}

function pluginCompletionTokenEnd(completion: CompletionResult): number {
  return completion.replaceEnd ?? completion.tokenStart + completion.query.length;
}

export function applyPluginCompletion<T extends { readonly insertText?: string }>(
  text: string,
  completion: CompletionResult<T>,
  selected: ListItem<T>,
): string {
  const before = text.slice(0, completion.tokenStart);
  const after = text.slice(pluginCompletionTokenEnd(completion));
  return `${before}${selected.value.insertText ?? selected.label}${after}`;
}

export interface AppliedPluginCompletion {
  readonly text: string;
  readonly cursorOffset: number;
}

function normalizePluginApplyResult(
  result: RelayAutocompleteApplyResult,
  fallback: AppliedPluginCompletion,
): AppliedPluginCompletion {
  if (result === undefined || result === null) return fallback;
  if (typeof result === "string") {
    return { text: result, cursorOffset: result.length };
  }
  return {
    text: result.text,
    cursorOffset: result.cursorOffset ?? result.text.length,
  };
}

export function applyPluginCompletionSelection<T extends RelayAutocompleteItem>(
  text: string,
  completion: CompletionResult<T>,
  selected: ListItem<T>,
  cwd: string,
  cursorOffset: number,
): AppliedPluginCompletion {
  const tokenEnd = pluginCompletionTokenEnd(completion);
  const fallbackText = applyPluginCompletion(text, completion, selected);
  const fallback = {
    text: fallbackText,
    cursorOffset: fallbackText.length - text.slice(tokenEnd).length,
  };

  if (!completion.applyCompletion) return fallback;
  return normalizePluginApplyResult(
    completion.applyCompletion({
      text,
      item: selected.value,
      cwd,
      cursorOffset,
      token: text.slice(completion.tokenStart, tokenEnd),
      tokenStart: completion.tokenStart,
      tokenEnd,
    }),
    fallback,
  );
}

function clampOffset(offset: number, text: string): number {
  if (!Number.isFinite(offset)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(offset)));
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/u.test(char);
}

function cursorLineColumn(
  text: string,
  cursorOffset: number,
): Pick<RelayAutocompleteContext, "cursorLine" | "cursorColumn"> {
  const beforeCursor = text.slice(0, cursorOffset);
  const lastNewline = beforeCursor.lastIndexOf("\n");
  const cursorLine = beforeCursor === "" ? 0 : beforeCursor.split("\n").length - 1;
  return {
    cursorLine,
    cursorColumn: cursorOffset - lastNewline - 1,
  };
}

function findPlainTokenRange(text: string, cursorOffset: number): { readonly start: number; readonly end: number } {
  let start = cursorOffset;
  while (start > 0 && !isWhitespace(text[start - 1])) start--;
  let end = cursorOffset;
  while (end < text.length && !isWhitespace(text[end])) end++;
  return { start, end };
}

function findTriggeredTokenRange(
  text: string,
  cursorOffset: number,
  trigger: string,
): { readonly start: number; readonly end: number } | null {
  if (trigger.length === 0) return null;
  const beforeCursor = text.slice(0, cursorOffset);
  const triggerStart = beforeCursor.lastIndexOf(trigger);
  if (triggerStart < 0) return null;
  const prefix = text.slice(triggerStart, cursorOffset);
  if (/\s/u.test(prefix)) return null;

  let end = cursorOffset;
  while (end < text.length && !isWhitespace(text[end])) end++;
  return { start: triggerStart, end };
}

export function getRelayAutocompleteContext(
  text: string,
  cwd: string,
  cursorOffset: number = text.length,
  trigger?: string,
): RelayAutocompleteContext | null {
  const offset = clampOffset(cursorOffset, text);
  const range = trigger ? findTriggeredTokenRange(text, offset, trigger) : findPlainTokenRange(text, offset);
  if (!range) return null;
  return {
    text,
    lines: text.split("\n"),
    cursorOffset: offset,
    ...cursorLineColumn(text, offset),
    cwd,
    token: text.slice(range.start, range.end),
    tokenStart: range.start,
  };
}

function isRelayAutocompleteItemArray(
  value: RelayAutocompleteProviderResult,
): value is readonly RelayAutocompleteItem[] {
  return Array.isArray(value);
}

function isRelayAutocompleteResult(value: RelayAutocompleteProviderResult): value is RelayAutocompleteResult {
  return value !== null && !isRelayAutocompleteItemArray(value);
}

function autocompleteResultItems(result: RelayAutocompleteProviderResult): readonly RelayAutocompleteItem[] | null {
  if (result === null) return null;
  return isRelayAutocompleteItemArray(result) ? result : result.items;
}

export function buildPluginAutocompleteCompletion(
  context: RelayAutocompleteContext,
  result: RelayAutocompleteProviderResult,
  applyCompletion?: (ctx: RelayAutocompleteApplyContext) => RelayAutocompleteApplyResult,
): CompletionResult<RelayAutocompleteItem> | null {
  const items = autocompleteResultItems(result);
  if (!items || items.length === 0) return null;

  const resultObject = isRelayAutocompleteResult(result) ? result : null;
  const tokenStart = clampOffset(resultObject?.tokenStart ?? context.tokenStart, context.text);
  const tokenEnd = clampOffset(
    resultObject?.tokenEnd ?? tokenStart + (resultObject?.query ?? context.token).length,
    context.text,
  );
  const replaceEnd = Math.max(tokenStart, tokenEnd);
  const query = resultObject?.query ?? context.text.slice(tokenStart, replaceEnd);

  return {
    items: items.map((item) => ({
      value: item,
      label: item.label,
      description: item.description ?? "",
    })),
    tokenStart,
    query,
    replaceEnd,
    ...(applyCompletion ? { applyCompletion } : {}),
    kind: "plugin",
  };
}

function getFdArgs(query: string, maxResults: number): string[] {
  const args = [
    "--full-path",
    "--color=never",
    "--max-results",
    String(maxResults),
    "-t",
    "f",
    "-t",
    "d",
    "--exclude",
    "node_modules",
    "--exclude",
    ".git",
  ];
  if (query) args.push(query);
  return args;
}

function parseFdOutput(stdout: string, cwd: string): string[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((p) => join(cwd, p));
}

/**
 * Find files matching query using `fd` or fallback.
 */
function findFiles(query: string, cwd: string, maxResults: number): string[] {
  // Try `fd` first
  try {
    const result = spawnSync("fd", getFdArgs(query, maxResults), {
      cwd,
      timeout: 500,
      encoding: "utf-8",
    });

    if (result.status === 0 && result.stdout) {
      return parseFdOutput(result.stdout, cwd);
    }
  } catch {
    // fd not available, fallback
  }

  // Fallback: simple readdir-based search
  return fallbackFind(query, cwd, maxResults);
}

function findFilesDeferred(
  query: string,
  cwd: string,
  maxResults: number,
  onResult: (paths: string[]) => void,
): () => void {
  let settled = false;

  try {
    const child = execFile("fd", getFdArgs(query, maxResults), { cwd, timeout: 500 }, (error, output) => {
      if (settled) return;
      settled = true;
      if (!error && output) {
        onResult(parseFdOutput(output, cwd));
        return;
      }
      onResult(fallbackFind(query, cwd, maxResults));
    });

    child.on("error", () => {
      if (settled) return;
      settled = true;
      onResult(fallbackFind(query, cwd, maxResults));
    });

    return () => {
      settled = true;
      child.kill();
    };
  } catch {
    onResult(fallbackFind(query, cwd, maxResults));
    return () => {};
  }
}

function fallbackFind(query: string, cwd: string, maxResults: number): string[] {
  const results: string[] = [];
  const queryLower = query.toLowerCase();

  function walk(dir: string, depth: number) {
    if (depth > 3 || results.length >= maxResults) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = join(dir, entry.name);
        const rel = relative(cwd, full);
        if (!queryLower || rel.toLowerCase().includes(queryLower)) {
          results.push(full);
        }
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        }
      }
    } catch {}
  }

  walk(cwd, 0);
  return results;
}

// ---------------------------------------------------------------------------
// Selection mode enum
// ---------------------------------------------------------------------------

export enum SelectionMode {
  MODEL = "model",
  THINKING = "thinking",
  MODE = "mode",
  THEME = "theme",
  SETTINGS = "settings",
  SETTING_VALUE = "setting-value",
  ACP_CONFIG_VALUE = "acp-config-value",
  PLUGINS = "plugins",
  PLUGIN_DETAILS = "plugin-details",
  SESSION = "session",
  SESSION_LOADING = "session-loading",
  AUTH_METHOD = "auth-method",
  LINK = "link",
  WORKTREE = "worktree",
  PROMPT_HISTORY = "prompt-history",
  TREE = "tree",
  SUBAGENT = "subagent",
  CHILD = "child",
}

// ---------------------------------------------------------------------------
// PathCompleter — Tab-based filesystem path completion
// ---------------------------------------------------------------------------

const PATH_QUOTE_BOUNDARY_CHARS = new Set(["(", "[", "{", "<", "=", ":", ",", ";", "/", "\\"]);
const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}_]/u;

function isEscaped(text: string, index: number): boolean {
  let backslashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
    backslashCount++;
  }
  return backslashCount % 2 === 1;
}

function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && WORD_CHARACTER_PATTERN.test(char);
}

function canStartQuotedPath(text: string, index: number): boolean {
  if (isEscaped(text, index)) return false;
  const previous = index > 0 ? text[index - 1] : undefined;
  if (previous === undefined || /\s/.test(previous)) return true;
  if (isWordCharacter(previous)) return false;
  return PATH_QUOTE_BOUNDARY_CHARS.has(previous);
}

function findUnclosedPathQuoteStart(text: string): number {
  let quoteChar: string | null = null;
  let quoteStart = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if ((char !== '"' && char !== "'") || isEscaped(text, i)) continue;

    if (quoteChar === null) {
      if (!canStartQuotedPath(text, i)) continue;
      quoteChar = char;
      quoteStart = i;
    } else if (char === quoteChar) {
      quoteChar = null;
      quoteStart = -1;
    }
  }

  return quoteStart;
}

/**
 * Synchronous path completion with caching.
 *
 * Features:
 * - Expands ~ and resolves relative paths
 * - Caches directory listings for performance
 * - Finds longest common prefix for multiple matches
 * - Returns (completionText, alternatives)
 */
export class PathCompleter {
  private _cache: Map<string, string[]> = new Map();

  clearCache(): void {
    this._cache.clear();
  }

  /**
   * Complete a path fragment.
   * Returns [completionText, alternatives]:
   *  - completionText: text to append (or longest common prefix)
   *  - alternatives: all matching names (empty if unique match)
   */
  complete(cwd: string, pathFragment: string): [string, string[]] {
    if (!pathFragment) return ["", []];

    // Expand ~ to home directory
    let expanded = pathFragment;
    if (pathFragment.startsWith("~")) {
      const home = getHomeEnv() ?? "";
      expanded = home + pathFragment.slice(1);
    }

    // Resolve relative to cwd if not absolute
    const basePath = isAbsolute(expanded) ? expanded : join(cwd, expanded);
    const normalized = normalize(basePath);

    // Determine directory to list and prefix to match
    const endsWithSep = pathFragment.endsWith("/") || pathFragment.endsWith(sep);
    const isHomeOnly = pathFragment === "~" || pathFragment === "~/";
    const isDotPath = pathFragment === "." || pathFragment === "..";

    let dirToList: string;
    let matchPrefix: string;

    if (endsWithSep || isHomeOnly) {
      // User wants to see directory contents
      try {
        if (existsSync(normalized) && statSync(normalized).isDirectory()) {
          dirToList = normalized;
          matchPrefix = "";
        } else {
          return ["", []];
        }
      } catch {
        return ["", []];
      }
    } else if (isDotPath) {
      // . or .. → complete to ./ or ../
      return ["/", []];
    } else {
      // Typing a name — match in parent directory
      dirToList = dirname(normalized);
      matchPrefix = basename(normalized);
      if (!dirToList) dirToList = cwd;
    }

    const entries = this._listDirectory(dirToList);
    if (!entries) return ["", []];

    // Filter by prefix (case-insensitive)
    const matches = entries.filter((e) => e.toLowerCase().startsWith(matchPrefix.toLowerCase()));

    if (matches.length === 0) return ["", []];

    if (matches.length === 1) {
      const match = matches[0];
      const fullPath = join(dirToList, match);
      let isDir = false;
      try {
        isDir = existsSync(fullPath) && statSync(fullPath).isDirectory();
      } catch {}
      const withSep = isDir ? match + "/" : match;
      const completion = withSep.slice(matchPrefix.length);
      return [completion, []];
    }

    // Multiple matches — find longest common prefix
    const lcp = this._longestCommonPrefix(matches);
    const completion = lcp.slice(matchPrefix.length);

    const alternatives: string[] = [];
    for (const match of [...matches].sort()) {
      const fullPath = join(dirToList, match);
      let isDir = false;
      try {
        isDir = existsSync(fullPath) && statSync(fullPath).isDirectory();
      } catch {}
      alternatives.push(isDir ? match + "/" : match);
    }

    return [completion, alternatives];
  }

  private _listDirectory(dirPath: string): string[] | null {
    if (this._cache.has(dirPath)) return this._cache.get(dirPath)!;
    try {
      const entries = readdirSync(dirPath);
      this._cache.set(dirPath, entries);
      return entries;
    } catch {
      return null;
    }
  }

  /**
   * Extract the path fragment from text before the cursor.
   * Returns [pathFragment, startIndex] or ["", -1] if nothing found.
   */
  static extractPathFragment(text: string, cursorPos?: number): [string, number] {
    const before = cursorPos !== undefined ? text.slice(0, cursorPos) : text;
    if (!before) return ["", -1];

    // Handle quoted paths with spaces, but ignore natural-language apostrophes
    // inside words (for example, "Let's open ~/src" should complete ~/src).
    const quoteStart = findUnclosedPathQuoteStart(before);
    if (quoteStart >= 0) {
      return [before.slice(quoteStart + 1), quoteStart];
    }

    // Match explicit path patterns: ~/..., ./..., ../..., /..., word/word
    const m = before.match(/(~[^\s]*|\.\.?\/[^\s]*|\/[^\s]*|[^\s]*\/[^\s]*)$/);
    if (m) {
      return [m[1], before.length - m[1].length];
    }

    // Fall back: last whitespace-separated word (if it doesn't start with -)
    const trimmed = before.trimEnd();
    const spaceIdx = trimmed.lastIndexOf(" ");
    const lastWord = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1) : trimmed;
    if (lastWord && !lastWord.startsWith("-")) {
      const start = before.lastIndexOf(lastWord);
      return [lastWord, start];
    }

    return ["", -1];
  }

  /**
   * Get the directory portion of a path fragment.
   * For "src/kon/t" returns "src/kon/"
   * For "src" returns ""
   */
  static getBasePath(pathFragment: string): string {
    const lastSlash = pathFragment.lastIndexOf("/");
    if (lastSlash !== -1) return pathFragment.slice(0, lastSlash + 1);
    const lastSep = pathFragment.lastIndexOf(sep);
    if (lastSep !== -1) return pathFragment.slice(0, lastSep + 1);
    return "";
  }

  private _longestCommonPrefix(strings: string[]): string {
    if (strings.length === 0) return "";
    if (strings.length === 1) return strings[0];
    const first = strings[0];
    let result = "";
    for (let i = 0; i < first.length; i++) {
      const charLower = first[i].toLowerCase();
      if (strings.slice(1).every((s) => i < s.length && s[i].toLowerCase() === charLower)) {
        result += first[i];
      } else {
        break;
      }
    }
    return result;
  }

  invalidate(dirPath: string): void {
    this._cache.delete(normalize(dirPath));
  }
}
