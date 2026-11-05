import { describe, expect, test } from "bun:test";
import { $PROXY, createMemo, createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { findPendingApprovalBlock, findPendingElicitationBlock } from "../../../src/ui/app/approval-block";
import type { ChatBlock, ElicitationBlock, ToolBlock } from "../../../src/ui/state";

const text = (id: string): ChatBlock => ({ type: "content", id, content: id, finalized: true });
const approval = (id: string): ToolBlock =>
  ({
    type: "tool",
    id,
    toolCallId: id,
    toolName: "bash",
    display: "",
    status: "approval",
    resolveApproval: () => {},
  }) as ToolBlock;

const elicitation = (id: string): ElicitationBlock =>
  ({ type: "elicitation", id, status: "pending", respond: () => {} }) as unknown as ElicitationBlock;

describe("pending block lookup", () => {
  test("returns the store proxy for the newest pending approval and stays reactive", () => {
    createRoot((dispose) => {
      const [state, setState] = createStore({ blocks: [text("a"), approval("t1"), text("b")] as ChatBlock[] });
      const pending = createMemo(() => findPendingApprovalBlock(state.blocks)?.id ?? null);
      expect(pending()).toBe("t1");
      expect(findPendingApprovalBlock(state.blocks)).toBe(state.blocks[1] as ToolBlock);

      setState("blocks", state.blocks.length, approval("t2"));
      expect(pending()).toBe("t2");

      setState("blocks", 3, { status: "error", resolveApproval: undefined } as Partial<ToolBlock>);
      expect(pending()).toBe("t1");

      setState("blocks", 1, { status: "running" } as Partial<ToolBlock>);
      expect(pending()).toBeNull();
      dispose();
    });
  });

  test("tracks a pending elicitation being added and answered", () => {
    createRoot((dispose) => {
      const [state, setState] = createStore({ blocks: [text("a")] as ChatBlock[] });
      const pending = createMemo(() => findPendingElicitationBlock(state.blocks)?.id ?? null);
      expect(pending()).toBeNull();

      setState("blocks", state.blocks.length, elicitation("e1"));
      expect(pending()).toBe("e1");

      setState("blocks", 1, { status: "accepted", respond: undefined } as Partial<ElicitationBlock>);
      expect(pending()).toBeNull();
      dispose();
    });
  });

  test("does not notice a block flipped to pending in place", () => {
    // Pins the contract in findLastPendingBlock: writers must append pending blocks, not mutate existing ones.
    createRoot((dispose) => {
      const [state, setState] = createStore({
        blocks: [text("a"), { ...approval("t1"), status: "running" }] as ChatBlock[],
      });
      const pending = createMemo(() => findPendingApprovalBlock(state.blocks)?.id ?? null);
      expect(pending()).toBeNull();
      setState("blocks", 1, { status: "approval" } as Partial<ToolBlock>);
      expect(findPendingApprovalBlock(state.blocks)?.id).toBe("t1");
      expect(pending()).toBeNull();
      dispose();
    });
  });

  test("does not wrap every block in a store proxy", () => {
    // Runs on every key and wheel event; proxy reads made that O(transcript).
    const blocks = Array.from({ length: 5000 }, (_, i) => text(`b${i}`));
    const [state] = createStore({ blocks });
    expect(findPendingApprovalBlock(state.blocks)).toBeNull();
    expect(findPendingElicitationBlock(state.blocks)).toBeNull();
    expect(blocks.filter((block) => $PROXY in block).length).toBe(0);
  });
});
