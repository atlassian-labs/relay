import { describe, expect, test } from "bun:test";
import { acpThreadEventFromSessionUpdate, textFromAcpThreadToolContent } from "../../src/acp/thread-events";

describe("ACP thread events", () => {
  test("maps message content into typed ACP thread content", () => {
    expect(
      acpThreadEventFromSessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      }),
    ).toEqual({
      type: "agentMessage",
      content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    });

    expect(
      acpThreadEventFromSessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "resource_link", name: "README.md", uri: "file:///tmp/project/README.md" },
      }),
    ).toEqual({
      type: "agentMessage",
      content: { type: "resourceLink", name: "README.md", uri: "file:///tmp/project/README.md" },
    });
  });

  test("maps tool content into typed text, diff, resource, and terminal items", () => {
    const event = acpThreadEventFromSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      title: "inspect",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "done" } },
        { type: "diff", path: "/tmp/project/a.ts", oldText: "before", newText: "after" },
        {
          type: "content",
          content: {
            type: "resource",
            resource: { uri: "file:///tmp/project/out.txt", text: "resource text", mimeType: "text/plain" },
          },
        },
        { type: "terminal", terminalId: "term-1" },
      ],
    });

    expect(event).toEqual({
      type: "toolCall",
      toolCallId: "tc-1",
      title: "inspect",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "done" } },
        { type: "diff", path: "/tmp/project/a.ts", oldText: "before", newText: "after" },
        {
          type: "content",
          content: {
            type: "resource",
            uri: "file:///tmp/project/out.txt",
            mimeType: "text/plain",
            text: "resource text",
          },
        },
        { type: "terminal", terminalId: "term-1" },
      ],
    });
  });

  test("provides safe terminal text fallbacks for non-text tool content", () => {
    expect(textFromAcpThreadToolContent({ type: "terminal", terminalId: "term-1" })).toBe("Terminal: term-1");
    expect(
      textFromAcpThreadToolContent({
        type: "content",
        content: { type: "resource", uri: "file:///tmp/out.txt", text: "resource text" },
      }),
    ).toBe("resource text");
    expect(
      textFromAcpThreadToolContent({
        type: "content",
        content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      }),
    ).toBe("`Image`");
  });

  test("maps non-rendered update kinds into explicit typed events", () => {
    expect(acpThreadEventFromSessionUpdate({ sessionUpdate: "plan", entries: [] })).toEqual({
      type: "plan",
      raw: { sessionUpdate: "plan", entries: [] },
    });
    expect(acpThreadEventFromSessionUpdate({ sessionUpdate: "usage_update", usage: {}, size: 10, used: 3 })).toEqual({
      type: "usage",
      usage: {},
      size: 10,
      used: 3,
    });
  });
});
