/**
 * Paste compaction - large clipboard pastes are collapsed to markers
 * with a short preview snippet of the first few words.
 *
 * Marker formats:
 *   - text:  [paste #1 +20 lines - first few words...]
 *   - image: [image #2 photo.png]
 *
 * Image markers are produced when the entire paste is a single path to an
 * existing local image file (e.g. a drag-and-drop or copied file path). The
 * marker shows only the file name; image bytes live in promptImageStore sidecar
 * state and are lowered to ACP image blocks at submit time.
 */

import { promptImageStore, readPromptImageFile, type PromptImageSource } from "./prompt-images";

const PASTE_LINE_THRESHOLD = 5;
const PASTE_CHAR_THRESHOLD = 500;
const SNIPPET_WORD_COUNT = 4;
const PASTE_MARKER_PREFIX = "[paste #";
const IMAGE_MARKER_PREFIX = "[image #";

/**
 * Regex to match paste markers. Supports both old format (no snippet)
 * and new format (with " - snippet..." suffix).
 *
 * Groups: (1) paste id, (2) size info, (3) optional snippet
 *
 * Snippets are sanitized at generation time to never contain brackets, so
 * [^\]]* is safe and unambiguous for marker boundaries.
 */
const PASTE_MARKER_RE = /\[paste #(\d+) (\+\d+ lines|\d+ chars)(?:\s-\s([^\]]*))?\]/g;

// Combined matcher for both placeholder marker kinds (text paste or image).
// File names in image markers are sanitized at generation time to never contain
// brackets. Group (1) is the paste id, group (2) the image id; one per match.
const ANY_MARKER_RE = /\[paste #(\d+) (?:\+\d+ lines|\d+ chars)(?:\s-\s[^\]]*)?\]|\[image #(\d+) [^\]]*\]/g;

// ---------------------------------------------------------------------------
// Snippet helpers
// ---------------------------------------------------------------------------

function snippetFromText(text: string, wordCount: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const taken = words.slice(0, wordCount);
  const truncated = taken.length < words.length;
  // Strip brackets so the snippet can't break the marker's closing bracket
  // and orphaned '[' don't appear when their matching ']' is removed
  const snippet = taken.join(" ").replace(/[\[\]]/g, "");
  return snippet + (truncated ? "..." : "");
}

function buildMarker(pasteId: number, sizeLabel: string, content: string): string {
  const snippet = snippetFromText(content, SNIPPET_WORD_COUNT);
  if (snippet) {
    return `[paste #${pasteId} ${sizeLabel} - ${snippet}]`;
  }
  return `[paste #${pasteId} ${sizeLabel}]`;
}

// ---------------------------------------------------------------------------
// PlaceholderSpan and detection
// ---------------------------------------------------------------------------

export interface PlaceholderSpan {
  start: number;
  end: number;
  marker: string;
  pasteId: number;
  kind: "paste" | "image";
}

function findAllPlaceholders(text: string): PlaceholderSpan[] {
  const results: PlaceholderSpan[] = [];
  const re = new RegExp(ANY_MARKER_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Group 1 is the paste id, group 2 the image id; exactly one is present.
    const isImage = m[2] !== undefined;
    const idStr = m[1] ?? m[2];
    results.push({
      start: m.index,
      end: m.index + m[0].length,
      marker: m[0],
      pasteId: parseInt(idStr, 10),
      kind: isImage ? "image" : "paste",
    });
  }
  return results;
}

function findPlaceholderAt(text: string, offset: number, spans?: PlaceholderSpan[]): PlaceholderSpan | null {
  for (const span of spans ?? findAllPlaceholders(text)) {
    if (offset >= span.start && offset < span.end) return span;
  }
  return null;
}

function findPlaceholdersInRange(spans: PlaceholderSpan[], rangeStart: number, rangeEnd: number): PlaceholderSpan[] {
  return spans.filter((s) => s.start < rangeEnd && s.end > rangeStart);
}

function expandRange(rangeStart: number, rangeEnd: number, spans: PlaceholderSpan[]): { start: number; end: number } {
  const overlapping = findPlaceholdersInRange(spans, rangeStart, rangeEnd);
  let lo = rangeStart;
  let hi = rangeEnd;
  for (const s of overlapping) {
    if (s.start < lo) lo = s.start;
    if (s.end > hi) hi = s.end;
  }
  return { start: lo, end: hi };
}

// ---------------------------------------------------------------------------
// PlaceholderRemovalResult
// ---------------------------------------------------------------------------

export interface PlaceholderRemovalResult {
  newText: string;
  removedText: string;
  cursorOffset: number;
  affectedIds: number[];
}

// ---------------------------------------------------------------------------
// PasteStore - encapsulates all paste state and operations
// ---------------------------------------------------------------------------

export class PasteStore {
  private _counter = 0;
  private _pastes = new Map<number, string>();

  /** Quick check for whether text contains paste or image markers. */
  hasPasteMarkers(text: string): boolean {
    return text.includes(PASTE_MARKER_PREFIX) || text.includes(IMAGE_MARKER_PREFIX);
  }

  /** Find all placeholder spans in the given text. */
  findAllPlaceholders(text: string): PlaceholderSpan[] {
    return findAllPlaceholders(text);
  }

  /** Find the placeholder containing `offset` (start <= offset < end). */
  findPlaceholderAt(text: string, offset: number, spans?: PlaceholderSpan[]): PlaceholderSpan | null {
    return findPlaceholderAt(text, offset, spans);
  }

  /** Expand a range to fully cover partially-overlapped placeholders (read-only). */
  expandRangeToPlaceholders(
    text: string,
    start: number,
    end: number,
    spans?: PlaceholderSpan[],
  ): { start: number; end: number } {
    return expandRange(start, end, spans ?? findAllPlaceholders(text));
  }

  /** Normalize line endings and strip control characters from pasted text. */
  filterPastedText(rawText: string): string {
    const normalized = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return Array.from(normalized)
      .filter((ch) => ch === "\n" || ch.charCodeAt(0) >= 32)
      .join("");
  }

  /**
   * Compact a pasted text into a placeholder marker if it exceeds
   * size thresholds. Adds a new mapping to the store for the content.
   * Returns the original text unchanged if below thresholds or all-whitespace.
   */
  transformPaste(pastedText: string): string {
    const filtered = this.filterPastedText(pastedText);

    if (filtered.trim() === "") return filtered;

    // Image path paste: collapse to `[image #N name]`. The image bytes live in
    // promptImageStore sidecar state; only text paste markers use _pastes.
    const imageMarker = this.transformImagePath(filtered);
    if (imageMarker) return imageMarker;

    const lineCount = filtered.split("\n").length;
    const charCount = filtered.length;

    if (lineCount > PASTE_LINE_THRESHOLD || charCount > PASTE_CHAR_THRESHOLD) {
      const sizeLabel = lineCount > PASTE_LINE_THRESHOLD ? `+${lineCount} lines` : `${charCount} chars`;

      this._counter++;
      this._pastes.set(this._counter, filtered);
      return buildMarker(this._counter, sizeLabel, filtered);
    }

    return filtered;
  }

  /** Create an image marker from an existing local image path. */
  transformImagePath(path: string): string | null {
    const source = readPromptImageFile(path);
    return source ? this.transformImageSource(source) : null;
  }

  /** Create an image marker from already-read image bytes. */
  transformImageSource(source: PromptImageSource): string | null {
    const nextId = this._counter + 1;
    const result = promptImageStore.addSourceWithId(nextId, source);
    if (!result.ok) return null;
    this._counter = nextId;
    return result.attachment.marker;
  }

  /** Expand text paste markers back to original content (before sending to LLM). */
  expandPasteMarkers(text: string): string {
    return text.replace(PASTE_MARKER_RE, (match, idStr) => {
      const pasteId = parseInt(idStr, 10);
      return this._pastes.get(pasteId) ?? match;
    });
  }

  /** Clear all stored pastes/images and reset the counter. */
  reset(): void {
    this._pastes.clear();
    this._counter = 0;
    promptImageStore.reset();
  }

  /** Ensure future marker IDs don't collide with restored image sidecars. */
  reservePlaceholderIds(ids: readonly number[]): void {
    for (const id of ids) {
      if (id > this._counter) this._counter = id;
    }
  }

  /** Remove a single paste/image mapping. Resets counter when no sidecars remain. */
  removePasteMapping(pasteId: number): void {
    this._pastes.delete(pasteId);
    promptImageStore.removeImageIds([pasteId]);
    if (this._pastes.size === 0 && promptImageStore.all().length === 0) this._counter = 0;
  }

  /** Remove paste/image mappings for the given IDs. */
  commitAffectedIds(ids: number[]): void {
    for (const id of ids) {
      this.removePasteMapping(id);
    }
  }

  /**
   * Compute a range removal that expands to cover overlapping placeholders.
   * Does NOT mutate mappings. Call commitAffectedIds() to finalize.
   */
  computeRangeRemoval(
    text: string,
    rangeStart: number,
    rangeEnd: number,
    spans?: PlaceholderSpan[],
  ): PlaceholderRemovalResult | null {
    const allSpans = spans ?? findAllPlaceholders(text);
    const overlapping = findPlaceholdersInRange(allSpans, rangeStart, rangeEnd);
    if (overlapping.length === 0) return null;

    const { start: lo, end: hi } = expandRange(rangeStart, rangeEnd, allSpans);
    const affected = findPlaceholdersInRange(allSpans, lo, hi);

    return {
      newText: text.slice(0, lo) + text.slice(hi),
      removedText: text.slice(lo, hi),
      cursorOffset: lo,
      affectedIds: affected.map((s) => s.pasteId),
    };
  }

  /** Snap cursor to the nearest placeholder edge if inside one. */
  snapCursorAroundPlaceholder(text: string, offset: number, direction: "left" | "right" | "up" | "down"): number {
    const span = findPlaceholderAt(text, offset);
    if (!span) return offset;
    return direction === "right" || direction === "down" ? span.end : span.start;
  }

  /**
   * Find the placeholder that should be atomically deleted on backspace/delete.
   * Backspace: strictly inside or at right edge. Delete: inside.
   */
  placeholderForDeletion(
    text: string,
    offset: number,
    key: "backspace" | "delete",
    spans?: PlaceholderSpan[],
  ): PlaceholderSpan | null {
    const atCursor = findPlaceholderAt(text, offset, spans);
    if (key === "delete") return atCursor;
    if (atCursor && offset > atCursor.start) return atCursor;
    if (offset > 0) {
      const beforeCursor = findPlaceholderAt(text, offset - 1, spans);
      if (beforeCursor && beforeCursor.end === offset) return beforeCursor;
    }
    return null;
  }

  /** Get paste mappings referenced by markers in the text (for history persistence). */
  getPasteMappingsForText(text: string): Record<number, string> {
    const result: Record<number, string> = {};
    for (const span of findAllPlaceholders(text)) {
      const content = this._pastes.get(span.pasteId);
      if (content !== undefined) {
        result[span.pasteId] = content;
      }
    }
    return result;
  }

  /** Restore paste mappings (e.g., from history). Bumps counter to avoid ID collisions. */
  restorePasteMappings(mappings: Record<number, string>): void {
    for (const [idStr, content] of Object.entries(mappings)) {
      const id = Number(idStr);
      this._pastes.set(id, content);
      if (id >= this._counter) this._counter = id;
    }
  }

  /** Find an existing marker for content that was already pasted. */
  findExistingMarkerForContent(textareaText: string, content: string): { marker: string; pasteId: number } | null {
    let targetId: number | undefined;
    for (const [id, stored] of this._pastes) {
      if (stored === content) {
        targetId = id;
        break;
      }
    }
    if (targetId === undefined) return null;
    const span = findAllPlaceholders(textareaText).find((s) => s.pasteId === targetId);
    return span ? { marker: span.marker, pasteId: targetId } : null;
  }

  /** Expand a placeholder in-place, replacing the marker with full content. */
  expandPlaceholderInPlace(text: string, span: PlaceholderSpan): { newText: string; cursorOffset: number } | null {
    const content = this._pastes.get(span.pasteId);
    if (content === undefined) return null;
    const newText = text.slice(0, span.start) + content + text.slice(span.end);
    this.removePasteMapping(span.pasteId);
    return { newText, cursorOffset: span.start + content.length };
  }
}

// Singleton instance
export const pasteStore = new PasteStore();

// ---------------------------------------------------------------------------
// Event handler result types
//
// Handlers never remove mappings. They return affectedPasteIds for the
// caller to commit. handlePasteEvent may add new mappings via transformPaste
// when compacting a paste.
// ---------------------------------------------------------------------------

/** Unified result for paste and key event handlers. */
export interface PasteActionResult {
  /** Whether the event was handled. If false, caller should fall through. */
  handled: boolean;
  /** New full text for the textarea. */
  newText?: string;
  /** Where to position the cursor. */
  cursorOffset?: number;
  /** Insert text at cursor instead of replacing full text. */
  insertText?: string;
  /** Whether to prevent the default event behavior. */
  preventDefault: boolean;
  /** Text to copy to clipboard (for cut operations). */
  clipboardText?: string;
  /** Whether to clear the selection highlight. */
  clearSelection?: boolean;
  /** Schedule a post-move snap check with this direction (for up/down arrows). */
  scheduleSnap?: "up" | "down";
  /** Paste IDs whose mappings should be removed. Caller commits these. */
  affectedPasteIds?: number[];
}

// ---------------------------------------------------------------------------
// Paste event handler
// ---------------------------------------------------------------------------

interface KeyEventInput {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

const NOT_HANDLED: PasteActionResult = { handled: false, preventDefault: false };

/**
 * Handle a paste event. Determines how to process pasted content given
 * the current textarea state.
 *
 * May add new mappings via transformPaste (compaction), but never removes
 * mappings. The caller must:
 * 1. Apply newText/cursorOffset or insertText to the textarea
 * 2. Call store.commitAffectedIds(result.affectedPasteIds) to remove mappings
 */
export function handlePasteEvent(
  store: PasteStore,
  rawText: string,
  currentText: string,
  hasSel: boolean,
  selRange: { start: number; end: number } | null,
): PasteActionResult {
  const filtered = store.filterPastedText(rawText);

  // Paste over a selection that overlaps a placeholder
  if (hasSel && selRange && store.hasPasteMarkers(currentText)) {
    const result = store.computeRangeRemoval(currentText, selRange.start, selRange.end);
    if (result) {
      const transformed = store.transformPaste(rawText);
      const newText =
        result.newText.slice(0, result.cursorOffset) + transformed + result.newText.slice(result.cursorOffset);
      return {
        handled: true,
        newText,
        cursorOffset: result.cursorOffset + transformed.length,
        preventDefault: true,
        affectedPasteIds: result.affectedIds,
      };
    }
  }

  // Duplicate paste: expand existing placeholder in-place
  const existing = store.findExistingMarkerForContent(currentText, filtered);
  if (existing) {
    const idx = currentText.indexOf(existing.marker);
    if (idx !== -1) {
      const newText = currentText.slice(0, idx) + filtered + currentText.slice(idx + existing.marker.length);
      return {
        handled: true,
        newText,
        cursorOffset: idx + filtered.length,
        preventDefault: true,
        affectedPasteIds: [existing.pasteId],
      };
    }
  }

  // Normal paste compaction (transformPaste creates a new mapping in the store)
  const transformed = store.transformPaste(rawText);
  if (transformed !== rawText) {
    return { handled: true, insertText: transformed, preventDefault: true };
  }

  return NOT_HANDLED;
}

// ---------------------------------------------------------------------------
// Keyboard event handler (read-only, never mutates the store)
// ---------------------------------------------------------------------------

/**
 * Handle placeholder-aware key events. Never mutates the store.
 *
 * The caller must:
 * 1. Copy clipboardText to clipboard (if present)
 * 2. Clear selection (if clearSelection is true)
 * 3. Apply newText/cursorOffset to the textarea
 * 4. Call store.commitAffectedIds(result.affectedPasteIds) to remove mappings
 * 5. Schedule snap (if scheduleSnap is set)
 * 6. Call preventDefault on the event (if preventDefault is true)
 */
export function handlePlaceholderKeyEvent(
  store: PasteStore,
  text: string,
  offset: number,
  hasSel: boolean,
  selRange: { start: number; end: number } | null,
  evt: KeyEventInput,
): PasteActionResult {
  if (!store.hasPasteMarkers(text)) return NOT_HANDLED;

  const spans = store.findAllPlaceholders(text);

  // --- Selection-based edits ---
  if (hasSel && selRange) {
    const result = store.computeRangeRemoval(text, selRange.start, selRange.end, spans);
    if (result) {
      // Ctrl+X cut
      if (evt.ctrl && evt.name === "x") {
        return {
          handled: true,
          newText: result.newText,
          cursorOffset: result.cursorOffset,
          preventDefault: true,
          clipboardText: store.expandPasteMarkers(result.removedText),
          clearSelection: true,
          affectedPasteIds: result.affectedIds,
        };
      }
      // Backspace or delete with selection
      if (!evt.ctrl && !evt.meta && (evt.name === "backspace" || evt.name === "delete")) {
        return {
          handled: true,
          newText: result.newText,
          cursorOffset: result.cursorOffset,
          preventDefault: true,
          clearSelection: true,
          affectedPasteIds: result.affectedIds,
        };
      }
      // Typing over a selection
      if (!evt.ctrl && !evt.meta && evt.name && evt.name.length === 1) {
        return {
          handled: true,
          newText: result.newText,
          cursorOffset: result.cursorOffset,
          preventDefault: false,
          clearSelection: true,
          affectedPasteIds: result.affectedIds,
        };
      }
    }
  }

  // --- No selection: atomic backspace/delete ---
  if (!hasSel && !evt.ctrl && !evt.meta && (evt.name === "backspace" || evt.name === "delete")) {
    const span = store.placeholderForDeletion(text, offset, evt.name, spans);
    if (span) {
      const result = store.computeRangeRemoval(text, span.start, span.end, spans);
      if (result) {
        return {
          handled: true,
          newText: result.newText,
          cursorOffset: result.cursorOffset,
          preventDefault: true,
          affectedPasteIds: result.affectedIds,
        };
      }
    }
  }

  // --- Arrow keys ---
  if (!evt.ctrl && !evt.meta) {
    if (evt.name === "right") {
      const span = findPlaceholderAt(text, offset, spans);
      if (span && offset === span.start) {
        return { handled: true, cursorOffset: span.end, preventDefault: true };
      }
    }
    if (evt.name === "left" && offset > 0) {
      const span = findPlaceholderAt(text, offset - 1, spans);
      if (span && offset === span.end) {
        return { handled: true, cursorOffset: span.start, preventDefault: true };
      }
    }
    if (evt.name === "up" || evt.name === "down") {
      return { handled: true, preventDefault: false, scheduleSnap: evt.name };
    }
  }

  return NOT_HANDLED;
}
