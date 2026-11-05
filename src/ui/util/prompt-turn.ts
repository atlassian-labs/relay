export interface CompletedPromptTurnDecision {
  readonly shouldNotifyCompletion: boolean;
  readonly shouldDrainQueue: boolean;
}

export function completedPromptTurnDecision(input: {
  readonly queuedPromptCount: number;
  readonly cancelRequested: boolean;
  readonly drainQueueOnCompletion?: boolean;
}): CompletedPromptTurnDecision {
  if (input.cancelRequested) {
    return { shouldNotifyCompletion: false, shouldDrainQueue: false };
  }

  return {
    shouldNotifyCompletion: input.queuedPromptCount === 0,
    shouldDrainQueue: input.drainQueueOnCompletion !== false && input.queuedPromptCount > 0,
  };
}
