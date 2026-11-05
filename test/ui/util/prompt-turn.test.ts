import { describe, expect, test } from "bun:test";
import { completedPromptTurnDecision } from "../../../src/ui/util/prompt-turn";

describe("prompt turn utilities", () => {
  test("notifies and does not drain when a completed turn has no queued prompt", () => {
    expect(
      completedPromptTurnDecision({
        queuedPromptCount: 0,
        cancelRequested: false,
      }),
    ).toEqual({ shouldNotifyCompletion: true, shouldDrainQueue: false });
  });

  test("suppresses completion notification and drains when queued prompt remains", () => {
    expect(
      completedPromptTurnDecision({
        queuedPromptCount: 1,
        cancelRequested: false,
      }),
    ).toEqual({ shouldNotifyCompletion: false, shouldDrainQueue: true });
  });

  test("cancelled turns neither notify nor drain queued prompts", () => {
    expect(
      completedPromptTurnDecision({
        queuedPromptCount: 1,
        cancelRequested: true,
      }),
    ).toEqual({ shouldNotifyCompletion: false, shouldDrainQueue: false });
  });

  test("respects explicit queue-drain suppression", () => {
    expect(
      completedPromptTurnDecision({
        queuedPromptCount: 1,
        cancelRequested: false,
        drainQueueOnCompletion: false,
      }),
    ).toEqual({ shouldNotifyCompletion: false, shouldDrainQueue: false });
  });
});
