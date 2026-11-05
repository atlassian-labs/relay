import { describe, expect, test } from "bun:test";
import { createStore } from "solid-js/store";
import type { ChatBlock } from "../../../src/ui/state";
import {
  pluginEventsFromBlockTransition,
  pluginToolUpdateEvent,
  snapshotPluginBlocks,
  type PluginEventContext,
} from "../../../src/ui/app/plugin-events";

const ctx: PluginEventContext = {
  threadId: "thread-1",
  sessionId: "session-1",
  cwd: "/repo",
  raw: { sessionUpdate: "agent_message_chunk" },
};

describe("plugin lifecycle event helpers", () => {
  test("emits assistant message start/update/end transitions", () => {
    const started = pluginEventsFromBlockTransition(
      snapshotPluginBlocks([]),
      snapshotPluginBlocks([{ type: "content", id: "m1", content: "hel", finalized: false }]),
      ctx,
    );
    const finished = pluginEventsFromBlockTransition(
      snapshotPluginBlocks([{ type: "content", id: "m1", content: "hel", finalized: false }]),
      snapshotPluginBlocks([{ type: "content", id: "m1", content: "hello", finalized: true }]),
      ctx,
    );

    expect(started.map((event) => event.type)).toEqual(["message:start", "message:update"]);
    expect(started[0]).toMatchObject({
      type: "message:start",
      threadId: "thread-1",
      sessionId: "session-1",
      cwd: "/repo",
      blockId: "m1",
      role: "assistant",
      blockType: "content",
      content: "hel",
    });
    expect(finished.map((event) => event.type)).toEqual(["message:update", "message:end"]);
    expect(finished[0]).toMatchObject({ type: "message:update", blockId: "m1", content: "hello", delta: "lo" });
    expect(finished[1]).toMatchObject({ type: "message:end", blockId: "m1", content: "hello" });
  });

  test("emits tool start/update/end transitions", () => {
    const toolBlock: ChatBlock = {
      type: "tool",
      id: "tool-block-1",
      toolCallId: "call-1",
      toolName: "bash",
      display: "ls",
      rawInput: { command: "ls" },
      rawOutput: "done",
      status: "success",
      details: "done",
    };

    const events = pluginEventsFromBlockTransition(snapshotPluginBlocks([]), snapshotPluginBlocks([toolBlock]), ctx);

    expect(events.map((event) => event.type)).toEqual(["tool:start", "tool:update", "tool:end"]);
    expect(events[0]).toMatchObject({
      type: "tool:start",
      threadId: "thread-1",
      blockId: "tool-block-1",
      toolCallId: "call-1",
      toolName: "bash",
      status: "success",
      input: { command: "ls" },
      output: "done",
    });
  });

  test("normalizes raw ACP tool update events", () => {
    const raw = {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-2",
      title: "read_file",
      status: "completed",
      rawInput: { path: "README.md" },
      rawOutput: "ok",
    };

    const event = pluginToolUpdateEvent(raw, ctx);

    expect(event).toMatchObject({
      type: "tool:update",
      threadId: "thread-1",
      sessionId: "session-1",
      cwd: "/repo",
      blockId: "call-2",
      toolName: "read_file",
      toolCallId: "call-2",
      status: "success",
      input: { path: "README.md" },
      output: "ok",
      raw,
    });
  });

  test("snapshots store-backed blocks the same as plain blocks", () => {
    const blocks: ChatBlock[] = [
      { type: "content", id: "m1", content: "hello", finalized: true },
      { type: "tool", id: "t1", toolCallId: "t1", toolName: "bash", display: "ls", status: "running" },
    ];
    const [state] = createStore({ blocks });

    expect(snapshotPluginBlocks(state.blocks)).toEqual(snapshotPluginBlocks(blocks));
  });
});
