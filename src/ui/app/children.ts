import { childThreads, threadRelaySessionName, type ThreadInfo } from "../../core/threads";
import type { ListItem } from "../autocomplete";
import { compactPreviewText } from "../util/thread-preview";
import type { SelectionOverlayApp, SelectionOverlayBehavior } from "./selection-overlay";

export const CHILD_PICKER_LAYOUT = {
  labelMinWidth: 20,
  labelMaxWidth: 56,
  descriptionMaxWidth: 80,
  viewportReservedWidth: 4,
} as const;

export function directChildThreads(threads: readonly ThreadInfo[], parentThreadId: string): ThreadInfo[] {
  return childThreads(threads, parentThreadId);
}

export function parentThreadForChild(threads: readonly ThreadInfo[], childThreadId: string): ThreadInfo | undefined {
  const child = threads.find((thread) => thread.id === childThreadId && !thread.archived);
  if (!child?.parentThreadId) return undefined;
  return threads.find((thread) => thread.id === child.parentThreadId && !thread.archived);
}

export function childStatusLabel(thread: ThreadInfo): string {
  if (thread.status === "running") return "running";
  if (thread.status === "connecting" || thread.childTaskStatus === "starting") return "starting";
  return thread.childTaskStatus ?? "idle";
}

export function childListItems(threads: readonly ThreadInfo[], parentThreadId: string): ListItem<ThreadInfo>[] {
  return directChildThreads(threads, parentThreadId).map((thread) => {
    const status = childStatusLabel(thread);
    const goal = thread.relationGoal?.trim() ?? "";
    const sessionId = thread.relaySessionId ?? thread.id;
    const sessionName = threadRelaySessionName(thread);
    return {
      value: thread,
      label: goal ? `${thread.title} (${compactPreviewText(goal, 42, false)})` : thread.title,
      searchLabel: `${thread.title} ${goal} ${sessionName} ${sessionId} ${status}`,
      description: `${status} · ${sessionName} · ${sessionId}`,
    };
  });
}

export function childPickerBehavior(
  selectThread: ((app: SelectionOverlayApp, threadId: string) => Promise<void>) | undefined,
  onError: (error: unknown) => void,
): SelectionOverlayBehavior {
  return {
    onSelect: (item, app) => {
      const thread = item.value as ThreadInfo;
      void selectThread?.(app, thread.id).catch(onError);
    },
  };
}
