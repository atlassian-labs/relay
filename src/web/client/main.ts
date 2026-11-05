import { createPatch } from "diff";
import { parseLiveSessionMessage } from "../../core/live-sessions";
import { builtinSlashCommandNameSet, normalizeBuiltinSlashCommandName } from "../../core/slash-commands";
import type { QueuedPrompt, UserBlock } from "../../ui/state";
import { userBashHeader } from "../../ui/util/user-bash-block";
import { formatQueuedPromptPreview } from "../../ui/util/prompt-queue";
import { userBlockSkillInvocation } from "../../ui/util/user-message";
import { WEB_SLASH_COMMANDS } from "./prompt-data";
import {
  compactText,
  escapeAttribute,
  escapeHtml,
  formatToolName,
  markdown,
  renderCodeBlock,
  renderDiffBlock,
} from "./html";

type AnyRecord = {
  [key: string]: unknown;
  id?: string;
  activeThreadId?: string;
  agent?: string;
  availableCommands?: AnyRecord[];
  disabledBuiltinSlashCommands?: unknown;
  availableModes?: AnyRecord[];
  availableModels?: AnyRecord[];
  availableThinkingLevels?: AnyRecord[];
  sessionListAvailable?: boolean;
  sessionLoadAvailable?: boolean;
  sessionResumeAvailable?: boolean;
  blocks?: AnyRecord[];
  choices?: AnyRecord[];
  connecting?: boolean;
  content?: unknown;
  cwd?: string;
  description?: string;
  detail?: string;
  elapsedSeconds?: number;
  fields?: AnyRecord[];
  generationSeconds?: number;
  kind?: string;
  label?: string;
  modeId?: string;
  modelId?: string;
  thinkingLevel?: string;
  thinkingConfigId?: string;
  name?: string;
  pendingQueue?: AnyRecord[];
  requestId?: string;
  running?: boolean;
  sessionId?: string;
  spinnerActive?: boolean;
  state?: AnyRecord;
  status?: string;
  text?: string;
  title?: string;
  toolName?: string;
  userBashRunning?: boolean;
  value?: string;
  type?: string;
  details?: string;
  approvalPreview?: string;
  approvalOptions?: AnyRecord[];
  display?: string;
  toolKind?: string;
  threads?: AnyRecord[];
  path?: string;
  branch?: string | null;
  head?: string | null;
  diff?: { path?: string; oldText?: string; newText?: string };
};
type WorktreeCandidate = {
  path: string;
  label: string;
  description: string;
  branch?: string | null;
  head?: string | null;
};
type ConfigMenu = "model" | "thinking" | "mode" | "settings";
type ConfigMenuItem = { value: string; label: string; detail?: string; active?: boolean };
type SuggestionItem = { type?: string; label: string; detail?: string; insertText?: string };
type SuggestionState = {
  open: boolean;
  mode: string | null;
  items: SuggestionItem[];
  index: number;
  replaceStart: number;
  replaceEnd: number;
  pendingPathRequestId?: string;
};

const ICON_PLUS = svg('<path d="M8 3.5v9M3.5 8h9"/>');
const ICON_BRANCH = svg(
  '<circle cx="4.5" cy="4" r="1.6"/><circle cx="4.5" cy="12" r="1.6"/><circle cx="11.5" cy="4" r="1.6"/><path d="M4.5 5.6v4.8M11.5 5.6c0 3-3.2 2.6-5.4 3.9"/>',
);
const ICON_BRANCH_PLUS = svg(
  '<circle cx="4.5" cy="4" r="1.6"/><circle cx="4.5" cy="12" r="1.6"/><path d="M4.5 5.6v4.8"/><path d="M11.5 2.6v3.8M9.6 4.5h3.8"/>',
);
const ICON_CHEVRON_DOWN = svg('<path d="M4 6.5l4 4 4-4"/>');
const ICON_ARCHIVE = svg(
  '<path d="M2.5 4.2h11M3.6 4.2v8.1a1 1 0 0 0 1 1h6.8a1 1 0 0 0 1-1V4.2M2.2 2.5h11.6v1.7H2.2zM6.4 7.2h3.2"/>',
);
const ICON_ARROW_UP = svg('<path d="M8 12.5v-9M4 7l4-4 4 4"/>');
const ICON_SLIDERS = svg(
  '<path d="M2.5 5h7M11.5 5h2M2.5 11h2M6.5 11h7"/><circle cx="10.2" cy="5" r="1.3"/><circle cx="5.3" cy="11" r="1.3"/>',
);
const ICON_STOP = svg('<rect x="4.5" y="4.5" width="7" height="7" rx="1.4" fill="currentColor" stroke="none"/>');

function svg(inner: string): string {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function promptInput(): HTMLTextAreaElement {
  return byId<HTMLTextAreaElement>("promptInput");
}

function records(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? (value as AnyRecord[]) : [];
}

const app = byId("app");
let snapshot: AnyRecord | null = null;
let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let draftPrompt = "";
let shellReady = false;
let renderScheduled = false;
const blockNodes = new Map<string, { node: Element; html: string }>();
const PROMPT_HISTORY_KEY = "relay.web.promptHistory.v1";
let promptHistory: string[] = loadPromptHistory();
let historyCursor: number | null = null;
let latestPathRequestId = 0;
let suggestionState: SuggestionState = { open: false, mode: null, items: [], index: 0, replaceStart: 0, replaceEnd: 0 };
let configMenu: ConfigMenu | null = null;
let configMenuIndex = 0;
let worktreePickerOpen = false;
let showAllThreads = false;
let worktreePickerLoading = false;
let worktreePickerItems: WorktreeCandidate[] = [];
let worktreePickerError: string | null = null;

function send(message: AnyRecord) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function shortPath(value: unknown) {
  return String(value || "")
    .split(/[\\/]/)
    .filter(Boolean)
    .slice(-2)
    .join("/");
}

function workspaceLabel(value: unknown) {
  return (
    String(value || "")
      .split(/[\\/]/)
      .filter(Boolean)
      .at(-1) || "workspace"
  );
}

function headerTitle(value: unknown): string {
  const title = String(value || "New thread");
  return title.length > 32 ? `${title.slice(0, 32).trimEnd()}...` : title;
}

const THREAD_LIST_LIMIT = 20;

function isDefaultDraftTitle(title: unknown): boolean {
  return title === "New thread" || title === "New worktree thread";
}

// Mirrors the TUI's visibleSidebarThreads: hide empty default drafts (unless
// active) and collapse threads that share a session down to the newest one.
function visibleWebThreads(threads: AnyRecord[], activeThreadId: unknown): AnyRecord[] {
  const recency = (thread: AnyRecord) => String(thread.updatedAt ?? thread.createdAt ?? "");
  const byConversation = new Map<string, AnyRecord>();
  for (const thread of threads) {
    if (thread.archived) continue;
    if (thread.id !== activeThreadId && isDefaultDraftTitle(thread.title)) continue;
    const key = thread.sessionId ? `session:${thread.sessionId}` : `thread:${thread.id}`;
    const existing = byConversation.get(key);
    if (!existing || thread.id === activeThreadId) {
      byConversation.set(key, thread);
      continue;
    }
    if (existing.id === activeThreadId) continue;
    if (recency(thread).localeCompare(recency(existing)) >= 0) byConversation.set(key, thread);
  }
  return [...byConversation.values()].sort((a, b) => recency(b).localeCompare(recency(a)));
}

function relativeTime(value: unknown): string {
  const time = value ? Date.parse(String(value)) : NaN;
  if (Number.isNaN(time)) return "";
  // effect-shape-allow: browser relative recency label
  const diff = Math.max(0, Date.now() - time);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "now";
  if (diff < hour) return `${Math.round(diff / minute)}m`;
  if (diff < day) return `${Math.round(diff / hour)}h`;
  if (diff < 30 * day) return `${Math.round(diff / day)}d`;
  if (diff < 365 * day) return `${Math.round(diff / (30 * day))}mo`;
  return `${Math.round(diff / (365 * day))}y`;
}

function pathBasename(value: unknown): string {
  const parts = String(value || "changes")
    .split(/[\\/]/)
    .filter(Boolean);
  return parts.at(-1) || "changes";
}

function patchFromDiff(diff: { path?: string; oldText?: string; newText?: string }): string {
  const filePath = diff.path || "changes";
  return createPatch(pathBasename(filePath), diff.oldText ?? "", diff.newText ?? "", "before", "after", { context: 3 });
}

function diffFromRecord(record: AnyRecord): { path?: string; oldText?: string; newText?: string } {
  const source =
    record.diff && typeof record.diff === "object" && !Array.isArray(record.diff) ? (record.diff as AnyRecord) : record;
  return {
    path: typeof source.path === "string" ? source.path : undefined,
    oldText: typeof source.oldText === "string" ? source.oldText : "",
    newText: typeof source.newText === "string" ? source.newText : "",
  };
}

function diffItems(
  block: AnyRecord,
): Array<
  { type: "diff"; diff: { path?: string; oldText?: string; newText?: string } } | { type: "text"; text: string }
> {
  const items = Array.isArray(block.content) ? block.content : [];
  const mapped = items
    .map(
      (
        item,
      ):
        | { type: "diff"; diff: { path?: string; oldText?: string; newText?: string } }
        | { type: "text"; text: string }
        | null => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const record = item as AnyRecord;
        if (record.type === "diff") return { type: "diff", diff: diffFromRecord(record) };
        if (record.type === "text" && typeof record.text === "string") return { type: "text", text: record.text };
        return null;
      },
    )
    .filter(
      (
        item,
      ): item is
        | { type: "diff"; diff: { path?: string; oldText?: string; newText?: string } }
        | { type: "text"; text: string } => item !== null,
    );
  if (mapped.some((item) => item.type === "diff")) return mapped;
  return block.diff ? [{ type: "diff", diff: block.diff }] : [];
}

function renderToolDiffs(block: AnyRecord): string {
  return diffItems(block)
    .map((item) => {
      if (item.type === "text") return renderCodeBlock(item.text, block.toolKind || block.toolName || "output");
      const filePath = item.diff.path ? `<div class="diff-path">${escapeHtml(item.diff.path)}</div>` : "";
      return `${filePath}${renderDiffBlock(patchFromDiff(item.diff))}`;
    })
    .join("");
}

function toolBody(block: AnyRecord): string {
  const diffHtml = renderToolDiffs(block);
  if (diffHtml) return diffHtml;
  const details = block.details || block.approvalPreview || block.display || "";
  if (!compactText(details, Number.MAX_SAFE_INTEGER)) return "";
  return renderCodeBlock(details, block.toolKind || block.toolName || "output");
}

function toolRawInput(block: AnyRecord): AnyRecord | null {
  const value = block.rawInput;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : null;
}

function firstStringField(record: AnyRecord | null, keys: string[]): string {
  if (!record) return "";
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Short, human target for the tool line — a path, command, query, or url. */
function toolTarget(block: AnyRecord): string {
  const record = toolRawInput(block);
  const command = firstStringField(record, ["command", "cmd"]);
  if (command) return compactText(command.split("\n")[0], 72);
  const filePath = firstStringField(record, ["path", "file_path", "filePath", "abs_path", "absPath"]);
  if (filePath) return shortPath(filePath);
  const query = firstStringField(record, ["query", "pattern", "content_pattern", "contentPattern"]);
  if (query) return compactText(query, 60);
  const url = firstStringField(record, ["url"]);
  if (url) return compactText(url, 60);
  return "";
}

/** Small trailing metric: change counts for diffs. */
function toolMetric(block: AnyRecord): string {
  const items = diffItems(block);
  if (!items.some((item) => item.type === "diff")) return "";
  let added = 0;
  let removed = 0;
  for (const item of items) {
    if (item.type !== "diff") continue;
    for (const line of patchFromDiff(item.diff).split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }
  const parts: string[] = [];
  if (added) parts.push(`+${added}`);
  if (removed) parts.push(`−${removed}`);
  return parts.join(" ");
}

function toolStatusFlag(status: string): string {
  if (status === "error") return '<span class="tool-flag error">failed</span>';
  if (status === "approval") return '<span class="tool-flag warn">needs approval</span>';
  if (status === "running" || status === "pending") return '<span class="tool-spin" aria-hidden="true"></span>';
  return "";
}

/** Generic, per-name count summary for a run of tool calls: "2 Read File, 1 Bash". */
function toolGroupSummary(blocks: AnyRecord[]): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const block of blocks) {
    const name = formatToolName(block.toolName || "tool");
    if (!counts.has(name)) order.push(name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return order.map((name) => `${counts.get(name)} ${name}`).join(", ");
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function renderThoughtItem(block: AnyRecord): string {
  return `<div class="tool-thought"><div class="markdown">${markdown(block.content)}</div></div>`;
}

function isActiveThought(block: AnyRecord): boolean {
  return block.type === "thinking" && block.finalized !== true;
}

function stringifyParams(raw: AnyRecord): string {
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

/** Generic input params for tool calls, shown verbatim as JSON. */
function toolParamsSection(block: AnyRecord): string {
  const raw = toolRawInput(block);
  if (!raw || Object.keys(raw).length === 0) return "";
  return `<div class="tool-item-section"><div class="tool-item-label">Params</div>${renderCodeBlock(stringifyParams(raw), "json")}</div>`;
}

/** Generic result for tool calls: diffs/text content, else raw output/details. */
function toolResultSection(block: AnyRecord): string {
  const diffs = renderToolDiffs(block);
  if (diffs) return `<div class="tool-item-section"><div class="tool-item-label">Result</div>${diffs}</div>`;
  const details = block.details || block.approvalPreview || block.display || "";
  if (!compactText(details, Number.MAX_SAFE_INTEGER)) return "";
  return `<div class="tool-item-section"><div class="tool-item-label">Result</div>${renderCodeBlock(details, block.toolKind || block.toolName || "output")}</div>`;
}

/** One tool call inside an expanded group: name/target header + params + result. */
function renderToolItem(block: AnyRecord): string {
  const name = formatToolName(block.toolName || "tool");
  const target = toolTarget(block);
  const metric = toolMetric(block);
  const status = String(block.status || "pending");
  const head = `<div class="tool-item-head"><span class="tool-item-name">${escapeHtml(name)}</span>${
    target ? `<span class="tool-target">${escapeHtml(target)}</span>` : ""
  }${metric ? `<span class="tool-metric">${escapeHtml(metric)}</span>` : ""}${toolStatusFlag(status)}</div>`;
  const body = `${toolParamsSection(block)}${toolResultSection(block)}`;
  return `<div class="tool-item">${head}${body}</div>`;
}

function renderThinkingBlock(block: AnyRecord): string {
  return `<section class="block thinking content-lane" aria-label="Thinking">${renderThoughtItem(block)}</section>`;
}

/** Collapse a run of consecutive thoughts/tool calls into one exploration block. */
function renderToolGroup(blocks: AnyRecord[]): string {
  const thoughts = blocks.filter((block) => block.type === "thinking");
  const tools = blocks.filter((block) => isGroupableTool(block));
  const toolSummary = toolGroupSummary(tools);
  const thoughtSummary = thoughts.length
    ? `${thoughts.length} ${pluralize(thoughts.length, "thought")}${toolSummary ? `, ${toolSummary}` : ""}`
    : "";
  const summary = thoughts.length ? thoughtSummary : toolSummary;
  const anyError = tools.some((block) => String(block.status || "") === "error");
  const anyActive =
    tools.some((block) => ["pending", "running"].includes(String(block.status || ""))) ||
    thoughts.some(isActiveThought);
  const statusMod = anyError ? "error" : anyActive ? "pending" : "complete";
  const flag = anyError
    ? '<span class="tool-flag error">failed</span>'
    : anyActive
      ? '<span class="tool-spin" aria-hidden="true"></span>'
      : "";
  const label = thoughts.length ? "Explored" : "Tool calls";
  const line = `<span class="tool-verb">${label}</span><span class="tool-target">${escapeHtml(summary)}</span>${flag}`;
  const thoughtBody = thoughts.map(renderThoughtItem).join("");
  const separator = thoughts.length && tools.length ? '<hr class="tool-separator" />' : "";
  const toolBody = tools.map(renderToolItem).join("");
  return `<section class="block tool content-lane ${statusMod}" aria-label="${thoughts.length ? "Exploration" : "Tool calls"}"><details class="tool-line-wrap"><summary class="tool-line">${line}</summary><div class="tool-body">${thoughtBody}${separator}${toolBody}</div></details></section>`;
}

/** Interactive permission request — kept standalone (never grouped). */
function renderApprovalTool(block: AnyRecord): string {
  const name = formatToolName(block.toolName || "tool");
  const target = toolTarget(block);
  const line = `<span class="tool-verb">${escapeHtml(name)}</span>${
    target ? `<span class="tool-target">${escapeHtml(target)}</span>` : ""
  }${toolStatusFlag("approval")}`;
  const preview = toolBody(block);
  const previewHtml = preview ? `<div class="tool-body">${preview}</div>` : "";
  return `<section class="block tool content-lane approval" aria-label="Tool"><div class="tool-line">${line}</div>${previewHtml}${approvalButtons(block)}</section>`;
}

function approvalButtons(block: AnyRecord): string {
  const blockId = escapeAttribute(block.id);
  const options = records(block.approvalOptions);
  if (options.length === 0) {
    return `<div class="choice-row"><button class="danger" data-action="approval" data-block="${blockId}" data-response="deny">Cancel request</button></div>`;
  }
  return `<div class="choice-row">${options
    .map((option) => {
      const optionId = typeof option.optionId === "string" ? option.optionId : "";
      if (!optionId) return "";
      const kind = typeof option.kind === "string" ? option.kind : "";
      const className = kind.startsWith("reject") ? "danger" : kind.startsWith("allow") ? "primary" : "";
      const label = typeof option.name === "string" && option.name.trim() ? option.name : optionId;
      return `<button class="${className}" data-action="approval" data-block="${blockId}" data-option-id="${escapeAttribute(optionId)}">${escapeHtml(label)}</button>`;
    })
    .join("")}</div>`;
}

function renderBlock(block: AnyRecord) {
  if (!block) return "";
  if (block.type === "user") {
    const sessionMessage = typeof block.content === "string" ? parseLiveSessionMessage(block.content) : null;
    if (sessionMessage) {
      const sessionLabel = `[${sessionMessage.relation}: ${sessionMessage.name}]`;
      const label = block.delivery === "current-turn-guidance" ? `[turn update] ${sessionLabel}` : sessionLabel;
      return `<section class="block user" aria-label="${escapeAttribute(`${sessionMessage.relation} session ${sessionMessage.name}`)}"><strong>${escapeHtml(label)}</strong><div class="markdown">${markdown(sessionMessage.text)}</div></section>`;
    }
    if (block.delivery === "current-turn-guidance") {
      return `<section class="block user" aria-label="You"><strong>[turn update]</strong><div class="markdown">${markdown(block.content)}</div></section>`;
    }
    const skill = userBlockSkillInvocation(block as unknown as UserBlock);
    if (skill) {
      const userMessage = skill.userMessage ? `<div class="markdown">${markdown(skill.userMessage)}</div>` : "";
      return `<section class="block user" aria-label="You"><strong>[skill] ${escapeHtml(skill.name)}</strong>${userMessage}</section>`;
    }
    return `<section class="block user" aria-label="You"><div class="markdown">${markdown(block.content)}</div></section>`;
  }
  if (block.type === "content")
    return `<section class="block content content-lane" aria-label="Relay"><span class="block-symbol" data-label="Relay">✦</span><div class="markdown">${markdown(block.content)}</div></section>`;
  if (block.type === "thinking") return renderThinkingBlock(block);
  if (block.type === "info")
    return `<section class="block info content-lane ${escapeHtml(block.variant)}" aria-label="Info"><span class="block-symbol" data-label="Info">ⓘ</span>${block.content ? `<div class="markdown">${markdown(block.content)}</div>` : '<div class="empty-note">Relay session</div>'}</section>`;
  if (block.type === "user-bash") {
    const title = userBashHeader(block.excludeFromContext === true);
    return `<section class="block user" aria-label="Local command"><strong>${escapeHtml(title)}</strong><div class="markdown"><p><code>$ ${escapeHtml(block.command)}</code></p></div>${renderCodeBlock(block.output || "", "shell")}</section>`;
  }
  if (block.type === "tool")
    return String(block.status || "") === "approval" ? renderApprovalTool(block) : renderToolGroup([block]);
  if (block.type === "elicitation") {
    const fields = (block.fields || [])
      .map((field: AnyRecord) => {
        if (field.choices && field.choices.length)
          return `<div class="field"><label>${escapeHtml(field.title)}</label><div class="choice-row">${field.choices.map((choice: AnyRecord) => `<button data-action="elicitation-choice" data-block="${escapeAttribute(block.id)}" data-key="${escapeAttribute(field.key)}" data-value="${escapeAttribute(choice.value)}">${escapeHtml(choice.title)}</button>`).join("")}</div></div>`;
        return `<div class="field"><label>${escapeHtml(field.title)}</label><input data-elicit-input="${escapeAttribute(block.id)}" data-key="${escapeAttribute(field.key)}" placeholder="${escapeAttribute(field.description || "")}" /></div>`;
      })
      .join("");
    return `<section class="block tool content-lane" aria-label="Input requested"><span class="block-symbol" data-label="Input requested">?</span><div class="tool-head"><span class="tool-name">Input requested</span><span class="badge ${escapeHtml(block.status)}">${escapeHtml(block.status)}</span></div><p>${escapeHtml(block.message)}</p><div class="elicitation-form">${fields || "<p>No fields were provided.</p>"}<div class="choice-row"><button class="primary" data-action="elicitation-submit" data-block="${escapeAttribute(block.id)}">Submit</button><button data-action="elicitation-decline" data-block="${escapeAttribute(block.id)}">Decline</button><button class="danger" data-action="elicitation-cancel" data-block="${escapeAttribute(block.id)}">Cancel</button></div></div></section>`;
  }
  return "";
}

function ensureShell() {
  if (shellReady) return;
  app.innerHTML = `<div class="app-shell" id="shell">
    <aside class="sidebar">
      <nav class="side-nav">
        <button class="nav-icon-btn" data-action="new-thread" title="New thread" aria-label="New thread">${ICON_PLUS}</button>
        <button class="nav-icon-btn" data-action="new-worktree" title="New worktree" aria-label="New worktree">${ICON_BRANCH_PLUS}</button>
        <button class="nav-icon-btn" data-action="new-existing-worktree" title="Existing worktree" aria-label="Existing worktree">${ICON_BRANCH}</button>
      </nav>
      <div class="side-scroll">
        <div class="section-label"><span>Threads</span></div>
        <div class="thread-list" id="threadList"></div>
      </div>
    </aside>
    <main class="main">
      <header class="main-head"><div class="head-title" id="headTitle"></div></header>
      <div class="chat-wrap" id="chatWrap"><div class="chat" id="chat"></div></div>
      <div class="queue" id="queue"></div>
      <div class="prompt-dock"><div class="prompt" id="promptBox"><div class="prompt-suggestions" id="promptSuggestions" hidden></div><div class="prompt-input-row"><textarea id="promptInput" rows="1" placeholder="Message Relay…"></textarea><div class="prompt-actions" id="promptActions"><button class="primary send-btn" data-action="send-prompt" aria-label="Send">${ICON_ARROW_UP}</button></div></div><div class="prompt-meta" id="promptMeta"></div></div><div class="prompt-foot"><div class="foot-left"><div class="status-pill" id="statusPill"></div><span class="foot-agent" id="footAgent"></span><span class="foot-branch" id="footBranch"></span></div><div class="controls" id="controls"></div></div></div>
    </main>
    <div class="worktree-picker" id="worktreePicker" hidden></div>
  </div>`;
  app.addEventListener("click", handleClick);
  const input = promptInput();
  input.addEventListener("input", () => {
    draftPrompt = input.value;
    historyCursor = null;
    const hadConfigMenu = configMenu !== null;
    configMenu = null;
    configMenuIndex = 0;
    autoResizePrompt(input);
    updatePromptAssist();
    if (hadConfigMenu) scheduleRender();
  });
  input.addEventListener("click", updatePromptAssist);
  input.addEventListener("keyup", (event) => {
    if (!["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)) updatePromptAssist();
  });
  input.addEventListener("keydown", handlePromptKeydown);
  shellReady = true;
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function render() {
  if (!snapshot) {
    app.innerHTML =
      '<div class="empty"><div><h2>Relay Web</h2><p>Connecting to the local Relay server…</p></div></div>';
    shellReady = false;
    return;
  }
  ensureShell();

  const shell = byId("shell");
  const state = (snapshot.state ?? {}) as AnyRecord;
  const threads = records(snapshot.threads);
  const allBlocks = records(state.blocks);
  const blocks = visibleConversationBlocks(allBlocks);
  const running = Boolean(state.running);
  const connecting = Boolean(state.connecting);
  const empty = blocks.length === 0;
  shell.classList.toggle("is-empty", empty);
  shell.classList.toggle("is-running", running);
  shell.classList.toggle("is-connecting", connecting);
  shell.classList.toggle("is-ready", !running && !connecting);

  const activeThread = threads.find((thread: AnyRecord) => thread.id === snapshot!.activeThreadId);
  const fullTitle = String(activeThread?.title || "New thread");
  const titleNode = byId("headTitle");
  titleNode.textContent = headerTitle(fullTitle);
  titleNode.setAttribute("title", fullTitle);
  byId("footAgent").innerHTML =
    `<span class="foot-agent-name">(${escapeHtml(String(snapshot.agent ?? "agent"))})</span>`;
  const branchLabel = String(state.worktreeBranch || "") || workspaceLabel(snapshot.cwd);
  byId("footBranch").innerHTML = `${ICON_BRANCH}<span>${escapeHtml(branchLabel)}</span>`;
  const visibleThreads = visibleWebThreads(threads, snapshot.activeThreadId);
  const collapsed = !showAllThreads && visibleThreads.length > THREAD_LIST_LIMIT;
  const shownThreads = collapsed ? visibleThreads.slice(0, THREAD_LIST_LIMIT) : visibleThreads;
  const threadCards = shownThreads
    .map((thread: AnyRecord) => {
      const active = thread.id === snapshot!.activeThreadId;
      const time = relativeTime(thread.updatedAt ?? thread.createdAt);
      const running = thread.status === "running" || thread.status === "connecting";
      const spinner = running ? '<span class="thread-spin" aria-hidden="true"></span>' : "";
      return `<div class="thread-card ${active ? "active" : ""} ${running ? "running" : ""}"><button class="thread-main" data-action="select-thread" data-thread="${escapeAttribute(thread.id)}" title="${escapeAttribute(thread.title || "New chat")}">${spinner}<span class="thread-title">${escapeHtml(thread.title || "New chat")}</span>${time ? `<span class="thread-time">${escapeHtml(time)}</span>` : ""}</button><button class="thread-archive" data-action="archive-thread" data-thread="${escapeAttribute(thread.id)}" title="Archive thread" aria-label="Archive thread">${ICON_ARCHIVE}</button></div>`;
    })
    .join("");
  const moreButton = collapsed
    ? `<button class="thread-more" data-action="show-all-threads">More (${visibleThreads.length - THREAD_LIST_LIMIT})</button>`
    : "";
  byId("threadList").innerHTML = threadCards + moreButton;
  renderWorktreePicker();

  const statusPill = byId("statusPill");
  const statusText = running
    ? `Working · ${formatElapsed(state.generationSeconds || state.elapsedSeconds || 0)}`
    : connecting
      ? "Getting ready"
      : "Ready";
  const statusKind = running ? "running" : connecting ? "connecting" : "ready";
  statusPill.className = `status-pill ${statusKind}`;
  statusPill.innerHTML = `<span class="status-dot ${statusKind}"></span>${escapeHtml(statusText)}`;

  byId("controls").innerHTML = renderPromptConfig(state);

  const promptAction =
    running || state.userBashRunning
      ? `<button class="send-btn stop-btn" data-action="cancel" title="Stop" aria-label="Stop">${ICON_STOP}</button>`
      : `<button class="primary send-btn" data-action="send-prompt" aria-label="Send">${ICON_ARROW_UP}</button>`;
  byId("promptActions").innerHTML = promptAction;

  const wrap = byId("chatWrap");
  const wasNearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 180;
  renderConversation(byId("chat"), blocks, state, snapshot.agent ?? "agent");
  applyUserClamps();
  if (wasNearBottom)
    requestAnimationFrame(() => {
      wrap.scrollTop = wrap.scrollHeight;
    });

  byId("queue").innerHTML = records(state.pendingQueue)
    .map((item: AnyRecord, index: number) => {
      const preview = formatQueuedPromptPreview(item as unknown as QueuedPrompt);
      return `<div class="queue-item">Queued prompt #${index + 1} · ${escapeHtml(preview)}</div>`;
    })
    .join("");

  const input = promptInput();
  if (document.activeElement !== input && input.value !== draftPrompt) input.value = draftPrompt;
  input.placeholder = empty ? "Ask Relay anything, @ to add context" : "Send follow-up";
  autoResizePrompt(input);
  updatePromptAssist();
}

function normalizedModeId(mode: AnyRecord | undefined): string | undefined {
  return mode?.id || mode?.modeId || mode?.value || mode?.name;
}

function thinkingLevelLabel(value: unknown): string {
  return String(value || "Thinking");
}

function renderPromptConfig(state: AnyRecord) {
  const models = state.availableModels || [];
  const modes = state.availableModes || [];
  const thinkingLevels = state.availableThinkingLevels || [];
  const currentModel = models.find((model: AnyRecord) => model.modelId === state.modelId);
  const currentMode = modes.find((mode: AnyRecord) => normalizedModeId(mode) === state.modeId);
  const currentThinking = thinkingLevels.find((thinkingLevel: AnyRecord) => thinkingLevel.id === state.thinkingLevel);
  const modelLabel = currentModel?.name || currentModel?.modelId || state.modelId || "Model";
  const modeLabel = currentMode?.name || normalizedModeId(currentMode || {}) || state.modeId || "Mode";
  const thinkingLabel = currentThinking?.name || thinkingLevelLabel(state.thinkingLevel);
  const menuFor = (menu: ConfigMenu) => (configMenu === menu ? renderConfigMenu(menu, state) : "");
  const pill = (menu: ConfigMenu, label: string) =>
    `<span class="config-control"><button class="config-pill ${configMenu === menu ? "active" : ""}" data-action="config-menu" data-menu="${menu}"><span class="config-pill-label">${escapeHtml(label)}</span><span class="config-caret" aria-hidden="true">${ICON_CHEVRON_DOWN}</span></button>${menuFor(menu)}</span>`;
  const modelControl = models.length ? pill("model", modelLabel) : "";
  const thinkingControl = thinkingLevels.length ? pill("thinking", thinkingLabel) : "";
  const modeControl = modes.length ? pill("mode", modeLabel) : "";
  const settingsControl = `<span class="config-control"><button class="config-icon ${configMenu === "settings" ? "active" : ""}" data-action="config-menu" data-menu="settings" title="Settings" aria-label="Settings">${ICON_SLIDERS}</button>${menuFor("settings")}</span>`;
  return `<div class="prompt-controls">${modelControl}${thinkingControl}${modeControl}${settingsControl}</div>`;
}

function renderConfigMenu(menu: ConfigMenu, state: AnyRecord) {
  const items = configMenuItems(menu, state);
  if (!items.length) return "";
  const title =
    menu === "model"
      ? "Choose model"
      : menu === "thinking"
        ? "Choose thinking"
        : menu === "mode"
          ? "Choose mode"
          : "Settings";
  return `<div class="config-menu"><div class="config-menu-title">${title}</div>${items
    .map(
      (item: AnyRecord, index: number) =>
        `<button class="config-menu-item ${index === configMenuIndex ? "focused" : ""} ${item.active ? "active" : ""}" data-action="config-choice" data-menu="${escapeAttribute(menu)}" data-value="${escapeAttribute(item.value)}"><span><span>${escapeHtml(item.label)}</span>${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ""}</span>${item.active ? "<span>✓</span>" : ""}</button>`,
    )
    .join("")}</div>`;
}

function configMenuItems(menu: ConfigMenu, state: AnyRecord): ConfigMenuItem[] {
  if (menu === "model") {
    return records(state.availableModels).map((model: AnyRecord) => ({
      value: model.modelId ?? "",
      label: model.name || model.modelId || "Model",
      detail: model.description || model.modelId,
      active: model.modelId === state.modelId,
    }));
  }
  if (menu === "thinking") {
    return records(state.availableThinkingLevels).map((thinkingLevel: AnyRecord) => ({
      value: thinkingLevel.id ?? "",
      label: thinkingLevel.name || thinkingLevelLabel(thinkingLevel.id),
      detail: thinkingLevel.description || thinkingLevel.id,
      active: thinkingLevel.id === state.thinkingLevel,
    }));
  }
  if (menu === "mode") {
    return records(state.availableModes).map((mode: AnyRecord) => {
      const value = normalizedModeId(mode);
      return {
        value: value ?? "",
        label: mode.name || value || "Mode",
        detail: mode.description || value,
        active: value === state.modeId,
      };
    });
  }
  if (menu === "settings") {
    const models = records(state.availableModels);
    const thinkingLevels = records(state.availableThinkingLevels);
    const modes = records(state.availableModes);
    return [
      ...(models.length ? [{ value: "model", label: "Model", detail: state.modelId || "Choose model" }] : []),
      ...(thinkingLevels.length
        ? [{ value: "thinking", label: "Thinking", detail: state.thinkingLevel || "Choose thinking level" }]
        : []),
      ...(modes.length ? [{ value: "mode", label: "Mode", detail: state.modeId || "Choose mode" }] : []),
      { value: "sessions", label: "Sessions", detail: "Open the agent session list" },
      { value: "new-thread", label: "New local thread", detail: "Start a fresh thread in this worktree" },
      { value: "new-worktree", label: "New worktree", detail: "Create an isolated worktree thread" },
      {
        value: "new-existing-worktree",
        label: "Existing worktree",
        detail: "Start a thread in an existing git worktree",
      },
      { value: "clear", label: "Clear transcript", detail: "Clear visible web transcript" },
    ];
  }
  return [];
}

function isEmptySession() {
  return !snapshot?.state?.blocks || visibleConversationBlocks(snapshot.state.blocks).length === 0;
}

function isConfigMenu(value: string | undefined): value is ConfigMenu {
  return value === "model" || value === "thinking" || value === "mode" || value === "settings";
}

function handleSettingsChoice(value: string | undefined) {
  if (value === "model" || value === "thinking" || value === "mode") {
    openPromptConfig(value);
    return;
  }
  if (value === "sessions") send({ type: "listSessions" });
  if (value === "new-thread") send({ type: "newThread" });
  if (value === "new-worktree") send({ type: "newThread", worktree: true });
  if (value === "new-existing-worktree") openExistingWorktreePicker();
  if (value === "clear") send({ type: "prompt", text: "/clear" });
  configMenu = null;
  configMenuIndex = 0;
}

function openPromptConfig(menu: ConfigMenu) {
  configMenu = menu;
  configMenuIndex = initialConfigMenuIndex(menu);
  closeSuggestions();
  scheduleRender();
  requestAnimationFrame(() => promptInput()?.focus());
}

function initialConfigMenuIndex(menu: ConfigMenu) {
  const items = configMenuItems(menu, snapshot?.state || {});
  const activeIndex = items.findIndex((item: ConfigMenuItem) => item.active);
  return activeIndex >= 0 ? activeIndex : 0;
}

function handleLocalSlashSubmit(text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;
  const [commandRaw, ...rest] = trimmed.slice(1).split(/\s+/);
  const command = commandRaw.toLowerCase();
  const arg = rest.join(" ").trim();
  if (webBuiltinCommandDisabled(command, disabledWebBuiltinCommandNames())) return false;
  if ((command === "models" || command === "model") && !arg) {
    openPromptConfig("model");
    return true;
  }
  if (command === "thinking" && !arg) {
    openPromptConfig("thinking");
    return true;
  }
  if ((command === "modes" || command === "mode") && !arg) {
    openPromptConfig("mode");
    return true;
  }
  if (command === "settings") {
    openPromptConfig("settings");
    return true;
  }
  if (command === "model" && arg) {
    send({ type: "switchModel", modelId: arg });
    return true;
  }
  if (command === "thinking" && arg) {
    send({ type: "switchThinking", thinkingLevel: arg });
    return true;
  }
  if (command === "mode" && arg) {
    send({ type: "switchMode", modeId: arg });
    return true;
  }
  return false;
}

function worktreeCandidateFromRecord(value: AnyRecord): WorktreeCandidate | null {
  if (!value.path) return null;
  const pathValue = String(value.path);
  return {
    path: pathValue,
    label: String(value.label || value.branch || shortPath(pathValue) || pathValue),
    description: String(value.description || pathValue),
    branch: typeof value.branch === "string" ? value.branch : null,
    head: typeof value.head === "string" ? value.head : null,
  };
}

function openExistingWorktreePicker() {
  worktreePickerOpen = true;
  worktreePickerLoading = true;
  worktreePickerItems = [];
  worktreePickerError = null;
  send({ type: "listWorktrees" });
  scheduleRender();
}

function closeExistingWorktreePicker() {
  worktreePickerOpen = false;
  worktreePickerLoading = false;
  worktreePickerError = null;
  scheduleRender();
}

function renderWorktreePicker() {
  const picker = byId("worktreePicker");
  if (!picker) return;
  picker.hidden = !worktreePickerOpen;
  if (!worktreePickerOpen) {
    picker.innerHTML = "";
    return;
  }
  const body = worktreePickerLoading
    ? '<div class="picker-empty">Scanning git worktrees…</div>'
    : worktreePickerError
      ? `<div class="picker-empty error">${escapeHtml(worktreePickerError)}</div>`
      : worktreePickerItems.length === 0
        ? '<div class="picker-empty">No available git worktrees found.</div>'
        : worktreePickerItems
            .map(
              (item) =>
                `<button class="picker-item" data-action="worktree-choice" data-path="${escapeAttribute(item.path)}"><span class="picker-item-label">${escapeHtml(item.label)}</span><span class="picker-item-detail">${escapeHtml(item.description)}</span></button>`,
            )
            .join("");
  picker.innerHTML = `<div class="picker-panel" role="dialog" aria-modal="true" aria-label="Choose existing worktree"><div class="picker-head"><div><div class="picker-kicker">Existing worktree</div><h2>Choose a worktree</h2></div><button data-action="worktree-picker-close" aria-label="Close worktree picker">×</button></div><div class="picker-list">${body}</div></div>`;
}

function handleWorktreeCandidates(message: AnyRecord) {
  worktreePickerLoading = false;
  worktreePickerError = typeof message.error === "string" ? message.error : null;
  worktreePickerItems = records(message.items)
    .map(worktreeCandidateFromRecord)
    .filter((item): item is WorktreeCandidate => item !== null);
  worktreePickerOpen = true;
  scheduleRender();
}

function handleClick(event: MouseEvent) {
  const target = (event.target as Element | null)?.closest("[data-action]") as HTMLElement | null;
  const action = target?.dataset.action;
  if (configMenu && action !== "config-menu" && action !== "config-choice") {
    const insideMenu = (event.target as Element | null)?.closest(".config-menu");
    if (!insideMenu) {
      configMenu = null;
      configMenuIndex = 0;
      scheduleRender();
    }
  }
  if (!target) {
    const clamped = (event.target as Element | null)?.closest(".block.user.clamped");
    if (clamped) clamped.classList.toggle("expanded");
    return;
  }
  if (action === "prompt-suggestion") {
    applySuggestion(Number(target.dataset.index || 0));
    return;
  }
  if (action === "config-menu") {
    if (configMenu === target.dataset.menu) {
      configMenu = null;
      configMenuIndex = 0;
    } else {
      if (isConfigMenu(target.dataset.menu)) openPromptConfig(target.dataset.menu);
    }
    scheduleRender();
    return;
  }
  if (action === "config-choice") {
    if (target.dataset.menu === "model") send({ type: "switchModel", modelId: target.dataset.value });
    if (target.dataset.menu === "thinking") send({ type: "switchThinking", thinkingLevel: target.dataset.value });
    if (target.dataset.menu === "mode") send({ type: "switchMode", modeId: target.dataset.value });
    if (target.dataset.menu === "settings") handleSettingsChoice(target.dataset.value);
    if (target.dataset.menu !== "settings") {
      configMenu = null;
      configMenuIndex = 0;
    }
    scheduleRender();
    return;
  }
  if (action === "new-thread") send({ type: "newThread" });
  if (action === "new-worktree") send({ type: "newThread", worktree: true });
  if (action === "new-existing-worktree") openExistingWorktreePicker();
  if (action === "worktree-picker-close") closeExistingWorktreePicker();
  if (action === "worktree-choice" && target.dataset.path) {
    send({ type: "newThread", worktreePath: target.dataset.path });
    closeExistingWorktreePicker();
  }
  if (action === "show-all-threads") {
    showAllThreads = true;
    scheduleRender();
    return;
  }
  if (action === "select-thread") send({ type: "selectThread", threadId: target.dataset.thread });
  if (action === "archive-thread") send({ type: "archiveThread", threadId: target.dataset.thread });
  if (action === "send-prompt") submitPrompt(false);
  if (action === "active-input") submitPrompt(true);
  if (action === "cancel") send({ type: "cancel" });
  if (action === "sessions") send({ type: "listSessions" });
  if (action === "approval")
    send({
      type: "approval",
      blockId: target.dataset.block,
      response: target.dataset.optionId ? { optionId: target.dataset.optionId } : target.dataset.response,
    });
  if (action === "elicitation-submit")
    send({
      type: "elicitation",
      blockId: target.dataset.block,
      response: { action: "accept", content: collectElicitation(target.dataset.block ?? "") },
    });
  if (action === "elicitation-decline")
    send({ type: "elicitation", blockId: target.dataset.block, response: { action: "decline" } });
  if (action === "elicitation-cancel")
    send({ type: "elicitation", blockId: target.dataset.block, response: { action: "cancel" } });
  if (action === "elicitation-choice")
    send({
      type: "elicitation",
      blockId: target.dataset.block,
      response: { action: "accept", content: { [target.dataset.key ?? "value"]: target.dataset.value } },
    });
}

function formatElapsed(seconds: unknown) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  const remainder = value % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function shouldShowWorkingPlaceholder(blocks: AnyRecord[], state: AnyRecord) {
  if (!state.running && !state.spinnerActive) return false;
  if (!blocks.length) return true;
  const lastUserIndex = blocks.map((block: AnyRecord) => block.type).lastIndexOf("user");
  const afterUser = lastUserIndex >= 0 ? blocks.slice(lastUserIndex + 1) : blocks;
  return !afterUser.some((block: AnyRecord) =>
    ["content", "thinking", "tool", "elicitation", "user-bash"].includes(String(block.type)),
  );
}

function workingPlaceholder() {
  return `<section class="block agent-working content-lane" data-synthetic="agent-working" aria-label="Relay working"><span class="block-symbol" data-label="Relay working">✦</span><span class="working-dot"></span><span class="working-dot"></span><span class="working-dot"></span><span class="working-copy">Agent working…</span></section>`;
}

function collectElicitation(blockId: string): Record<string, string> {
  const content: Record<string, string> = {};
  document.querySelectorAll<HTMLInputElement>(`[data-elicit-input="${CSS.escape(blockId)}"]`).forEach((input) => {
    if (input.dataset.key) content[input.dataset.key] = input.value;
  });
  return content;
}

function isSystemInfoBlock(block: AnyRecord) {
  if (!block || block.type !== "info") return false;
  const content = String(block.content || "").trim();
  if (!content) return true;
  if (/^Queued prompt #\d+$/.test(content)) return true;
  return /^Connected to .+ agent \(session:/.test(content);
}

function visibleConversationBlocks(blocks: AnyRecord[]) {
  return blocks.filter((block: AnyRecord) => !isSystemInfoBlock(block));
}

function emptyHero(_state: AnyRecord, _agent: string) {
  return `<div class="empty hero"><span class="loader-spin" aria-label="Connecting"></span></div>`;
}

function isGroupableTool(block: AnyRecord): boolean {
  return Boolean(block) && block.type === "tool" && String(block.status || "") !== "approval";
}

function isExplorationBlock(block: AnyRecord): boolean {
  return Boolean(block) && (block.type === "thinking" || isGroupableTool(block));
}

type RenderUnit = { id: string; html: string };

/** Coalesce consecutive thoughts/non-approval tool calls into one grouped unit. */
function conversationUnits(blocks: AnyRecord[]): RenderUnit[] {
  const units: RenderUnit[] = [];
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index];
    if (isExplorationBlock(block)) {
      const group: AnyRecord[] = [];
      while (index < blocks.length && isExplorationBlock(blocks[index])) {
        group.push(blocks[index]);
        index += 1;
      }
      units.push({
        id: `explore-${group.map((item) => String(item.id ?? "")).join("_")}`,
        html: renderToolGroup(group),
      });
      continue;
    }
    const id = String(block.id ?? "");
    if (id) units.push({ id, html: renderBlock(block) });
    index += 1;
  }
  return units;
}

const USER_CLAMP_PX = 132;

/** Bound tall user messages; clicking a clamped message expands it (see handleClick). */
function applyUserClamps() {
  for (const node of document.querySelectorAll<HTMLElement>(".block.user")) {
    if (node.dataset.clamp) continue;
    node.dataset.clamp = "1";
    if (node.scrollHeight > USER_CLAMP_PX + 12) node.classList.add("clamped");
  }
}

function renderConversation(chat: HTMLElement, blocks: AnyRecord[], state: AnyRecord, agent: string) {
  if (blocks.length === 0) {
    const hero = emptyHero(state, agent);
    if (chat.innerHTML !== hero) chat.innerHTML = hero;
    blockNodes.clear();
    return;
  }
  if (chat.querySelector(".hero")) chat.textContent = "";
  const showWorkingPlaceholder = shouldShowWorkingPlaceholder(blocks, state);
  const synthetic = chat.querySelector('[data-synthetic="agent-working"]');
  if (!showWorkingPlaceholder) synthetic?.remove();
  const activeIds = new Set();
  for (const unit of conversationUnits(blocks)) {
    const blockId = unit.id;
    activeIds.add(blockId);
    const html = unit.html;
    let entry = blockNodes.get(blockId);
    if (!entry) {
      const template = document.createElement("template");
      template.innerHTML = html.trim();
      const node = template.content.firstElementChild!;
      entry = { node, html: "" };
      blockNodes.set(blockId, entry);
    }
    if (entry.html !== html) {
      const openDetails = [...entry.node.querySelectorAll("details")].map((details) => details.open);
      const template = document.createElement("template");
      template.innerHTML = html.trim();
      const next = template.content.firstElementChild!;
      entry.node.className = next.className;
      entry.node.innerHTML = next.innerHTML;
      entry.node.querySelectorAll("details").forEach((details, detailIndex) => {
        details.open = openDetails[detailIndex] === true;
      });
      entry.html = html;
    }
    if (entry.node.parentElement !== chat) chat.appendChild(entry.node);
  }
  for (const [id, entry] of [...blockNodes]) {
    if (!activeIds.has(id)) {
      entry.node.remove();
      blockNodes.delete(id);
    }
  }
  if (showWorkingPlaceholder) {
    if (synthetic) chat.appendChild(synthetic);
    else chat.insertAdjacentHTML("beforeend", workingPlaceholder());
  }
}

function loadPromptHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROMPT_HISTORY_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item: unknown): item is string => typeof item === "string").slice(0, 100)
      : [];
  } catch {
    return [];
  }
}

function rememberPrompt(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  promptHistory = [trimmed, ...promptHistory.filter((item: string) => item !== trimmed)].slice(0, 100);
  try {
    localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(promptHistory));
  } catch {}
}

function webSlashCommandAvailable(command: string, state: AnyRecord): boolean {
  switch (command) {
    case "/models":
    case "/model":
      return records(state.availableModels).length > 0;
    case "/thinking":
      return records(state.availableThinkingLevels).length > 0;
    case "/modes":
    case "/mode":
      return records(state.availableModes).length > 0;
    case "/sessions":
    case "/resume":
      return state.sessionLoadAvailable === true || state.sessionResumeAvailable === true;
    default:
      return true;
  }
}

function disabledWebBuiltinCommandNames(): Set<string> {
  const values = Array.isArray(snapshot?.disabledBuiltinSlashCommands)
    ? snapshot.disabledBuiltinSlashCommands.filter((item): item is string => typeof item === "string")
    : [];
  return builtinSlashCommandNameSet(values);
}

const WEB_BUILTIN_SLASH_COMMAND_ALIASES = new Map<string, readonly string[]>([
  ["model", ["models"]],
  ["models", ["model"]],
  ["mode", ["modes"]],
  ["modes", ["mode"]],
  ["resume", ["sessions"]],
  ["sessions", ["resume"]],
]);

function webBuiltinCommandDisabled(command: string, disabled: ReadonlySet<string>): boolean {
  const name = normalizeBuiltinSlashCommandName(command);
  if (!name) return false;
  return disabled.has(name) || (WEB_BUILTIN_SLASH_COMMAND_ALIASES.get(name) ?? []).some((alias) => disabled.has(alias));
}

function nativeSlashCommands() {
  const state = snapshot?.state || {};
  const disabled = disabledWebBuiltinCommandNames();
  const commands: Array<[string, string]> = WEB_SLASH_COMMANDS.filter(
    ([command]) => !webBuiltinCommandDisabled(command, disabled) && webSlashCommandAvailable(command, state),
  ).map(([command, description]) => [command, description]);
  for (const command of records(snapshot?.availableCommands)) {
    const name = String(command.name || "").replace(/^\//, "");
    if (name) commands.push([`/${name}`, command.description || "Agent command"]);
  }
  if (!webBuiltinCommandDisabled("model", disabled)) {
    for (const model of records(state.availableModels))
      if (model.modelId) commands.push([`/model ${model.modelId}`, model.name || "Switch model"]);
  }
  if (!webBuiltinCommandDisabled("thinking", disabled)) {
    for (const thinkingLevel of records(state.availableThinkingLevels))
      if (thinkingLevel.id)
        commands.push([`/thinking ${thinkingLevel.id}`, thinkingLevel.name || "Set thinking level"]);
  }
  if (!webBuiltinCommandDisabled("mode", disabled)) {
    for (const mode of records(state.availableModes)) {
      const value = normalizedModeId(mode);
      if (value) commands.push([`/mode ${value}`, mode.name || "Switch mode"]);
    }
  }
  return commands;
}

function promptContext(input: HTMLTextAreaElement) {
  const cursor = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, cursor);
  const slash = before.match(/(^|\s)(\/[^\s]*)$/);
  if (slash)
    return {
      mode: "slash",
      query: slash[2],
      replaceStart: cursor - slash[2].length,
      replaceEnd: cursor,
    };
  const pathMatch = before.match(/(^|\s)@([^\s]*)$/);
  if (pathMatch)
    return { mode: "path", query: pathMatch[2], replaceStart: cursor - pathMatch[2].length - 1, replaceEnd: cursor };
  const bash = before.match(/^!{1,2}[^\n]*$/);
  if (bash) return { mode: "bash", query: before, replaceStart: 0, replaceEnd: cursor };
  const text = input.value.trim();
  if (text.length >= 2) return { mode: "history", query: text, replaceStart: 0, replaceEnd: input.value.length };
  return null;
}

function updatePromptAssist() {
  const input = promptInput();
  if (!input) return;
  updatePromptMeta(input.value);
  const context = promptContext(input);
  if (!context) {
    closeSuggestions();
    return;
  }
  if (context.mode === "slash") {
    const query = context.query.toLowerCase();
    const items = nativeSlashCommands()
      .filter(([label]) => label.toLowerCase().startsWith(query) || label.toLowerCase().includes(query.slice(1)))
      .slice(0, 12)
      .map(([label, detail]) => ({
        type: "slash",
        label,
        detail,
        insertText: label.endsWith(" ") ? label : `${label} `,
      }));
    showSuggestions(context, items);
    return;
  }
  if (context.mode === "bash") {
    showSuggestions(context, [
      {
        type: "bash",
        label: "! command",
        detail: "Run locally only; do not attach output",
        insertText: "!",
      },
      {
        type: "bash",
        label: "!! command",
        detail: "Run locally and attach output to your next message",
        insertText: "!!",
      },
    ]);
    return;
  }
  if (context.mode === "history") {
    const query = context.query.toLowerCase();
    const items = promptHistory
      .filter((item: string) => item.toLowerCase().includes(query))
      .slice(0, 8)
      .map((item: string) => ({ type: "history", label: item, detail: "Prompt history", insertText: item }));
    showSuggestions(context, items);
    return;
  }
  if (context.mode === "path") {
    const requestId = `path-${++latestPathRequestId}`;
    suggestionState.pendingPathRequestId = requestId;
    suggestionState.replaceStart = context.replaceStart;
    suggestionState.replaceEnd = context.replaceEnd;
    send({ type: "pathComplete", requestId, query: context.query });
  }
}

function handlePathCompletions(message: AnyRecord) {
  if (message.requestId !== suggestionState.pendingPathRequestId) return;
  const input = promptInput();
  if (!input) return;
  const context = promptContext(input);
  if (!context || context.mode !== "path") return;
  const items = records(message.items).map((item: AnyRecord) => ({
    type: item.kind === "directory" ? "directory" : "file",
    label: item.label || item.value || "",
    detail: item.detail ? `${item.detail} · @${item.value}` : `@${item.value}`,
    insertText: `@${item.value}`,
  }));
  showSuggestions(context, items);
}

function showSuggestions(context: AnyRecord, items: SuggestionItem[]) {
  const panel = byId("promptSuggestions");
  if (!panel) return;
  if (!items.length) {
    closeSuggestions();
    return;
  }
  suggestionState = {
    ...suggestionState,
    open: true,
    mode: typeof context.mode === "string" ? context.mode : null,
    items,
    index: typeof context.index === "number" ? context.index : 0,
    replaceStart: typeof context.replaceStart === "number" ? context.replaceStart : 0,
    replaceEnd: typeof context.replaceEnd === "number" ? context.replaceEnd : 0,
  };
  panel.hidden = false;
  panel.innerHTML = `<div class="suggestion-head">${suggestionHeading(suggestionState.mode)}</div>${items
    .map(
      (item: SuggestionItem, index: number) =>
        `<button class="suggestion-item ${index === suggestionState.index ? "active" : ""}" data-action="prompt-suggestion" data-index="${index}"><span class="suggestion-kind">${escapeHtml(suggestionKind(item.type))}</span><span class="suggestion-main"><span class="suggestion-label">${escapeHtml(item.label)}</span><span class="suggestion-detail">${escapeHtml(item.detail || "")}</span></span></button>`,
    )
    .join("")}`;
}

function suggestionHeading(mode: string | null) {
  if (mode === "slash") return "Commands";
  if (mode === "path") return "Files";
  if (mode === "bash") return "Local command";
  return "History";
}

function suggestionKind(type: string | undefined) {
  if (type === "slash") return "/";
  if (type === "directory") return "dir";
  if (type === "file") return "file";
  if (type === "bash") return "!";
  return "hist";
}

function closeSuggestions() {
  suggestionState = { ...suggestionState, open: false, items: [], index: 0 };
  const panel = byId("promptSuggestions");
  if (panel) panel.hidden = true;
}

function moveSuggestion(delta: number) {
  if (!suggestionState.open || !suggestionState.items.length) return;
  suggestionState.index = (suggestionState.index + delta + suggestionState.items.length) % suggestionState.items.length;
  showSuggestions(suggestionState, suggestionState.items);
}

function applySuggestion(index = suggestionState.index) {
  if (!suggestionState.open) return false;
  const item = suggestionState.items[index];
  const input = promptInput();
  if (!item || !input) return false;
  const before = input.value.slice(0, suggestionState.replaceStart);
  const after = input.value.slice(suggestionState.replaceEnd);
  const insertText = item.insertText ?? item.label;
  input.value = `${before}${insertText}${after}`;
  draftPrompt = input.value;
  const cursor = before.length + insertText.length;
  input.setSelectionRange(cursor, cursor);
  autoResizePrompt(input);
  closeSuggestions();
  updatePromptAssist();
  input.focus();
  return true;
}

function moveConfigMenu(delta: number) {
  if (!configMenu) return false;
  const items = configMenuItems(configMenu, snapshot?.state || {});
  if (!items.length) return false;
  configMenuIndex = (configMenuIndex + delta + items.length) % items.length;
  scheduleRender();
  return true;
}

function applyConfigMenuSelection() {
  if (!configMenu) return false;
  const items = configMenuItems(configMenu, snapshot?.state || {});
  const item = items[configMenuIndex];
  if (!item) return false;
  if (configMenu === "model") send({ type: "switchModel", modelId: item.value });
  if (configMenu === "thinking") send({ type: "switchThinking", thinkingLevel: item.value });
  if (configMenu === "mode") send({ type: "switchMode", modeId: item.value });
  if (configMenu === "settings") {
    handleSettingsChoice(item.value);
    scheduleRender();
    return true;
  }
  configMenu = null;
  configMenuIndex = 0;
  scheduleRender();
  return true;
}

function handleConfigMenuKeydown(event: KeyboardEvent) {
  if (!configMenu || !["ArrowDown", "ArrowUp", "Tab", "Enter", "Escape"].includes(event.key)) return false;
  event.preventDefault();
  if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) return moveConfigMenu(1);
  if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) return moveConfigMenu(-1);
  if (event.key === "Enter") return applyConfigMenuSelection();
  if (event.key === "Escape") {
    configMenu = null;
    configMenuIndex = 0;
    scheduleRender();
    return true;
  }
  return false;
}

function handlePromptKeydown(event: KeyboardEvent) {
  const input = event.currentTarget as HTMLTextAreaElement;
  if (handleConfigMenuKeydown(event)) return;
  if (suggestionState.open && ["ArrowDown", "ArrowUp", "Tab", "Enter", "Escape"].includes(event.key)) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSuggestion(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSuggestion(-1);
      return;
    }
    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
      event.preventDefault();
      applySuggestion();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSuggestions();
      return;
    }
  }
  if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
    if (cyclePromptHistory(input, event.key === "ArrowUp" ? -1 : 1)) {
      event.preventDefault();
      return;
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") {
    event.preventDefault();
    showSuggestions(
      { mode: "history", replaceStart: 0, replaceEnd: input.value.length },
      promptHistory
        .slice(0, 12)
        .map((item: string) => ({ type: "history", label: item, detail: "Prompt history", insertText: item })),
    );
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitPrompt(false);
  }
  if (event.key === "Escape") closeSuggestions();
}

function cyclePromptHistory(input: HTMLTextAreaElement, direction: number) {
  if (suggestionState.open || promptHistory.length === 0) return false;
  const atSingleLineBoundary = !input.value.includes("\n") || input.selectionStart === input.selectionEnd;
  if (!atSingleLineBoundary) return false;
  if (historyCursor === null) {
    if (direction > 0 || input.value.trim()) return false;
    historyCursor = 0;
  } else {
    historyCursor += direction;
  }
  if (historyCursor < 0) historyCursor = promptHistory.length - 1;
  if (historyCursor >= promptHistory.length) {
    historyCursor = null;
    input.value = "";
  } else {
    input.value = promptHistory[historyCursor];
  }
  draftPrompt = input.value;
  input.setSelectionRange(input.value.length, input.value.length);
  autoResizePrompt(input);
  updatePromptMeta(input.value);
  return true;
}

function updatePromptMeta(value: string) {
  const meta = byId("promptMeta");
  if (!meta) return;
  const chips = [];
  if (value.trimStart().startsWith("/")) chips.push(["Command", "enter to run · tab to complete"]);
  if (/(^|\s)@[^\s]*/.test(value)) chips.push(["File context", "@ path autocomplete"]);
  if (value.startsWith("!!")) chips.push(["LLM request", "output attaches to next prompt"]);
  else if (value.startsWith("!")) chips.push(["Local", "output stays out of next prompt"]);
  meta.hidden = chips.length === 0;
  meta.innerHTML = chips
    .map(
      ([label, detail]) =>
        `<span class="prompt-chip"><strong>${escapeHtml(label)}</strong>${escapeHtml(detail)}</span>`,
    )
    .join("");
}

function autoResizePrompt(input: HTMLTextAreaElement) {
  if (!input) return;
  input.style.height = "auto";
  const maxHeight = 188;
  const nextHeight = Math.min(input.scrollHeight, maxHeight);
  input.style.height = `${nextHeight}px`;
  input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
}

function submitPrompt(activeTurn: boolean) {
  const input = promptInput();
  const text = input ? input.value.trim() : "";
  if (!text) return;
  closeSuggestions();
  if (handleLocalSlashSubmit(text)) {
    draftPrompt = "";
    historyCursor = null;
    input.value = "";
    autoResizePrompt(input);
    updatePromptAssist();
    return;
  }
  rememberPrompt(text);
  send({ type: activeTurn ? "activeTurnInput" : "prompt", text });
  draftPrompt = "";
  historyCursor = null;
  input.value = "";
  autoResizePrompt(input);
  updatePromptAssist();
}

function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
  ws.addEventListener("message", (event) => {
    let message: AnyRecord;
    try {
      message = JSON.parse(event.data) as AnyRecord;
    } catch {
      return;
    }
    if (message.type === "snapshot") {
      snapshot = (message.snapshot ?? null) as AnyRecord | null;
      scheduleRender();
    }
    if (message.type === "pathCompletions") handlePathCompletions(message);
    if (message.type === "worktreeCandidates") handleWorktreeCandidates(message);
  });
  ws.addEventListener("close", () => {
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    // effect-shape-allow: browser WebSocket reconnect scheduling lives in the browser client.
    reconnectTimer = window.setTimeout(connect, 800);
  });
}

render();
connect();
