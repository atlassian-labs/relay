/**
 * Paste-textarea adapter: wires PasteStore logic to the textarea ref.
 *
 * All paste-specific textarea interaction lives here. The app layer
 * only needs to call these functions at the right lifecycle points.
 */

import { copyToClipboard } from "./clipboard";
import { runEffect } from "../../effect/runtime";
import { type PasteActionResult, type PasteStore, handlePasteEvent, handlePlaceholderKeyEvent } from "../paste";
import { readClipboardImage } from "./clipboard-image";

// ---------------------------------------------------------------------------
// Textarea helpers
// ---------------------------------------------------------------------------

/** Convert (row, col) cursor to a character offset in the text. */
export function getCursorOffset(ref: any, text: string): number {
  try {
    const cursor = ref?.logicalCursor ?? ref?.editBuffer?.cursor;
    if (!cursor) return text.length;
    const lines = text.split("\n");
    const row = typeof cursor.line === "number" ? cursor.line : typeof cursor.row === "number" ? cursor.row : 0;
    const col = typeof cursor.column === "number" ? cursor.column : typeof cursor.col === "number" ? cursor.col : 0;
    const clampedRow = Math.min(row, lines.length - 1);
    let offset = 0;
    for (let i = 0; i < clampedRow; i++) offset += lines[i].length + 1;
    offset += Math.min(col, lines[clampedRow]?.length ?? 0);
    return offset;
  } catch {}
  return text.length;
}

/**
 * Apply a text update to the textarea with cursor positioning.
 * Uses editBuffer.replaceText when available (preserves buffer state),
 * falls back to setText.
 */
export function applyTextareaTextUpdate(ref: any, newText: string, cursorOffset: number): void {
  try {
    const eb = ref.editBuffer;
    if (eb && typeof eb.replaceText === "function") {
      eb.replaceText(newText);
      if (typeof eb.setCursorByOffset === "function") eb.setCursorByOffset(cursorOffset);
      else ref.cursorOffset = cursorOffset;
    } else {
      ref.setText(newText);
      ref.cursorOffset = cursorOffset;
    }
  } catch {}
}

/**
 * Apply a PasteActionResult to the textarea, clipboard, and store.
 * Single point of application for all paste action results.
 */
function applyResult(
  ref: any,
  store: PasteStore,
  result: PasteActionResult,
  renderer?: any,
  onApplied?: () => void,
): void {
  if (result.clipboardText) {
    copyToClipboard(result.clipboardText);
  }
  if (result.clearSelection) {
    try {
      renderer?.clearSelection?.();
    } catch {}
  }
  if (result.newText !== undefined && result.cursorOffset !== undefined) {
    applyTextareaTextUpdate(ref, result.newText, result.cursorOffset);
  } else if (result.insertText) {
    ref.insertText(result.insertText);
  } else if (result.cursorOffset !== undefined) {
    try {
      ref.cursorOffset = result.cursorOffset;
    } catch {}
  }
  if (result.affectedPasteIds?.length) {
    store.commitAffectedIds(result.affectedPasteIds);
  }
  onApplied?.();
}

function isClipboardImagePasteKey(evt: any): boolean {
  const name = typeof evt?.name === "string" ? evt.name.toLowerCase() : "";
  return name === "v" && (evt.ctrl === true || evt.meta === true || evt.option === true);
}

function insertImageMarkerAtCursor(
  ref: any,
  store: PasteStore,
  marker: string,
  renderer?: any,
  onApplied?: () => void,
): void {
  const text: string = ref.plainText ?? ref.editBuffer?.getText() ?? "";
  const hasSel = ref.hasSelection?.() ?? false;
  const offset = ref.cursorOffset ?? getCursorOffset(ref, text);
  const selRange = hasSel ? (ref.getSelection?.() ?? ref.editBuffer?.getSelection?.() ?? null) : null;

  if (selRange) {
    const placeholderRemoval = store.hasPasteMarkers(text)
      ? store.computeRangeRemoval(text, selRange.start, selRange.end)
      : null;
    if (placeholderRemoval) {
      applyResult(
        ref,
        store,
        {
          handled: true,
          newText:
            placeholderRemoval.newText.slice(0, placeholderRemoval.cursorOffset) +
            marker +
            placeholderRemoval.newText.slice(placeholderRemoval.cursorOffset),
          cursorOffset: placeholderRemoval.cursorOffset + marker.length,
          preventDefault: true,
          clearSelection: true,
          affectedPasteIds: placeholderRemoval.affectedIds,
        },
        renderer,
        onApplied,
      );
      return;
    }

    const start = Math.max(0, Math.min(selRange.start, selRange.end));
    const end = Math.max(start, Math.max(selRange.start, selRange.end));
    applyResult(
      ref,
      store,
      {
        handled: true,
        newText: text.slice(0, start) + marker + text.slice(end),
        cursorOffset: start + marker.length,
        preventDefault: true,
        clearSelection: true,
      },
      renderer,
      onApplied,
    );
    return;
  }

  applyResult(
    ref,
    store,
    {
      handled: true,
      newText: text.slice(0, offset) + marker + text.slice(offset),
      cursorOffset: offset + marker.length,
      preventDefault: true,
    },
    renderer,
    onApplied,
  );
}

export function insertImagePathAtCursor(
  ref: any,
  store: PasteStore,
  path: string,
  renderer?: any,
  onApplied?: () => void,
): boolean {
  if (!ref) return false;
  const marker = store.transformImagePath(path);
  if (!marker) return false;
  insertImageMarkerAtCursor(ref, store, marker, renderer, onApplied);
  return true;
}

function pasteClipboardImage(ref: any, store: PasteStore, renderer?: any, onApplied?: () => void): void {
  void runEffect(readClipboardImage())
    .then((source) => {
      if (!source) return;
      const marker = store.transformImageSource(source);
      if (!marker) return;
      insertImageMarkerAtCursor(ref, store, marker, renderer, onApplied);
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Public adapter functions
// ---------------------------------------------------------------------------

/**
 * Install the paste handler monkey-patch on the textarea ref.
 * Call once when the textarea ref is created.
 */
export function installPasteHandler(ref: any, store: PasteStore, onApplied?: () => void): void {
  if (!ref || typeof ref.handlePaste !== "function") return;

  const originalHandlePaste = ref.handlePaste.bind(ref);
  ref.handlePaste = (event: any) => {
    try {
      const rawText = new TextDecoder().decode(event.bytes);
      const currentText = ref.plainText ?? ref.editBuffer?.getText() ?? "";
      const hasSel = ref.hasSelection?.() ?? false;
      const selRange = hasSel ? (ref.getSelection?.() ?? null) : null;

      const result = handlePasteEvent(store, rawText, currentText, hasSel, selRange);
      if (result.handled) {
        event.preventDefault();
        applyResult(ref, store, result, undefined, onApplied);
        return;
      }
    } catch {}
    originalHandlePaste(event);
  };
}

/**
 * Handle mouseUp on the textarea: expand a placeholder if clicked.
 */
export function handlePasteMouseUp(ref: any, store: PasteStore, onApplied?: () => void): void {
  setTimeout(() => {
    try {
      if (!ref) return;
      if (ref.hasSelection?.()) return;
      const text: string = ref.plainText ?? ref.editBuffer?.getText() ?? "";
      if (!store.hasPasteMarkers(text)) return;
      const offset = ref.cursorOffset ?? getCursorOffset(ref, text);
      const span = store.findPlaceholderAt(text, offset);
      if (!span) return;
      const result = store.expandPlaceholderInPlace(text, span);
      if (!result) return;
      applyTextareaTextUpdate(ref, result.newText, result.cursorOffset);
      onApplied?.();
    } catch {}
  }, 0);
}

/**
 * Handle a keyboard event for placeholder-aware behavior.
 * Returns true if the event was handled (caller should not process further).
 */
export function handlePasteKeyEvent(
  ref: any,
  store: PasteStore,
  evt: any,
  renderer?: any,
  onApplied?: () => void,
): boolean {
  if (isClipboardImagePasteKey(evt)) {
    pasteClipboardImage(ref, store, renderer, onApplied);
    evt.preventDefault?.();
    return true;
  }

  const text: string = ref.plainText ?? ref.editBuffer?.getText() ?? "";
  const hasSel = ref.hasSelection?.() ?? false;
  const offset = ref.cursorOffset ?? getCursorOffset(ref, text);
  const selRange = hasSel ? (ref.getSelection?.() ?? ref.editBuffer?.getSelection?.() ?? null) : null;

  const result = handlePlaceholderKeyEvent(store, text, offset, hasSel, selRange, {
    name: evt.name ?? "",
    ctrl: !!evt.ctrl,
    meta: !!evt.meta,
    shift: !!evt.shift,
  });

  if (!result.handled) return false;

  applyResult(ref, store, result, renderer, onApplied);

  if (result.scheduleSnap) {
    const direction = result.scheduleSnap;
    setTimeout(() => {
      try {
        const newText: string = ref.plainText ?? ref.editBuffer?.getText() ?? "";
        const newOffset = ref.cursorOffset ?? getCursorOffset(ref, newText);
        const snapped = store.snapCursorAroundPlaceholder(newText, newOffset, direction);
        if (snapped !== newOffset) {
          ref.cursorOffset = snapped;
        }
      } catch {}
    }, 0);
  }

  if (result.preventDefault) {
    if (evt.preventDefault) evt.preventDefault();
  }

  return result.preventDefault;
}

/**
 * Restore paste mappings for a history entry. Clears stale mappings first.
 */
export function restorePasteMappings(store: PasteStore, mappings?: Record<number, string>): void {
  store.reset();
  if (mappings) store.restorePasteMappings(mappings);
}

/**
 * Copy selected text to clipboard, expanding any paste markers.
 * Returns true if text was copied.
 */
export function copySelectionWithPasteExpansion(ref: any, store: PasteStore, selectedText: string): string {
  if (!ref) return selectedText;

  try {
    const bufText: string = ref.plainText ?? ref.editBuffer?.getText() ?? "";
    if (store.hasPasteMarkers(bufText)) {
      const sel = ref.getSelection?.();
      if (sel) {
        const { start, end } = store.expandRangeToPlaceholders(bufText, sel.start, sel.end);
        return store.expandPasteMarkers(bufText.slice(start, end));
      }
    }
  } catch {}
  return selectedText;
}
