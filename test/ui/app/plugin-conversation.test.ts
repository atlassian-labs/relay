import { describe, expect, test } from "bun:test";
import { snapshotRelayConversation } from "../../../src/ui/app/plugin-conversation";
import type { RelayPluginThreadInfo } from "../../../src/plugins";
import type { ChatBlock } from "../../../src/ui/state";

const thread: RelayPluginThreadInfo = {
  id: "thread-one",
  title: "Thread one",
  sessionId: "session-thread",
  cwd: "/workspace",
  workspaceKind: "local",
  status: "paused",
  archived: false,
};

describe("plugin conversation snapshots", () => {
  test("maps UI chat blocks into stable plugin-facing conversation blocks", () => {
    const blocks: ChatBlock[] = [
      {
        type: "user",
        id: "u1",
        content: "hello",
        origin: "local",
        contentItems: [
          { type: "text", text: "hello" },
          { type: "image", data: "base64", mimeType: "image/png" },
        ],
      },
      { type: "thinking", id: "th1", content: "private", finalized: true },
      { type: "content", id: "c1", content: "final answer", finalized: true },
      { type: "content", id: "c2", content: "streaming", finalized: false },
      {
        type: "tool",
        id: "t1",
        toolCallId: "tool-1",
        toolName: "bash",
        display: "ls",
        status: "success",
        rawInput: { command: "ls" },
        rawOutput: "ok",
        content: [{ type: "text", text: "ok" }],
      },
      {
        type: "user-bash",
        id: "b1",
        command: "pwd",
        output: "/workspace",
        exitCode: 0,
        status: "done",
        excludeFromContext: true,
      },
      {
        type: "plugin",
        id: "p1",
        pluginId: "plugin",
        pluginName: "Plugin",
        blockType: "note",
        content: "note",
        data: { x: 1 },
      },
      { type: "info", id: "i1", content: "info", variant: "info" },
      {
        type: "elicitation",
        id: "e1",
        mode: "form",
        message: "Pick",
        status: "pending",
        fields: [{ key: "env", title: "Environment", choices: [{ value: "dev", title: "Dev" }] }],
        currentFieldIndex: 0,
        answers: { env: "dev" },
      },
    ];

    const snapshot = snapshotRelayConversation({ thread, blocks, sessionId: "active-session" });

    expect(snapshot.threadId).toBe("thread-one");
    expect(snapshot.sessionId).toBe("active-session");
    expect(snapshot.cwd).toBe("/workspace");
    expect(snapshot.blocks).toHaveLength(blocks.length);
    expect(snapshot.blocks[0]).toMatchObject({ type: "user", role: "user", content: "hello", origin: "local" });
    expect(snapshot.blocks[0]?.type === "user" ? snapshot.blocks[0].contentItems?.[1] : null).toEqual({
      type: "image",
      data: "base64",
      mimeType: "image/png",
    });
    expect(snapshot.blocks[1]).toMatchObject({ type: "thinking", role: "assistant", finalized: true });
    expect(snapshot.blocks[2]).toMatchObject({
      type: "content",
      role: "assistant",
      content: "final answer",
      finalized: true,
    });
    expect(snapshot.blocks[4]).toMatchObject({
      type: "tool",
      toolName: "bash",
      input: { command: "ls" },
      output: "ok",
    });
    expect(snapshot.blocks[8]).toMatchObject({ type: "elicitation", message: "Pick", answers: { env: "dev" } });
  });
});
