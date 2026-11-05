import { describe, expect, test } from "bun:test";
import { formatRelayConversationMarkdown } from "../../../src/ui/app/conversation-export";
import type { RelayConversationSnapshot } from "../../../src/plugins";

function snapshot(blocks: RelayConversationSnapshot["blocks"]): RelayConversationSnapshot {
  return {
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
    blocks,
  };
}

describe("conversation export", () => {
  test("formats markdown without thinking and groups adjacent tool calls across thinking blocks", () => {
    const markdown = formatRelayConversationMarkdown(
      snapshot([
        { type: "user", id: "u1", role: "user", content: "Please inspect this" },
        { type: "thinking", id: "th1", role: "assistant", content: "private", finalized: true },
        {
          type: "tool",
          id: "t1",
          toolCallId: "tc1",
          toolName: "read_file",
          display: "read",
          status: "success",
          input: null,
          output: null,
        },
        { type: "thinking", id: "th2", role: "assistant", content: "more private", finalized: true },
        {
          type: "tool",
          id: "t2",
          toolCallId: "tc2",
          toolName: "bash",
          display: "test",
          status: "success",
          input: null,
          output: null,
        },
        { type: "content", id: "c1", role: "assistant", content: "Done.", finalized: true },
      ]),
      { exportedAt: new Date("2026-07-07T12:00:00.000Z"), toolPreviewLimit: 1 },
    );

    expect(markdown).toContain("# Relay Conversation Export");
    expect(markdown).toContain("## User\n\nPlease inspect this");
    expect(markdown).toContain("> Tool activity: 2 calls: read_file, ... (+1 more)");
    expect(markdown).toContain("## Assistant\n\nDone.");
    expect(markdown).not.toContain("private");
  });

  test("lists up to ten files read by supported read tools, ordered by frequency", () => {
    const readTool = (id: string, toolName: "read" | "read_file" | "read_files", input: unknown) => ({
      type: "tool" as const,
      id,
      toolCallId: `call-${id}`,
      toolName,
      display: toolName,
      status: "success" as const,
      input,
      output: null,
    });
    const markdown = formatRelayConversationMarkdown(
      snapshot([
        readTool("a1", "read", { path: "frequent.ts" }),
        readTool("b1", "read_file", { path: "second.ts" }),
        readTool("a2", "read", { path: "frequent.ts" }),
        readTool("c1", "read_files", { paths: ["third.ts", "fourth.ts"] }),
        readTool("a3", "read", { path: "frequent.ts" }),
        readTool("b2", "read_file", { path: "second.ts" }),
        {
          type: "tool" as const,
          id: "ignored",
          toolCallId: "call-ignored",
          toolName: "view_file",
          display: "view",
          status: "success" as const,
          input: { path: "not-included.ts" },
          output: null,
        },
        ...Array.from({ length: 8 }, (_, index) => readTool(`extra-${index}`, "read", { path: `extra-${index}.ts` })),
      ]),
    );

    expect(markdown).toContain(
      "> Files read: frequent.ts, second.ts, third.ts, fourth.ts, extra-0.ts, extra-1.ts, extra-2.ts, extra-3.ts, extra-4.ts, extra-5.ts",
    );
    expect(markdown).not.toContain("extra-6.ts");
    expect(markdown).not.toContain("not-included.ts");
  });

  test("truncates long thread titles in metadata", () => {
    const longTitle = "x".repeat(300);
    const markdown = formatRelayConversationMarkdown(
      {
        ...snapshot([]),
        thread: { ...snapshot([]).thread, title: longTitle },
      },
      { exportedAt: new Date("2026-07-07T12:00:00.000Z") },
    );
    const threadLine = markdown.split("\n").find((line) => line.startsWith("- Thread: "));

    expect(threadLine).toBe(`- Thread: ${"x".repeat(239)}…`);
  });
});
