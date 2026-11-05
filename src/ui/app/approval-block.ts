/**
 * Helpers for locating the active tool-approval block in the chat transcript.
 *
 * Pure over the block list so the keyboard handler can resolve which approval
 * the Enter / arrow keys act on without embedding the search inline.
 */

import { $RAW } from "solid-js/store";
import type { ChatBlock, ElicitationBlock, ToolBlock } from "../state";

/**
 * Finds the last block matching `isPending`. Runs on every key and mouse event, so it scans the raw
 * array: store proxy reads made each wheel tick cost O(transcript). Callers stay reactive because
 * `length` and the match are read through the proxy, and blocks only become pending when added:
 * flipping an existing block to pending in place would not re-run callers such as the approval panel.
 */
function findLastPendingBlock<T extends ChatBlock>(
  blocks: readonly ChatBlock[],
  isPending: (block: ChatBlock) => block is T,
): T | null {
  const raw = (blocks as { [$RAW]?: readonly ChatBlock[] })[$RAW] ?? blocks;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (!isPending(raw[i])) continue;
    const block = blocks[i];
    return isPending(block) ? block : null;
  }
  return null;
}

const isPendingApproval = (block: ChatBlock): block is ToolBlock =>
  block.type === "tool" && block.status === "approval" && Boolean(block.resolveApproval);

const isPendingElicitation = (block: ChatBlock): block is ElicitationBlock =>
  block.type === "elicitation" && block.status === "pending" && Boolean(block.respond);

/** The most recent tool block awaiting an approve/deny decision, if any. */
export function findPendingApprovalBlock(blocks: readonly ChatBlock[]): ToolBlock | null {
  return findLastPendingBlock(blocks, isPendingApproval);
}

/** The most recent elicitation awaiting a response, if any. */
export function findPendingElicitationBlock(blocks: readonly ChatBlock[]): ElicitationBlock | null {
  return findLastPendingBlock(blocks, isPendingElicitation);
}
