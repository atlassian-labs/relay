import { describe, expect, test } from "bun:test";
import { createTextareaVimEditor, type VimTextareaRef } from "../../../src/ui/util/vim-editor";

class FakeEditBuffer {
  cursor = { line: 0, column: 0 };

  constructor(private ref: VimTextareaRef & { plainText: string }) {}

  getText(): string {
    return this.ref.plainText;
  }

  replaceText(text: string): void {
    this.ref.plainText = text;
  }

  setCursorByOffset(offset: number): void {
    this.ref.cursorOffset = Math.max(0, Math.min(offset, this.ref.plainText.length));
  }
}

describe("textarea vim editor adapter", () => {
  test("replaces clamped ranges and positions the cursor after replacement", () => {
    const ref: VimTextareaRef & { plainText: string } = { plainText: "hello world", cursorOffset: 5 };
    ref.editBuffer = new FakeEditBuffer(ref);
    const editor = createTextareaVimEditor(ref);

    editor.replaceRange(6, 99, "Relay");

    expect(ref.plainText).toBe("hello Relay");
    expect(ref.cursorOffset).toBe(11);
  });

  test("reads logical cursor when cursorOffset is unavailable", () => {
    const ref = { plainText: "one\ntwo", editBuffer: undefined as FakeEditBuffer | undefined };
    ref.editBuffer = new FakeEditBuffer(ref);
    ref.editBuffer.cursor = { line: 1, column: 1 };
    const editor = createTextareaVimEditor(ref);

    expect(editor.cursor()).toBe(5);
  });
});
