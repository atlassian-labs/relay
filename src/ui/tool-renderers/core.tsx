import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import * as path from "node:path";
import { createPatch } from "diff";
import { getConfig } from "../../config";
import type { ColorsConfig } from "../../config/themes";
import { computeDiffColors } from "../../config/themes";
import { isSingleLineResult, stripTerminalControls } from "../util/format";

export { isSingleLineResult };
import type { ToolRenderContext, ToolRenderHelpers, ToolRendererOutput } from "./types";

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function readString(record: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function readScalarText(record: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

export function readBoolean(record: Record<string, unknown> | null, ...keys: string[]): boolean | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

export function readStringArray(record: Record<string, unknown> | null, ...keys: string[]): string[] {
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && item.length > 0);
    }
  }
  return [];
}

export function readLineRanges(record: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value) || value.length === 0) continue;
    const parts = value.map((item) => (Array.isArray(item) ? item.join("-") : "")).filter(Boolean);
    if (parts.length > 0) return parts.join(", ");
  }
  return undefined;
}

export function formatPathForDisplay(filePath: string, cwd: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) return filePath;
  if (!path.isAbsolute(trimmed)) return trimmed;

  const relative = path.relative(cwd, trimmed);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative || ".";
  }
  return trimmed;
}

export function truncateText(text: string, max = 256): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

export function previewInlineArg(text: string, max = 128): string {
  return truncateText(text.trim().replace(/\r\n|\n|\r/g, "\\n"), max);
}

export function countLines(text: string): number {
  if (!text.trim()) return 0;
  return text.trimEnd().split("\n").length;
}

export function parseLeadingCount(text: string, regex: RegExp): number | null {
  const line = text.split("\n")[0] ?? "";
  const match = line.match(regex);
  if (!match?.[1]) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

export function isDone(status: string): boolean {
  return status === "success" || status === "error";
}

export function toolLabelColor(status: string, colors: ColorsConfig): string {
  if (status === "error") return colors.failed;
  if (status === "success") return colors.badge.label;
  if (status === "approval") return colors.accent;
  return colors.running;
}

export function buildPatch(filePath: string, before: string, after: string): string {
  return createPatch(path.basename(filePath), before, after, "before", "after", { context: 3 });
}

export function countPatchChanges(diffText: string): { added: number; removed: number } {
  const lines = diffText.split("\n");
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

export function splitDiffPreamble(text: string): { leadingText?: string; diffText: string } | null {
  const lines = text.split("\n");
  const diffStart = lines.findIndex(
    (line) => line.startsWith("Index: ") || line.startsWith("--- ") || line.startsWith("@@ "),
  );
  if (diffStart < 0) return null;

  const leadingText = lines.slice(0, diffStart).join("\n").trim();
  const diffText = lines.slice(diffStart).join("\n").trim();
  if (!diffText) return null;
  return { leadingText: leadingText || undefined, diffText: sanitizeDiff(diffText) };
}

/**
 * Sanitize a unified diff by recalculating the line counts in `@@` hunk headers
 * so they match the actual content lines. Some tools produce diffs with incorrect
 * counts which causes the `diff` library's `parsePatch()` to throw.
 */
export function sanitizeDiff(diffText: string): string {
  const lines = diffText.split("\n");
  const result: string[] = [];
  let i = 0;

  // Copy file headers (--- / +++ / Index: / diff lines) before the first hunk
  while (i < lines.length && !lines[i].startsWith("@@ ")) {
    result.push(lines[i]);
    i++;
  }

  // Process hunks
  while (i < lines.length) {
    const headerMatch = lines[i].match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (!headerMatch) {
      // Not a hunk header — skip stray lines between hunks (e.g. error messages
      // injected by the tool) to avoid breaking the diff parser.
      i++;
      continue;
    }

    const oldStart = headerMatch[1];
    const newStart = headerMatch[2];
    const trailing = headerMatch[3] ?? "";
    i++;

    // Collect the body lines for this hunk
    const bodyLines: string[] = [];
    while (i < lines.length && !lines[i].startsWith("@@ ")) {
      const ch = lines[i].length === 0 ? " " : lines[i][0];
      if (ch === "+" || ch === "-" || ch === " " || ch === "\\") {
        bodyLines.push(lines[i]);
      } else if (
        lines[i].startsWith("--- ") ||
        lines[i].startsWith("+++ ") ||
        lines[i].startsWith("Index: ") ||
        lines[i].startsWith("diff ")
      ) {
        // Start of a new file diff — stop collecting for this hunk
        break;
      }
      // else: skip invalid/stray lines (e.g. error messages embedded in the diff)
      i++;
    }

    // Count actual old/new lines
    let oldLines = 0;
    let newLines = 0;
    for (const line of bodyLines) {
      const op = line[0];
      if (op === "+") newLines++;
      else if (op === "-") oldLines++;
      else if (op === " ") {
        oldLines++;
        newLines++;
      }
      // "\" (no newline at end of file) doesn't count
    }

    result.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${trailing}`);
    result.push(...bodyLines);
  }

  return result.join("\n");
}

export function changeBadge(added: number, removed: number, colors: ColorsConfig): JSX.Element | null {
  const hasAdded = added > 0;
  const hasRemoved = removed > 0;
  if (!hasAdded && !hasRemoved) return null;
  return [
    hasAdded ? <span style={{ fg: colors.diffAdded } as any}>{` +${added}`}</span> : null,
    hasRemoved ? <span style={{ fg: colors.diffRemoved } as any}>{` -${removed}`}</span> : null,
  ] as unknown as JSX.Element;
}

export function renderTextResultLines(
  lines: string[],
  colors: ColorsConfig,
  helpers: ToolRenderHelpers,
  opts?: { prefix?: string; firstPrefix?: string; indentColor?: string },
): JSX.Element {
  const prefix = opts?.prefix ?? "  ";
  const firstPrefix = opts?.firstPrefix ?? "└ ";
  const indentColor = opts?.indentColor ?? colors.textSubtle;

  return (
    <For each={lines}>
      {(line, i) => {
        const currentPrefix = i() === 0 ? firstPrefix : prefix;
        if (line === "") {
          return currentPrefix ? <text fg={indentColor}>{currentPrefix}</text> : <box height={1} />;
        }
        return (
          <text>
            <Show when={currentPrefix}>
              <span style={{ fg: indentColor } as any}>{currentPrefix}</span>
            </Show>
            {helpers.hasMarkup(line) ? (
              helpers.renderMarkup(line, colors.textSubtle)
            ) : (
              <span style={{ fg: colors.textSubtle } as any}>{line}</span>
            )}
          </text>
        );
      }}
    </For>
  );
}

export function renderToggleHint(
  colors: ColorsConfig,
  text: string,
  opts?: { prefix?: string; indentColor?: string },
): JSX.Element {
  const prefix = opts?.prefix ?? "  ";
  const indentColor = opts?.indentColor ?? colors.textSubtle;
  return (
    <text>
      <span style={{ fg: indentColor } as any}>{prefix}</span>
      <span style={{ fg: colors.textSubtle } as any}>{text}</span>
    </text>
  );
}

export function renderPlainResult(
  text: string,
  colors: ColorsConfig,
  helpers: ToolRenderHelpers,
  expanded: boolean,
  previewLines: number,
  truncatable: boolean,
  opts?: { prefix?: string; firstPrefix?: string; indentColor?: string },
): { element?: JSX.Element; canToggle: boolean; hiddenLineCount: number } {
  const rawLines = text.split("\n");
  const totalLines = rawLines.length;
  const limit = Math.max(0, previewLines);
  const canToggle = truncatable && totalLines > limit;
  const shownLines = canToggle && !expanded ? rawLines.slice(0, limit) : rawLines;
  const hiddenLineCount = canToggle && !expanded ? totalLines - shownLines.length : 0;
  if (shownLines.length === 0) return { canToggle, hiddenLineCount };

  return {
    canToggle,
    hiddenLineCount,
    element: (
      <box paddingLeft={2} flexDirection="column">
        {renderTextResultLines(shownLines, colors, helpers, opts)}
        <Show when={canToggle && !expanded}>
          {renderToggleHint(colors, `... (${hiddenLineCount} lines hidden)`, opts)}
        </Show>
      </box>
    ),
  };
}

export function renderDiffResult(
  diffText: string,
  colors: ColorsConfig,
  helpers: ToolRenderHelpers,
  leadingText?: string,
): JSX.Element {
  const dc = computeDiffColors(colors);
  return (
    <box width="100%" paddingLeft={2} flexDirection="column">
      <Show when={leadingText}>
        <box flexDirection="column">{renderTextResultLines((leadingText ?? "").split("\n"), colors, helpers)}</box>
      </Show>
      <box paddingLeft={2} flexDirection="column">
        <diff
          diff={diffText}
          view="unified"
          filetype="none"
          syntaxStyle={helpers.getSyntaxStyle()}
          showLineNumbers={true}
          width="100%"
          wrapMode="word"
          fg={colors.fg}
          addedBg={dc.addedBg}
          removedBg={dc.removedBg}
          contextBg={dc.contextBg}
          addedSignColor={dc.highlightAdded}
          removedSignColor={dc.highlightRemoved}
          lineNumberFg={dc.lineNumberFg}
          lineNumberBg={dc.contextBg}
          addedLineNumberBg={dc.addedLineNumberBg}
          removedLineNumberBg={dc.removedLineNumberBg}
        />
      </box>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Fenced code block parsing (ALTA wraps file content in ```` fences)
// ---------------------------------------------------------------------------

const FENCE_RE = /^````(\w*)\n([\s\S]*?)\n````$/;

/** Strip a 4-backtick fenced code block. Returns { language, content } or null. */
export function parseFencedCodeBlock(text: string): { language: string; content: string } | null {
  const m = text.match(FENCE_RE);
  if (!m) return null;
  return { language: m[1] ?? "", content: m[2] ?? "" };
}

/** Map ALTA language names to tree-sitter filetype names used by opentui <code>. */
const ALTA_LANG_TO_FILETYPE: Record<string, string> = {
  typescript: "typescript",
  tsx: "typescript",
  javascript: "typescript",
  jsx: "typescript",
  python: "python",
  rust: "rust",
  go: "go",
  ruby: "ruby",
  java: "java",
  c: "c",
  cpp: "cpp",
  csharp: "c_sharp",
  swift: "swift",
  kotlin: "kotlin",
  lua: "lua",
  bash: "bash",
  zsh: "bash",
  json: "json",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  css: "css",
  scss: "css",
  markdown: "markdown",
  sql: "sql",
  dockerfile: "dockerfile",
  dart: "dart",
  scala: "scala",
  elixir: "elixir",
  haskell: "haskell",
  ocaml: "ocaml",
  r: "r",
};

export function altaLangToFiletype(lang: string): string {
  return ALTA_LANG_TO_FILETYPE[lang] ?? "none";
}

/** Render a syntax-highlighted code block result for tool output. */
export function renderCodeResult(
  content: string,
  filetype: string,
  language: string,
  colors: ColorsConfig,
  helpers: ToolRenderHelpers,
  expanded: boolean,
  previewLines: number,
): { element?: import("solid-js").JSX.Element; canToggle: boolean; hiddenLineCount: number } {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const limit = Math.max(0, previewLines);
  const canToggle = totalLines > limit;
  const shownContent = canToggle && !expanded ? lines.slice(0, limit).join("\n") : content;
  const hiddenLineCount = canToggle && !expanded ? totalLines - limit : 0;
  if (hiddenLineCount === totalLines) return { canToggle, hiddenLineCount };

  return {
    canToggle,
    hiddenLineCount,
    element: (
      <box flexDirection="column">
        <text fg={colors.textSubtle}>{`  └${language ? ` ${language}` : ""}`}</text>
        <box paddingLeft={1}>
          <code
            content={shownContent}
            filetype={filetype}
            syntaxStyle={helpers.getSyntaxStyle()}
            width="100%"
            fg={colors.textSubtle}
          />
        </box>
        <Show when={canToggle && !expanded}>
          {renderToggleHint(colors, `... (${hiddenLineCount} lines hidden)`, { prefix: "  " })}
        </Show>
      </box>
    ),
  };
}

export function formatHeaderLabel(label: string): string {
  return label.trim().split(/\s+/).filter(Boolean).join("-").toLowerCase();
}

// Most headers use a plain string detail, but shell tools need per-token
// coloring for the command preview. Accept JSX here so specialized renderers can
// supply richer detail spans while existing string callers stay unchanged.
type HeaderDetail = string | JSX.Element;

export function renderHeader(
  ctx: ToolRenderContext,
  icon: string,
  label: string,
  detail?: HeaderDetail,
  extras: string[] = [],
  badges?: JSX.Element,
  inlineResult?: string,
): JSX.Element {
  const labelColor = toolLabelColor(ctx.block.status, ctx.colors);
  const displayLabel = formatHeaderLabel(label);
  const hasDetail = detail !== undefined && detail !== null && detail !== "";
  return (
    <text>
      <span style={{ fg: labelColor, bold: true } as any}>{`${icon} ${displayLabel}`}</span>
      <Show when={hasDetail}>
        <span style={{ fg: ctx.colors.textLabel } as any}> </span>
        {typeof detail === "string" ? <span style={{ fg: ctx.colors.textLabel } as any}>{detail}</span> : detail}
      </Show>
      <Show when={extras.length > 0}>
        <span style={{ fg: ctx.colors.textSubtle } as any}>{` (${extras.join(", ")})`}</span>
      </Show>
      {badges}
      <Show when={inlineResult}>
        <span style={{ fg: ctx.colors.textSubtle } as any}>{` ${inlineResult}`}</span>
      </Show>
      <Show when={!isDone(ctx.block.status) && !hasDetail && extras.length === 0 && !badges && !inlineResult}>
        <span style={{ fg: ctx.colors.textMuted } as any}> ...</span>
      </Show>
    </text>
  );
}

export function renderReadLikeHeader(
  ctx: ToolRenderContext,
  icon: string,
  label: string,
  filePath: string,
  extras: string[],
  badges?: JSX.Element,
): JSX.Element {
  return renderHeader(ctx, icon, label, formatPathForDisplay(filePath, ctx.cwd), extras, badges);
}

export function buildPlainOutput(
  ctx: ToolRenderContext,
  header: JSX.Element,
  text: string,
  truncatable: boolean,
  shouldHideResultInSuccinctMode: (toolName: string) => boolean,
  opts?: { prefix?: string; firstPrefix?: string; indentColor?: string; renderSingleLine?: boolean },
): ToolRendererOutput {
  if (getConfig().ui.succinct_tool_results && shouldHideResultInSuccinctMode(ctx.block.toolName)) {
    return {
      header,
      result: undefined,
      canToggle: false,
      hiddenLineCount: 0,
    };
  }

  // Empty or single-line results: no body rendered unless the caller explicitly
  // needs a one-line body (for example, a single elicitation answer).
  if (!text.trim() || (isSingleLineResult(text) && !opts?.renderSingleLine)) {
    return {
      header,
      result: undefined,
      canToggle: false,
      hiddenLineCount: 0,
    };
  }

  const rendered = renderPlainResult(
    stripTerminalControls(text),
    ctx.colors,
    ctx.helpers,
    ctx.expanded,
    ctx.previewLines,
    truncatable,
    {
      prefix: "  ",
      firstPrefix: "└ ",
      indentColor: ctx.colors.textSubtle,
      ...opts,
    },
  );
  return {
    header,
    result: rendered.element,
    canToggle: rendered.canToggle,
    hiddenLineCount: rendered.hiddenLineCount,
  };
}
