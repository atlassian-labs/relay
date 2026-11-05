import { beforeEach, describe, expect, test } from "bun:test";

import { store } from "../../../src/ui/app/runtime-store";
import { createThreadQueueStore } from "../../../src/ui/app/thread-queue";
import { createAppStateValue } from "../../../src/ui/context/app-state";

beforeEach(() => {
  store.threadPendingQueues.clear();
});

describe("ThreadQueueStore", () => {
  test("admits prompts into the addressed thread and returns a typed outcome", () => {
    const app = createAppStateValue(process.cwd());
    const queue = createThreadQueueStore(2);
    const activeThreadId = app.state.activeThreadId;
    const inactiveThreadId = "inactive-thread";

    const active = queue.admit({ app, threadId: activeThreadId, input: "active prompt" });
    const inactive = queue.admit({ app, threadId: inactiveThreadId, input: "inactive prompt" });

    expect(active).toMatchObject({ accepted: true, insertIndex: 0 });
    expect(inactive).toMatchObject({ accepted: true, insertIndex: 0 });
    expect(app.state.pendingQueue.map((item) => item.text)).toEqual(["active prompt"]);
    expect(queue.get(app, inactiveThreadId).map((item) => item.text)).toEqual(["inactive prompt"]);
  });

  test("returns isolated queue snapshots for image-bearing prompts", () => {
    const app = createAppStateValue(process.cwd());
    const queue = createThreadQueueStore(2);
    const threadId = app.state.activeThreadId;
    const image = {
      id: 1,
      marker: "[image #1 photo.png]",
      data: "abc",
      mimeType: "image/png",
      byteLength: 3,
      filename: "photo.png",
    };

    expect(queue.admit({ app, threadId, input: { text: "inspect image", images: [image] } }).accepted).toBe(true);
    const snapshot = queue.get(app, threadId);
    snapshot[0]!.text = "mutated prompt";
    snapshot[0]!.images!.push({ ...image, id: 2, filename: "extra.png" });
    expect(snapshot[0]?.images).toHaveLength(2);

    const stored = queue.get(app, threadId)[0];
    expect(stored?.text).toBe("inspect image");
    expect(stored?.images).toEqual([image]);
  });

  test("applies reserved edit capacity through the same admission policy", () => {
    const app = createAppStateValue(process.cwd());
    const queue = createThreadQueueStore(2);
    const threadId = app.state.activeThreadId;

    expect(queue.admit({ app, threadId, input: "committed" }).accepted).toBe(true);
    const rejected = queue.admit({ app, threadId, input: "external", placement: "end", reservedSlots: 1 });

    expect(rejected).toMatchObject({ accepted: false, reason: "full" });
    expect(app.state.pendingQueue.map((item) => item.text)).toEqual(["committed"]);
  });
});
