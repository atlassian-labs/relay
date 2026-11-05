import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import { blendHexColors } from "../../../config/themes";
import type { ToolContentItem, ToolDiff } from "../../state";
import {
  buildPatch,
  buildPlainOutput,
  changeBadge,
  countLines,
  countPatchChanges,
  formatPathForDisplay,
  isSingleLineResult,
  previewInlineArg,
  renderDiffResult,
  renderHeader,
  renderPlainResult,
  renderTextResultLines,
  renderToggleHint,
  truncateText,
} from "../core";
import type { ToolRenderContext, ToolRendererOutput } from "../types";

export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function inlineValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim().replace(/\r\n|\n|\r/g, "\\n");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => inlineValue(item)).join(", ")}]`;
  return safeJson(value);
}

export function scalarText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function recordValue(record: Record<string, unknown> | null, ...keys: readonly string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

export function firstLine(value: unknown, max = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value
    .split("\n")
    .find((candidate) => candidate.trim().length > 0)
    ?.trim();
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function shellQuote(part: string): string {
  if (!part) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(part)) return part;
  return `'${part.replace(/'/g, `'\\''`)}'`;
}

export function commandText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return firstLine(value);
  if (Array.isArray(value)) {
    const parts = value.filter((item): item is string => typeof item === "string");
    return parts.length > 0 ? parts.map(shellQuote).join(" ") : undefined;
  }
  return undefined;
}

// Shared shell-tool rendering support. Across Alta-style agents the executable
// tool is usually named `bash` (with `powershell` as the Windows sibling), and
// the shell text is commonly supplied as `command` with `cmd` as a fallback.
const SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);

// Lightweight command tokenizer for header styling. We only need enough shell
// structure to distinguish command words, args, options, strings, variables, and
// operators; execution still belongs entirely to the agent/tool provider.
const SHELL_COMMAND_TOKEN_RE = /(\s+)|(\|\||&&|;;|[|;&()<>])|('[^']*')|("(?:\\.|[^"\\])*")|([^\s|;&()<>]+)/gu;
const COMMAND_EXPECTING_OPERATORS = new Set(["|", "||", "&&", ";", ";;", "("]);

export type ShellCommandTokenKind = "space" | "operator" | "string" | "variable" | "command" | "option" | "arg";

export interface ShellCommandToken {
  readonly text: string;
  readonly kind: ShellCommandTokenKind;
}

export function isShellToolName(toolName: string): boolean {
  return SHELL_TOOL_NAMES.has(toolName);
}

// Rovo-style payloads sometimes put real args under `tool_call_part` while
// Alta/default payloads put them directly on rawInput. Normalize both shapes
// before looking for `command`/`cmd` or optional metadata like `timeout`.
function shellInputRecord(input: unknown): Record<string, unknown> | null {
  const record =
    input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  const nested = recordValue(record, "tool_call_part");
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as Record<string, unknown>;
  return record;
}

function commandFromInput(input: unknown): string | undefined {
  return commandText(recordValue(shellInputRecord(input), "command", "cmd"));
}

export function shellCommandText(input: unknown, fallback?: string): string | undefined {
  return commandFromInput(input) ?? (fallback?.trim() ? fallback : undefined);
}

export function shellCommandTokens(command: string, max = 128): ShellCommandToken[] {
  // Headers are intentionally single-line previews. Tokenize after truncation so
  // the rendered spans match exactly what the user sees in the compact header.
  const displayCommand = previewInlineArg(command, max);
  let text = displayCommand;
  const tokens: ShellCommandToken[] = [];
  if (text.startsWith("$ ")) {
    tokens.push({ text: "$ ", kind: "space" });
    text = text.slice(2);
  }

  let expectCommand = true;
  for (const match of text.matchAll(SHELL_COMMAND_TOKEN_RE)) {
    const token = match[0];
    if (match[1] !== undefined) {
      tokens.push({ text: token, kind: "space" });
      continue;
    }
    if (match[2] !== undefined) {
      tokens.push({ text: token, kind: "operator" });
      expectCommand = COMMAND_EXPECTING_OPERATORS.has(token);
      continue;
    }
    if (match[3] !== undefined || match[4] !== undefined) {
      tokens.push({ text: token, kind: "string" });
      expectCommand = false;
      continue;
    }
    if (token.startsWith("$")) {
      tokens.push({ text: token, kind: "variable" });
      expectCommand = false;
      continue;
    }
    if (expectCommand) {
      tokens.push({ text: token, kind: "command" });
      expectCommand = false;
      continue;
    }
    if (token.startsWith("-")) {
      tokens.push({ text: token, kind: "option" });
      continue;
    }
    tokens.push({ text: token, kind: "arg" });
  }
  return tokens;
}

function shellTokenColor(ctx: ToolRenderContext, kind: ShellCommandTokenKind): string {
  if (kind === "space" || kind === "arg") return ctx.colors.textLabel;

  const color = (() => {
    switch (kind) {
      case "command":
        return ctx.colors.markdownCode;
      case "operator":
        return ctx.colors.notice;
      case "option":
        return ctx.colors.accent;
      case "string":
      case "variable":
        return ctx.colors.info;
    }
  })();
  return blendHexColors(ctx.colors.bg, color, 0.75);
}

// Render the command itself as rich header detail so it stands apart from
// generic key/value params and can use shell-aware token colors.
export function renderShellCommandDetail(ctx: ToolRenderContext, command: string): JSX.Element {
  return (
    <>
      {shellCommandTokens(command).map((token) => (
        <span style={{ fg: shellTokenColor(ctx, token.kind), bold: token.kind === "command" } as any}>
          {token.text}
        </span>
      ))}
    </>
  );
}

// Common renderer used by default/Alta/Rovo profiles for bash-like tools. It
// keeps normal result rendering, but replaces generic param text with the
// highlighted command preview plus compact metadata such as timeout/output lines.
export function renderShellTool(
  ctx: ToolRenderContext,
  opts?: {
    icon?: string;
    label?: string;
    commandFallback?: string;
    shouldHideResultInSuccinctMode?: (toolName: string) => boolean;
  },
): ToolRendererOutput | null {
  if (!isShellToolName(ctx.block.toolName)) return null;
  const command = shellCommandText(ctx.block.rawInput, opts?.commandFallback);
  if (!command) return null;

  const input = shellInputRecord(ctx.block.rawInput);
  const timeout = scalarText(recordValue(input, "timeout"));
  const resultText = ctx.block.details ?? "";
  const extras: string[] = [];
  if (timeout) extras.push(`${timeout}s`);
  if (resultText && !isSingleLineResult(resultText)) extras.push(plural(countLines(resultText), "line"));

  const inlineResult = isSingleLineResult(resultText) ? truncateText(resultText.trim()) : undefined;
  return buildPlainOutput(
    ctx,
    renderHeader(
      ctx,
      opts?.icon ?? ctx.helpers.getToolIcon(ctx.block.toolName),
      opts?.label ?? (ctx.block.toolName === "powershell" ? "PowerShell" : "Bash"),
      renderShellCommandDetail(ctx, command),
      extras,
      undefined,
      inlineResult,
    ),
    resultText,
    true,
    opts?.shouldHideResultInSuccinctMode ?? (() => false),
  );
}

export function formatPathDetail(filePath: string | undefined, cwd: string): string | undefined {
  return filePath ? formatPathForDisplay(filePath, cwd) : undefined;
}

export function compactPathList(paths: readonly string[], cwd: string, max = 2): { detail?: string; extras: string[] } {
  const visible = paths.slice(0, max).map((path) => formatPathForDisplay(path, cwd));
  const extras = paths.length > max ? [plural(paths.length, "file")] : [];
  return { detail: visible.join(", ") || undefined, extras };
}

export function countGrepMatches(text: string): number | null {
  if (!text.trim()) return null;
  if (/^No matches found/i.test(text)) return 0;
  const found = text.match(/Found\s+(\d+)\s+match/i);
  if (found?.[1]) return Number.parseInt(found[1], 10);
  const lines = text.split("\n").filter((line) => line.trim());
  return lines.length > 0 ? lines.length : 0;
}

export function toolDiffItems(ctx: ToolRenderContext): ToolDiff[] {
  const fromContent = ctx.block.content
    ?.filter((item): item is Extract<ToolContentItem, { type: "diff" }> => item.type === "diff")
    .map((item) => item.diff);
  if (fromContent && fromContent.length > 0) return fromContent;
  return ctx.block.diff ? [ctx.block.diff] : [];
}

export function textFromToolContent(ctx: ToolRenderContext): string {
  const items = ctx.block.content ?? [];
  const lines: string[] = [];
  for (const item of items) {
    switch (item.type) {
      case "text":
        lines.push(item.text);
        break;
      case "resource":
        lines.push(item.text ?? item.uri);
        break;
      case "resourceLink":
        lines.push(item.uri);
        break;
      case "image":
        lines.push(`Image (${item.mimeType})`);
        break;
      case "audio":
        lines.push(`Audio (${item.mimeType})`);
        break;
      case "terminal":
        lines.push(`Terminal: ${item.terminalId}`);
        break;
      case "diff":
        break;
    }
  }
  return lines.filter((line) => line.trim()).join("\n");
}

function patchFromDiff(diff: ToolDiff): string {
  return buildPatch(formatPathForDisplay(diff.path, ""), diff.oldText, diff.newText);
}

export function diffChangeCounts(diffs: readonly ToolDiff[]): { added: number; removed: number } {
  return diffs.reduce(
    (total, diff) => {
      const counts = countPatchChanges(patchFromDiff(diff));
      return { added: total.added + counts.added, removed: total.removed + counts.removed };
    },
    { added: 0, removed: 0 },
  );
}

export function renderDiffBody(ctx: ToolRenderContext, diffs: readonly ToolDiff[], leadingText?: string): JSX.Element {
  return (
    <box flexDirection="column">
      <Show when={leadingText?.trim()} keyed>
        {(text) => (
          <box paddingLeft={2} flexDirection="column">
            {renderTextResultLines(text.split("\n"), ctx.colors, ctx.helpers)}
          </box>
        )}
      </Show>
      <For each={diffs}>
        {(diff, index) => (
          <box flexDirection="column" marginTop={index() === 0 && !leadingText ? 0 : 1}>
            <text fg={ctx.colors.textLabel}>{formatPathForDisplay(diff.path, ctx.cwd)}</text>
            {renderDiffResult(patchFromDiff(diff), ctx.colors, ctx.helpers)}
          </box>
        )}
      </For>
    </box>
  );
}

export function renderDiffTool(
  ctx: ToolRenderContext,
  opts: {
    icon: string;
    label: string;
    detail?: string;
    extras?: string[];
    leadingText?: string;
  },
): ToolRendererOutput | null {
  const diffs = toolDiffItems(ctx);
  if (diffs.length === 0) return null;
  const counts = diffChangeCounts(diffs);
  const files = diffs.map((diff) => diff.path);
  const compact = compactPathList(files, ctx.cwd, 2);
  const extras = [...(opts.extras ?? [])];
  if (diffs.length > 1) extras.push(plural(diffs.length, "file"));
  const badges = changeBadge(counts.added, counts.removed, ctx.colors) ?? undefined;
  return {
    header: renderHeader(ctx, opts.icon, opts.label, opts.detail ?? compact.detail, extras, badges),
    result: renderDiffBody(ctx, diffs, opts.leadingText),
    canToggle: false,
    hiddenLineCount: 0,
  };
}

export function renderPlainWithInline(
  ctx: ToolRenderContext,
  opts: {
    icon: string;
    label: string;
    detail?: string;
    extras?: string[];
    text: string;
    truncatable?: boolean;
    shouldHideResultInSuccinctMode: (toolName: string) => boolean;
  },
): ToolRendererOutput {
  const inlineResult = isSingleLineResult(opts.text) ? truncateText(opts.text.trim()) : undefined;
  const header = renderHeader(ctx, opts.icon, opts.label, opts.detail, opts.extras ?? [], undefined, inlineResult);
  return buildPlainOutput(ctx, header, opts.text, opts.truncatable ?? true, opts.shouldHideResultInSuccinctMode);
}

export function renderExpandableGeneric(
  ctx: ToolRenderContext,
  opts: {
    icon: string;
    label: string;
    detail?: string;
    extras?: string[];
    argsText: string;
    resultText: string;
    truncatable?: boolean;
  },
): ToolRendererOutput {
  const header = renderHeader(ctx, opts.icon, opts.label, opts.detail, opts.extras ?? []);
  const hasBody = Boolean(opts.argsText.trim() || opts.resultText.trim());
  if (ctx.expanded) {
    return {
      header,
      result: (
        <box paddingLeft={2} flexDirection="column">
          <text fg={ctx.colors.textLabel}>Params</text>
          {renderTextResultLines(opts.argsText ? opts.argsText.split("\n") : ["(none)"], ctx.colors, ctx.helpers, {
            prefix: "  ",
            firstPrefix: "  ",
            indentColor: ctx.colors.textSubtle,
          })}
          <text fg={ctx.colors.textSubtle}>---</text>
          <text fg={ctx.colors.textLabel}>Result</text>
          {renderTextResultLines(opts.resultText ? opts.resultText.split("\n") : ["(empty)"], ctx.colors, ctx.helpers, {
            prefix: "  ",
            firstPrefix: "  ",
            indentColor: ctx.colors.textSubtle,
          })}
        </box>
      ),
      canToggle: hasBody,
      hiddenLineCount: 0,
    };
  }

  const result = opts.resultText.trim()
    ? renderPlainResult(
        opts.resultText,
        ctx.colors,
        ctx.helpers,
        ctx.expanded,
        ctx.previewLines,
        opts.truncatable ?? true,
        {
          prefix: "  ",
          firstPrefix: "└ ",
          indentColor: ctx.colors.textSubtle,
        },
      )
    : { element: undefined, canToggle: false, hiddenLineCount: 0 };

  return {
    header,
    result: result.element,
    canToggle: result.canToggle || Boolean(opts.argsText.trim()),
    hiddenLineCount: result.hiddenLineCount,
  };
}

export function compactObjectSummary(value: unknown, ignoredKeys: ReadonlySet<string> = new Set(), max = 2): string[] {
  const record =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!record) return [];
  const summary: string[] = [];
  for (const [key, entryValue] of Object.entries(record)) {
    if (summary.length >= max) break;
    if (ignoredKeys.has(key)) continue;
    const text = scalarText(entryValue);
    if (text) summary.push(`${key}:${previewInlineArg(text, 32)}`);
  }
  return summary;
}
