import type { Selection } from "@opentui/core";

export type TranscriptSelectionCopy = (selection: Selection) => void;
export type TranscriptSelectionCompletionResult = "deferred" | "not-handled" | "too-large";

export interface TranscriptSelectionCoordinator {
  /**
   * Completes or defers a renderer selection while ensuring all selected pages are mounted.
   *
   * @param selection - Current renderer selection to copy.
   * @param copy - Callback invoked after the selection is ready for clipboard serialization.
   * @returns Whether completion was deferred, declined, or rejected for exceeding the page limit.
   */
  completeSelection(selection: Selection, copy: TranscriptSelectionCopy): TranscriptSelectionCompletionResult;
  /**
   * Cancels selection work and measurement ownership before a thread leaves the active view.
   *
   * @param threadId - Identifier of the thread being deactivated.
   * @returns Nothing; transient selection and measurement state are cleared in place.
   */
  beforeThreadDeactivate(threadId: string): void;
  /**
   * Prepares scroll restoration after a thread becomes active.
   *
   * @param threadId - Identifier of the thread being activated.
   * @returns Nothing; activation state is recorded for the next render frame.
   */
  afterThreadActivate(threadId: string): void;
  /**
   * Releases selection, navigation, and renderer resources owned by the coordinator.
   *
   * @returns Nothing; transient resources are cleared in place.
   */
  dispose(): void;
}
