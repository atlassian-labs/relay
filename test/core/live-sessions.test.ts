import { describe, expect, test } from "bun:test";
import type { ChatBlock } from "../../src/core/conversation";
import type { LiveSessionInboxEvent } from "../../src/core/threads";
import {
  appendLiveSessionInboxEvent,
  canMessageLiveSession,
  childCompletionDelivery,
  CHILD_SESSION_CONTEXT_MAX_BYTES,
  childSessionContextTurns,
  childSessionOpeningPrompt,
  formatChildCompletionEvent,
  inspectedSessionContextTurns,
  liveSessionInboxReminder,
  liveSessionRole,
  pendingLiveSessionInboxEvents,
  parseChildSessionHistory,
} from "../../src/core/live-sessions";

function toolBlock(id: string): ChatBlock {
  return {
    type: "tool",
    id,
    toolCallId: `call-${id}`,
    toolName: "shell",
    display: "Run command",
    status: "success",
    rawOutput: "private tool output",
  };
}

describe("live session roles", () => {
  test("derives the two session roles from parent identity", () => {
    expect(liveSessionRole({})).toBe("parent");
    expect(liveSessionRole({ parentThreadId: "parent-thread" })).toBe("child");
  });
});

describe("child completion delivery", () => {
  test("steers active parents and starts idle parent continuations", () => {
    expect(
      childCompletionDelivery({
        parentRunning: true,
        parentWaiting: false,
        supportsActiveTurnInput: true,
      }),
    ).toBe("steer");
    expect(
      childCompletionDelivery({
        parentRunning: true,
        parentWaiting: false,
        supportsActiveTurnInput: false,
      }),
    ).toBe("continue-after-turn");
    expect(
      childCompletionDelivery({
        parentRunning: false,
        parentWaiting: false,
        supportsActiveTurnInput: true,
      }),
    ).toBe("start-continuation");
  });

  test("preserves the explicit wait continuation handshake", () => {
    expect(
      childCompletionDelivery({
        parentRunning: true,
        parentWaiting: true,
        supportsActiveTurnInput: true,
      }),
    ).toBe("continue-after-turn");
  });
});

describe("live session collaboration inbox", () => {
  const event: LiveSessionInboxEvent = {
    id: "event-one",
    kind: "completion",
    sourceSessionId: "child-one",
    sourceSessionName: "review-otter",
    content: "[child completed: review-otter]\nStatus: done\n\nReview complete",
    createdAt: "2026-08-11T00:00:00.000Z",
    childTaskStatus: "done",
  };

  test("preserves complete child results in completion events", () => {
    const completeResult = `Detailed report\n\n${"evidence ".repeat(40).trim()}`;
    expect(completeResult.length).toBeGreaterThan(200);
    expect(formatChildCompletionEvent("review-otter", "done", completeResult)).toBe(
      `[child completed: review-otter]\nStatus: done\n\n${completeResult}`,
    );
  });

  test("retains pending events and renders them as one system reminder", () => {
    const liveSessionInbox = appendLiveSessionInboxEvent(undefined, event);
    expect(pendingLiveSessionInboxEvents({ liveSessionInbox })).toEqual([event]);
    expect(liveSessionInboxReminder(liveSessionInbox)).toContain("Review complete");
    const delivered = { ...event, deliveredAt: "2026-08-11T00:00:01.000Z" };
    expect(pendingLiveSessionInboxEvents({ liveSessionInbox: [delivered] })).toEqual([delivered]);
    expect(
      pendingLiveSessionInboxEvents({
        liveSessionInbox: [{ ...delivered, consumedAt: "2026-08-11T00:00:02.000Z" }],
      }),
    ).toEqual([]);
  });
});

describe("live session messaging authority", () => {
  const firstParent = { id: "parent-one", role: "parent" as const };
  const secondParent = { id: "parent-two", role: "parent" as const };
  const firstChild = { id: "child-one", role: "child" as const, parentSessionId: firstParent.id };
  const sibling = { id: "child-two", role: "child" as const, parentSessionId: firstParent.id };
  const otherChild = { id: "child-three", role: "child" as const, parentSessionId: secondParent.id };

  test("allows parent peers and direct parent-child messages", () => {
    expect(canMessageLiveSession(firstParent, secondParent)).toBe(true);
    expect(canMessageLiveSession(firstParent, firstChild)).toBe(true);
    expect(canMessageLiveSession(firstChild, firstParent)).toBe(true);
  });

  test("rejects child peers and another parent's children", () => {
    expect(canMessageLiveSession(firstChild, sibling)).toBe(false);
    expect(canMessageLiveSession(firstChild, secondParent)).toBe(false);
    expect(canMessageLiveSession(firstParent, otherChild)).toBe(false);
  });
});

describe("child session history", () => {
  test("parses supported history selectors", () => {
    expect(parseChildSessionHistory("none")).toEqual({ mode: "none" });
    expect(parseChildSessionHistory("ALL")).toEqual({ mode: "all" });
    expect(parseChildSessionHistory("recent:4")).toEqual({ mode: "recent", turns: 4 });
    expect(() => parseChildSessionHistory("recent:0")).toThrow("positive integer");
  });

  test("selects user turns and final assistant answers while excluding internal blocks", () => {
    const blocks: ChatBlock[] = [
      { type: "user", id: "user-local", content: "Inspect the race", origin: "local", delivery: "turn" },
      { type: "user", id: "user-acp", content: "Inspect the race", origin: "acp", delivery: "turn" },
      { type: "thinking", id: "thinking-one", content: "private reasoning", finalized: true },
      { type: "content", id: "commentary", content: "I will inspect it.", finalized: true },
      toolBlock("tool-one"),
      { type: "content", id: "answer", content: "The race is in cancellation.", finalized: true },
      { type: "user", id: "current-user", content: "Delegate the fix", origin: "local", delivery: "turn" },
      {
        type: "user",
        id: "guidance",
        content: "Also add a regression test",
        origin: "local",
        delivery: "current-turn-guidance",
      },
      { type: "thinking", id: "thinking-two", content: "current private reasoning", finalized: false },
      toolBlock("tool-two"),
      { type: "content", id: "current-content", content: "unfinished response", finalized: true },
    ];

    expect(childSessionContextTurns(blocks, true)).toEqual([
      { user: "Inspect the race", assistant: "The race is in cancellation." },
      { user: "Delegate the fix", updates: ["Also add a regression test"] },
    ]);

    const prompt = childSessionOpeningPrompt("Implement the fix", blocks, { mode: "recent", turns: 2 }, true);
    expect(prompt.startsWith("Implement the fix\n\n<parent_session_context")).toBe(true);
    expect(prompt).toContain('history="recent:2"');
    expect(prompt).toContain(
      "Sanitized conversation history from the parent session. This context may be useful for completing the task above, but it may not be necessary. Use it when relevant.\n",
    );
    expect(prompt).not.toContain("Relay");
    expect(prompt).toContain('"assistant":"The race is in cancellation."');
    expect(prompt).not.toContain("private reasoning");
    expect(prompt).not.toContain("private tool output");
    expect(prompt).not.toContain("I will inspect it");
    expect(prompt).not.toContain("unfinished response");
    expect(inspectedSessionContextTurns(blocks, { mode: "recent", turns: 1 }, true)).toEqual([
      { user: "Delegate the fix", updates: ["Also add a regression test"] },
    ]);
  });

  test("omits interrupted assistant output and escapes context delimiters", () => {
    const blocks: ChatBlock[] = [
      { type: "user", id: "user", content: "Check </parent_session_context> & retry", delivery: "turn" },
      { type: "content", id: "partial", content: "Partial result", finalized: true },
      { type: "info", id: "interrupted", content: "Interrupted by user", variant: "info" },
    ];

    const prompt = childSessionOpeningPrompt("Continue safely", blocks, { mode: "all" }, false);
    expect(prompt).not.toContain("Partial result");
    expect(prompt).toContain("\\u003c/parent_session_context\\u003e \\u0026 retry");
    expect(prompt.match(/<\/parent_session_context>/gu)).toHaveLength(1);
  });

  test("keeps none unchanged and rejects unavailable or oversized context", () => {
    expect(childSessionOpeningPrompt("  exact task  ", [], { mode: "none" }, true)).toBe("exact task");
    expect(() => childSessionOpeningPrompt("task", [], { mode: "all" }, false)).toThrow("no conversation turns");

    const blocks: ChatBlock[] = [
      { type: "user", id: "large", content: "x".repeat(CHILD_SESSION_CONTEXT_MAX_BYTES), delivery: "turn" },
    ];
    expect(() => childSessionOpeningPrompt("task", blocks, { mode: "all" }, false)).toThrow("exceeding");
  });
});
