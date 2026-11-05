import { describe, expect, test } from "bun:test";
import { PluginRunner } from "../../src/plugins";

describe("plugin conversation API", () => {
  test("exposes thread conversation snapshots through the runner API", async () => {
    const snapshots: unknown[] = [];
    const runner = new PluginRunner({
      cwd: "/workspace",
      thread: {
        current: () => ({
          id: "thread-one",
          title: "Thread one",
          sessionId: "session-one",
          cwd: "/workspace",
          workspaceKind: "local",
          status: "paused",
          archived: false,
        }),
        list: () => [],
        conversation: () => ({
          thread: {
            id: "thread-one",
            title: "Thread one",
            sessionId: "session-one",
            cwd: "/workspace",
            workspaceKind: "local",
            status: "paused",
            archived: false,
          },
          threadId: "thread-one",
          sessionId: "session-one",
          cwd: "/workspace",
          blocks: [{ type: "user", id: "u1", role: "user", content: "hello" }],
        }),
        select: async () => undefined,
        archive: async () => undefined,
      },
    });

    await runner.register({
      info: { id: "plugin", name: "plugin", path: "/plugin" },
      factory: (relay) => {
        snapshots.push(relay.thread.conversation());
      },
    });

    expect(snapshots).toEqual([
      {
        thread: {
          id: "thread-one",
          title: "Thread one",
          sessionId: "session-one",
          cwd: "/workspace",
          workspaceKind: "local",
          status: "paused",
          archived: false,
        },
        threadId: "thread-one",
        sessionId: "session-one",
        cwd: "/workspace",
        blocks: [{ type: "user", id: "u1", role: "user", content: "hello" }],
      },
    ]);
  });
});
