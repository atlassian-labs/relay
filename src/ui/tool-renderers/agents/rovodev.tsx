import { For, Show } from "solid-js";
import { getConfig } from "../../../config";
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
  parseFencedCodeBlock,
  previewInlineArg,
  readBoolean,
  readLineRanges,
  readScalarText,
  readString,
  readStringArray,
  renderCodeResult,
  renderDiffResult,
  renderHeader,
  renderPlainResult,
  renderReadLikeHeader,
  renderTextResultLines,
  renderToggleHint,
  sanitizeDiff,
  splitDiffPreamble,
} from "../core";
import { diffChangeCounts, renderDiffBody, renderShellTool, toolDiffItems } from "./common";
import { defaultProfile } from "./default";

const ROVODEV_NON_TRUNCATABLE_TOOL_NAMES = new Set(["find_and_replace_code"]);
const ROVODEV_SUCCINCT_HIDDEN_RESULT_TOOL_NAMES = new Set([
  "open_file",
  "open_files",
  "expand_code_chunks",
  "expand_folder",
  "grep",
  "rovo_search",
  "get_session_metadata",
  "get_memory",
  "list_memories",
]);

function icon(toolName: string): string {
  const icons: Record<string, string> = {
    ...defaultProfile.icons,
    open_file: "→",
    open_files: "→",
    expand_code_chunks: "→",
    expand_folder: "→",
    create_file: "+",
    delete_file: "×",
    move_file: "⇄",
    find_and_replace_code: "~",
    grep: "*",
    bash: "$",
    powershell: "$",
    create_technical_plan: "◆",
    exit_plan_mode: "✓",
    ask_user_questions: "?",
    rovo_search: "*",
    get_session_metadata: "ⓘ",
    get_memory: "◷",
    list_memories: "≡",
    update_todo: "☑",
    watch_jira_issue_update: "◉",
    configure_live_preview: "◈",
  };
  return icons[toolName] ?? "≡";
}

function headerOnly(header: import("solid-js").JSX.Element): ToolRendererOutput {
  return { header, result: undefined, canToggle: false, hiddenLineCount: 0 };
}

function plural(n: number, singular: string, pluralForm?: string): string {
  return `${n} ${n === 1 ? singular : (pluralForm ?? singular + "s")}`;
}

function toolInput(ctx: ToolRenderContext): Record<string, unknown> | null {
  const rawInput = asRecord(ctx.block.rawInput);
  return asRecord(rawInput?.tool_call_part) ?? rawInput;
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

function headerWithOptionalBody(
  ctx: ToolRenderContext,
  header: import("solid-js").JSX.Element,
  resultText: string,
  truncatable = true,
): ToolRendererOutput {
  if (!resultText.trim()) return headerOnly(header);
  return buildPlainOutput(ctx, header, resultText, truncatable, shouldHideResultInSuccinctMode);
}

function headerWithCodeBody(
  ctx: ToolRenderContext,
  header: import("solid-js").JSX.Element,
  resultText: string,
): ToolRendererOutput {
  if (!resultText.trim()) return headerOnly(header);
  if (getConfig().ui.succinct_tool_results && shouldHideResultInSuccinctMode(ctx.block.toolName))
    return headerOnly(header);

  const parsed = parseFencedCodeBlock(resultText.trimEnd());
  if (!parsed) return headerWithOptionalBody(ctx, header, resultText);

  const rendered = renderCodeResult(
    parsed.content,
    altaLangToFiletype(parsed.language),
    parsed.language,
    ctx.colors,
    ctx.helpers,
    ctx.expanded,
    ctx.previewLines,
  );
  return { header, result: rendered.element, canToggle: rendered.canToggle, hiddenLineCount: rendered.hiddenLineCount };
}

function countGrepMatches(text: string): number | null {
  if (!text) return null;
  if (/^No matches found/i.test(text)) return 0;
  const found = text.match(/Found\s+(\d+)\s+match/i);
  if (found?.[1]) return parseInt(found[1], 10);
  const lines = text.split("\n").filter((line) => line.trim());
  return lines.length > 0 ? lines.length : 0;
}

function rovodevOpenFilePaths(ctx: ToolRenderContext, input: Record<string, unknown> | null): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const filePath of readStringArray(input, "file_paths")) {
    const displayPath = formatPathForDisplay(filePath, ctx.cwd).trim();
    if (!displayPath || seen.has(displayPath)) continue;
    seen.add(displayPath);
    paths.push(displayPath);
  }
  return paths;
}

function rovodevOpenResultText(ctx: ToolRenderContext): string {
  // The completed Rovo update repeats the formatted input path list as the
  // first content item, then adds one result item per file. rawOutput contains
  // only those results, so prefer it to avoid rendering/counting transport text.
  const rawOutputText = textFromRovodevOutput(ctx.block.rawOutput);
  return rawOutputText || (ctx.block.details ?? "");
}

function openFilesRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = toolInput(ctx);
  const filePaths = rovodevOpenFilePaths(ctx, input);
  if (filePaths.length === 0) return null;
  const resultText = rovodevOpenResultText(ctx);
  const extras = [plural(filePaths.length, "file")];
  const detail = previewInlineArg(filePaths.join(", "));
  return headerWithOptionalBody(ctx, renderHeader(ctx, icon(ctx.block.toolName), "Open", detail, extras), resultText);
}

function viewRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = toolInput(ctx);
  const filePath = readString(input, "file_path", "path");
  if (!filePath) return null;
  const patterns = readStringArray(input, "patterns");
  const lineRanges = readLineRanges(input, "line_ranges", "ranges");
  const resultText = (ctx.block.details ?? "").replace(/^Successfully\s[^\n]*\n/, "").trimEnd();
  const extras: string[] = [];
  if (patterns.length > 0) extras.push(`${patterns.length} patterns`);
  if (lineRanges) extras.push(`ranges ${lineRanges}`);
  return headerWithCodeBody(
    ctx,
    renderReadLikeHeader(ctx, icon(ctx.block.toolName), "View", filePath, extras),
    resultText,
  );
}

function createRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = toolInput(ctx);
  const filePath = readString(input, "file_path", "path");
  if (!filePath) return null;
  const content = readString(input, "initial_content", "content") ?? "";
  const extras = readBoolean(input, "overwrite") ? ["overwrite"] : [];
  return headerOnly(
    renderReadLikeHeader(
      ctx,
      icon(ctx.block.toolName),
      "Create",
      filePath,
      extras,
      changeBadge(countLines(content), 0, ctx.colors) ?? undefined,
    ),
  );
}

function editRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = toolInput(ctx);
  const diffs = toolDiffItems(ctx);
  const filePath = readString(input, "file_path", "path", "target_file") ?? diffs[0]?.path;
  if (!filePath) return null;
  const before = readString(input, "find", "old_string") ?? "";
  const after = readString(input, "replace", "new_string") ?? "";
  const resultText = ctx.block.details ?? "";
  const parsed = splitDiffPreamble(resultText);
  const parsedPatch = parsed?.diffText ?? (resultText.includes("@@") ? sanitizeDiff(resultText) : "");
  const parsedCounts = parsedPatch ? countPatchChanges(parsedPatch) : { added: 0, removed: 0 };
  const inputPatch = before || after ? buildPatch(filePath, before, after) : "";
  const patch = parsedCounts.added > 0 || parsedCounts.removed > 0 ? parsedPatch : inputPatch;
  const counts = patch ? countPatchChanges(patch) : diffs.length > 0 ? diffChangeCounts(diffs) : parsedCounts;
  const extras = readBoolean(input, "replace_all") ? ["replace all"] : [];
  return {
    header: renderReadLikeHeader(
      ctx,
      icon(ctx.block.toolName),
      "Edit",
      filePath,
      extras,
      changeBadge(counts.added, counts.removed, ctx.colors) ?? undefined,
    ),
    result: patch
      ? renderDiffResult(patch, ctx.colors, ctx.helpers, parsed?.leadingText)
      : diffs.length > 0
        ? renderDiffBody(ctx, diffs, parsed?.leadingText)
        : resultText
          ? renderPlainResult(resultText, ctx.colors, ctx.helpers, ctx.expanded, ctx.previewLines, false).element
          : undefined,
    canToggle: false,
    hiddenLineCount: 0,
  };
}

function deleteRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = toolInput(ctx);
  const filePath = readString(input, "file_path", "path");
  if (!filePath) return null;
  return headerOnly(
    renderReadLikeHeader(
      ctx,
      icon(ctx.block.toolName),
      "Delete",
      filePath,
      isDone(ctx.block.status) ? ["deleted"] : [],
    ),
  );
}

function moveRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = toolInput(ctx);
  const from = readString(input, "file_path", "path", "source");
  const to = readString(input, "new_path", "target", "destination");
  if (!from || !to) return null;
  return headerOnly(
    renderHeader(
      ctx,
      icon(ctx.block.toolName),
      "Move",
      `${formatPathForDisplay(from, ctx.cwd)} → ${formatPathForDisplay(to, ctx.cwd)}`,
      isDone(ctx.block.status) ? ["moved"] : [],
    ),
  );
}

function folderRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = toolInput(ctx);
  const folderPath = readString(input, "folder_path", "path") ?? ".";
  const resultText = ctx.block.details ?? "";
  return headerWithOptionalBody(
    ctx,
    renderReadLikeHeader(
      ctx,
      icon(ctx.block.toolName),
      "View",
      folderPath,
      resultText ? [plural(countLines(resultText), "item")] : [],
    ),
    resultText,
  );
}

function grepRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = toolInput(ctx);
  const pattern = readString(input, "content_pattern", "pattern");
  const include = readString(input, "path_glob", "include");
  const searchPath = readString(input, "path");
  if (!pattern && !include && !searchPath) return null;
  const detailParts: string[] = [];
  if (pattern) detailParts.push(JSON.stringify(previewInlineArg(pattern)));
  if (include) detailParts.push(include);
  if (searchPath) detailParts.push(formatPathForDisplay(searchPath, ctx.cwd));
  const resultText = ctx.block.details ?? "";
  const matchCount = countGrepMatches(resultText);
  return headerWithOptionalBody(
    ctx,
    renderHeader(
      ctx,
      icon(ctx.block.toolName),
      "Search",
      detailParts.join(" ") || undefined,
      matchCount !== null ? [plural(matchCount, "match", "matches")] : [],
    ),
    resultText,
  );
}

// Rovo sometimes reports bare command-title shell calls before rawInput arrives;
// pass the title as a fallback while still preferring command/cmd when present.
function shellRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  return renderShellTool(ctx, {
    icon: icon(ctx.block.toolName),
    commandFallback: ctx.block.rawInput === undefined ? ctx.block.toolName : undefined,
    shouldHideResultInSuccinctMode,
  });
}

function technicalPlanRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = toolInput(ctx);
  const plan = asRecord(input?.plan);
  const changes = Array.isArray(plan?.logicalChanges) ? plan.logicalChanges : [];
  let fileCount = 0;
  for (const change of changes) {
    const files = asRecord(change)?.filesToChange;
    if (Array.isArray(files)) fileCount += files.length;
  }
  const extras: string[] = [];
  if (changes.length > 0) extras.push(plural(changes.length, "change"));
  if (fileCount > 0) extras.push(plural(fileCount, "file"));
  return headerWithOptionalBody(
    ctx,
    renderHeader(ctx, icon(ctx.block.toolName), "Plan", undefined, extras),
    ctx.block.details ?? "",
  );
}

function exitPlanRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = toolInput(ctx);
  const plan = readString(input, "plan");
  if (!plan) return null;
  return headerWithOptionalBody(
    ctx,
    renderHeader(ctx, icon(ctx.block.toolName), "Plan", undefined, [plural(countLines(plan), "line")]),
    plan,
    false,
  );
}

function askRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = toolInput(ctx);
  const nested = asRecord(input?.questions_input);
  const questions = Array.isArray(input?.questions)
    ? input.questions
    : Array.isArray(nested?.questions)
      ? nested.questions
      : [];
  if (questions.length === 0) return null;
  const first = readString(asRecord(questions[0]), "question", "header", "title");
  const answers: Array<{ label: string; value: string }> = ctx.block.elicitationAnswers ?? [];
  if (!isDone(ctx.block.status) && answers.length === 0) return null;
  const header = renderHeader(ctx, icon(ctx.block.toolName), "Ask", first ? previewInlineArg(first) : undefined, [
    plural(questions.length, "question"),
  ]);
  if (answers.length === 0) return headerOnly(header);
  return buildPlainOutput(
    ctx,
    header,
    answers.map((answer) => `${answer.label}: ${answer.value}`).join("\n"),
    false,
    () => false,
    { renderSingleLine: true },
  );
}

function rovoSearchRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = toolInput(ctx);
  const query = readString(input, "query");
  if (!query) return null;
  const site = readString(input, "site_url");
  const limit = readScalarText(input, "limit");
  const resultText = ctx.block.details ?? "";
  const extras: string[] = [];
  const count = resultText.match(/['\"]?resultCount['\"]?\s*[:=]\s*(\d+)/)?.[1];
  if (count) extras.push(plural(Number.parseInt(count, 10), "result"));
  else if (limit) extras.push(`limit ${limit}`);
  return headerWithOptionalBody(
    ctx,
    renderHeader(
      ctx,
      icon(ctx.block.toolName),
      "Rovo Search",
      `${JSON.stringify(previewInlineArg(query))}${site ? ` ${site}` : ""}`,
      extras,
    ),
    resultText,
  );
}

function simpleRenderer(label: string): (ctx: ToolRenderContext) => ToolRendererOutput | null {
  return (ctx) => {
    const resultText = ctx.block.details ?? "";
    const extras = resultText ? [plural(countLines(resultText), "line")] : [];
    return headerWithOptionalBody(
      ctx,
      renderHeader(ctx, icon(ctx.block.toolName), label, undefined, extras),
      resultText,
    );
  };
}

function memoryRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = toolInput(ctx);
  const sessionId = readString(input, "session_id");
  const resultText = ctx.block.details ?? "";
  return headerWithOptionalBody(
    ctx,
    renderHeader(
      ctx,
      icon(ctx.block.toolName),
      "Memory",
      sessionId ? previewInlineArg(sessionId) : undefined,
      resultText ? [plural(countLines(resultText), "line")] : [],
    ),
    resultText,
  );
}

function listMemoriesRenderer(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = toolInput(ctx);
  const limit = readScalarText(input, "limit");
  const resultText = ctx.block.details ?? "";
  const extras: string[] = [];
  if (limit) extras.push(`limit ${limit}`);
  if (resultText) extras.push(plural(countLines(resultText), "line"));
  return headerWithOptionalBody(
    ctx,
    renderHeader(ctx, icon(ctx.block.toolName), "Memories", undefined, extras),
    resultText,
  );
}

type RovodevTodoStatus = "pending" | "in_progress" | "completed" | "cancelled" | "unknown";

type RovodevTodoItem = {
  readonly id?: string;
  readonly content: string;
  readonly activeForm?: string;
  readonly status: RovodevTodoStatus;
};

type ParsedTodoOutput = {
  readonly found: boolean;
  readonly valid: boolean;
  readonly todos: RovodevTodoItem[];
};

function todoStatus(value: unknown): RovodevTodoStatus {
  if (value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled") return value;
  return "unknown";
}

function todoItem(value: unknown): RovodevTodoItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = readScalarText(record, "id");
  const content = readString(record, "content", "task", "subject");
  const activeForm = readString(record, "active_form", "activeForm");
  const displayContent = content ?? activeForm ?? (id ? `Todo ${id}` : undefined);
  if (!displayContent) return null;
  return {
    ...(id ? { id } : {}),
    content: displayContent,
    ...(activeForm ? { activeForm } : {}),
    status: todoStatus(record.status),
  };
}

function todoItems(value: unknown): RovodevTodoItem[] {
  if (!Array.isArray(value)) return [];
  return value.map(todoItem).filter((item): item is RovodevTodoItem => item !== null);
}

function textFromRovodevOutput(value: unknown, seen = new Set<object>()): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value))
    return value
      .map((item) => textFromRovodevOutput(item, seen))
      .filter(Boolean)
      .join("\n");
  const record = asRecord(value);
  if (!record) return "";
  for (const key of ["text", "message", "result", "output", "content"] as const) {
    const text = textFromRovodevOutput(record[key], seen);
    if (text) return text;
  }
  return "";
}

function parseTodoOutput(value: unknown): ParsedTodoOutput {
  const text = textFromRovodevOutput(value);
  const match = text.match(/<todo>\s*([\s\S]*?)\s*<\/todo>/iu);
  if (!match) return { found: false, valid: false, todos: [] };
  const payload = match[1]?.trim() ?? "";
  if (!payload) return { found: true, valid: true, todos: [] };

  if (payload.startsWith("[")) {
    try {
      const decoded = JSON.parse(payload) as unknown;
      const todos = todoItems(decoded);
      return { found: true, valid: Array.isArray(decoded) && (decoded.length === 0 || todos.length > 0), todos };
    } catch {
      return { found: true, valid: false, todos: [] };
    }
  }

  const todos: RovodevTodoItem[] = [];
  for (const line of payload.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const item = todoItem(JSON.parse(line) as unknown);
      if (item) todos.push(item);
    } catch {
      // Keep valid JSONL rows from a partial result and ignore malformed rows.
    }
  }
  return { found: true, valid: todos.length > 0, todos };
}

function todoMarker(todo: RovodevTodoItem): string {
  switch (todo.status) {
    case "completed":
      return "●";
    case "in_progress":
      return "◉";
    case "pending":
      return "○";
    case "cancelled":
      return "×";
    case "unknown":
      return "•";
  }
}

function todoMarkerColor(todo: RovodevTodoItem, ctx: ToolRenderContext): string {
  switch (todo.status) {
    case "completed":
      return ctx.colors.success;
    case "in_progress":
      return ctx.colors.running;
    case "cancelled":
      return ctx.colors.failed;
    case "pending":
    case "unknown":
      return ctx.colors.textMuted;
  }
}

function renderTodoList(
  ctx: ToolRenderContext,
  todos: readonly RovodevTodoItem[],
): Pick<ToolRendererOutput, "result" | "canToggle" | "hiddenLineCount"> {
  if (todos.length === 0) return { result: undefined, canToggle: false, hiddenLineCount: 0 };
  const limit = Math.max(0, ctx.previewLines);
  const canToggle = todos.length > limit;
  const visibleTodos = canToggle && !ctx.expanded ? todos.slice(0, limit) : todos;
  const hiddenLineCount = canToggle && !ctx.expanded ? todos.length - visibleTodos.length : 0;
  if (visibleTodos.length === 0) return { result: undefined, canToggle, hiddenLineCount };

  return {
    canToggle,
    hiddenLineCount,
    result: (
      <box paddingLeft={2} flexDirection="column">
        <For each={visibleTodos}>
          {(todo, index) => (
            <text>
              <span style={{ fg: ctx.colors.textSubtle } as any}>{index() === 0 ? "└ " : "  "}</span>
              <span style={{ fg: todoMarkerColor(todo, ctx) } as any}>{todoMarker(todo)}</span>
              <span style={{ fg: todo.status === "completed" ? ctx.colors.textSubtle : ctx.colors.textMuted } as any}>
                {` ${todo.status === "in_progress" ? (todo.activeForm ?? todo.content) : todo.content}`}
              </span>
            </text>
          )}
        </For>
        <Show when={canToggle && !ctx.expanded}>
          {renderToggleHint(ctx.colors, `... (${hiddenLineCount} tasks hidden)`, { prefix: "  " })}
        </Show>
      </box>
    ),
  };
}

function todoRenderer(ctx: ToolRenderContext): ToolRendererOutput {
  const input = toolInput(ctx);
  const inputTodos = todoItems(input?.todos);
  const rawOutput = parseTodoOutput(ctx.block.rawOutput);
  const parsedOutput = rawOutput.found ? rawOutput : parseTodoOutput(ctx.block.details);
  const todos = parsedOutput.valid ? parsedOutput.todos : inputTodos;
  const status = String(ctx.block.status);
  const cancelled = status === "cancelled";
  const failed = status === "error";
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const extras: string[] = [];

  if (todos.length > 0) {
    const isPartialMerge = readBoolean(input, "merge") === true && !parsedOutput.valid;
    extras.push(isPartialMerge ? plural(todos.length, "update") : `${completed}/${todos.length} done`);
  } else if (parsedOutput.valid) {
    extras.push("0 tasks");
  }
  if (cancelled) extras.push("cancelled");
  else if (failed) extras.push("failed");

  // ToolStatus currently follows ACP's four-state enum. Tolerate a provider's
  // future cancelled extension without making a cancelled call look active.
  const headerCtx = cancelled ? { ...ctx, block: { ...ctx.block, status: "error" as const } } : ctx;
  const header = renderHeader(headerCtx, icon("update_todo"), "Todos", undefined, extras);
  if (todos.length > 0) return { header, ...renderTodoList(ctx, todos) };

  const failureText = failed || cancelled ? textFromRovodevOutput(ctx.block.rawOutput) : "";
  if (failureText && !parsedOutput.valid) {
    const rendered = renderPlainResult(failureText, ctx.colors, ctx.helpers, ctx.expanded, ctx.previewLines, true);
    return {
      header,
      result: rendered.element,
      canToggle: rendered.canToggle,
      hiddenLineCount: rendered.hiddenLineCount,
    };
  }
  return headerOnly(header);
}

function genericRenderer(ctx: ToolRenderContext): ToolRendererOutput {
  const input = toolInput(ctx);
  const detail = readString(input, "issueKey", "issue_key", "key", "id", "url", "query", "path", "file_path");
  const resultText = ctx.block.details ?? "";
  const argsText = multilineValue(input ?? ctx.block.rawInput).trim();
  const canExpand = Boolean(argsText || resultText);
  const extras: string[] = [];
  if (isDone(ctx.block.status) && resultText) {
    const lineSummary = plural(countLines(resultText), "line");
    extras.push(lineSummary);
  }
  const header = renderHeader(
    ctx,
    icon(ctx.block.toolName),
    ctx.helpers.formatToolName(ctx.block.toolName),
    detail ? previewInlineArg(detail) : undefined,
    extras,
  );

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
  return ROVODEV_SUCCINCT_HIDDEN_RESULT_TOOL_NAMES.has(toolName);
}

export function isNonTruncatableTool(toolName: string): boolean {
  return ROVODEV_NON_TRUNCATABLE_TOOL_NAMES.has(toolName);
}

export const rovodevProfile: ToolRenderProfile = {
  icons: Object.fromEntries(
    Object.keys({ ...defaultProfile.icons })
      .concat([
        "open_file",
        "open_files",
        "expand_code_chunks",
        "expand_folder",
        "create_file",
        "delete_file",
        "move_file",
        "find_and_replace_code",
        "grep",
        "bash",
        "powershell",
        "create_technical_plan",
        "exit_plan_mode",
        "ask_user_questions",
        "rovo_search",
        "get_session_metadata",
        "get_memory",
        "list_memories",
        "update_todo",
        "watch_jira_issue_update",
        "configure_live_preview",
      ])
      .map((name) => [name, icon(name)]),
  ),
  renderers: {
    ...defaultProfile.renderers,
    open_file: viewRenderer,
    open_files: openFilesRenderer,
    expand_code_chunks: viewRenderer,
    create_file: createRenderer,
    delete_file: deleteRenderer,
    move_file: moveRenderer,
    find_and_replace_code: editRenderer,
    grep: grepRenderer,
    expand_folder: folderRenderer,
    bash: shellRenderer,
    powershell: shellRenderer,
    create_technical_plan: technicalPlanRenderer,
    exit_plan_mode: exitPlanRenderer,
    ask_user_questions: askRenderer,
    rovo_search: rovoSearchRenderer,
    get_session_metadata: simpleRenderer("Session"),
    get_memory: memoryRenderer,
    list_memories: listMemoriesRenderer,
    update_todo: todoRenderer,
    watch_jira_issue_update: simpleRenderer("Watch"),
    configure_live_preview: simpleRenderer("Preview"),
  },
  isNonTruncatableTool,
  shouldHideResultInSuccinctMode,
};

export function renderRovodevToolBlock(ctx: ToolRenderContext): ToolRendererOutput {
  const rawInput = asRecord(ctx.block.rawInput);
  const rawToolName = readString(rawInput, "tool_name");
  const toolName = rovodevProfile.renderers[ctx.block.toolName] ? ctx.block.toolName : rawToolName;
  const renderCtx = toolName && toolName !== ctx.block.toolName ? { ...ctx, block: { ...ctx.block, toolName } } : ctx;
  const renderer = toolName ? rovodevProfile.renderers[toolName] : undefined;
  if (renderer) {
    const result = renderer(renderCtx);
    if (result) return result;
  }
  return genericRenderer(renderCtx);
}
