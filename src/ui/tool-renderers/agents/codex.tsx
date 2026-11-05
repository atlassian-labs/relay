import { asRecord, countLines, formatPathForDisplay, previewInlineArg, readScalarText, readString } from "../core";
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

const CODEX_METADATA_KEYS = new Set([
  "call_id",
  "completed_at_ms",
  "duration",
  "process_id",
  "request_id",
  "server",
  "started_at_ms",
  "status",
  "tool",
  "turn_id",
]);

const CODEX_HIDDEN_RESULT_PATTERNS = [
  /^read\b/i,
  /^list\b/i,
  /^search\b/i,
  /^grep\b/i,
  /^tool:/i,
  /^mcp\b/i,
  /^web search\b/i,
];

function icon(toolName: string, kind?: string): string {
  const normalized = toolName.trim().toLowerCase();
  if (kind === "execute" || normalized === "bash" || normalized.includes("shell")) return "$";
  if (normalized.startsWith("edit") || normalized === "apply_patch" || normalized.includes("patch")) return "~";
  if (normalized.startsWith("read") || normalized.startsWith("view image")) return "→";
  if (normalized.startsWith("list") || normalized.startsWith("search") || normalized.startsWith("tool:")) return "*";
  if (normalized.includes("web") || normalized.startsWith("opening:")) return "↗";
  if (normalized.includes("image")) return "◈";
  return defaultProfile.icons[toolName] ?? "→";
}

function firstUsefulTitleLine(toolName: string): string {
  return toolName.trim().replace(/\s+/g, " ");
}

function stripPrefix(value: string, prefix: RegExp): string | undefined {
  const match = value.match(prefix);
  return match?.[1]?.trim() || undefined;
}

function commandFromInput(input: Record<string, unknown> | null): string | undefined {
  return (
    commandText(recordValue(input, "command", "cmd")) ??
    commandText(recordValue(input, "argv")) ??
    commandText(recordValue(input, "interaction_input"))
  );
}

function outputText(ctx: ToolRenderContext): string {
  const contentText = textFromToolContent(ctx);
  if (contentText) return contentText;

  const output = asRecord(ctx.block.rawOutput);
  const preferred = readString(output, "formatted_output", "aggregated_output", "output", "result", "message", "text");
  if (preferred) return preferred;

  const stdout = readString(output, "stdout") ?? "";
  const stderr = readString(output, "stderr") ?? "";
  const combined = [stdout, stderr].filter((text) => text.trim()).join("\n");
  if (combined) return combined;

  return ctx.block.details ?? "";
}

function exitExtras(output: Record<string, unknown> | null): string[] {
  const extras: string[] = [];
  const exitCode = readScalarText(output, "exit_code", "return_code");
  if (exitCode && exitCode !== "0") extras.push(`exit ${exitCode}`);
  const status = readScalarText(output, "status");
  if (status && status !== "completed" && status !== "Completed") extras.push(status.toLowerCase());
  return extras;
}

function renderCommand(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  const command =
    commandFromInput(input) ?? (ctx.block.toolName === "bash" ? undefined : firstUsefulTitleLine(ctx.block.toolName));
  const looksExecutable =
    ctx.block.toolKind === "execute" || ctx.block.toolName === "bash" || Boolean(commandFromInput(input));
  if (!looksExecutable) return null;

  const resultText = outputText(ctx);
  const extras = exitExtras(asRecord(ctx.block.rawOutput));
  const cwd = readString(input, "cwd", "workdir", "working_directory");
  if (cwd && formatPathForDisplay(cwd, ctx.cwd) !== ".") extras.push(`cwd:${formatPathForDisplay(cwd, ctx.cwd)}`);
  if (resultText && resultText.includes("\n")) extras.push(plural(countLines(resultText), "line"));

  return renderPlainWithInline(ctx, {
    icon: "$",
    label: "Bash",
    detail: command ? previewInlineArg(command) : undefined,
    extras,
    text: resultText,
    shouldHideResultInSuccinctMode,
  });
}

function titlePath(ctx: ToolRenderContext, prefix: RegExp, ...inputKeys: string[]): string | undefined {
  const fromTitle = stripPrefix(firstUsefulTitleLine(ctx.block.toolName), prefix);
  if (fromTitle) return formatPathForDisplay(fromTitle, ctx.cwd);
  const input = asRecord(ctx.block.rawInput);
  return formatPathDetail(readString(input, ...inputKeys), ctx.cwd);
}

function renderRead(ctx: ToolRenderContext): ToolRendererOutput | null {
  const detail = titlePath(ctx, /^Read\s+(.+)$/i, "path", "file_path");
  if (!detail) return null;
  const input = asRecord(ctx.block.rawInput);
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

function renderList(ctx: ToolRenderContext): ToolRendererOutput | null {
  const detail = titlePath(ctx, /^List\s+(.+)$/i, "path", "cwd", "workdir");
  if (!detail) return null;
  const resultText = outputText(ctx);
  const itemCount = resultText ? countLines(resultText) : 0;
  const extras = itemCount > 0 ? [plural(itemCount, "item")] : [];
  return renderPlainWithInline(ctx, {
    icon: "→",
    label: "List",
    detail,
    extras,
    text: resultText,
    shouldHideResultInSuccinctMode,
  });
}

function renderSearch(ctx: ToolRenderContext): ToolRendererOutput | null {
  const title = firstUsefulTitleLine(ctx.block.toolName);
  const input = asRecord(ctx.block.rawInput);
  const query = readString(input, "query", "pattern", "content_pattern", "contentPattern");
  const searchPath = readString(input, "path", "path_glob", "pathGlob");
  const titleDetail = stripPrefix(title, /^Search\s+(.+)$/i) ?? stripPrefix(title, /^Searching for:\s+(.+)$/i);
  if (!query && !searchPath && !titleDetail && !/^Searching the Web$/i.test(title)) return null;

  const detail = titleDetail ?? [query ? JSON.stringify(query) : undefined, searchPath].filter(Boolean).join(" ");
  const resultText = outputText(ctx);
  const matchCount = countGrepMatches(resultText);
  const extras = matchCount === null ? [] : [plural(matchCount, "match", "matches")];
  return renderPlainWithInline(ctx, {
    icon: title.toLowerCase().includes("web") ? "↗" : "*",
    label: title.toLowerCase().includes("web") || title.toLowerCase().startsWith("searching") ? "Web Search" : "Search",
    detail,
    extras,
    text: resultText,
    shouldHideResultInSuccinctMode,
  });
}

function renderWebOrImage(ctx: ToolRenderContext): ToolRendererOutput | null {
  const title = firstUsefulTitleLine(ctx.block.toolName);
  const input = asRecord(ctx.block.rawInput);
  const output = asRecord(ctx.block.rawOutput);

  if (/^Opening:/i.test(title)) {
    return renderPlainWithInline(ctx, {
      icon: "↗",
      label: "Open Page",
      detail: stripPrefix(title, /^Opening:\s*(.+)$/i),
      text: outputText(ctx),
      shouldHideResultInSuccinctMode,
    });
  }

  if (/^Finding:/i.test(title)) {
    return renderPlainWithInline(ctx, {
      icon: "*",
      label: "Find Page",
      detail: stripPrefix(title, /^Finding:\s*(.+)$/i),
      text: outputText(ctx),
      shouldHideResultInSuccinctMode,
    });
  }

  if (/^Image generation$/i.test(title)) {
    const savedPath = formatPathDetail(readString(output, "saved_path"), ctx.cwd);
    const status = readScalarText(output, "status");
    const prompt = readString(output, "revised_prompt") ?? readString(input, "prompt");
    const extras = [savedPath, status].filter((value): value is string => Boolean(value));
    return renderPlainWithInline(ctx, {
      icon: "◈",
      label: "Image",
      detail: prompt ? previewInlineArg(prompt) : undefined,
      extras,
      text: outputText(ctx),
      shouldHideResultInSuccinctMode,
    });
  }

  const imagePath = stripPrefix(title, /^View Image\s+(.+)$/i);
  if (imagePath) {
    return renderPlainWithInline(ctx, {
      icon: "→",
      label: "View Image",
      detail: formatPathForDisplay(imagePath, ctx.cwd),
      text: outputText(ctx),
      shouldHideResultInSuccinctMode,
    });
  }

  return null;
}

function normalizeMcpToolName(value: string): string {
  return value.trim().replace(/_/g, "-");
}

function parseMcpResultSummary(text: string): string[] {
  if (!text.trim()) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    const record = asRecord(parsed);
    if (!record) return [];
    const resources = record.resources;
    if (Array.isArray(resources)) return [plural(resources.length, "resource")];
    const templates = record.resourceTemplates ?? record.resource_templates;
    if (Array.isArray(templates)) return [plural(templates.length, "template")];
    const tools = record.tools;
    if (Array.isArray(tools)) return [plural(tools.length, "tool")];
  } catch {
    return [];
  }
  return [];
}

function renderMcpTool(ctx: ToolRenderContext): ToolRendererOutput | null {
  const input = asRecord(ctx.block.rawInput);
  const server = readString(input, "server", "namespace");
  const tool =
    readString(input, "tool", "name") ?? stripPrefix(firstUsefulTitleLine(ctx.block.toolName), /^Tool:\s*(.+)$/i);
  const isMcp =
    Boolean(server || tool) && (/^Tool:/i.test(ctx.block.toolName) || ctx.block.toolName.startsWith("tool:"));
  if (!isMcp || !tool) return null;

  const args = recordValue(input, "arguments", "params", "input") ?? ctx.block.rawInput;
  const resultText = outputText(ctx);
  const detail = server ? `${server}/${normalizeMcpToolName(tool)}` : normalizeMcpToolName(tool);
  const extras = parseMcpResultSummary(resultText);
  const argExtras = compactObjectSummary(args, CODEX_METADATA_KEYS, 1);
  if (argExtras.length > 0) extras.push(...argExtras);

  return renderPlainWithInline(ctx, {
    icon: "*",
    label: "MCP Tool",
    detail,
    extras,
    text: resultText,
    shouldHideResultInSuccinctMode,
  });
}

function renderPatch(ctx: ToolRenderContext): ToolRendererOutput | null {
  const diffs = toolDiffItems(ctx);
  if (diffs.length === 0) return null;
  const title = firstUsefulTitleLine(ctx.block.toolName);
  const detail = stripPrefix(title, /^Edit\s+(.+)$/i);
  const leadingText = textFromToolContent(ctx);
  return renderDiffTool(ctx, {
    icon: "~",
    label: /^Apply patch$/i.test(title) || ctx.block.toolName === "apply_patch" ? "Apply Patch" : "Edit",
    detail: detail ? formatPathForDisplay(detail, ctx.cwd) : undefined,
    leadingText,
  });
}

function genericArgsText(ctx: ToolRenderContext): string {
  const input = asRecord(ctx.block.rawInput);
  if (!input) return inlineValue(ctx.block.rawInput);
  return Object.entries(input)
    .filter(([key]) => !CODEX_METADATA_KEYS.has(key))
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : safeJson(value)}`)
    .join("\n");
}

function renderCodexGeneric(ctx: ToolRenderContext): ToolRendererOutput {
  const argsText = genericArgsText(ctx);
  const resultText = outputText(ctx);
  const summary = compactObjectSummary(ctx.block.rawInput, CODEX_METADATA_KEYS, 2);
  return renderExpandableGeneric(ctx, {
    icon: icon(ctx.block.toolName, ctx.block.toolKind),
    label: ctx.helpers.formatToolName(ctx.block.toolName),
    extras: summary,
    argsText,
    resultText,
  });
}

export function shouldHideResultInSuccinctMode(toolName: string): boolean {
  return CODEX_HIDDEN_RESULT_PATTERNS.some((pattern) => pattern.test(toolName));
}

export function isNonTruncatableTool(toolName: string): boolean {
  return /^(edit|apply_patch|apply patch)/i.test(toolName);
}

export const codexProfile: ToolRenderProfile = {
  ...defaultProfile,
  icons: {
    ...defaultProfile.icons,
    "Tool:": "*",
    apply_patch: "~",
    bash: "$",
    edit: "~",
    exec: "$",
    read: "→",
    shell: "$",
    write: "+",
  },
  renderers: {},
  isNonTruncatableTool,
  shouldHideResultInSuccinctMode,
};

export function renderCodexToolBlock(ctx: ToolRenderContext): ToolRendererOutput {
  return (
    renderPatch(ctx) ??
    renderCommand(ctx) ??
    renderRead(ctx) ??
    renderList(ctx) ??
    renderSearch(ctx) ??
    renderWebOrImage(ctx) ??
    renderMcpTool(ctx) ??
    renderCodexGeneric(ctx)
  );
}
