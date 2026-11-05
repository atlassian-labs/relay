import { isPromptSubmission, promptInputText, type PromptInput } from "../../core/prompt-submission";
import { useApp, type QueuedPrompt } from "../state";
import { queuePromptItem, type QueuePromptResult, type QueuePlacement } from "../util/prompt-queue";
import { nextQueueId } from "./prompt-dispatch";
import { store } from "./runtime-store";

type App = ReturnType<typeof useApp>;

export interface ThreadQueueStore {
  readonly maxSize: number;
  get: (app: App, threadId: string) => QueuedPrompt[];
  set: (app: App, threadId: string, queue: QueuedPrompt[]) => void;
  admit: (args: {
    app: App;
    threadId: string;
    input: PromptInput;
    editing?: QueuedPrompt | null;
    placement?: QueuePlacement;
    reservedSlots?: number;
  }) => QueuePromptResult;
}

function cloneQueue(queue: readonly QueuedPrompt[]): QueuedPrompt[] {
  return queue.map((item) => ({
    ...item,
    images: item.images ? [...item.images] : undefined,
    skill: item.skill ? { ...item.skill } : undefined,
  }));
}

export function createThreadQueueStore(maxSize: number): ThreadQueueStore {
  const get = (app: App, threadId: string): QueuedPrompt[] =>
    threadId === app.state.activeThreadId
      ? cloneQueue(app.state.pendingQueue)
      : cloneQueue(store.threadPendingQueues.get(threadId) ?? []);

  const set = (app: App, threadId: string, queue: QueuedPrompt[]): void => {
    const nextQueue = cloneQueue(queue);
    store.threadPendingQueues.set(threadId, nextQueue);
    if (threadId === app.state.activeThreadId) app.setState("pendingQueue", nextQueue);
  };

  const admit: ThreadQueueStore["admit"] = ({
    app,
    threadId,
    input,
    editing = null,
    placement = "in-place",
    reservedSlots = 0,
  }) => {
    const result = queuePromptItem({
      queue: get(app, threadId),
      text: promptInputText(input),
      images: isPromptSubmission(input) ? input.images : [],
      editing,
      placement,
      maxSize: Math.max(0, maxSize - reservedSlots),
      nextId: nextQueueId,
    });
    if (result.accepted) set(app, threadId, result.queue);
    return result;
  };

  return { maxSize, get, set, admit };
}
