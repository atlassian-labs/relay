/**
 * Prompt queue + prompt-history navigation helpers.
 *
 * Extracted from app-root as a factory. The queue interaction state, textarea
 * ref, thread-scoped queue store, and submit entrypoint are injected here;
 * `clampQueueFocus` / `cancelQueuedPrompt` / `editQueuedPrompt` are private to
 * this module (only used internally), the rest are returned for the keyboard
 * handler, submit pipeline, and plugin editor bridge to call.
 */

import type { PromptImageAttachment, PromptInput } from "../../core/prompt-submission";
import { type QueuedPrompt, useApp } from "../state";
import type { AcpClient } from "../../acp/client";
import type { InputUpdateSource } from "../component/composer";
import { promptHistory } from "../component/composer";
import { pasteStore } from "../paste";
import { promptImageStore } from "../prompt-images";
import { applyTextareaTextUpdate, restorePasteMappings } from "../util/paste-textarea";
import { showToast } from "./toast-controller";
import type { PromptSubmissionOptions } from "./submit-controller";
import type { ThreadQueueStore } from "./thread-queue";
import {
  cancelQueuedPromptAt,
  moveQueueFocusIndex,
  moveQueuedPrompt,
  normalizeQueueFocus,
  queuedPromptEditText,
  queuedPromptToInput,
  removeQueuedPromptAt,
  restoreEditingQueuedPrompt as restoreEditingQueuedPromptState,
  startEditQueuedPrompt,
} from "../util/prompt-queue";

type App = ReturnType<typeof useApp>;

export type ComposerDraft = {
  text: string;
  pasteMappings: Record<number, string>;
  images: PromptImageAttachment[];
};

export type QueueInteractionState =
  | { kind: "idle" }
  | { kind: "browsing"; index: number }
  | { kind: "editing"; item: QueuedPrompt; composerDraft: ComposerDraft };

export interface QueueControllerDeps {
  queueInteraction: () => QueueInteractionState;
  setQueueInteraction: (value: QueueInteractionState) => void;
  threadQueue: ThreadQueueStore;
  textareaRef: () => any;
  markInputUpdateSource: (source: InputUpdateSource, text: string) => void;
  syncPromptText: (text: string) => void;
  resetVimState: () => void;
  refreshCurrentPasteHighlights: () => void;
  acpClient: () => AcpClient | null;
  allowGlobalPromptHistoryContinuation: () => boolean;
  cancelRequested: () => boolean;
  resumeQueueDrain: (app: App) => boolean;
  submitPromptToAgent: (
    input: PromptInput,
    app: App,
    queuePlacement?: "in-place" | "end",
    options?: PromptSubmissionOptions,
  ) => Promise<void>;
}

export interface QueueController {
  queuePrompt: (
    input: PromptInput,
    app: App,
    placement?: "in-place" | "end",
    reason?: "queued" | "startup" | "active-turn-input-rejected" | "active-turn-input-error",
  ) => boolean;
  setPromptText: (text: string, source?: InputUpdateSource) => void;
  restoreRejectedPromptToComposerDraft: (text: string) => boolean;
  restoreEditingQueuedPrompt: (app: App, notify?: boolean) => boolean;
  deleteEditingQueuedPrompt: (app: App) => boolean;
  cancelPendingQueueFocus: () => boolean;
  exitQueueBrowse: (app: App) => void;
  moveQueueFocus: (delta: number, app: App) => number | null;
  navigatePromptHistory: (direction: -1 | 1) => boolean;
  editFocusedQueuedPrompt: (app: App) => boolean;
  cancelFocusedQueuedPrompt: (app: App) => boolean;
  moveFocusedQueuedPrompt: (delta: number, app: App) => boolean;
  sendFocusedQueuedPromptNow: (app: App) => boolean;
}

export function createQueueController(deps: QueueControllerDeps): QueueController {
  const {
    queueInteraction,
    setQueueInteraction,
    threadQueue,
    textareaRef,
    markInputUpdateSource,
    syncPromptText,
    resetVimState,
    refreshCurrentPasteHighlights,
    acpClient,
    allowGlobalPromptHistoryContinuation,
    cancelRequested,
    resumeQueueDrain,
    submitPromptToAgent,
  } = deps;

  const queueFocusIndex = (): number | null => {
    const interaction = queueInteraction();
    return interaction.kind === "browsing" ? interaction.index : null;
  };
  const editingQueueItem = (): QueuedPrompt | null => {
    const interaction = queueInteraction();
    return interaction.kind === "editing" ? interaction.item : null;
  };
  const setBrowseIndex = (index: number | null): void =>
    setQueueInteraction(index === null ? { kind: "idle" } : { kind: "browsing", index });
  let pendingQueueFocusTimeout: ReturnType<typeof setTimeout> | null = null;

  function cancelPendingQueueFocus(): boolean {
    if (pendingQueueFocusTimeout === null) return false;
    clearTimeout(pendingQueueFocusTimeout);
    pendingQueueFocusTimeout = null;
    return true;
  }

  function scheduleQueueFocus(app: App, preferredIndex: number): boolean {
    const nextIndex = normalizeQueueFocus(app.state.pendingQueue.length, preferredIndex);
    if (nextIndex === null) return false;
    const nextItemId = app.state.pendingQueue[nextIndex]?.id;
    pendingQueueFocusTimeout = setTimeout(() => {
      pendingQueueFocusTimeout = null;
      if (queueInteraction().kind !== "idle") return;
      const currentIndex = app.state.pendingQueue.findIndex((item) => item.id === nextItemId);
      if (currentIndex >= 0) setBrowseIndex(currentIndex);
    }, 0);
    return true;
  }

  function captureComposerDraft(): ComposerDraft {
    const text = textareaRef()?.plainText ?? "";
    return {
      text,
      pasteMappings: pasteStore.getPasteMappingsForText(text),
      images: promptImageStore.all(),
    };
  }

  function restoreComposerDraft(draft: ComposerDraft): void {
    restorePasteMappings(pasteStore, draft.pasteMappings);
    promptImageStore.restore(draft.images);
    pasteStore.reservePlaceholderIds(draft.images.map((image) => image.id));
    setPromptText(draft.text);
    refreshCurrentPasteHighlights();
  }

  function restoreRejectedPromptToComposerDraft(text: string): boolean {
    const interaction = queueInteraction();
    if (interaction.kind !== "editing") return false;
    const draft = interaction.composerDraft;
    const nextText = draft.text.trim() && draft.text !== text ? `${text}\n\n${draft.text}` : text;
    setQueueInteraction({ ...interaction, composerDraft: { ...draft, text: nextText } });
    showToast("Queue full; prompt restored to the composer draft", "warning");
    return true;
  }

  function queuePrompt(
    input: PromptInput,
    app: App,
    placement: "in-place" | "end" = "in-place",
    reason: "queued" | "startup" | "active-turn-input-rejected" | "active-turn-input-error" = "queued",
  ): boolean {
    const activeInteraction = queueInteraction();
    const activeEditingItem = activeInteraction.kind === "editing" ? activeInteraction.item : null;
    const editing = placement === "in-place" ? activeEditingItem : null;
    const result = threadQueue.admit({
      app,
      threadId: app.state.activeThreadId,
      input,
      editing,
      placement,
      reservedSlots: activeEditingItem && !editing ? 1 : 0,
    });
    if (!result.accepted) {
      if (result.reason === "full") showToast(`Queue full (max ${threadQueue.maxSize})`, "error");
      return false;
    }
    if (editing && !result.editing && activeInteraction.kind === "editing") {
      setQueueInteraction({ kind: "idle" });
      restoreComposerDraft(activeInteraction.composerDraft);
    }
    if (reason === "startup") {
      showToast(`Agent is still starting; queued prompt #${(result.insertIndex ?? 0) + 1}`);
    } else if (reason === "active-turn-input-rejected") {
      showToast(`Could not add to current turn; queued prompt #${(result.insertIndex ?? 0) + 1}`, "warning");
    } else if (reason === "active-turn-input-error") {
      showToast(`Could not add to current turn; queued prompt #${(result.insertIndex ?? 0) + 1}`, "error");
    } else if (placement === "in-place" && editing) {
      showToast(`Updated queued prompt #${(result.insertIndex ?? 0) + 1}`);
    } else {
      showToast(
        editing
          ? `Moved edited prompt to queue end (#${(result.insertIndex ?? 0) + 1})`
          : `Queued prompt #${(result.insertIndex ?? 0) + 1}`,
      );
    }
    if (editing && !result.editing) resumeQueueDrain(app);
    return true;
  }

  function setPromptText(text: string, source: InputUpdateSource = "queue", cursorOffset: number = text.length): void {
    syncPromptText(text);
    markInputUpdateSource(source, text);
    const _textareaRef = textareaRef();
    if (!_textareaRef) return;
    applyTextareaTextUpdate(_textareaRef, text, cursorOffset);
    try {
      _textareaRef.focus?.();
    } catch {}
    resetVimState();
  }

  function clampQueueFocus(queueLength: number, preferred = queueFocusIndex()): void {
    setBrowseIndex(normalizeQueueFocus(queueLength, preferred));
  }

  function cancelQueuedPrompt(index: number, app: App): void {
    cancelPendingQueueFocus();
    const item = app.state.pendingQueue[index];
    if (!item) return;
    const result = cancelQueuedPromptAt(app.state.pendingQueue, index);
    app.setState("pendingQueue", result.queue);
    setQueueInteraction({ kind: "idle" });
    scheduleQueueFocus(app, result.focusIndex ?? index);
    showToast(`Cancelled queued prompt #${index + 1}`);
  }

  function editQueuedPrompt(index: number, app: App): void {
    const item = app.state.pendingQueue[index];
    if (!item) return;
    const result = startEditQueuedPrompt(app.state.pendingQueue, index);
    const editing = result.editing;
    if (!editing) return;
    const composerDraft = captureComposerDraft();
    // Seed the editor before mounting it; the selected item is removed
    // from the drainable queue as edit mode starts.
    syncPromptText(queuedPromptEditText(item));
    app.setState("pendingQueue", result.queue);
    setQueueInteraction({ kind: "editing", item: editing, composerDraft });
    pasteStore.reset();
    promptImageStore.restore(editing.images ?? []);
    pasteStore.reservePlaceholderIds((editing.images ?? []).map((image) => image.id));
    const editText = queuedPromptEditText(editing);
    setPromptText(editText, "queue", editText.length);
    setTimeout(() => {
      if (editingQueueItem()?.id !== editing.id) return;
      const ref = textareaRef();
      if (!ref) return;
      const currentText = ref.plainText ?? editText;
      applyTextareaTextUpdate(ref, currentText, currentText.length);
      ref.focus?.();
    }, 0);
  }

  function restoreEditingQueuedPrompt(app: App, notify = true): boolean {
    const interaction = queueInteraction();
    if (interaction.kind !== "editing") return false;
    const result = restoreEditingQueuedPromptState(app.state.pendingQueue, interaction.item);
    if (!result.restored) return false;
    app.setState("pendingQueue", result.queue);
    restoreComposerDraft(interaction.composerDraft);
    setQueueInteraction(
      result.insertIndex === undefined ? { kind: "idle" } : { kind: "browsing", index: result.insertIndex },
    );
    if (notify) showToast(`Restored queued prompt #${(result.insertIndex ?? 0) + 1}`);
    return true;
  }

  function deleteEditingQueuedPrompt(app: App): boolean {
    cancelPendingQueueFocus();
    const interaction = queueInteraction();
    if (interaction.kind !== "editing") return false;
    const deletedIndex = interaction.item.originalIndex ?? 0;
    setQueueInteraction({ kind: "idle" });
    restoreComposerDraft(interaction.composerDraft);
    showToast(`Deleted queued prompt #${deletedIndex + 1}`);
    if (!scheduleQueueFocus(app, deletedIndex)) resumeQueueDrain(app);
    return true;
  }

  function exitQueueBrowse(app: App): void {
    cancelPendingQueueFocus();
    setBrowseIndex(null);
    resumeQueueDrain(app);
  }

  function moveQueueFocus(delta: number, app: App): number | null {
    if (editingQueueItem()) return null;
    const next = moveQueueFocusIndex(app.state.pendingQueue.length, queueFocusIndex(), delta);
    setBrowseIndex(next);
    if (next === null) resumeQueueDrain(app);
    return next;
  }

  function navigatePromptHistory(direction: -1 | 1): boolean {
    const _textareaRef = textareaRef();
    if (!_textareaRef) return false;
    if (direction === 1 && !promptHistory.isBrowsing()) return false;

    const currentText = _textareaRef.plainText ?? "";
    const draftMappings =
      direction === -1 && !promptHistory.isBrowsing() ? pasteStore.getPasteMappingsForText(currentText) : undefined;
    const entry = promptHistory.navigate(direction, direction === -1 ? currentText : "", draftMappings, {
      sessionId: acpClient()?.sessionId,
      allowGlobalContinuation: allowGlobalPromptHistoryContinuation(),
    });
    if (entry === null) return false;

    markInputUpdateSource("history", entry.text);
    try {
      _textareaRef.setText(entry.text);
    } catch {}
    restorePasteMappings(pasteStore, entry.pasteMappings);
    refreshCurrentPasteHighlights();
    return true;
  }

  function editFocusedQueuedPrompt(app: App): boolean {
    const idx = queueFocusIndex();
    if (idx === null) return false;
    if (idx < 0 || idx >= app.state.pendingQueue.length) {
      clampQueueFocus(app.state.pendingQueue.length);
      return false;
    }
    editQueuedPrompt(idx, app);
    return true;
  }

  function cancelFocusedQueuedPrompt(app: App): boolean {
    const idx = queueFocusIndex();
    if (idx === null) return false;
    if (idx < 0 || idx >= app.state.pendingQueue.length) {
      clampQueueFocus(app.state.pendingQueue.length);
      return false;
    }
    cancelQueuedPrompt(idx, app);
    return true;
  }

  function moveFocusedQueuedPrompt(delta: number, app: App): boolean {
    if (editingQueueItem()) return false;
    const idx = queueFocusIndex();
    if (idx === null) return false;
    const result = moveQueuedPrompt(app.state.pendingQueue, idx, delta);
    app.setState("pendingQueue", result.queue);
    setBrowseIndex(result.focusIndex);
    if (result.moved) showToast(`Moved queued prompt to #${(result.focusIndex ?? 0) + 1}`);
    return result.moved;
  }

  function sendFocusedQueuedPromptNow(app: App): boolean {
    if (editingQueueItem()) {
      showToast("Save or cancel the queue edit before sending", "warning");
      return true;
    }
    const idx = queueFocusIndex();
    if (idx === null) return false;

    if (app.state.running || !cancelRequested()) {
      showToast("Send now is only available after interrupting a turn", "warning");
      return true;
    }

    if (!acpClient() || app.state.connecting) {
      showToast("No ACP agent ready for send now", "warning");
      return true;
    }

    const promptText = textareaRef()?.plainText ?? "";
    if (promptText.trim()) {
      showToast("Clear input before sending a queued prompt now", "warning");
      return true;
    }

    if (idx < 0 || idx >= app.state.pendingQueue.length) {
      clampQueueFocus(app.state.pendingQueue.length);
      return true;
    }

    const result = removeQueuedPromptAt(app.state.pendingQueue, idx);
    if (!result.item) {
      app.setState("pendingQueue", result.queue);
      setBrowseIndex(result.focusIndex);
      return true;
    }

    app.setState("pendingQueue", result.queue);
    setBrowseIndex(null);
    void submitPromptToAgent(queuedPromptToInput(result.item), app, "in-place", {
      includePendingBashContext: false,
      drainQueueIncludePendingBashContext: false,
      source: "queue",
    });
    showToast(`Sent queued prompt #${idx + 1}`);
    return true;
  }

  return {
    queuePrompt,
    setPromptText,
    restoreRejectedPromptToComposerDraft,
    restoreEditingQueuedPrompt,
    deleteEditingQueuedPrompt,
    cancelPendingQueueFocus,
    exitQueueBrowse,
    moveQueueFocus,
    navigatePromptHistory,
    editFocusedQueuedPrompt,
    cancelFocusedQueuedPrompt,
    moveFocusedQueuedPrompt,
    sendFocusedQueuedPromptNow,
  };
}
