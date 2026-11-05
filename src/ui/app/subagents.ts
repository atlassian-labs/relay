import type { ChatBlock, ToolBlock, ToolSubagentState } from "../state";
import type { ListItem } from "../autocomplete";
import { compactPreviewText } from "../util/thread-preview";
import type { SelectionOverlayBehavior } from "./selection-overlay";

export interface SubagentEntry {
  readonly tool: ToolBlock;
  readonly state: ToolSubagentState;
}

export const SUBAGENT_PICKER_LAYOUT = {
  labelMinWidth: 20,
  labelMaxWidth: 48,
  descriptionMaxWidth: 80,
  viewportReservedWidth: 4,
} as const;

const SUBAGENT_TASK_PREVIEW_LENGTH = 36;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function subagentName(entry: SubagentEntry): string {
  const input = record(entry.tool.rawInput);
  const configured = input?.agent ?? input?.name;
  return entry.state.agentName ?? (typeof configured === "string" && configured.trim() ? configured : "subagent");
}

export function subagentTask(entry: SubagentEntry): string {
  const input = record(entry.tool.rawInput);
  const task = input?.message ?? input?.prompt;
  return typeof task === "string" ? task.replace(/\s+/gu, " ").trim() : "";
}

export function subagentLabel(entry: SubagentEntry): string {
  const name = subagentName(entry);
  const task = subagentTask(entry);
  return task ? `${name} (${compactPreviewText(task, SUBAGENT_TASK_PREVIEW_LENGTH, false)})` : name;
}

export function subagentEntries(blocks: readonly ChatBlock[]): SubagentEntry[] {
  return blocks
    .filter((block): block is ToolBlock => block.type === "tool" && block.subagent !== undefined)
    .map((tool) => ({ tool, state: tool.subagent! }));
}

export function subagentStatusLabel(status: ToolSubagentState["status"]): string {
  switch (status) {
    case "success":
      return "done";
    case "error":
      return "failed";
    case "cancelled":
    case "running":
    default:
      return status;
  }
}

export function formatSubagentElapsed(state: ToolSubagentState, now = Date.now()): string {
  const started = state.startedAt;
  if (started === undefined) return "";
  const seconds = Math.max(0, Math.floor(((state.finishedAt ?? now) - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
}

export function subagentListItems(blocks: readonly ChatBlock[], now = Date.now()): ListItem<SubagentEntry>[] {
  return subagentEntries(blocks).map((entry) => {
    const status = subagentStatusLabel(entry.state.status);
    const elapsed = formatSubagentElapsed(entry.state, now);
    const session = entry.state.childSessionId ?? "starting";
    const task = subagentTask(entry);
    return {
      value: entry,
      label: subagentLabel(entry),
      searchLabel: `${subagentName(entry)} ${task} ${session} ${status}`,
      description: [status, session, elapsed].filter(Boolean).join(" · "),
    };
  });
}

export function subagentPickerBehavior(): SelectionOverlayBehavior {
  return {
    onSelect: (item, app) => {
      const entry = item.value as SubagentEntry;
      app.setState("selectedSubagentToolCallId", entry.tool.toolCallId);
    },
  };
}
