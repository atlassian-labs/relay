import {
  asRecord,
  countLines,
  formatPathForDisplay,
  previewInlineArg,
  readBoolean,
  readScalarText,
  readString,
  readStringArray,
  renderHeader,
} from "../core";
import type { ToolRenderContext, ToolRenderProfile, ToolRendererOutput } from "../types";
import {
  commandText,
  compactObjectSummary,
  countGrepMatches,
  formatPathDetail,
  inlineValue,
  plural,
  recordValue,
  renderDiffTool,
  renderExpandableGeneric,
  renderPlainWithInline,
  safeJson,
  textFromToolContent,
  toolDiffItems,
} from "./common";
import { defaultProfile } from "./default";

const CLAUDE_METADATA_KEYS = new Set(["id", "taskId", "tool_use_id", "type"]);

const CLAUDE_HIDDEN_RESULT_PATTERNS = [
  /^read\b/i,
  /^find\b/i,
  /^glob\b/i,
  /^grep\b/i,
  /^fetch\b/i,
  /^web search\b/i,
  /^update todos\b/i,
];

function title(ctx: ToolRenderContext): string {
  return ctx.block.toolName.trim().replace(/\s+/g, " ");
}

function icon(toolName: string, kind?: string): string {
  const normalized = toolName.trim().toLowerCase();
  if (kind === "execute" || normalized === "bash" || normalized.startsWith("run")) return "$";
  if (normalized.startsWith("edit") || normalized.startsWith("write"))
    return normalized.startsWith("write") ? "+" : "~";
  if (normalized.startsWith("read")) return "→";
  if (normalized.startsWith("find") || normalized.startsWith("grep") || normalized.startsWith("glob")) return "*";
  if (normalized.startsWith("fetch") || normalized.includes("search")) return "↗";
  if (normalized.includes("todo") || normalized.includes("task") || normalized.includes("plan")) return "□";
  return defaultProfile.icons[toolName] ?? "→";
}

function stripPrefix(value: string, prefix: RegExp): string | undefined {
  const match = value.match(prefix);
  return match?.[1]?.trim() || undefined;
}

function outputText(ctx: ToolRenderContext): string {
  const contentText = textFromToolContent(ctx);
  if (contentText) return contentText;
  return ctx.block.details ?? "";
}

function inputRecord(ctx: ToolRenderContext): Record<string, unknown> | null {
  return asRecord(ctx.block.rawInput);
}

function isComplete(ctx: ToolRenderContext): boolean {
  return ctx.block.status === "success" || ctx.block.status === "error";
}

function commandFromInput(input: Record<string, unknown> | null): string | undefined {
  return commandText(recordValue(input, "command", "cmd"));
}

function renderBash(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = inputRecord(ctx);
  const command = commandFromInput(input);
  const isBash = ctx.block.toolKind === "execute" || /^bash$/i.test(ctx.block.toolName) || Boolean(command);
  if (!isBash) return null;

  const resultText = outputText(ctx);
  const extras: string[] = [];
  const description = readString(input, "description");
  const timeout = readScalarText(input, "timeout");
  if (timeout) extras.push(`${timeout}s`);
  if (resultText && resultText.includes("\n")) extras.push(plural(countLines(resultText), "line"));

  return renderPlainWithInline(ctx, {
    icon: "$",
    label: "Bash",
    detail: command ? previewInlineArg(command) : description ? previewInlineArg(description) : undefined,
    extras,
    text: resultText,
    shouldHideResultInSuccinctMode,
  });
}

function titlePath(ctx: ToolRenderContext, prefix: RegExp, ...keys: string[]): string | undefined {
  const input = inputRecord(ctx);
  const fromInput = formatPathDetail(readString(input, ...keys), ctx.cwd);
  if (fromInput) return fromInput;
  const fromTitle = stripPrefix(title(ctx), prefix);
  return fromTitle ? formatPathForDisplay(fromTitle, ctx.cwd) : undefined;
}

function renderRead(ctx: ToolRenderContext): ToolRendererOutput | null {
  const detail = titlePath(ctx, /^Read\s+(.+)$/i, "file_path");
  if (!detail) return null;
  const input = inputRecord(ctx);
  const resultText = outputText(ctx);
  const extras: string[] = [];
  const offset = readScalarText(input, "offset");
  const limit = readScalarText(input, "limit");
  if (offset && limit) extras.push(`${offset}-${Number(offset) + Number(limit) - 1}`);
  else if (offset) extras.push(`from ${offset}`);

  return renderPlainWithInline(ctx, {
    icon: "→",
    label: "Read",
    detail,
    extras,
    text: resultText,
    shouldHideResultInSuccinctMode,
  });
}

function renderEditOrWrite(ctx: ToolRenderContext): ToolRendererOutput | null {
  const diffs = toolDiffItems(ctx);
  const input = inputRecord(ctx);
  const titleText = title(ctx);
  const edits = recordValue(input, "edits");
  const isWrite = /^Write\b/i.test(titleText) || readString(input, "content") !== undefined;
  const isEdit =
    /^(?:Edit|MultiEdit)\b/i.test(titleText) ||
    readString(input, "old_string", "new_string") !== undefined ||
    Array.isArray(edits);
  if (!isWrite && !isEdit) return null;

  const detail = titlePath(ctx, /^(?:Write|Edit)\s+(.+)$/i, "file_path", "path");
  if (diffs.length > 0) {
    return renderDiffTool(ctx, {
      icon: isWrite ? "+" : "~",
      label: isWrite ? "Write" : "Edit",
      detail,
      leadingText: textFromToolContent(ctx),
    });
  }

  const extras: string[] = [];
  const oldString = readString(input, "old_string");
  const newString = readString(input, "new_string", "content");
  if (newString) extras.push(plural(countLines(newString), "line"));
  const resultText = outputText(ctx);
  const inlineDetail = detail ?? (oldString ? `${JSON.stringify(previewInlineArg(oldString, 40))} →` : undefined);
  return renderPlainWithInline(ctx, {
    icon: isWrite ? "+" : "~",
    label: isWrite ? "Write" : "Edit",
    detail: inlineDetail,
    extras,
    text: resultText,
    shouldHideResultInSuccinctMode,
  });
}

function globDetail(input: Record<string, unknown> | null): string | undefined {
  const pattern = readString(input, "pattern");
  const searchPath = readString(input, "path");
  return (
    [searchPath ? formatPathForDisplay(searchPath, "") : undefined, pattern ? JSON.stringify(pattern) : undefined]
      .filter(Boolean)
      .join(" ") || undefined
  );
}

function grepDetail(input: Record<string, unknown> | null): string | undefined {
  const parts: string[] = [];
  if (readBoolean(input, "-i")) parts.push("-i");
  if (readBoolean(input, "-n")) parts.push("-n");
  for (const flag of ["-A", "-B", "-C"] as const) {
    const value = readScalarText(input, flag);
    if (value) parts.push(flag, value);
  }
  const outputMode = readString(input, "output_mode");
  if (outputMode === "files_with_matches") parts.push("-l");
  if (outputMode === "count") parts.push("-c");
  const headLimit = readScalarText(input, "head_limit");
  const glob = readString(input, "glob");
  const type = readString(input, "type");
  const pattern = readString(input, "pattern");
  const searchPath = readString(input, "path");
  if (glob) parts.push(`--include=${JSON.stringify(glob)}`);
  if (type) parts.push(`--type=${type}`);
  if (readBoolean(input, "multiline")) parts.push("-P");
  if (pattern) parts.push(JSON.stringify(pattern));
  if (searchPath) parts.push(formatPathForDisplay(searchPath, ""));
  const command = parts.join(" ");
  return headLimit ? `${command} | head -${headLimit}` : command;
}

function renderSearch(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = inputRecord(ctx);
  const titleText = title(ctx);
  const isGlob = /^Find\b/i.test(titleText) || readString(input, "pattern") !== undefined;
  const isGrep = /^grep\b/i.test(titleText) || readString(input, "output_mode", "glob", "head_limit") !== undefined;
  if (!isGlob && !isGrep) return null;

  const resultText = outputText(ctx);
  const matchCount = countGrepMatches(resultText);
  const extras = matchCount === null ? [] : [plural(matchCount, "match", "matches")];
  return renderPlainWithInline(ctx, {
    icon: "*",
    label: isGrep ? "Grep" : "Find",
    detail: isGrep ? grepDetail(input) : (globDetail(input) ?? stripPrefix(titleText, /^Find\s+(.+)$/i)),
    extras,
    text: resultText,
    shouldHideResultInSuccinctMode,
  });
}

function renderWeb(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = inputRecord(ctx);
  const titleText = title(ctx);
  const url = readString(input, "url") ?? stripPrefix(titleText, /^Fetch\s+(.+)$/i);
  const query = readString(input, "query");
  const isFetch = /^Fetch\b/i.test(titleText) || Boolean(url);
  const isSearch = Boolean(query || readStringArray(input, "allowed_domains", "blocked_domains").length > 0);
  if (!isFetch && !isSearch) return null;

  const extras: string[] = [];
  const allowed = readStringArray(input, "allowed_domains");
  const blocked = readStringArray(input, "blocked_domains");
  if (allowed.length > 0) extras.push(`${allowed.length} allowed`);
  if (blocked.length > 0) extras.push(`${blocked.length} blocked`);

  return renderPlainWithInline(ctx, {
    icon: "↗",
    label: isFetch ? "Web Fetch" : "Web Search",
    detail: url ?? (query ? JSON.stringify(query) : stripPrefix(titleText, /^"(.+)"$/i)),
    extras,
    text: outputText(ctx),
    shouldHideResultInSuccinctMode,
  });
}

function todoLine(todo: unknown): string | undefined {
  const record = asRecord(todo);
  if (!record) return undefined;
  const content = readString(record, "content", "subject");
  if (!content) return undefined;
  const status = readString(record, "status") ?? "pending";
  const marker = status === "completed" ? "✓" : status === "in_progress" ? "◐" : "□";
  return `${marker} ${content}`;
}

function renderTodos(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = inputRecord(ctx);
  const todosValue = recordValue(input, "todos");
  const todos = Array.isArray(todosValue) ? todosValue : [];
  if (!/^Update TODOs/i.test(title(ctx)) && todos.length === 0) return null;

  const lines = todos.map(todoLine).filter((line): line is string => Boolean(line));
  const completed = todos.filter((todo) => readString(asRecord(todo), "status") === "completed").length;
  const extras = todos.length > 0 ? [`${completed}/${todos.length} done`] : [];
  const text = lines.join("\n") || outputText(ctx);
  return renderPlainWithInline(ctx, {
    icon: "□",
    label: "Todos",
    extras,
    text,
    shouldHideResultInSuccinctMode,
  });
}

function renderTask(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = inputRecord(ctx);
  const titleText = title(ctx);
  const subject =
    readString(input, "subject", "description") ?? stripPrefix(titleText, /^(?:Create|Update) task:\s*(.+)$/i);
  const prompt = readString(input, "prompt", "description", "plan");
  const isTask =
    /^Task$/i.test(titleText) ||
    /^Create task/i.test(titleText) ||
    /^Update task/i.test(titleText) ||
    /^List tasks$/i.test(titleText) ||
    /^Get task$/i.test(titleText) ||
    /^Ready to code\?$/i.test(titleText);
  if (!isTask) return null;

  const label = /^Ready to code\?$/i.test(titleText) ? "Plan" : "Task";
  const status = readString(input, "status");
  const extras = status ? [status] : [];
  return renderPlainWithInline(ctx, {
    icon: label === "Plan" ? "◆" : "□",
    label,
    detail: subject ? previewInlineArg(subject) : undefined,
    extras,
    text: outputText(ctx) || prompt || "",
    shouldHideResultInSuccinctMode,
  });
}

function renderFindings(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = inputRecord(ctx);
  const findingsValue = recordValue(input, "findings");
  const findings = Array.isArray(findingsValue) ? findingsValue : [];
  if (!/^Report /i.test(title(ctx)) && findings.length === 0) return null;
  const lines = findings
    .map((finding) => {
      const record = asRecord(finding);
      if (!record) return undefined;
      const file = readString(record, "file", "path") ?? "finding";
      const line = readScalarText(record, "line");
      const summary = readString(record, "summary", "message") ?? "";
      return `${file}${line ? `:${line}` : ""}${summary ? ` — ${summary}` : ""}`;
    })
    .filter((line): line is string => Boolean(line));

  return renderPlainWithInline(ctx, {
    icon: "◆",
    label: "Findings",
    extras: [plural(findings.length, "finding")],
    text: lines.join("\n") || outputText(ctx),
    shouldHideResultInSuccinctMode,
  });
}

function renderQuestion(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = inputRecord(ctx);
  const questionsValue = recordValue(input, "questions");
  const questions = Array.isArray(questionsValue)
    ? questionsValue
        .map((question) => {
          const record = asRecord(question);
          if (!record) return null;
          const questionText = readString(record, "question", "body");
          const header = readString(record, "header", "title");
          return questionText || header ? { question: questionText ?? header ?? "Question", header } : null;
        })
        .filter((question): question is { question: string; header: string | undefined } => question !== null)
    : [];
  const rawAnswers = asRecord(recordValue(input, "answers"));
  const answersFromInput = rawAnswers
    ? Object.entries(rawAnswers).map(([label, value]) => ({ label, value: String(value) }))
    : [];
  const answers = ctx.block.elicitationAnswers?.length ? ctx.block.elicitationAnswers : answersFromInput;
  if (!/^Asking for your input$/i.test(title(ctx)) && questions.length === 0 && answers.length === 0) return null;

  const firstQuestion = questions[0]?.question ?? answers[0]?.label;
  const detail = firstQuestion ? previewInlineArg(firstQuestion) : undefined;
  const extras =
    answers.length > 0
      ? [plural(answers.length, "answer")]
      : questions.length > 0
        ? [plural(questions.length, "question")]
        : [];
  const header = renderHeader(ctx, "?", "Ask User", detail, extras);

  if (answers.length === 0) {
    if (!isComplete(ctx)) return null;
    return { header, result: undefined, canToggle: false, hiddenLineCount: 0 };
  }

  const answerText = answers
    .map((answer, index) => {
      const questionText = answer.label || questions[index]?.question || `Question ${index + 1}`;
      return `${index + 1}. ${questionText}\n   Answer: ${answer.value}`;
    })
    .join("\n");

  return {
    header,
    result: renderPlainWithInline(ctx, {
      icon: "?",
      label: "Ask User",
      detail,
      text: answerText,
      shouldHideResultInSuccinctMode,
    }).result,
    canToggle: false,
    hiddenLineCount: 0,
  };
}

function genericArgsText(ctx: ToolRenderContext): string {
  const input = inputRecord(ctx);
  if (!input) return inlineValue(ctx.block.rawInput);
  return Object.entries(input)
    .filter(([key]) => !CLAUDE_METADATA_KEYS.has(key))
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : safeJson(value)}`)
    .join("\n");
}

function renderClaudeGeneric(ctx: ToolRenderContext): ToolRendererOutput {
  const input = inputRecord(ctx);
  const detail =
    readString(input, "description", "subject") ??
    formatPathDetail(readString(input, "file_path", "path"), ctx.cwd) ??
    readString(input, "query", "pattern", "url");
  return renderExpandableGeneric(ctx, {
    icon: icon(ctx.block.toolName, ctx.block.toolKind),
    label: ctx.helpers.formatToolName(ctx.block.toolName),
    detail: detail ? previewInlineArg(detail) : undefined,
    extras: compactObjectSummary(ctx.block.rawInput, CLAUDE_METADATA_KEYS, 2),
    argsText: genericArgsText(ctx),
    resultText: outputText(ctx),
  });
}

export function shouldHideResultInSuccinctMode(toolName: string): boolean {
  return CLAUDE_HIDDEN_RESULT_PATTERNS.some((pattern) => pattern.test(toolName));
}

export function isNonTruncatableTool(toolName: string): boolean {
  return /^(Edit|Write)\b/i.test(toolName);
}

export const claudeProfile: ToolRenderProfile = {
  ...defaultProfile,
  icons: {
    ...defaultProfile.icons,
    AskUserQuestion: "?",
    Bash: "$",
    Edit: "~",
    ExitPlanMode: "◆",
    Glob: "*",
    Grep: "*",
    MultiEdit: "~",
    Read: "→",
    ReportFindings: "◆",
    Task: "□",
    TaskCreate: "□",
    TaskGet: "□",
    TaskList: "□",
    TaskUpdate: "□",
    TodoWrite: "□",
    WebFetch: "↗",
    WebSearch: "↗",
    Write: "+",
    bash: "$",
  },
  renderers: {},
  isNonTruncatableTool,
  shouldHideResultInSuccinctMode,
};

export function renderClaudeToolBlock(ctx: ToolRenderContext): ToolRendererOutput {
  return (
    renderEditOrWrite(ctx) ??
    renderBash(ctx) ??
    renderRead(ctx) ??
    renderSearch(ctx) ??
    renderWeb(ctx) ??
    renderTodos(ctx) ??
    renderTask(ctx) ??
    renderFindings(ctx) ??
    renderQuestion(ctx) ??
    renderClaudeGeneric(ctx)
  );
}
