import { describe, expect, test } from "bun:test";
import {
  getVimStatus,
  handleVimKey,
  initialVimState,
  type VimKeyEvent,
  type VimState,
} from "../../../src/ui/util/vim-engine";
import type { VimEditor } from "../../../src/ui/util/vim-editor";

class FixtureEditor implements VimEditor {
  private value: string;
  private offset: number;

  constructor(fixture: string) {
    const marker = fixture.indexOf("ˇ");
    if (marker === -1) throw new Error(`Missing cursor marker: ${fixture}`);
    this.value = fixture.slice(0, marker) + fixture.slice(marker + 1);
    this.offset = marker;
  }

  text(): string {
    return this.value;
  }

  cursor(): number {
    return this.offset;
  }

  setCursor(offset: number): void {
    this.offset = Math.max(0, Math.min(offset, this.value.length));
  }

  replaceRange(start: number, end: number, replacement: string): void {
    const rangeStart = Math.max(0, Math.min(start, end, this.value.length));
    const rangeEnd = Math.max(0, Math.min(Math.max(start, end), this.value.length));
    this.value = this.value.slice(0, rangeStart) + replacement + this.value.slice(rangeEnd);
    this.setCursor(rangeStart + replacement.length);
  }

  insert(text: string): void {
    this.value = this.value.slice(0, this.offset) + text + this.value.slice(this.offset);
    this.offset += text.length;
  }

  fixture(): string {
    return `${this.value.slice(0, this.offset)}ˇ${this.value.slice(this.offset)}`;
  }
}

function eventFor(input: string): VimKeyEvent {
  if (input === "Esc") return { name: "escape", sequence: "\u001b", preventDefault: () => {} };
  if (input === "Enter") return { name: "return", sequence: "\r", preventDefault: () => {} };
  if (input === "Left") return { name: "left", preventDefault: () => {} };
  if (input === "Right") return { name: "right", preventDefault: () => {} };
  if (input === "Up") return { name: "up", preventDefault: () => {} };
  if (input === "Down") return { name: "down", preventDefault: () => {} };
  return { name: input, sequence: input, preventDefault: () => {} };
}

function run(fixture: string, inputs: string[]): { editor: FixtureEditor; state: VimState } {
  const editor = new FixtureEditor(fixture);
  let state = initialVimState;
  for (const input of inputs) {
    const result = handleVimKey(editor, state, eventFor(input));
    state = result.state;
  }
  return { editor, state };
}

describe("vim engine", () => {
  test("Escape enters visible normal mode without changing text", () => {
    const { editor, state } = run("helloˇ", ["Esc"]);

    expect(editor.fixture()).toBe("helloˇ");
    expect(getVimStatus(state)).toEqual({ mode: "normal", pending: "" });
  });

  test("normal-mode movement does not insert command characters", () => {
    const { editor, state } = run("heˇllo", ["Esc", "h"]);

    expect(editor.fixture()).toBe("hˇello");
    expect(getVimStatus(state)).toEqual({ mode: "normal", pending: "" });
  });

  test("operator delete word composes d with w", () => {
    const { editor, state } = run("one ˇtwo three", ["Esc", "d", "w"]);

    expect(editor.fixture()).toBe("one ˇthree");
    expect(getVimStatus(state).mode).toBe("normal");
  });

  test("linewise delete supports dd and counts", () => {
    const { editor } = run("one\nˇtwo\nthree\nfour", ["Esc", "2", "d", "d"]);

    expect(editor.fixture()).toBe("one\nˇfour");
  });

  test("change line enters insert mode", () => {
    const { editor, state } = run("one\nˇtwo\nthree", ["Esc", "c", "c"]);

    expect(editor.fixture()).toBe("one\nˇthree");
    expect(getVimStatus(state)).toEqual({ mode: "insert", pending: "" });
  });

  test("pending commands are visible and cancelable", () => {
    const editor = new FixtureEditor("one ˇtwo");
    const pending = handleVimKey(editor, { mode: "normal", pending: { type: "idle" } }, eventFor("d")).state;

    expect(getVimStatus(pending)).toEqual({ mode: "normal", pending: "d" });

    const cancelled = handleVimKey(editor, pending, eventFor("Esc")).state;

    expect(editor.fixture()).toBe("one ˇtwo");
    expect(getVimStatus(cancelled)).toEqual({ mode: "normal", pending: "" });
  });

  test("gg and G navigate buffer boundaries", () => {
    expect(run("one\ntwo\nthreeˇ", ["Esc", "g", "g"]).editor.fixture()).toBe("ˇone\ntwo\nthree");
    expect(run("ˇone\ntwo\nthree", ["Esc", "G"]).editor.fixture()).toBe("one\ntwo\nthreeˇ");
  });

  test("O opens a line above the current line and leaves the cursor on that new line", () => {
    const { editor, state } = run("one\nˇtwo", ["Esc", "O"]);

    expect(editor.fixture()).toBe("one\nˇ\ntwo");
    expect(getVimStatus(state)).toEqual({ mode: "insert", pending: "" });
  });

  test("normal mode does not handle unknown non-printable global keys", () => {
    const editor = new FixtureEditor("helloˇ");
    const result = handleVimKey(editor, { mode: "normal", pending: { type: "idle" } }, { name: "f2" });

    expect(result.handled).toBe(false);
    expect(editor.fixture()).toBe("helloˇ");
  });

  test("normal-mode Enter is not handled when no command is pending", () => {
    const editor = new FixtureEditor("helloˇ");
    const result = handleVimKey(editor, { mode: "normal", pending: { type: "idle" } }, eventFor("Enter"));

    expect(result.handled).toBe(false);
    expect(result.state.mode).toBe("normal");
  });

  test("Escape switches insert to normal even when the buffer is empty", () => {
    const editor = new FixtureEditor("ˇ");
    const result = handleVimKey(editor, initialVimState, eventFor("Esc"));

    expect(result.handled).toBe(true);
    expect(result.state.mode).toBe("normal");
    expect(editor.fixture()).toBe("ˇ");
  });

  test("Ctrl+[ behaves as Escape from insert mode", () => {
    const editor = new FixtureEditor("helloˇ");
    const result = handleVimKey(editor, initialVimState, {
      name: "[",
      sequence: "[",
      ctrl: true,
      preventDefault: () => {},
    });

    expect(result.handled).toBe(true);
    expect(result.state.mode).toBe("normal");
    expect(editor.fixture()).toBe("helloˇ");
  });

  test("i enters insert mode without leaving the letter behind even on empty buffer", () => {
    const editor = new FixtureEditor("ˇ");
    const afterEsc = handleVimKey(editor, initialVimState, eventFor("Esc"));
    expect(afterEsc.state.mode).toBe("normal");

    const result = handleVimKey(editor, afterEsc.state, eventFor("i"));

    expect(result.handled).toBe(true);
    expect(result.state.mode).toBe("insert");
    expect(editor.fixture()).toBe("ˇ");
  });

  test("visual mode anchors selection and d deletes the highlighted range", () => {
    const editor = new FixtureEditor("heˇllo world");
    const enterNormal = handleVimKey(editor, initialVimState, eventFor("Esc"));
    const enterVisual = handleVimKey(editor, enterNormal.state, eventFor("v"));
    expect(enterVisual.state.mode).toBe("visual");
    expect(enterVisual.state.anchor).toBe(editor.cursor());

    const extended = handleVimKey(editor, enterVisual.state, eventFor("l"));
    expect(extended.state.mode).toBe("visual");
    // selection now spans 'l' and 'l' inclusively
    const deleted = handleVimKey(editor, extended.state, eventFor("d"));

    expect(deleted.handled).toBe(true);
    expect(deleted.state.mode).toBe("normal");
    expect(editor.fixture()).toBe("heˇo world");
  });

  test("visual-line selects whole lines and c replaces them into insert mode", () => {
    const editor = new FixtureEditor("one\ntˇwo\nthree");
    const normal = handleVimKey(editor, initialVimState, eventFor("Esc"));
    const visualLine = handleVimKey(editor, normal.state, eventFor("V"));
    expect(visualLine.state.mode).toBe("visual-line");

    const changed = handleVimKey(editor, visualLine.state, eventFor("c"));

    expect(changed.state.mode).toBe("insert");
    expect(editor.fixture()).toBe("one\nˇthree");
  });

  test("Escape from visual mode returns to normal without modifying text", () => {
    const editor = new FixtureEditor("heˇllo");
    const normal = handleVimKey(editor, initialVimState, eventFor("Esc"));
    const visual = handleVimKey(editor, normal.state, eventFor("v"));
    const extended = handleVimKey(editor, visual.state, eventFor("l"));

    const escaped = handleVimKey(editor, extended.state, eventFor("Esc"));

    expect(escaped.state.mode).toBe("normal");
    expect(editor.fixture()).toBe("helˇlo");
  });

  test("getVimStatus reports visual modes for the status line", () => {
    expect(getVimStatus({ mode: "visual", pending: { type: "idle" }, anchor: 0 })).toEqual({
      mode: "visual",
      pending: "",
    });
    expect(getVimStatus({ mode: "visual-line", pending: { type: "idle" }, anchor: 0 })).toEqual({
      mode: "visual-line",
      pending: "",
    });
  });
});
