import type { VimEditor } from "./vim-editor";

export type VimMode = "insert" | "normal" | "visual" | "visual-line";

type Operator = "delete" | "change";

type PendingCommand =
  | { type: "idle" }
  | { type: "count"; digits: string }
  | { type: "operator"; operator: Operator; count: number; digits: string }
  | { type: "g"; count: number };

export interface VimState {
  mode: VimMode;
  pending: PendingCommand;
  /** Anchor offset for visual selections. Always defined while mode is visual or visual-line. */
  anchor?: number;
}

export interface VimKeyEvent {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  option?: boolean;
  shift?: boolean;
  preventDefault?: () => void;
}

export interface VimStatus {
  mode: VimMode;
  pending: string;
}

export const initialVimState: VimState = { mode: "insert", pending: { type: "idle" } };

const idle: PendingCommand = { type: "idle" };

function state(mode: VimMode, pending: PendingCommand = idle, anchor?: number): VimState {
  return anchor === undefined ? { mode, pending } : { mode, pending, anchor };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function keyValue(event: VimKeyEvent): string {
  if (event.sequence && event.sequence.length === 1 && event.sequence >= " ") return event.sequence;
  return event.name ?? "";
}

function isDigit(key: string): boolean {
  return key >= "0" && key <= "9";
}

function isPrintableKey(key: string): boolean {
  return key.length === 1 && key >= " ";
}

/**
 * True when the event should be interpreted as Escape: the literal Escape key,
 * or Ctrl+[ (the canonical Vim alias that terminals also emit as ESC).
 */
function isEscapeEvent(event: VimKeyEvent): boolean {
  if (event.name === "escape") return true;
  if (event.ctrl && (event.name === "[" || event.sequence === "\u001b")) return true;
  return false;
}

function countFromDigits(digits: string): number {
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

function lineEnd(text: string, offset: number): number {
  const end = text.indexOf("\n", offset);
  return end === -1 ? text.length : end;
}

function nextLineStart(text: string, offset: number): number {
  const end = text.indexOf("\n", offset);
  return end === -1 ? text.length : end + 1;
}

function previousLineStart(text: string, offset: number): number {
  const currentStart = lineStart(text, offset);
  if (currentStart === 0) return 0;
  return lineStart(text, currentStart - 1);
}

function columnAt(text: string, offset: number): number {
  return offset - lineStart(text, offset);
}

function moveVertical(text: string, offset: number, direction: -1 | 1, count: number): number {
  let target = clamp(offset, 0, text.length);
  const desiredColumn = columnAt(text, target);
  for (let i = 0; i < count; i++) {
    const nextStart = direction < 0 ? previousLineStart(text, target) : nextLineStart(text, target);
    if (nextStart === target || (direction > 0 && nextStart === text.length)) {
      target = direction > 0 ? text.length : nextStart;
      break;
    }
    target = nextStart;
  }
  return clamp(target + Math.min(desiredColumn, lineEnd(text, target) - target), 0, text.length);
}

function moveWordForward(text: string, offset: number, count: number): number {
  let cursor = clamp(offset, 0, text.length);
  for (let i = 0; i < count; i++) {
    while (cursor < text.length && /\w/.test(text[cursor])) cursor++;
    while (cursor < text.length && !/\w/.test(text[cursor])) cursor++;
  }
  return cursor;
}

function moveWordBackward(text: string, offset: number, count: number): number {
  let cursor = clamp(offset, 0, text.length);
  for (let i = 0; i < count; i++) {
    cursor = Math.max(0, cursor - 1);
    while (cursor > 0 && !/\w/.test(text[cursor])) cursor--;
    while (cursor > 0 && /\w/.test(text[cursor - 1])) cursor--;
  }
  return cursor;
}

function lineRange(text: string, offset: number, count: number): { start: number; end: number; cursor: number } {
  const start = lineStart(text, offset);
  let end = start;
  for (let i = 0; i < count; i++) {
    if (end >= text.length) {
      end = text.length;
      break;
    }
    const next = text.indexOf("\n", end);
    end = next === -1 ? text.length : next + 1;
  }
  return { start, end, cursor: Math.min(start, Math.max(0, text.length - (end - start))) };
}

function motionTarget(text: string, cursor: number, motion: string, count: number): number | null {
  switch (motion) {
    case "h":
    case "left":
      return clamp(cursor - count, 0, text.length);
    case "l":
    case "right":
      return clamp(cursor + count, 0, text.length);
    case "j":
    case "down":
      return moveVertical(text, cursor, 1, count);
    case "k":
    case "up":
      return moveVertical(text, cursor, -1, count);
    case "w":
      return moveWordForward(text, cursor, count);
    case "b":
      return moveWordBackward(text, cursor, count);
    case "0":
    case "^":
      return lineStart(text, cursor);
    case "$":
      return lineEnd(text, cursor);
    case "G":
      return text.length;
    default:
      return null;
  }
}

function applyMotion(editor: VimEditor, motion: string, count: number): void {
  const text = editor.text();
  const target = motionTarget(text, editor.cursor(), motion, count);
  if (target !== null) editor.setCursor(target);
}

function applyLineOperator(editor: VimEditor, operator: Operator, count: number): VimState {
  const text = editor.text();
  const range = lineRange(text, editor.cursor(), count);
  editor.replaceRange(range.start, range.end, "");
  editor.setCursor(range.cursor);
  return state(operator === "change" ? "insert" : "normal");
}

function applyOperator(
  editor: VimEditor,
  operator: Operator,
  motion: string,
  operatorCount: number,
  motionCount: number,
): VimState {
  const text = editor.text();
  const cursor = editor.cursor();
  const count = operatorCount * motionCount;
  if (motion === "d" && operator === "delete") return applyLineOperator(editor, operator, count);
  if (motion === "c" && operator === "change") return applyLineOperator(editor, operator, count);
  const target = motionTarget(text, cursor, motion, count);
  if (target === null) return state("normal");
  const start = Math.min(cursor, target);
  const end = Math.max(cursor, target);
  if (start !== end) editor.replaceRange(start, end, "");
  editor.setCursor(start);
  return state(operator === "change" ? "insert" : "normal");
}

function insertModeAt(editor: VimEditor, offset: number): VimState {
  editor.setCursor(offset);
  return state("insert");
}

function pendingLabel(pending: PendingCommand): string {
  switch (pending.type) {
    case "idle":
      return "";
    case "count":
      return pending.digits;
    case "operator":
      return `${pending.count > 1 ? pending.count : ""}${pending.operator === "delete" ? "d" : "c"}${pending.digits}`;
    case "g":
      return `${pending.count > 1 ? pending.count : ""}g`;
  }
}

export function getVimStatus(vimState: VimState): VimStatus {
  return { mode: vimState.mode, pending: pendingLabel(vimState.pending) };
}

export function shouldVimHandleEnter(vimState: VimState): boolean {
  if (vimState.mode === "visual" || vimState.mode === "visual-line") return true;
  return vimState.mode === "normal" && vimState.pending.type !== "idle";
}

/**
 * Inclusive character range for the current visual selection, or null if not in visual mode.
 * For visual-line mode, the range expands to whole lines covering both anchor and cursor.
 */
export function getVisualSelection(
  vimState: VimState,
  text: string,
  cursor: number,
): { start: number; end: number } | null {
  if (vimState.mode !== "visual" && vimState.mode !== "visual-line") return null;
  if (vimState.anchor === undefined) return null;
  const anchor = clamp(vimState.anchor, 0, text.length);
  const head = clamp(cursor, 0, text.length);
  if (vimState.mode === "visual") {
    const start = Math.min(anchor, head);
    // Visual is inclusive of the cursor character — extend end by one when text exists.
    const end = Math.min(text.length, Math.max(anchor, head) + 1);
    return { start, end };
  }
  // visual-line: expand to whole lines covering both endpoints
  const low = Math.min(anchor, head);
  const high = Math.max(anchor, head);
  return { start: lineStart(text, low), end: nextLineStart(text, high) };
}

function deleteVisualSelection(editor: VimEditor, vimState: VimState): VimState {
  const text = editor.text();
  const selection = getVisualSelection(vimState, text, editor.cursor());
  if (selection && selection.end > selection.start) {
    editor.replaceRange(selection.start, selection.end, "");
    editor.setCursor(selection.start);
  }
  return state("normal");
}

function changeVisualSelection(editor: VimEditor, vimState: VimState): VimState {
  const text = editor.text();
  const selection = getVisualSelection(vimState, text, editor.cursor());
  if (selection && selection.end > selection.start) {
    editor.replaceRange(selection.start, selection.end, "");
    editor.setCursor(selection.start);
  }
  return state("insert");
}

export function handleVimKey(
  editor: VimEditor,
  vimState: VimState,
  event: VimKeyEvent,
): { handled: boolean; state: VimState } {
  // Ctrl+[ is the classic Vim alias for Escape — accept it before the modifier bail-out.
  if (isEscapeEvent(event)) {
    if (vimState.mode === "insert") {
      event.preventDefault?.();
      return { handled: true, state: state("normal") };
    }
    if (vimState.mode === "visual" || vimState.mode === "visual-line") {
      event.preventDefault?.();
      return { handled: true, state: state("normal") };
    }
    // normal mode: cancel pending command
    event.preventDefault?.();
    return { handled: true, state: state("normal") };
  }

  if (event.ctrl || event.meta || event.option) return { handled: false, state: vimState };

  const text = editor.text();
  const key = keyValue(event);

  if (vimState.mode === "insert") {
    // Esc was already handled above. Let the textarea handle all other insert-mode input.
    return { handled: false, state: vimState };
  }

  // Visual / visual-line mode dispatch
  if (vimState.mode === "visual" || vimState.mode === "visual-line") {
    return handleVisualKey(editor, vimState, event, key, text);
  }

  // ---- Normal mode below ----

  // Pass-through non-printable global keys that vim does not own (e.g. F-keys).
  if (vimState.pending.type === "idle" && !isPrintableKey(key)) {
    if (key !== "left" && key !== "right" && key !== "up" && key !== "down" && key !== "return") {
      return { handled: false, state: vimState };
    }
  }

  if (event.name === "return") {
    if (vimState.pending.type === "idle") return { handled: false, state: vimState };
    event.preventDefault?.();
    return { handled: true, state: state("normal") };
  }

  let nextState: VimState;
  const pending = vimState.pending;

  if (pending.type === "operator") {
    if (isDigit(key)) {
      nextState = state("normal", { ...pending, digits: pending.digits + key });
    } else {
      nextState = applyOperator(editor, pending.operator, key, pending.count, countFromDigits(pending.digits));
    }
    event.preventDefault?.();
    return { handled: true, state: nextState };
  }

  if (pending.type === "g") {
    if (key === "g") {
      editor.setCursor(0);
    }
    event.preventDefault?.();
    return { handled: true, state: state("normal") };
  }

  const prefixCount = pending.type === "count" ? countFromDigits(pending.digits) : 1;

  if (isDigit(key) && !(key === "0" && pending.type === "idle")) {
    const digits = pending.type === "count" ? pending.digits + key : key;
    event.preventDefault?.();
    return { handled: true, state: state("normal", { type: "count", digits }) };
  }

  switch (key) {
    case "i":
      nextState = insertModeAt(editor, editor.cursor());
      break;
    case "a":
      nextState = insertModeAt(editor, Math.min(editor.cursor() + 1, text.length));
      break;
    case "I":
      nextState = insertModeAt(editor, lineStart(text, editor.cursor()));
      break;
    case "A":
      nextState = insertModeAt(editor, lineEnd(text, editor.cursor()));
      break;
    case "o":
      editor.setCursor(lineEnd(text, editor.cursor()));
      editor.insert("\n");
      nextState = state("insert");
      break;
    case "O": {
      const start = lineStart(text, editor.cursor());
      editor.setCursor(start);
      editor.insert("\n");
      editor.setCursor(start);
      nextState = state("insert");
      break;
    }
    case "v":
      nextState = state("visual", idle, editor.cursor());
      break;
    case "V":
      nextState = state("visual-line", idle, editor.cursor());
      break;
    case "d":
      nextState = state("normal", { type: "operator", operator: "delete", count: prefixCount, digits: "" });
      break;
    case "c":
      nextState = state("normal", { type: "operator", operator: "change", count: prefixCount, digits: "" });
      break;
    case "x":
      editor.replaceRange(editor.cursor(), Math.min(editor.cursor() + prefixCount, text.length), "");
      nextState = state("normal");
      break;
    case "X":
      editor.replaceRange(Math.max(0, editor.cursor() - prefixCount), editor.cursor(), "");
      nextState = state("normal");
      break;
    case "D":
      editor.replaceRange(editor.cursor(), lineEnd(text, editor.cursor()), "");
      nextState = state("normal");
      break;
    case "C":
      editor.replaceRange(editor.cursor(), lineEnd(text, editor.cursor()), "");
      nextState = state("insert");
      break;
    case "g":
      nextState = state("normal", { type: "g", count: prefixCount });
      break;
    default: {
      const target = motionTarget(text, editor.cursor(), key, prefixCount);
      if (target !== null) {
        applyMotion(editor, key, prefixCount);
      }
      nextState = state("normal");
      break;
    }
  }

  event.preventDefault?.();
  return { handled: true, state: nextState };
}

function handleVisualKey(
  editor: VimEditor,
  vimState: VimState,
  event: VimKeyEvent,
  key: string,
  text: string,
): { handled: boolean; state: VimState } {
  const anchor = vimState.anchor ?? editor.cursor();

  // 'v' / 'V' toggle off when re-pressed in the same visual mode; switch when different.
  if (key === "v") {
    event.preventDefault?.();
    if (vimState.mode === "visual") return { handled: true, state: state("normal") };
    return { handled: true, state: state("visual", idle, anchor) };
  }
  if (key === "V") {
    event.preventDefault?.();
    if (vimState.mode === "visual-line") return { handled: true, state: state("normal") };
    return { handled: true, state: state("visual-line", idle, anchor) };
  }

  // Operations on the selection
  if (key === "d" || key === "x") {
    event.preventDefault?.();
    return { handled: true, state: deleteVisualSelection(editor, vimState) };
  }
  if (key === "c" || key === "s") {
    event.preventDefault?.();
    return { handled: true, state: changeVisualSelection(editor, vimState) };
  }

  // Movement extends the selection by moving the cursor; anchor is preserved.
  const target = motionTarget(text, editor.cursor(), key, 1);
  if (target !== null) {
    editor.setCursor(target);
    event.preventDefault?.();
    return { handled: true, state: state(vimState.mode, idle, anchor) };
  }

  // Unknown printable key in visual mode: swallow to avoid accidental typing.
  if (isPrintableKey(key)) {
    event.preventDefault?.();
    return { handled: true, state: vimState };
  }

  return { handled: false, state: vimState };
}
