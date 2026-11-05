import { For, type JSX } from "solid-js";
import { getConfig } from "../../../config";
import { formatDuration } from "../../util/format";
import { renderPlainResult } from "../core";
import type { ToolRenderContext, ToolRenderProfile, ToolRendererOutput } from "../types";
import {
  altaLangToFiletype,
  asRecord,
  buildPatch,
  buildPlainOutput,
  changeBadge,
  countLines,
  countPatchChanges,
  formatPathForDisplay,
  isDone,
  isSingleLineResult,
  parseFencedCodeBlock,
  parseLeadingCount,
  previewInlineArg,
  readBoolean,
  readLineRanges,
  readScalarText,
  readString,
  readStringArray,
  renderCodeResult,
  renderDiffResult,
  renderHeader,
  renderReadLikeHeader,
  renderTextResultLines,
  renderToggleHint,
  sanitizeDiff,
  splitDiffPreamble,
  truncateText,
} from "../core";
import { diffChangeCounts, renderDiffBody, renderShellTool, toolDiffItems } from "./common";
import { defaultProfile } from "./default";

const ALTA_NON_TRUNCATABLE_TOOL_NAMES = new Set(["edit", "find_and_replace_code"]);
const ALTA_SUCCINCT_HIDDEN_RESULT_TOOL_NAMES = new Set([
  "read",
  "read_file",
  "open_file",
  "open_files",
  "view_file",
  "expand_code_chunks",
  "view_folder",
  "expand_folder",
  "view_workspace",
  "grep",
  "find",
]);

function icon(toolName: string): string {
  const icons: Record<string, string> = {
    ...defaultProfile.icons,
    read: "→",
    edit: "~",
    write: "+",
    web_fetch: "↗",
    open_file: "→",
    open_files: "→",
    view_file: "→",
    expand_code_chunks: "→",
    create_file: "+",
    find_and_replace_code: "~",
    move_file: "⇄",
    delete_file: "×",
    python: "λ",
    powershell: "$",
    view_folder: "→",
    expand_folder: "→",
    view_workspace: "→",
    grep: "*",
    find: "*",
    bash: "$",
    create_technical_plan: "◆",
    ask_user_questions: "?",
    invoke_agent: "↪",
    "atlassian-get-tool-schema": "→",
  };
  return icons[toolName] ?? "≡";
}

// ---------------------------------------------------------------------------
// Helpers for extracting result summaries
// ---------------------------------------------------------------------------

/** Header-only output — no result body, just the header with summary in extras. */
function headerOnly(header: import("solid-js").JSX.Element): ToolRendererOutput {
  return { header, result: undefined, canToggle: false, hiddenLineCount: 0 };
}

function headerWithOptionalBody(
  ctx: ToolRenderContext,
  header: import("solid-js").JSX.Element,
  resultText: string,
  truncatable: boolean = true,
): ToolRendererOutput {
  if (!resultText.trim()) return headerOnly(header);
  return buildPlainOutput(ctx, header, resultText, truncatable, shouldHideResultInSuccinctMode);
}

/** Count grep matches from result text. */
function countGrepMatches(text: string): number | null {
  if (!text) return null;
  if (/^No matches found/i.test(text)) return 0;
  const found = text.match(/Found\s+(\d+)\s+match/i);
  if (found?.[1]) return parseInt(found[1], 10);
  // Count non-empty lines as match results
  const lines = text.split("\n").filter((l) => l.trim());
  return lines.length > 0 ? lines.length : 0;
}

/** Pluralise a count label: "1 match" vs "3 matches". */
function plural(n: number, singular: string, pluralForm?: string): string {
  return `${n} ${n === 1 ? singular : (pluralForm ?? singular + "s")}`;
}

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

function renderExpandedGenericBody(
  ctx: ToolRenderContext,
  renderedArgs: string,
  renderedResult: string,
): ToolRendererOutput["result"] {
  return (
    <box paddingLeft={2} flexDirection="column">
      <text fg={ctx.colors.textLabel}>Params</text>
      {renderTextResultLines(renderedArgs ? renderedArgs.split("\n") : ["(none)"], ctx.colors, ctx.helpers, {
        prefix: "  ",
        firstPrefix: "  ",
        indentColor: ctx.colors.textSubtle,
      })}
      <text fg={ctx.colors.textSubtle}>---</text>
      <text fg={ctx.colors.textLabel}>Result</text>
      {renderTextResultLines(renderedResult ? renderedResult.split("\n") : ["(empty)"], ctx.colors, ctx.helpers, {
        prefix: "  ",
        firstPrefix: "  ",
        indentColor: ctx.colors.textSubtle,
      })}
    </box>
  );
}

// ---------------------------------------------------------------------------
// Renderers — header-only for read-like tools, body for execute/edit tools
// ---------------------------------------------------------------------------

/** Build output with a syntax-highlighted code block if the result is a fenced block, otherwise plain text. */
function headerWithCodeBody(
  ctx: ToolRenderContext,
  header: import("solid-js").JSX.Element,
  resultText: string,
): ToolRendererOutput {
  if (!resultText.trim()) return headerOnly(header);

  // In succinct mode, hide the result body for read/search-style tools.
  if (getConfig().ui.succinct_tool_results && shouldHideResultInSuccinctMode(ctx.block.toolName)) {
    return headerOnly(header);
  }

  const parsed = parseFencedCodeBlock(resultText.trimEnd());
  if (parsed) {
    const filetype = altaLangToFiletype(parsed.language);
    const rendered = renderCodeResult(
      parsed.content,
      filetype,
      parsed.language,
      ctx.colors,
      ctx.helpers,
      ctx.expanded,
      ctx.previewLines,
    );
    return {
      header,
      result: rendered.element,
      canToggle: rendered.canToggle,
      hiddenLineCount: rendered.hiddenLineCount,
    };
  }

  // Fallback to plain text if not a fenced block
  return headerWithOptionalBody(ctx, header, resultText);
}

function viewFileRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  const filePath = readString(input, "file_path", "path");
  if (!filePath) return null;

  const patterns = readStringArray(input, "patterns");
  const lineRanges = readLineRanges(input, "line_ranges", "ranges");
  const rawResultText = ctx.block.details ?? "";
  const resultText = rawResultText.replace(/^Successfully\s[^\n]*\n/, "").trimEnd();
  const extras: string[] = [];
  if (patterns.length > 0) extras.push(`${patterns.length} patterns`);
  if (lineRanges) extras.push(`ranges ${lineRanges}`);

  return headerWithCodeBody(
    ctx,
    renderReadLikeHeader(ctx, icon(ctx.block.toolName), "View File", filePath, extras),
    resultText,
  );
}

function readRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  const filePath = readString(input, "path", "file_path");
  if (!filePath) return null;

  const offset = readScalarText(input, "offset");
  const limit = readScalarText(input, "limit");
  const resultText = ctx.block.details ?? "";
  const extras: string[] = [];
  if (offset) extras.push(`from ${offset}`);
  if (limit) extras.push(`limit ${limit}`);

  return headerWithOptionalBody(
    ctx,
    renderReadLikeHeader(ctx, icon(ctx.block.toolName), "Read", filePath, extras),
    resultText,
  );
}

function createFileRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  const filePath = readString(input, "file_path", "path");
  if (!filePath) return null;

  const content = readString(input, "initial_content", "content") ?? "";
  const overwrite = readBoolean(input, "overwrite");
  const lineCount = countLines(content);
  const extras: string[] = overwrite ? ["overwrite"] : [];
  const badges = changeBadge(lineCount, 0, ctx.colors) ?? undefined;

  return headerOnly(renderReadLikeHeader(ctx, icon(ctx.block.toolName), "Create File", filePath, extras, badges));
}

function editRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  const diffs = toolDiffItems(ctx);
  const filePath = readString(input, "path", "file_path", "target_file") ?? diffs[0]?.path;
  if (!filePath) return null;

  const replaceAll = readBoolean(input, "replace_all");
  const before = readString(input, "old_string", "find") ?? "";
  const after = readString(input, "new_string", "replace") ?? "";
  const resultText = ctx.block.details ?? "";
  const parsedResult = splitDiffPreamble(resultText);
  const parsedPatch = parsedResult?.diffText ?? (resultText.includes("@@") ? sanitizeDiff(resultText) : "");
  const parsedCounts = parsedPatch ? countPatchChanges(parsedPatch) : { added: 0, removed: 0 };
  const inputPatch = before || after ? buildPatch(filePath, before, after) : "";
  // Completed ACP updates may contain only diff headers in their result text.
  // Keep the input preview in that case, then fall back to structured ACP diff
  // content if the completion update no longer carries old/new input text.
  const patch = parsedCounts.added > 0 || parsedCounts.removed > 0 ? parsedPatch : inputPatch;
  const counts = patch ? countPatchChanges(patch) : diffs.length > 0 ? diffChangeCounts(diffs) : parsedCounts;
  const extras: string[] = replaceAll ? ["replace all"] : [];
  const badges = changeBadge(counts.added, counts.removed, ctx.colors) ?? undefined;

  return {
    header: renderReadLikeHeader(ctx, icon(ctx.block.toolName), "Edit", filePath, extras, badges),
    result: patch
      ? renderDiffResult(patch, ctx.colors, ctx.helpers, parsedResult?.leadingText)
      : diffs.length > 0
        ? renderDiffBody(ctx, diffs, parsedResult?.leadingText)
        : resultText
          ? renderPlainResult(resultText, ctx.colors, ctx.helpers, ctx.expanded, ctx.previewLines, false).element
          : undefined,
    canToggle: false,
    hiddenLineCount: 0,
  };
}

function writeRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  const filePath = readString(input, "path", "file_path");
  if (!filePath) return null;

  const content = readString(input, "content", "initial_content") ?? "";
  const resultText = ctx.block.details ?? "";
  const overwrote = /^Successfully overwrote/i.test(resultText);
  const lineCount = countLines(content);
  const extras: string[] = overwrote ? ["overwrite"] : [];
  const badges = changeBadge(lineCount, 0, ctx.colors) ?? undefined;

  return headerOnly(renderReadLikeHeader(ctx, icon(ctx.block.toolName), "Write", filePath, extras, badges));
}

function webFetchRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  const url = readString(input, "url");
  if (!url) return null;

  const resultText = ctx.block.details ?? "";
  const extras: string[] = resultText ? [plural(countLines(resultText), "line")] : [];

  return headerWithOptionalBody(
    ctx,
    renderHeader(ctx, icon(ctx.block.toolName), "Web Fetch", previewInlineArg(url), extras),
    resultText,
  );
}

function moveFileRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  const from = readString(input, "file_path", "path", "source");
  const to = readString(input, "new_path", "target", "destination");
  if (!from || !to) return null;

  const extras: string[] = isDone(ctx.block.status) ? ["moved"] : [];
  return headerOnly(
    renderHeader(
      ctx,
      icon(ctx.block.toolName),
      "Move File",
      `${formatPathForDisplay(from, ctx.cwd)} → ${formatPathForDisplay(to, ctx.cwd)}`,
      extras,
    ),
  );
}

function deleteFileRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  const filePath = readString(input, "file_path", "path");
  if (!filePath) return null;

  const extras: string[] = isDone(ctx.block.status) ? ["deleted"] : [];
  return headerOnly(renderReadLikeHeader(ctx, icon(ctx.block.toolName), "Delete File", filePath, extras));
}

function viewFolderRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  const folderPath = readString(input, "folder_path", "path") ?? ".";
  const resultText = ctx.block.details ?? "";
  const extras: string[] = resultText ? [plural(countLines(resultText), "item")] : [];

  return headerWithOptionalBody(
    ctx,
    renderReadLikeHeader(ctx, icon(ctx.block.toolName), "View Folder", folderPath, extras),
    resultText,
  );
}

function grepRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  const pattern = readString(input, "pattern", "content_pattern");
  const include = readString(input, "include", "path_glob");
  const searchPath = readString(input, "path");
  if (!pattern && !include && !searchPath) return null;

  const resultText = ctx.block.details ?? "";

  // Build detail string: "pattern" path_glob path
  const detailParts: string[] = [];
  if (pattern) detailParts.push(JSON.stringify(previewInlineArg(pattern)));
  if (include) detailParts.push(include);
  if (searchPath) detailParts.push(formatPathForDisplay(searchPath, ctx.cwd));
  const detail = detailParts.join(" ") || undefined;

  // Result summary in extras
  const matchCount = countGrepMatches(resultText);
  const extras: string[] = matchCount !== null ? [plural(matchCount, "match", "matches")] : [];

  return headerWithOptionalBody(ctx, renderHeader(ctx, icon(ctx.block.toolName), "Grep", detail, extras), resultText);
}

// Alta exposes bash/powershell through filesystem-tools; delegate both to the
// shared shell renderer so command/cmd args get highlighted consistently.
function bashRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  return renderShellTool(ctx, {
    icon: icon(ctx.block.toolName),
    shouldHideResultInSuccinctMode,
  });
}

function pythonRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  const code = readString(input, "code");
  if (!code) return null;

  const resultText = ctx.block.details ?? "";
  const extras: string[] = [`${countLines(code)} lines code`];
  if (resultText && !isSingleLineResult(resultText)) extras.push(plural(countLines(resultText), "line") + " output");

  const inlineResult = isSingleLineResult(resultText) ? truncateText(resultText.trim()) : undefined;
  return buildPlainOutput(
    ctx,
    renderHeader(ctx, icon(ctx.block.toolName), "Python", previewInlineArg(code), extras, undefined, inlineResult),
    resultText,
    true,
    shouldHideResultInSuccinctMode,
  );
}

function openFileRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  const filePath = readString(input, "file_path", "path");
  if (!filePath) return null;

  const rawResultText = ctx.block.details ?? "";
  const resultText = rawResultText.replace(/^Successfully\s[^\n]*\n/, "").trimEnd();

  return headerWithCodeBody(
    ctx,
    renderReadLikeHeader(ctx, icon(ctx.block.toolName), "Open File", filePath, []),
    resultText,
  );
}

function openFilesRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  const filePaths = readStringArray(input, "file_paths");
  if (filePaths.length === 0) return null;

  const resultText = ctx.block.details ?? "";
  const extras = [plural(filePaths.length, "file")];

  return headerWithOptionalBody(
    ctx,
    renderHeader(ctx, icon(ctx.block.toolName), "Open Files", formatPathForDisplay(filePaths[0], ctx.cwd), extras),
    resultText,
  );
}

function viewWorkspaceRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const resultText = ctx.block.details ?? "";
  const extras: string[] = resultText ? [plural(countLines(resultText), "item")] : [];

  return headerWithOptionalBody(
    ctx,
    renderHeader(ctx, icon(ctx.block.toolName), "View Workspace", undefined, extras),
    resultText,
  );
}

function skillRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  const name = readString(input, "name");
  if (!name) return null;
  const header = renderHeader(ctx, icon(ctx.block.toolName), "Skill", undefined, [name]);
  return buildPlainOutput(ctx, header, ctx.block.details ?? "", true, shouldHideResultInSuccinctMode);
}

function askUserQuestionsRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  if (!input) return null;

  const questions = input.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const displayLines: string[] = [];
  for (const q of questions) {
    const rec = asRecord(q);
    if (!rec) continue;
    const questionText = readString(rec, "question", "body");
    const fallbackTitle = readString(rec, "header", "title");
    const displayText = questionText ?? fallbackTitle;
    if (displayText) displayLines.push(displayText);
  }

  const firstQuestion = displayLines[0];
  const answers: Array<{ label: string; value: string }> = ctx.block.elicitationAnswers ?? [];
  const hasAnswers = answers.length > 0;

  // Hide the tool block while elicitation is in progress — the elicitation block shows the UI.
  if (!isDone(ctx.block.status) && !hasAnswers) return null;

  const header = renderHeader(
    ctx,
    icon(ctx.block.toolName),
    "Ask User",
    firstQuestion ? previewInlineArg(firstQuestion) : undefined,
  );

  if (!hasAnswers) {
    return buildPlainOutput(ctx, header, "", false, () => false);
  }

  const answerLines = answers.map((a) => `${a.label}: ${a.value}`);
  return buildPlainOutput(ctx, header, answerLines.join("\n"), false, () => false, { renderSingleLine: true });
}

type SubagentProgressItem = NonNullable<ToolRenderContext["block"]["subagent"]>["progress"][number];

function subagentToolStatus(
  item: SubagentProgressItem,
  colors: ToolRenderContext["colors"],
): {
  symbol: string;
  color: string;
} {
  switch (item.status) {
    case "success":
      return { symbol: "✓", color: colors.textSubtle };
    case "error":
      return { symbol: "×", color: colors.error };
    case "approval":
      return { symbol: "?", color: colors.notice };
    case "pending":
    case "running":
    case undefined:
    default:
      return { symbol: "⋯", color: colors.running };
  }
}

function subagentToolActivity(name: string, formatToolName: (value: string) => string): string {
  const normalized = name.toLowerCase().replace(/-/g, "_");
  if (["read", "read_file", "open_file", "open_files", "view_file", "expand_code_chunks"].includes(normalized)) {
    return "read files";
  }
  if (["grep", "find", "view_folder", "expand_folder", "view_workspace", "search"].includes(normalized)) {
    return "search repository";
  }
  if (["bash", "powershell", "python", "execute"].includes(normalized)) return "run command";
  if (["edit", "find_and_replace_code"].includes(normalized)) return "edit files";
  if (["write", "create_file"].includes(normalized)) return "write files";
  if (normalized === "web_fetch" || normalized === "fetch") return "fetch web content";
  const formatted = formatToolName(normalized);
  return formatted ? `${formatted[0].toLowerCase()}${formatted.slice(1)}` : "tool";
}

function renderSubagentToolProgress(ctx: ToolRenderContext, item: SubagentProgressItem, prefix: string): JSX.Element {
  const status = () => subagentToolStatus(item, ctx.colors);
  return (
    <text>
      <span style={{ fg: ctx.colors.textSubtle } as never}>{prefix}</span>
      <span style={{ fg: status().color } as never}>{`${status().symbol} `}</span>
      <span style={{ fg: ctx.colors.textLabel } as never}>
        {subagentToolActivity(item.text, ctx.helpers.formatToolName)}
      </span>
    </text>
  );
}

function renderSubagentCompletion(ctx: ToolRenderContext): JSX.Element | undefined {
  const state = ctx.block.subagent;
  if (!state || state.status === "running") return undefined;
  const toolCallCount = state.blocks?.filter((block) => block.type === "tool").length ?? 0;
  const duration =
    state.startedAt !== undefined && state.finishedAt !== undefined
      ? formatDuration((state.finishedAt - state.startedAt) / 1000)
      : undefined;
  const details = [
    `${toolCallCount} tool ${toolCallCount === 1 ? "call" : "calls"}`,
    ...(duration ? [duration] : []),
  ].join(" · ");
  const label = state.status === "success" ? "Done" : state.status === "error" ? "Failed" : "Cancelled";
  return (
    <text>
      <span style={{ fg: ctx.colors.textSubtle } as never}>└ </span>
      <span style={{ fg: ctx.colors.textLabel } as never}>{label}</span>
      <span style={{ fg: ctx.colors.textMuted } as never}>{` (${details})`}</span>
    </text>
  );
}

function renderSubagentProgress(ctx: ToolRenderContext): JSX.Element | undefined {
  const completion = renderSubagentCompletion(ctx);
  if (completion) return <box paddingLeft={2}>{completion}</box>;
  const tools = (ctx.block.subagent?.progress ?? []).filter((item) => item.kind === "tool");
  if (tools.length === 0) return undefined;
  return (
    <box paddingLeft={2} flexDirection="column">
      <For each={tools}>{(item, index) => renderSubagentToolProgress(ctx, item, index() === 0 ? "└ " : "  ")}</For>
    </box>
  );
}

function invokeAgentRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  const agentName = readString(input, "agent", "name") ?? ctx.block.subagent?.agentName ?? "agent";
  const mode = readBoolean(input, "background") === true ? "background" : "foreground";
  const prompt = readString(input, "message", "prompt");
  const extras = [mode];
  if (prompt) extras.push(`"${previewInlineArg(prompt, 72)}"`);
  if (ctx.block.subagent?.status === "cancelled") extras.push("cancelled");

  return {
    header: renderHeader(ctx, icon(ctx.block.toolName), "Subagent", agentName, extras),
    result: renderSubagentProgress(ctx),
    canToggle: false,
    hiddenLineCount: 0,
  };
}

function createTechnicalPlanRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  if (!input) return null;

  const plan = input.plan;
  const changes =
    plan && typeof plan === "object" && !Array.isArray(plan) && Array.isArray((plan as any).logicalChanges)
      ? ((plan as any).logicalChanges as unknown[])
      : [];

  const resultText = ctx.block.details ?? "";
  const extras: string[] = [];
  if (changes.length > 0) extras.push(plural(changes.length, "change"));

  return buildPlainOutput(
    ctx,
    renderHeader(ctx, icon(ctx.block.toolName), "Technical Plan", undefined, extras),
    resultText,
    true,
    shouldHideResultInSuccinctMode,
  );
}

function parseFindResultSummary(text: string): { fileCount: number | null; limitReached: boolean; noMatches: boolean } {
  if (!text.trim()) return { fileCount: null, limitReached: false, noMatches: false };
  if (/^No files found/i.test(text)) return { fileCount: 0, limitReached: false, noMatches: true };
  if (/^fd is not installed/i.test(text)) return { fileCount: null, limitReached: false, noMatches: false };

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const resultLines = lines.filter((line) => !line.startsWith("["));
  const limitReached = lines.some((line) => /results limit reached/i.test(line));

  return { fileCount: resultLines.length, limitReached, noMatches: false };
}

function renderFindResultBody(
  ctx: ToolRenderContext,
  resultText: string,
  noMatches: boolean,
): Omit<ToolRendererOutput, "header"> {
  if (!resultText.trim() || noMatches) {
    return { result: undefined, canToggle: false, hiddenLineCount: 0 };
  }

  // In succinct mode, keep search tools header-only by default, but let the
  // detailed/expanded tool view reveal the file list.
  if (getConfig().ui.succinct_tool_results && !ctx.expanded) {
    return { result: undefined, canToggle: false, hiddenLineCount: 0 };
  }

  const rendered = renderPlainResult(resultText, ctx.colors, ctx.helpers, ctx.expanded, ctx.previewLines, true, {
    prefix: "  ",
    firstPrefix: "└ ",
    indentColor: ctx.colors.textSubtle,
  });
  return {
    result: rendered.element,
    canToggle: rendered.canToggle,
    hiddenLineCount: rendered.hiddenLineCount,
  };
}

// This renderer mainly supports the custom find tool in the pi-like custom
// agent for now. Ideally this should be driven by a custom extension/plugin
// system, but that is a larger body of work.
function findRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  const pattern = readString(input, "pattern", "glob");
  const searchPath = readString(input, "path", "folder_path");
  if (!pattern && !searchPath) return null;

  const resultText = ctx.block.details ?? "";
  const detailParts: string[] = [];
  if (pattern) detailParts.push(JSON.stringify(previewInlineArg(pattern)));
  if (searchPath) detailParts.push(formatPathForDisplay(searchPath, ctx.cwd));
  const detail = detailParts.join(" ") || undefined;

  const { fileCount, limitReached, noMatches } = parseFindResultSummary(resultText);
  const extras: string[] = [];
  if (fileCount !== null) extras.push(plural(fileCount, "file"));
  if (limitReached) extras.push("limit reached");

  const header = renderHeader(ctx, icon(ctx.block.toolName), "Find", detail, extras);
  return {
    header,
    ...renderFindResultBody(ctx, resultText, noMatches),
  };
}

/**
 * Alta-specific generic renderer — used as fallback when a specific renderer
 * returns null (e.g. rawInput not yet available) or when the tool name has
 * no dedicated renderer. Uses Alta's icon map instead of the default "→".
 */
function altaGenericRenderer(ctx: ToolRenderContext): ToolRendererOutput {
  const resultText = ctx.block.details ?? "";
  const argsText = multilineValue(ctx.block.rawInput).trim();
  const label = ctx.helpers.formatToolName(ctx.block.toolName);
  const canExpand = Boolean(argsText || resultText);
  const extras: string[] = [];
  if (isDone(ctx.block.status) && resultText) {
    const lineSummary = plural(countLines(resultText), "line");
    extras.push(lineSummary);
  }
  const header = renderHeader(ctx, icon(ctx.block.toolName), label, undefined, extras);

  if (ctx.expanded) {
    return {
      header,
      result: renderExpandedGenericBody(ctx, argsText, resultText),
      canToggle: canExpand,
      hiddenLineCount: 0,
    };
  }

  return {
    header,
    result: undefined,
    canToggle: canExpand,
    hiddenLineCount: 0,
  };
}

export function shouldHideResultInSuccinctMode(toolName: string): boolean {
  return ALTA_SUCCINCT_HIDDEN_RESULT_TOOL_NAMES.has(toolName);
}

export function isNonTruncatableTool(toolName: string): boolean {
  return ALTA_NON_TRUNCATABLE_TOOL_NAMES.has(toolName);
}

export const altaProfile: ToolRenderProfile = {
  icons: Object.fromEntries(
    Object.keys({ ...defaultProfile.icons })
      .concat([
        "read",
        "edit",
        "write",
        "web_fetch",
        "open_file",
        "open_files",
        "view_file",
        "expand_code_chunks",
        "create_file",
        "find_and_replace_code",
        "move_file",
        "delete_file",
        "python",
        "powershell",
        "view_folder",
        "expand_folder",
        "view_workspace",
        "grep",
        "find",
        "bash",
        "create_technical_plan",
        "ask_user_questions",
        "invoke_agent",
        "atlassian-get-tool-schema",
      ])
      .map((name) => [name, icon(name)]),
  ),
  renderers: {
    ...defaultProfile.renderers,
    read: readRenderer,
    read_file: readRenderer,
    open_file: openFileRenderer,
    open_files: openFilesRenderer,
    view_file: viewFileRenderer,
    expand_code_chunks: viewFileRenderer,
    create_file: createFileRenderer,
    delete_file: deleteFileRenderer,
    move_file: moveFileRenderer,
    find_and_replace_code: editRenderer,
    edit: editRenderer,
    write: writeRenderer,
    web_fetch: webFetchRenderer,
    grep: grepRenderer,
    find: findRenderer,
    view_folder: viewFolderRenderer,
    expand_folder: viewFolderRenderer,
    view_workspace: viewWorkspaceRenderer,
    bash: bashRenderer,
    python: pythonRenderer,
    powershell: bashRenderer,
    skill: skillRenderer,
    ask_user_questions: askUserQuestionsRenderer,
    invoke_agent: invokeAgentRenderer,
    create_technical_plan: createTechnicalPlanRenderer,
  },
  isNonTruncatableTool,
  shouldHideResultInSuccinctMode,
};

export function renderAltaToolBlock(ctx: ToolRenderContext): ToolRendererOutput {
  const renderer = altaProfile.renderers[ctx.block.toolName];
  if (renderer) {
    const result = renderer(ctx);
    if (result) return result;
  }
  // Fall back to Alta-specific generic renderer (uses Alta's icon map, not "→")
  return altaGenericRenderer(ctx);
}
