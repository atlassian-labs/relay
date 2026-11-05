import { Show } from "solid-js";
import {
  formatPathForDisplay,
  isSingleLineResult,
  previewInlineArg,
  renderHeader,
  renderPlainResult,
  renderTextResultLines,
  renderToggleHint,
  truncateText,
} from "../core";
import type { ToolRenderContext, ToolRenderProfile, ToolRenderer, ToolRendererOutput } from "../types";
import { renderShellTool } from "./common";

const DEFAULT_NON_TRUNCATABLE_TOOL_NAMES = new Set(["edit"]);

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function inlineValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim().replace(/\r\n|\n|\r/g, "\\n");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => inlineValue(item)).join(", ")}]`;
  return safeJson(value);
}

function multilineValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => inlineValue(item)).join("\n");
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "";
    return entries
      .map(([key, entryValue]) => `${key}: ${typeof entryValue === "string" ? entryValue : safeJson(entryValue)}`)
      .join("\n");
  }
  return String(value);
}

function truncateHeaderPart(text: string, max = 32): string {
  const normalized = text.trim().replace(/\r\n|\n|\r/g, " ");
  return normalized.length > max ? normalized.slice(0, max) + "..." : normalized;
}

const METADATA_ARG_KEYS = new Set([
  "call_id",
  "callId",
  "id",
  "pid",
  "process_id",
  "processId",
  "server",
  "session_id",
  "sessionId",
  "terminal_id",
  "terminalId",
  "tool",
  "tool_call_id",
  "tool_call_part",
  "tool_name",
  "toolCallId",
  "toolName",
]);

const DETAIL_ARG_KEYS = new Set([
  "command",
  "cmd",
  "path",
  "file_path",
  "filePath",
  "url",
  "query",
  "pattern",
  "content_pattern",
  "contentPattern",
  "path_glob",
  "pathGlob",
]);

const EXTRA_ARG_KEYS = new Set(["cwd", "timeout", "line", "lineNumber", "line_number", "method"]);

interface HeaderArgsSummary {
  readonly detail?: string;
  readonly extras: string[];
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function firstLine(value: unknown, max = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value
    .split("\n")
    .find((candidate) => candidate.trim().length > 0)
    ?.trim();
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function headerPath(value: unknown, cwd: string): string | undefined {
  const text = scalarText(value);
  return text ? formatPathForDisplay(text, cwd) : undefined;
}

function recordValue(record: Record<string, unknown>, ...keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function parseDisplaySummary(display: string): string[] {
  const summary: string[] = [];
  const lines = display
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key || METADATA_ARG_KEYS.has(key)) continue;
    const value = line.slice(idx + 1).trim();
    summary.push(`${truncateHeaderPart(key)}:${truncateHeaderPart(value)}`);
    if (summary.length >= 2) break;
  }
  if (summary.length > 0 && lines.length > summary.length) summary.push("...");
  return summary;
}

function summarizeRecordArgs(record: Record<string, unknown>, cwd: string): HeaderArgsSummary {
  const usedKeys = new Set<string>();
  const markUsed = (...keys: readonly string[]) => keys.forEach((key) => usedKeys.add(key));

  const command = firstLine(recordValue(record, "command", "cmd"));
  if (command) markUsed("command", "cmd");

  const pathValue = headerPath(recordValue(record, "path", "file_path", "filePath"), cwd);
  if (pathValue) markUsed("path", "file_path", "filePath");

  const url = scalarText(recordValue(record, "url"));
  if (url) markUsed("url");

  const query = scalarText(recordValue(record, "query", "pattern"));
  if (query) markUsed("query", "pattern");

  const contentPattern = scalarText(recordValue(record, "content_pattern", "contentPattern"));
  if (contentPattern) markUsed("content_pattern", "contentPattern");
  const pathGlob = scalarText(recordValue(record, "path_glob", "pathGlob"));
  if (pathGlob) markUsed("path_glob", "pathGlob");

  const detail = command
    ? previewInlineArg(command)
    : (pathValue ??
      url ??
      (query ? JSON.stringify(query) : undefined) ??
      (contentPattern && pathGlob
        ? `${JSON.stringify(contentPattern)} in ${pathGlob}`
        : contentPattern
          ? JSON.stringify(contentPattern)
          : pathGlob));

  const extras: string[] = [];
  const cwdValue = headerPath(record.cwd, cwd);
  if (cwdValue && command) extras.push(`cwd:${truncateHeaderPart(cwdValue)}`);
  markUsed("cwd");

  const timeout = scalarText(record.timeout);
  if (timeout) extras.push(`${timeout}s`);
  markUsed("timeout");

  const line = scalarText(recordValue(record, "line", "lineNumber", "line_number"));
  if (line) extras.push(`line ${line}`);
  markUsed("line", "lineNumber", "line_number");

  const method = scalarText(record.method);
  if (method && method.toUpperCase() !== "GET") extras.push(method.toUpperCase());
  markUsed("method");

  for (const [key, value] of Object.entries(record)) {
    if (extras.length >= 2) break;
    if (usedKeys.has(key) || METADATA_ARG_KEYS.has(key) || DETAIL_ARG_KEYS.has(key) || EXTRA_ARG_KEYS.has(key)) {
      continue;
    }
    const text = scalarText(value);
    if (!text) continue;
    extras.push(`${truncateHeaderPart(key)}:${truncateHeaderPart(text)}`);
  }

  return { detail, extras };
}

function summarizeArgs(rawInput: unknown, display: string, cwd: string): HeaderArgsSummary {
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    return summarizeRecordArgs(rawInput as Record<string, unknown>, cwd);
  }
  return { extras: display ? parseDisplaySummary(display) : [] };
}

function argsText(ctx: ToolRenderContext): string {
  const display = ctx.block.display?.trim() ?? "";
  if (display) return display;
  return multilineValue(ctx.block.rawInput).trim();
}

function resultText(ctx: ToolRenderContext): string {
  const details = ctx.block.details?.trim() ?? "";
  if (details) return details;
  return multilineValue(ctx.block.rawOutput).trim();
}

export function expandedDefaultBodyText(ctx: ToolRenderContext): { params: string; result: string } {
  return { params: argsText(ctx), result: resultText(ctx) };
}

export function renderExpandedDefaultBody(
  ctx: ToolRenderContext,
  options: { collapseHint?: string | false; compact?: boolean } = {},
): ToolRendererOutput["result"] {
  const { params: renderedArgs, result: renderedResult } = expandedDefaultBodyText(ctx);
  const collapseHint =
    options.collapseHint === false ? null : (options.collapseHint ?? (ctx.selected ? "enter to collapse" : false));
  const renderBodyText = (value: string, fallback: string) => {
    const text = value || fallback;
    if (!options.compact) {
      return renderTextResultLines(text.split("\n"), ctx.colors, ctx.helpers, {
        prefix: "  ",
        firstPrefix: "  ",
        indentColor: ctx.colors.textSubtle,
      });
    }
    return (
      <text fg={ctx.colors.textSubtle}>
        {text
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n")}
      </text>
    );
  };
  return (
    <box paddingLeft={2} flexDirection="column">
      <text fg={ctx.colors.textLabel}>Params</text>
      {renderBodyText(renderedArgs, "(none)")}
      <text fg={ctx.colors.textSubtle}>---</text>
      <text fg={ctx.colors.textLabel}>Result</text>
      {renderBodyText(renderedResult, "(empty)")}
      <Show when={collapseHint}>{(hint) => renderToggleHint(ctx.colors, hint(), { prefix: "  " })}</Show>
    </box>
  );
}

function genericRenderer(ctx: ToolRenderContext): ToolRendererOutput {
  const renderedArgs = argsText(ctx);
  const renderedResult = resultText(ctx);
  const summary = summarizeArgs(ctx.block.rawInput, renderedArgs, ctx.cwd);
  const hideResult = false;
  const truncatable = !DEFAULT_NON_TRUNCATABLE_TOOL_NAMES.has(ctx.block.toolName);
  const header = renderHeader(
    ctx,
    ctx.helpers.getToolIcon(ctx.block.toolName),
    ctx.helpers.formatToolName(ctx.block.toolName),
    summary.detail,
    summary.extras,
  );

  if (ctx.expanded) {
    return {
      header,
      result: renderExpandedDefaultBody(ctx),
      canToggle: Boolean(renderedArgs || renderedResult),
      hiddenLineCount: 0,
    };
  }

  // Single-line results: show inline in header, no body
  if (!hideResult && renderedResult && isSingleLineResult(renderedResult)) {
    const inlineResult = truncateText(renderedResult.trim());
    return {
      header: renderHeader(
        ctx,
        ctx.helpers.getToolIcon(ctx.block.toolName),
        ctx.helpers.formatToolName(ctx.block.toolName),
        summary.detail,
        summary.extras,
        undefined,
        inlineResult,
      ),
      result: undefined,
      canToggle: Boolean(renderedArgs),
      hiddenLineCount: 0,
    };
  }

  const result =
    !hideResult && renderedResult
      ? renderPlainResult(renderedResult, ctx.colors, ctx.helpers, ctx.expanded, ctx.previewLines, truncatable, {
          prefix: "  ",
          firstPrefix: "└ ",
          indentColor: ctx.colors.textSubtle,
        })
      : { element: undefined, canToggle: false, hiddenLineCount: 0 };

  return {
    header,
    result: result.element ?? undefined,
    canToggle: result.canToggle || Boolean(renderedArgs),
    hiddenLineCount: result.hiddenLineCount,
  };
}

export function shouldHideResultInSuccinctMode(_toolName: string): boolean {
  return false;
}

export function isNonTruncatableTool(toolName: string): boolean {
  return DEFAULT_NON_TRUNCATABLE_TOOL_NAMES.has(toolName);
}

export const defaultProfile: ToolRenderProfile = {
  icons: {
    bash: "$",
    powershell: "$",
  },
  // Even the generic/default profile treats shell-like tools specially so
  // `bash`/`powershell` calls get command-aware headers instead of plain params.
  renderers: {
    read: genericRenderer as ToolRenderer,
    write: genericRenderer as ToolRenderer,
    edit: genericRenderer as ToolRenderer,
    grep: genericRenderer as ToolRenderer,
    find: genericRenderer as ToolRenderer,
    bash: renderShellTool as ToolRenderer,
    powershell: renderShellTool as ToolRenderer,
  },
  isNonTruncatableTool,
  shouldHideResultInSuccinctMode,
};

export function renderDefaultToolBlock(ctx: ToolRenderContext): ToolRendererOutput {
  const renderer = defaultProfile.renderers[ctx.block.toolName];
  if (renderer) {
    const result = renderer(ctx);
    if (result) return result;
  }
  return genericRenderer(ctx);
}
