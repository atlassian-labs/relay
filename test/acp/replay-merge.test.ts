import { describe, expect, test } from "bun:test";
import { mergeAdjacentTextChunks, replayAcpSessionUpdates } from "../../src/application/acp-orchestration";
import { applyAcpSessionUpdate, finalizeAcpPrompt } from "../../src/application/acp-mapping";
import type { RelaySessionUpdate } from "../../src/acp/sdk";
import { createMappingFixture } from "../lib/acp-mapping-fixture";
import {
  acpAgentMessageChunk as msg,
  acpThinkingChunk as think,
  acpToolCallStart,
  acpUserMessageChunk as user,
} from "../lib/acp-events";

const u = (events: unknown[]) => events as RelaySessionUpdate[];

function replayBlocks(updates: RelaySessionUpdate[], merge: boolean) {
  const app = createMappingFixture();
  if (merge) replayAcpSessionUpdates(updates, app);
  else {
    for (const update of updates) applyAcpSessionUpdate(update, app);
    finalizeAcpPrompt(app, {});
  }
  return JSON.parse(JSON.stringify(app.state.blocks)).map(({ id: _id, ...block }: Record<string, unknown>) => block);
}

describe("mergeAdjacentTextChunks", () => {
  test("merges adjacent same-kind text chunks", () => {
    const merged = mergeAdjacentTextChunks(u([msg("a"), msg("b"), msg("c"), think("x"), think("y")]));
    expect(merged).toEqual([msg("abc"), think("xy")]);
  });

  test("does not merge across kinds, tool calls, or user chunks", () => {
    const tool = acpToolCallStart({ toolCallId: "t", toolName: "bash" });
    const input = u([msg("a"), think("b"), msg("c"), tool, msg("d"), user("e"), user("f"), msg("g")]);
    expect(mergeAdjacentTextChunks(input)).toEqual(input);
  });

  test("does not merge non-text content or chunks with extra fields", () => {
    const image = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "x", mimeType: "image/png" },
    };
    const metaA = { ...msg("a"), _meta: { "alta/subagent": { childSessionId: "a" } } };
    const metaB = { ...msg("b"), _meta: { "alta/subagent": { childSessionId: "b" } } };
    const withId = { ...msg("c"), messageId: "m1" };
    const annotated = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "d", annotations: {} } };
    const input = u([msg("0"), image, image, metaA, metaB, withId, msg("e"), annotated, msg("f")]);
    expect(mergeAdjacentTextChunks(input)).toEqual(input);
  });

  test("replay of merged history yields identical blocks", () => {
    const tool = acpToolCallStart({ toolCallId: "t", toolName: "bash" });
    const history = u([user("hi"), think("a"), think("b"), msg("c"), msg("d"), tool, msg("e"), msg("f"), user("g")]);
    expect(replayBlocks(history, true)).toEqual(replayBlocks(history, false));
  });
});
