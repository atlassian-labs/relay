import { applyTextareaTextUpdate, getCursorOffset } from "./paste-textarea";

export interface VimEditor {
  text(): string;
  cursor(): number;
  setCursor(offset: number): void;
  replaceRange(start: number, end: number, replacement: string): void;
  insert(text: string): void;
}

interface TextareaEditBuffer {
  getText?: () => string;
  replaceText?: (text: string) => void;
  setCursorByOffset?: (offset: number) => void;
}

export interface VimTextareaRef {
  plainText?: string;
  cursorOffset?: number;
  editBuffer?: TextareaEditBuffer;
  setText?: (text: string) => void;
  insertText?: (text: string) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export function createTextareaVimEditor(ref: VimTextareaRef): VimEditor {
  const readText = () => ref.plainText ?? ref.editBuffer?.getText?.() ?? "";

  const setCursor = (offset: number) => {
    const text = readText();
    const clamped = clamp(offset, 0, text.length);
    try {
      ref.editBuffer?.setCursorByOffset?.(clamped);
    } catch {}
    try {
      ref.cursorOffset = clamped;
    } catch {}
  };

  return {
    text: readText,
    cursor: () => {
      const text = readText();
      return clamp(ref.cursorOffset ?? getCursorOffset(ref, text), 0, text.length);
    },
    setCursor,
    replaceRange: (start: number, end: number, replacement: string) => {
      const text = readText();
      const rangeStart = clamp(Math.min(start, end), 0, text.length);
      const rangeEnd = clamp(Math.max(start, end), 0, text.length);
      const nextText = text.slice(0, rangeStart) + replacement + text.slice(rangeEnd);
      applyTextareaTextUpdate(ref, nextText, rangeStart + replacement.length);
    },
    insert: (insertedText: string) => {
      const text = readText();
      const cursor = clamp(ref.cursorOffset ?? getCursorOffset(ref, text), 0, text.length);
      if (typeof ref.insertText === "function") {
        ref.insertText(insertedText);
        return;
      }
      applyTextareaTextUpdate(
        ref,
        text.slice(0, cursor) + insertedText + text.slice(cursor),
        cursor + insertedText.length,
      );
    },
  };
}
