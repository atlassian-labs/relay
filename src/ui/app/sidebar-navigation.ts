/**
 * Pure layout/navigation math for the thread sidebar.
 *
 * The keyboard handler in app-root owns the sidebar focus signals and terminal
 * dimensions; these helpers turn those inputs into the grid geometry and focus
 * ordering used to move the selection around. Keeping them pure makes the
 * navigation behaviour unit-testable without a live renderer.
 */

import type { ThreadInfo } from "../../core/threads";

/** Action-row pseudo-indices that precede real threads when collapsed. */
export const SIDEBAR_ACTION_INDICES = [-2, -1, -3] as const;

function isDefaultDraftTitle(title: string): boolean {
  return title === "New thread" || title === "New worktree thread";
}

function threadRecency(thread: ThreadInfo): string {
  return thread.updatedAt ?? thread.createdAt ?? "";
}

function newerThread(left: ThreadInfo, right: ThreadInfo): ThreadInfo {
  return threadRecency(left).localeCompare(threadRecency(right)) >= 0 ? left : right;
}

export function visibleSidebarThreads(
  threads: readonly ThreadInfo[],
  activeThreadId?: string | null,
  options: { includeDefaultDrafts?: boolean } = {},
): ThreadInfo[] {
  const visibleByConversation = new Map<string, ThreadInfo>();
  for (const thread of threads) {
    if (thread.archived) continue;
    if (thread.id !== activeThreadId && isDefaultDraftTitle(thread.title) && options.includeDefaultDrafts !== true)
      continue;

    const key = thread.sessionId ? `session:${thread.sessionId}` : `thread:${thread.id}`;
    const existing = visibleByConversation.get(key);
    if (!existing || thread.id === activeThreadId) {
      visibleByConversation.set(key, thread);
      continue;
    }
    if (existing.id === activeThreadId) continue;
    visibleByConversation.set(key, newerThread(thread, existing));
  }

  return [...visibleByConversation.values()].toSorted((a, b) => threadRecency(b).localeCompare(threadRecency(a)));
}

export type SidebarLayout = {
  /** Number of columns in the expanded grid (always 1 when collapsed). */
  gridColumns: number;
  /** Number of rows that fit in the expanded grid. */
  gridRows: number;
  /** How many thread cards are visible at once. */
  visibleThreadCount: number;
  /**
   * Focus traversal order: action pseudo-indices (collapsed only) followed by
   * the visible thread indices.
   */
  focusOrder: number[];
};

export function computeSidebarLayout(args: {
  visibleThreadCount: number;
  expanded: boolean;
  columns: number;
  rows: number;
}): SidebarLayout {
  const { visibleThreadCount: threadCount, expanded, columns, rows } = args;
  const gridColumns = (() => {
    if (!expanded) return 1;
    const count = Math.max(1, threadCount);
    const width = Math.max(30, Math.max(42, columns - 2) - 3);
    const height = Math.max(7, rows - 6);
    const maxColumns = Math.max(1, Math.floor(width / 30));
    const idealColumns = count <= 2 ? count : Math.ceil(Math.sqrt(count * (width / Math.max(height * 4, 1))));
    return Math.max(1, Math.min(maxColumns, idealColumns));
  })();
  const gridRows = Math.max(1, Math.floor(Math.max(7, rows - 6) / 7));
  const visibleCardCount = expanded ? Math.max(1, gridColumns * gridRows) : 5;
  const actionOrder = expanded ? [] : [...SIDEBAR_ACTION_INDICES];
  const focusOrder = [...actionOrder, ...Array.from({ length: threadCount }, (_, index) => index)];
  return { gridColumns, gridRows, visibleThreadCount: visibleCardCount, focusOrder };
}

/** Move the focus index horizontally (expanded grid left/right wrap-around). */
export function horizontalSidebarFocus(focusOrder: number[], current: number, direction: -1 | 1): number {
  const pos = focusOrder.indexOf(current);
  const next = focusOrder[pos >= 0 ? (pos + direction + focusOrder.length) % focusOrder.length : 0] ?? 0;
  return next;
}

/** Move the focus index vertically by one grid step (clamped to the order). */
export function verticalSidebarFocus(focusOrder: number[], current: number, direction: -1 | 1, step: number): number {
  const pos = focusOrder.indexOf(current);
  if (direction === -1) {
    return focusOrder[Math.max(0, pos - step)] ?? focusOrder[0] ?? -2;
  }
  const base = pos >= 0 ? pos : 0;
  return focusOrder[Math.min(focusOrder.length - 1, base + step)] ?? focusOrder[0] ?? -2;
}

/** Compute the next list scroll offset so the focused index stays visible. */
export function ensureSidebarIndexVisible(offset: number, index: number, visibleThreadCount: number): number {
  if (index < 0) return offset;
  if (index < offset) return index;
  if (index >= offset + visibleThreadCount) return index - visibleThreadCount + 1;
  return offset;
}
