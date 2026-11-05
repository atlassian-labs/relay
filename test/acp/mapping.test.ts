import { describe, expect, test } from "bun:test";
import { parseSkillInvocationPrompt } from "../../src/skills";
import { applyAcpSessionUpdate, finalizeAcpPrompt } from "../../src/application/acp-mapping";
import type { ContentBlock, ThinkingBlock, ToolBlock } from "../../src/ui/state";
import { createAppStateValue } from "../../src/ui/context/app-state";
import { createMappingFixture } from "../lib/acp-mapping-fixture";
import {
  acpAgentMessageChunk,
  acpCurrentModeUpdate,
  acpPromptResponse,
  acpSessionInfoUpdate,
  acpThinkingChunk,
  acpToolCallStart,
  acpToolCallUpdate,
  acpToolDiffContent,
  acpToolMixedContent,
  acpToolTextContent,
  acpUsageUpdate,
  acpUserMessageChunk,
} from "../lib/acp-events";

describe("applyAcpSessionUpdate", () => {
  test("coalesces split restored skill user chunks into one renderable user block", () => {
    const app = createMappingFixture();
    const firstChunk = [
      '<skill name="git-publish" location="/Users/asumer/.agents/skills/git-publish/SKILL.md">',
      "References are relative to /Users/asumer/.agents/skills/git-publish.",
      "",
      "Publish current branch.",
    ].join("\n");
    const secondChunk = "\n</skill>";
    const separatorChunk = "\n\n";
    const argsChunk = "to all branches";

    applyAcpSessionUpdate(acpUserMessageChunk(firstChunk), app);
    applyAcpSessionUpdate(acpUserMessageChunk(secondChunk), app);
    applyAcpSessionUpdate(acpUserMessageChunk(separatorChunk), app);
    applyAcpSessionUpdate(acpUserMessageChunk(argsChunk), app);
    applyAcpSessionUpdate(acpAgentMessageChunk("ack"), app);

    expect(app.state.blocks).toHaveLength(2);
    expect(app.state.blocks[0]).toMatchObject({
      type: "user",
      content: `${firstChunk}${secondChunk}${separatorChunk}${argsChunk}`,
    });
    expect(parseSkillInvocationPrompt((app.state.blocks[0] as { content: string }).content)).toMatchObject({
      name: "git-publish",
      userMessage: "to all branches",
    });
    expect(app.state.blocks[1]).toMatchObject({ type: "content", content: "ack" });
  });

  test("ACP skill echo replaces a duplicate local slash skill prompt", () => {
    const app = createMappingFixture();
    app.addBlock({
      type: "user",
      id: "local-user",
      content: "/review and do it good",
      origin: "local",
      skillInvocation: { name: "review", userMessage: "and do it good" },
    });

    applyAcpSessionUpdate(
      acpUserMessageChunk(
        [
          "---",
          "name: review",
          "description: Review changes",
          "register_cmd: true",
          "---",
          "",
          "Review the code directly.",
          "",
          "ARGUMENTS: and do it good",
        ].join("\n"),
      ),
      app,
    );

    expect(app.state.blocks).toHaveLength(1);
    expect(app.state.blocks[0]).toMatchObject({ type: "user", origin: "acp" });
    expect(parseSkillInvocationPrompt((app.state.blocks[0] as { content: string }).content)).toMatchObject({
      name: "review",
      userMessage: "and do it good",
    });
  });

  test("ACP skill echo replaces a matching legacy raw slash prompt", () => {
    const app = createMappingFixture();
    app.addBlock({ type: "user", id: "local-user", content: "/review first line\nsecond line", origin: "local" });

    applyAcpSessionUpdate(
      acpUserMessageChunk(
        [
          "---",
          "name: review",
          "description: Review changes",
          "register_cmd: true",
          "---",
          "",
          "Review the code directly.",
          "",
          "ARGUMENTS: first line\nsecond line",
        ].join("\n"),
      ),
      app,
    );

    expect(app.state.blocks).toHaveLength(1);
    expect(app.state.blocks[0]).toMatchObject({ type: "user", origin: "acp" });
  });

  test("ACP skill echo keeps a previous slash prompt when arguments differ", () => {
    const app = createMappingFixture();
    app.addBlock({
      type: "user",
      id: "local-user",
      content: "/review different args",
      origin: "local",
      skillInvocation: { name: "review", userMessage: "different args" },
    });

    applyAcpSessionUpdate(
      acpUserMessageChunk(
        [
          "---",
          "name: review",
          "description: Review changes",
          "register_cmd: true",
          "---",
          "",
          "Review the code directly.",
          "",
          "ARGUMENTS: actual args",
        ].join("\n"),
      ),
      app,
    );

    expect(app.state.blocks).toHaveLength(2);
    expect(app.state.blocks[0]).toMatchObject({ type: "user", origin: "local" });
    expect(app.state.blocks[1]).toMatchObject({ type: "user", origin: "acp" });
  });

  test("finalizeAcpPrompt preserves a split restored user message when no assistant chunk follows", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(acpUserMessageChunk("first "), app);
    applyAcpSessionUpdate(acpUserMessageChunk("second"), app);
    finalizeAcpPrompt(app, acpPromptResponse());

    expect(app.state.blocks).toEqual([
      {
        type: "user",
        id: expect.any(String),
        content: "first second",
        origin: "acp",
        contentItems: [
          { type: "text", text: "first " },
          { type: "text", text: "second" },
        ],
      },
    ]);
    expect(app.state.currentBlockId).toBeNull();
  });

  test("tool calls finalize restored user chunk coalescing before adding tool output", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(acpUserMessageChunk("run "), app);
    applyAcpSessionUpdate(acpUserMessageChunk("tool"), app);
    applyAcpSessionUpdate(
      acpToolCallStart({ toolCallId: "call-1", toolName: "bash", rawInput: { command: "echo ok" } }),
      app,
    );

    expect(app.state.blocks).toHaveLength(2);
    expect(app.state.blocks[0]).toMatchObject({ type: "user", content: "run tool" });
    expect(app.state.blocks[1]).toMatchObject({ type: "tool", toolCallId: "call-1" });
    expect(app.state.currentBlockId).toBeNull();
  });

  test("streams assistant text into one content block", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(acpAgentMessageChunk("Hello, "), app);
    applyAcpSessionUpdate(acpAgentMessageChunk("world!"), app);

    expect(app.state.blocks).toHaveLength(1);
    expect(app.state.blocks[0]).toMatchObject({ type: "content", content: "Hello, world!", finalized: false });
    expect(app.state.blocks[0]?.type === "content" ? [...(app.state.blocks[0].contentItems ?? [])] : []).toEqual([
      { type: "text", text: "Hello, world!" },
    ]);
  });

  test("increments activity sequence for repeated streaming updates", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(acpAgentMessageChunk("tick"), app);
    expect(app.state.lastAcpActivityKind).toBe("streaming");
    expect(app.state.lastAcpActivitySequence).toBe(1);

    applyAcpSessionUpdate(acpAgentMessageChunk("tick"), app);
    expect(app.state.lastAcpActivityKind).toBe("streaming");
    expect(app.state.lastAcpActivitySequence).toBe(2);
  });

  test("does not bump activity sequence for streaming updates while a turn is already active", () => {
    const app = createMappingFixture();
    app.setState("running", true);
    app.setState("spinnerActive", true);

    applyAcpSessionUpdate(acpAgentMessageChunk("tick"), app);
    applyAcpSessionUpdate(acpAgentMessageChunk("tick"), app);

    expect(app.state.lastAcpActivityKind).toBe("streaming");
    expect(app.state.lastAcpActivitySequence).toBe(0);
  });

  test("finalizeAcpPrompt finalizes the current content block and clears running state", () => {
    const app = createMappingFixture();
    app.setState("running", true);
    app.setState("spinnerActive", true);

    applyAcpSessionUpdate(acpAgentMessageChunk("done"), app);
    finalizeAcpPrompt(app, acpPromptResponse({ inputTokens: 3, outputTokens: 5 }));

    expect(app.state.blocks[0]).toMatchObject({ type: "content", finalized: true });
    expect(app.state.currentBlockId).toBeNull();
    expect(app.state.running).toBe(false);
    expect(app.state.spinnerActive).toBe(false);
    expect(app.state.lastAcpActivityKind).toBeNull();
    expect(app.state.lastAcpActivityLabel).toBe("");
    expect(app.state.lastAcpActivityAt).toBeNull();
    expect(app.state.totalUsage).toMatchObject({ input_tokens: 3, output_tokens: 5 });
  });

  test("final prompt response usage does not overwrite latest context window used value", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(acpUsageUpdate({ size: 922_000, used: 155_767 }), app);
    finalizeAcpPrompt(app, acpPromptResponse({ inputTokens: 369_735, outputTokens: 1_336, cachedReadTokens: 290_816 }));

    expect(app.state.contextWindow).toBe(922_000);
    expect(app.state.contextTokens).toBe(155_767);
    expect(app.state.totalUsage).toEqual({
      input_tokens: 369_735,
      output_tokens: 1_336,
      cache_read_tokens: 290_816,
      cache_write_tokens: 0,
    });
  });

  test("final prompt response accepts Alta _meta usage aliases", () => {
    const app = createMappingFixture();

    finalizeAcpPrompt(app, {
      stopReason: "end_turn",
      _meta: {
        contextWindowTokens: 200_000,
        usage: {
          inputTokens: 369_735,
          outputTokens: 1_336,
          totalTokens: 371_071,
          cachedInputTokens: 290_816,
          cacheCreationInputTokens: 64,
          reasoningTokens: 128,
        },
      },
    });

    expect(app.state.contextWindow).toBe(200_000);
    expect(app.state.totalUsage).toEqual({
      input_tokens: 369_735,
      output_tokens: 1_336,
      cache_read_tokens: 290_816,
      cache_write_tokens: 64,
    });
    expect(app.state.lastUsage).toEqual({
      input_tokens: 369_735,
      output_tokens: 1_336,
      cache_read_tokens: 290_816,
      cache_write_tokens: 64,
    });
  });

  test("thinking block finalizes when content starts", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(acpThinkingChunk("I should inspect."), app);
    expect(app.state.lastAcpActivityKind).toBe("reasoning");
    applyAcpSessionUpdate(acpAgentMessageChunk("Answer."), app);

    expect(app.state.blocks).toHaveLength(2);
    expect(app.state.blocks[0]).toMatchObject({ type: "thinking", content: "I should inspect.", finalized: true });
    expect(app.state.blocks[1]).toMatchObject({ type: "content", content: "Answer.", finalized: false });
    expect(app.state.lastAcpActivityKind).toBe("streaming");
  });

  test("content block finalizes when thinking starts", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(acpAgentMessageChunk("Visible"), app);
    applyAcpSessionUpdate(acpThinkingChunk("Hidden"), app);

    expect(app.state.blocks).toHaveLength(2);
    expect(app.state.blocks[0]).toMatchObject({ type: "content", content: "Visible", finalized: true });
    expect(app.state.blocks[1]).toMatchObject({ type: "thinking", content: "Hidden", finalized: false });
  });

  test("renders standard ACP resource and image message chunks as safe text", () => {
    const resourceApp = createMappingFixture();
    applyAcpSessionUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "resource_link", name: "README.md", uri: "file:///tmp/project/README.md" },
      },
      resourceApp,
    );
    expect(resourceApp.state.blocks[0]).toEqual({
      type: "content",
      id: expect.any(String),
      content: "file:///tmp/project/README.md",
      finalized: false,
      contentItems: [
        {
          type: "resourceLink",
          name: "README.md",
          uri: "file:///tmp/project/README.md",
        },
      ],
    });

    const imageApp = createMappingFixture();
    applyAcpSessionUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      },
      imageApp,
    );
    expect(imageApp.state.blocks[0]).toEqual({
      type: "content",
      id: expect.any(String),
      content: "`Image`",
      finalized: false,
      contentItems: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
    });
  });

  test("standard mapping ignores malformed message content shapes", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate({ sessionUpdate: "user_message_chunk", content: "malformed user" }, app);
    applyAcpSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "bare answer" } }, app);
    applyAcpSessionUpdate(
      { sessionUpdate: "agent_message_chunk", content: { type: "thinking", thinking: "malformed thought" } },
      app,
    );
    applyAcpSessionUpdate(
      { sessionUpdate: "agent_message_chunk", content: [{ type: "content", content: { text: "nested answer" } }] },
      app,
    );

    expect(app.state.blocks).toHaveLength(0);

    applyAcpSessionUpdate(acpAgentMessageChunk("standard answer"), app);

    expect(app.state.blocks).toEqual([
      {
        type: "content",
        id: expect.any(String),
        content: "standard answer",
        finalized: false,
        contentItems: [{ type: "text", text: "standard answer" }],
      },
    ]);
  });

  test("tool call status updates mutate one block in place", () => {
    const app = createMappingFixture("/tmp/project");

    applyAcpSessionUpdate(
      acpToolCallStart({
        toolCallId: "tc_1",
        toolName: "Read",
        rawInput: { file_path: "/tmp/project/src/index.ts" },
        status: "pending",
      }),
      app,
    );
    const blockId = app.state.blocks[0].id;

    applyAcpSessionUpdate(acpToolCallUpdate({ toolCallId: "tc_1", status: "running" }), app);
    applyAcpSessionUpdate(acpToolCallUpdate({ toolCallId: "tc_1", status: "success", rawOutput: "hello" }), app);

    expect(app.state.blocks).toHaveLength(1);
    expect(app.state.blocks[0]).toMatchObject({
      id: blockId,
      type: "tool",
      toolCallId: "tc_1",
      status: "success",
      display: "file_path: src/index.ts",
      details: "hello",
    });
    expect(app.state.toolCallCount).toBe(1);
    expect(app.state.lastAcpActivityKind).toBe("tool");
    expect(app.state.lastAcpActivityLabel).toBe("Read");
  });

  test("command-title tool calls are normalized to bash with inferred command input", () => {
    const app = createMappingFixture("/tmp/project");
    const command = "git status --short && git diff --stat";

    applyAcpSessionUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc_shell_title",
        title: command,
        status: "in_progress",
      },
      app,
    );
    applyAcpSessionUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc_shell_title",
        title: command,
        status: "completed",
        rawOutput: " M src/index.ts",
      },
      app,
    );

    expect(app.state.blocks[0]).toMatchObject({
      type: "tool",
      toolName: "bash",
      rawInput: { command },
      display: `command: ${command}`,
      status: "success",
      details: " M src/index.ts",
    });
  });

  test("routes concurrent Alta subagent child updates to their invoking tool calls", () => {
    const app = createMappingFixture("/tmp/project");

    applyAcpSessionUpdate(
      acpToolCallStart({
        toolCallId: "invoke-scout",
        toolName: "invoke_agent",
        rawInput: { agent: "scout", message: "map the rendering seam", background: false },
        status: "running",
      }),
      app,
    );
    applyAcpSessionUpdate(
      acpToolCallStart({
        toolCallId: "invoke-reviewer",
        toolName: "invoke_agent",
        rawInput: { agent: "reviewer", message: "review the implementation", background: true },
        status: "running",
      }),
      app,
    );

    applyAcpSessionUpdate(acpAgentMessageChunk("scout progress"), app, {
      metadata: { "alta/subagent": { invokingToolCallId: "invoke-scout", childSessionId: "child-scout" } },
    });
    applyAcpSessionUpdate(acpThinkingChunk("reviewer thinking"), app, {
      metadata: { "alta/subagent": { invokingToolCallId: "invoke-reviewer", childSessionId: "child-reviewer" } },
    });
    applyAcpSessionUpdate(
      acpToolCallStart({
        toolCallId: "reviewer-read",
        toolName: "view_file",
        rawInput: { file_path: "src/ui/app/subagents.ts" },
        status: "running",
      }),
      app,
      {
        metadata: { "alta/subagent": { invokingToolCallId: "invoke-reviewer", childSessionId: "child-reviewer" } },
      },
    );
    applyAcpSessionUpdate(acpToolCallUpdate({ toolCallId: "reviewer-read", status: "success" }), app, {
      metadata: { "alta/subagent": { invokingToolCallId: "invoke-reviewer", childSessionId: "child-reviewer" } },
    });
    applyAcpSessionUpdate(acpAgentMessageChunk(" more"), app, {
      metadata: { "alta/subagent": { invokingToolCallId: "invoke-scout", status: "completed" } },
    });

    expect(app.state.blocks).toHaveLength(2);
    const scoutBlock = app.state.blocks[0] as ToolBlock;
    const reviewerBlock = app.state.blocks[1] as ToolBlock;
    expect(scoutBlock.type).toBe("tool");
    expect(scoutBlock.toolCallId).toBe("invoke-scout");
    expect(scoutBlock.subagent?.invokingToolCallId).toBe("invoke-scout");
    expect(scoutBlock.subagent?.childSessionId).toBe("child-scout");
    expect(scoutBlock.subagent?.status).toBe("success");
    expect(scoutBlock.subagent?.progress).toEqual([{ kind: "message", text: "scout progress more" }]);
    expect(scoutBlock.subagent?.blocks).toHaveLength(2);
    expect(scoutBlock.subagent?.blocks?.[0]).toMatchObject({ type: "user", content: "map the rendering seam" });
    expect(scoutBlock.subagent?.blocks?.[1]).toMatchObject({
      type: "content",
      content: "scout progress more",
      finalized: true,
    });
    const scoutAnswer = scoutBlock.subagent?.blocks?.[1];
    expect(scoutAnswer?.type === "content" ? [...(scoutAnswer.contentItems ?? [])] : []).toEqual([
      { type: "text", text: "scout progress more" },
    ]);
    expect(scoutBlock.subagent?.currentBlockId).toBeNull();
    expect(reviewerBlock.type).toBe("tool");
    expect(reviewerBlock.toolCallId).toBe("invoke-reviewer");
    expect(reviewerBlock.subagent?.invokingToolCallId).toBe("invoke-reviewer");
    expect(reviewerBlock.subagent?.childSessionId).toBe("child-reviewer");
    expect(reviewerBlock.subagent?.status).toBe("running");
    expect(reviewerBlock.subagent?.progress).toEqual([
      { kind: "thinking", text: "reviewer thinking" },
      { kind: "tool", text: "view_file", status: "success", toolCallId: "reviewer-read" },
    ]);
    expect(reviewerBlock.subagent?.blocks).toHaveLength(3);
    expect(reviewerBlock.subagent?.blocks?.[0]).toMatchObject({ type: "user", content: "review the implementation" });
    expect(reviewerBlock.subagent?.blocks?.[1]).toMatchObject({ type: "thinking", content: "reviewer thinking" });
    expect(reviewerBlock.subagent?.blocks?.[2]).toMatchObject({
      type: "tool",
      toolName: "view_file",
      status: "success",
    });
  });

  test("replays background subagent updates after the invoking tool publishes its child session", () => {
    const app = createMappingFixture("/tmp/project");

    applyAcpSessionUpdate(
      acpToolCallStart({
        toolCallId: "invoke-background",
        toolName: "invoke_agent",
        rawInput: { agent: "scout", message: "inspect the race", background: true },
        status: "running",
      }),
      app,
    );
    applyAcpSessionUpdate(acpAgentMessageChunk("early output"), app, {
      metadata: {
        "alta/subagent": { childSessionId: "subagent-background", childAlias: "scout", background: true },
      },
    });
    applyAcpSessionUpdate(acpThinkingChunk("final thought"), app, {
      metadata: {
        "alta/subagent": {
          childSessionId: "subagent-background",
          childAlias: "scout",
          background: true,
          terminal: true,
          terminalStatus: "completed",
        },
      },
    });

    expect((app.state.blocks[0] as ToolBlock).subagent).toBeUndefined();

    applyAcpSessionUpdate(
      acpToolCallUpdate({
        toolCallId: "invoke-background",
        status: "success",
        rawOutput: { sessionId: "subagent-background" },
      }),
      app,
    );

    const block = app.state.blocks[0] as ToolBlock;
    expect(block.subagent?.childSessionId).toBe("subagent-background");
    expect(block.subagent?.status).toBe("success");
    expect(block.subagent?.currentBlockId).toBeNull();
    expect(block.subagent?.blocks).toHaveLength(3);
    expect(block.subagent?.blocks?.[1]).toMatchObject({ type: "content", content: "early output", finalized: true });
    expect(block.subagent?.blocks?.[2]).toMatchObject({ type: "thinking", content: "final thought", finalized: true });
  });

  test("swallows malformed and orphaned Alta subagent metadata without top-level output", () => {
    const app = createMappingFixture("/tmp/project");

    applyAcpSessionUpdate(
      acpToolCallStart({ toolCallId: "invoke-scout", toolName: "invoke_agent", rawInput: { agent: "scout" } }),
      app,
    );
    applyAcpSessionUpdate(acpAgentMessageChunk("must not leak"), app, {
      metadata: { "alta/subagent": { invokingToolCallId: 42, childSessionId: "bad" } },
    });
    applyAcpSessionUpdate(acpAgentMessageChunk("orphan child"), app, {
      metadata: { "alta/subagent": { invokingToolCallId: "missing-parent", childSessionId: "orphan" } },
    });
    applyAcpSessionUpdate(acpAgentMessageChunk("still normal"), app);

    expect(app.state.blocks).toHaveLength(2);
    expect(app.state.blocks[0]).toMatchObject({ type: "tool", toolCallId: "invoke-scout" });
    expect((app.state.blocks[0] as ToolBlock).subagent).toBeUndefined();
    expect(app.state.blocks[1]).toMatchObject({ type: "content", content: "still normal" });
  });

  test("records Alta subagent cancellation metadata on the invoking tool call", () => {
    const app = createMappingFixture("/tmp/project");

    applyAcpSessionUpdate(acpToolCallStart({ toolCallId: "invoke-reviewer", toolName: "invoke_agent" }), app);
    applyAcpSessionUpdate(acpAgentMessageChunk("stopping"), app, {
      metadata: { "alta/subagent": { invokingToolCallId: "invoke-reviewer", status: "cancelled" } },
    });
    applyAcpSessionUpdate(acpToolCallUpdate({ toolCallId: "invoke-reviewer", status: "success" }), app);

    expect(app.state.blocks).toHaveLength(1);
    const block = app.state.blocks[0] as ToolBlock;
    expect(block.type).toBe("tool");
    expect(block.toolCallId).toBe("invoke-reviewer");
    expect(block.subagent?.invokingToolCallId).toBe("invoke-reviewer");
    expect(block.subagent?.status).toBe("cancelled");
    expect(block.subagent?.progress).toEqual([{ kind: "message", text: "stopping" }]);
    expect(block.subagent?.blocks?.[0]).toMatchObject({ type: "content", content: "stopping", finalized: true });
    expect(block.subagent?.currentBlockId).toBeNull();
  });

  test("restores completed one-shot tool calls with output content", () => {
    const app = createMappingFixture("/tmp/project");

    applyAcpSessionUpdate(
      acpToolCallStart({
        toolCallId: "tc_snapshot",
        toolName: "Read",
        rawInput: { file_path: "/tmp/project/src/index.ts" },
        status: "success",
      }),
      app,
    );
    applyAcpSessionUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc_final",
        title: "Edit",
        status: "completed",
        content: acpToolMixedContent([
          "updated",
          { path: "/tmp/project/src/a.ts", oldText: "before", newText: "after" },
        ]),
      },
      app,
    );

    expect(app.state.blocks[0]).toMatchObject({ type: "tool", status: "success", display: "file_path: src/index.ts" });
    expect(app.state.blocks[1]).toMatchObject({
      type: "tool",
      toolName: "Edit",
      status: "success",
      details: "updated",
    });
    expect((app.state.blocks[1] as ToolBlock).diff).toEqual({
      path: "/tmp/project/src/a.ts",
      oldText: "before",
      newText: "after",
    });
    expect(app.state.toolCallCount).toBe(2);
  });

  test("restores tool call updates without a prior tool_call start", () => {
    const app = createMappingFixture("/tmp/project");

    applyAcpSessionUpdate(
      acpToolCallUpdate({
        toolCallId: "tc_update_only",
        toolName: "Search",
        status: "success",
        rawInput: { query: "restore" },
        content: acpToolTextContent("found restore bug"),
      }),
      app,
    );

    expect(app.state.blocks).toHaveLength(1);
    expect(app.state.blocks[0]).toMatchObject({
      type: "tool",
      toolCallId: "tc_update_only",
      toolName: "Search",
      status: "success",
      display: "query: restore",
      details: "found restore bug",
    });
    expect(app.state.toolCallCount).toBe(1);
  });

  test("tool call update extracts normalized ACP diff content", () => {
    const app = createMappingFixture("/tmp/project");

    applyAcpSessionUpdate(acpToolCallStart({ toolCallId: "tc_diff", toolName: "patch" }), app);
    applyAcpSessionUpdate(
      acpToolCallUpdate({
        toolCallId: "tc_diff",
        status: "success",
        content: acpToolDiffContent({
          path: "/tmp/project/src/config.json",
          oldText: '{\n  "debug": false\n}',
          newText: '{\n  "debug": true\n}',
        }),
      }),
      app,
    );

    expect(app.state.blocks[0] as ToolBlock).toMatchObject({
      type: "tool",
      diff: {
        path: "/tmp/project/src/config.json",
        oldText: '{\n  "debug": false\n}',
        newText: '{\n  "debug": true\n}',
      },
    });
  });

  test("tool call update handles normalized ACP diff content for new files", () => {
    const app = createMappingFixture("/tmp/project");

    applyAcpSessionUpdate(acpToolCallStart({ toolCallId: "tc_new_diff", toolName: "create_or_patch" }), app);
    applyAcpSessionUpdate(
      acpToolCallUpdate({
        toolCallId: "tc_new_diff",
        status: "success",
        content: acpToolDiffContent({
          path: "/tmp/project/src/new.json",
          oldText: null,
          newText: '{\n  "created": true\n}',
        }),
      }),
      app,
    );

    expect((app.state.blocks[0] as ToolBlock).diff).toEqual({
      path: "/tmp/project/src/new.json",
      oldText: "",
      newText: '{\n  "created": true\n}',
    });
  });

  test("tool call update keeps existing diff when later updates omit content", () => {
    const app = createMappingFixture("/tmp/project");

    applyAcpSessionUpdate(acpToolCallStart({ toolCallId: "tc_sticky_diff", toolName: "patch" }), app);
    applyAcpSessionUpdate(
      acpToolCallUpdate({
        toolCallId: "tc_sticky_diff",
        status: "running",
        content: acpToolDiffContent({ path: "/tmp/project/src/a.ts", oldText: "before", newText: "after" }),
      }),
      app,
    );
    applyAcpSessionUpdate(
      acpToolCallUpdate({ toolCallId: "tc_sticky_diff", status: "success", rawOutput: "done" }),
      app,
    );

    expect((app.state.blocks[0] as ToolBlock).diff).toEqual({
      path: "/tmp/project/src/a.ts",
      oldText: "before",
      newText: "after",
    });
    expect(app.state.blocks[0]).toMatchObject({ status: "success", details: "done" });
  });

  test("tool call update preserves ordered mixed normalized ACP content", () => {
    const app = createMappingFixture("/tmp/project");

    applyAcpSessionUpdate(acpToolCallStart({ toolCallId: "tc_mixed_diff", toolName: "edit_many" }), app);
    applyAcpSessionUpdate(
      acpToolCallUpdate({
        toolCallId: "tc_mixed_diff",
        status: "success",
        content: acpToolMixedContent([
          "updated files",
          { path: "/tmp/project/src/a.ts", oldText: "one", newText: "ONE" },
          { path: "/tmp/project/src/b.ts", oldText: "two", newText: "TWO" },
        ]),
      }),
      app,
    );

    const block = app.state.blocks[0] as ToolBlock;
    expect(block.type).toBe("tool");
    expect(block.details).toBe("updated files");
    expect(block.diff).toEqual({ path: "/tmp/project/src/a.ts", oldText: "one", newText: "ONE" });
    expect(block.content).toEqual([
      { type: "text", text: "updated files" },
      { type: "diff", diff: { path: "/tmp/project/src/a.ts", oldText: "one", newText: "ONE" } },
      { type: "diff", diff: { path: "/tmp/project/src/b.ts", oldText: "two", newText: "TWO" } },
    ]);
  });

  test("tool call update extracts standard ACP embedded resource and terminal content", () => {
    const app = createMappingFixture("/tmp/project");

    applyAcpSessionUpdate(acpToolCallStart({ toolCallId: "tc_resource_content", toolName: "exec" }), app);
    applyAcpSessionUpdate(
      acpToolCallUpdate({
        toolCallId: "tc_resource_content",
        status: "success",
        content: [
          {
            type: "content",
            content: {
              type: "resource",
              resource: { uri: "file:///tmp/project/out.txt", text: "hello from resource", mimeType: "text/plain" },
            },
          },
          { type: "terminal", terminalId: "term-1" },
        ],
      }),
      app,
    );

    const block = app.state.blocks[0] as ToolBlock;
    expect(block.details).toBe("hello from resource\nTerminal: term-1");
    expect(block.content).toEqual([
      {
        type: "resource",
        uri: "file:///tmp/project/out.txt",
        text: "hello from resource",
        mimeType: "text/plain",
      },
      { type: "terminal", terminalId: "term-1" },
    ]);
  });

  test("tool call update preserves image and resource link ACP content with safe fallbacks", () => {
    const app = createMappingFixture("/tmp/project");

    applyAcpSessionUpdate(acpToolCallStart({ toolCallId: "tc_rich_content", toolName: "inspect" }), app);
    applyAcpSessionUpdate(
      acpToolCallUpdate({
        toolCallId: "tc_rich_content",
        status: "success",
        content: [
          { type: "content", content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" } },
          {
            type: "content",
            content: { type: "resource_link", name: "trace.json", uri: "file:///tmp/project/trace.json" },
          },
        ],
      }),
      app,
    );

    const block = app.state.blocks[0] as ToolBlock;
    expect(block.details).toBe("`Image`\nfile:///tmp/project/trace.json");
    expect(block.content).toEqual([
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      { type: "resourceLink", name: "trace.json", uri: "file:///tmp/project/trace.json" },
    ]);
  });

  test("standard mapping ignores malformed tool content fallback shapes", () => {
    const app = createMappingFixture("/tmp/project");

    applyAcpSessionUpdate(acpToolCallStart({ toolCallId: "tc_standard_only", toolName: "malformed_tool" }), app);
    applyAcpSessionUpdate(
      acpToolCallUpdate({
        toolCallId: "tc_standard_only",
        status: "success",
        content: [
          { text: "malformed output" },
          { type: "text", text: 8 },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        ],
      }),
      app,
    );

    const malformedBlock = app.state.blocks[0] as ToolBlock;
    expect(malformedBlock.details).toBeUndefined();
    expect(malformedBlock.content).toBeUndefined();
    expect(malformedBlock.diff).toBeUndefined();

    applyAcpSessionUpdate(
      acpToolCallUpdate({
        toolCallId: "tc_standard_only",
        status: "success",
        content: acpToolTextContent("standard output"),
      }),
      app,
    );

    const standardBlock = app.state.blocks[0] as ToolBlock;
    expect(standardBlock.details).toBe("standard output");
    expect(standardBlock.content).toEqual([{ type: "text", text: "standard output" }]);
  });

  test("tool call result content replaces an earlier streaming diff when omitted", () => {
    const app = createMappingFixture("/tmp/project");

    applyAcpSessionUpdate(acpToolCallStart({ toolCallId: "tc_replaced_diff", toolName: "maybe_edit" }), app);
    applyAcpSessionUpdate(
      acpToolCallUpdate({
        toolCallId: "tc_replaced_diff",
        status: "running",
        content: acpToolDiffContent({ path: "/tmp/project/src/a.ts", oldText: "before", newText: "after" }),
      }),
      app,
    );
    applyAcpSessionUpdate(
      acpToolCallUpdate({
        toolCallId: "tc_replaced_diff",
        status: "success",
        content: acpToolTextContent("no file changes"),
      }),
      app,
    );

    const block = app.state.blocks[0] as ToolBlock;
    expect(block.details).toBe("no file changes");
    expect(block.content).toEqual([{ type: "text", text: "no file changes" }]);
    expect(block.diff).toBeUndefined();
  });

  test("tool call update ignores malformed ACP diff content", () => {
    const app = createMappingFixture("/tmp/project");

    applyAcpSessionUpdate(acpToolCallStart({ toolCallId: "tc_bad_diff", toolName: "patch" }), app);
    applyAcpSessionUpdate(
      acpToolCallUpdate({
        toolCallId: "tc_bad_diff",
        status: "success",
        content: [{ type: "diff", path: "/tmp/project/src/config.json", oldText: false, newText: "after" }],
      }),
      app,
    );

    expect((app.state.blocks[0] as ToolBlock).diff).toBeUndefined();
  });

  test("tool call error preserves partial output", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(
      acpToolCallStart({ toolCallId: "tc_2", toolName: "Bash", rawInput: { command: "exit 1" } }),
      app,
    );
    applyAcpSessionUpdate(acpToolCallUpdate({ toolCallId: "tc_2", status: "error", rawOutput: "partial stderr" }), app);

    expect(app.state.blocks[0]).toMatchObject({ type: "tool", status: "error", details: "partial stderr" });
    expect((app.state.blocks[0] as ToolBlock).rawOutput).toBe("partial stderr");
  });

  test("result content is used when rawOutput is absent", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(acpToolCallStart({ toolCallId: "tc_3", toolName: "Search" }), app);
    applyAcpSessionUpdate(
      acpToolCallUpdate({
        toolCallId: "tc_3",
        status: "success",
        content: acpToolTextContent("found one result"),
      }),
      app,
    );

    expect(app.state.blocks[0]).toMatchObject({ type: "tool", details: "found one result" });
  });

  test("result content is preferred over rawOutput", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(acpToolCallStart({ toolCallId: "tc_content_first", toolName: "find" }), app);
    applyAcpSessionUpdate(
      acpToolCallUpdate({
        toolCallId: "tc_content_first",
        status: "success",
        rawOutput: { totalFiles: 144, truncated: false },
        content: acpToolTextContent("src/index.ts"),
      }),
      app,
    );

    expect(app.state.blocks[0]).toMatchObject({ type: "tool", details: "src/index.ts" });
  });

  test("args content on running updates does not leak into details", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(acpToolCallStart({ toolCallId: "tc_4", toolName: "Write" }), app);
    applyAcpSessionUpdate(
      acpToolCallUpdate({
        toolCallId: "tc_4",
        status: "running",
        rawInput: { file_path: "a.txt" },
        content: acpToolTextContent("file_path: a.txt"),
      }),
      app,
    );

    expect((app.state.blocks[0] as ToolBlock).display).toBe("file_path: a.txt");
    expect((app.state.blocks[0] as ToolBlock).details).toBeUndefined();
  });

  test("new tool call finalizes an active content stream", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(acpAgentMessageChunk("before tool"), app);
    applyAcpSessionUpdate(acpToolCallStart({ toolCallId: "tc_5", toolName: "Read" }), app);

    expect(app.state.blocks[0]).toMatchObject({ type: "content", finalized: true });
    expect(app.state.blocks[1]).toMatchObject({ type: "tool", toolCallId: "tc_5" });
    expect(app.state.currentBlockId).toBeNull();
  });

  test("user_message_chunk adds a user block", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(acpUserMessageChunk("hello"), app);

    expect(app.state.blocks).toHaveLength(1);
    expect(app.state.blocks[0]).toMatchObject({ type: "user", content: "hello" });
  });

  test("blank user_message_chunk is ignored", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(acpUserMessageChunk("   "), app);

    expect(app.state.blocks).toHaveLength(0);
  });

  test("system reminder user_message_chunk is stored on the current user block", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(acpUserMessageChunk("continue till the goal is complete"), app);
    applyAcpSessionUpdate(acpUserMessageChunk("system-reminder: keep responses concise"), app);

    expect(app.state.blocks).toHaveLength(1);
    expect(app.state.blocks[0]).toMatchObject({ type: "user", content: "continue till the goal is complete" });
    expect(app.state.blocks[0]?.type === "user" ? app.state.blocks[0].contentItems : null).toEqual([
      { type: "text", text: "continue till the goal is complete" },
      { type: "text", text: "system-reminder: keep responses concise" },
    ]);
  });

  test("usage updates merge aggregate input, output, and cache usage", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(
      acpUsageUpdate({ inputTokens: 10, outputTokens: 4, cachedReadTokens: 2, cachedWriteTokens: 1 }),
      app,
    );
    applyAcpSessionUpdate(acpUsageUpdate({ inputTokens: 1, outputTokens: 2 }), app);

    expect(app.state.totalUsage).toEqual({
      input_tokens: 11,
      output_tokens: 6,
      cache_read_tokens: 2,
      cache_write_tokens: 1,
    });
    expect(app.state.contextTokens).toBeNull();
  });

  test("usage updates apply context-only size and used fields", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate({ sessionUpdate: "usage_update", size: 100, used: 16 }, app);

    expect(app.state.totalUsage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    expect(app.state.lastUsage).toBeNull();
    expect(app.state.contextWindow).toBe(100);
    expect(app.state.contextTokens).toBe(16);
  });

  test("current mode and session info updates mutate status state", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(acpCurrentModeUpdate("review"), app);
    applyAcpSessionUpdate(acpSessionInfoUpdate("Investigating bug"), app);

    expect(app.state.modeId).toBe("review");
    expect(app.state.statusText).toBe("Investigating bug");
  });

  test("unknown and malformed updates are ignored", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(null, app);
    applyAcpSessionUpdate({ sessionUpdate: "not_real", content: { text: "x" } }, app);

    expect(app.state.blocks).toHaveLength(0);
  });

  test("config_option_update is ignored by the ACP mapping layer", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(
      { sessionUpdate: "config_option_update", optionId: "relay.notifications.sound_enabled", value: false },
      app,
    );

    expect(app.state.blocks).toHaveLength(0);
  });

  test("interleaved thinking chunks append to the active thinking block", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(acpThinkingChunk("one "), app);
    applyAcpSessionUpdate(acpThinkingChunk("two"), app);

    expect(app.state.blocks).toHaveLength(1);
    expect(app.state.blocks[0] as ThinkingBlock).toMatchObject({ type: "thinking", content: "one two" });
  });

  test("streaming can continue in a new content block after a finalized content block", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(acpAgentMessageChunk("first"), app);
    finalizeAcpPrompt(app, {});
    applyAcpSessionUpdate(acpAgentMessageChunk("second"), app);

    expect(app.state.blocks).toHaveLength(2);
    expect(app.state.blocks[0] as ContentBlock).toMatchObject({ content: "first", finalized: true });
    expect(app.state.blocks[1] as ContentBlock).toMatchObject({ content: "second", finalized: false });
  });

  test("user_message_chunk finalizes active content block so history replays in order", () => {
    const app = createMappingFixture();

    // Simulate history replay: agent content, then user message, then more agent content
    applyAcpSessionUpdate(acpAgentMessageChunk("answer to first question"), app);
    applyAcpSessionUpdate(acpUserMessageChunk("follow-up question"), app);
    applyAcpSessionUpdate(acpAgentMessageChunk("answer to follow-up"), app);

    expect(app.state.blocks).toHaveLength(3);
    expect(app.state.blocks[0]).toMatchObject({
      type: "content",
      content: "answer to first question",
      finalized: true,
    });
    expect(app.state.blocks[1]).toMatchObject({ type: "user", content: "follow-up question" });
    expect(app.state.blocks[2]).toMatchObject({ type: "content", content: "answer to follow-up", finalized: false });
  });

  test("user_message_chunk finalizes active thinking block so history replays in order", () => {
    const app = createMappingFixture();

    applyAcpSessionUpdate(acpThinkingChunk("internal reasoning"), app);
    applyAcpSessionUpdate(acpUserMessageChunk("next prompt"), app);
    applyAcpSessionUpdate(acpAgentMessageChunk("response"), app);

    expect(app.state.blocks).toHaveLength(3);
    expect(app.state.blocks[0]).toMatchObject({ type: "thinking", content: "internal reasoning", finalized: true });
    expect(app.state.blocks[1]).toMatchObject({ type: "user", content: "next prompt" });
    expect(app.state.blocks[2]).toMatchObject({ type: "content", content: "response", finalized: false });
  });

  for (const transcriptPagingEnabled of [false, true]) {
    test(`history replay cost does not grow with transcript length (paging ${transcriptPagingEnabled})`, () => {
      // Real app state: the mapping fixture's setters scan every block themselves.
      function replayTurns(turns: number): number {
        const app = createAppStateValue("/tmp/relay-fixture", { transcriptPagingEnabled });
        // A fresh thread id per run: transcript page views are cached per thread at module level.
        app.setState("activeThreadId", `scaling-${transcriptPagingEnabled}-${turns}`);
        const start = performance.now();
        for (let turn = 0; turn < turns; turn++) {
          applyAcpSessionUpdate(acpUserMessageChunk(`prompt ${turn}`), app);
          for (let chunk = 0; chunk < 20; chunk++) applyAcpSessionUpdate(acpThinkingChunk("t"), app);
          applyAcpSessionUpdate(acpToolCallStart({ toolCallId: `tool-${turn}`, toolName: "bash" }), app);
          applyAcpSessionUpdate(
            acpToolCallUpdate({ toolCallId: `tool-${turn}`, status: "completed", rawOutput: "ok" }),
            app,
          );
          for (let chunk = 0; chunk < 20; chunk++) applyAcpSessionUpdate(acpAgentMessageChunk("m"), app);
        }
        expect(app.state.blocks.length).toBeGreaterThanOrEqual(turns * 4);
        return performance.now() - start;
      }

      replayTurns(100);
      const small = Math.max(replayTurns(400), 1);
      const large = replayTurns(1600);
      // 4x the turns should cost about 4x. A per-update scan of the transcript makes it about 16x.
      expect(large / small).toBeLessThan(10);
    });
  }
});
