import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openTextInExternalEditor } from "../../../src/ui/util/external-editor";

function countRelayTempDirs(): number {
  return readdirSync(tmpdir()).filter((entry) => entry.startsWith("relay-editor-")).length;
}

function makeFakeEditor(body: string): string {
  // Build a tiny shell script that overwrites the file we are handed with a
  // deterministic payload. Used as the editor binary for these tests.
  const dir = mkdtempSync(join(tmpdir(), "relay-fake-editor-"));
  const editor = join(dir, "editor.sh");
  writeFileSync(editor, ["#!/bin/sh", 'cat > "$1" <<"EOF"', body, "EOF", ""].join("\n"), { encoding: "utf-8" });
  chmodSync(editor, 0o755);
  return editor;
}

function makeIdleEditor(): string {
  // Editor that exits 0 without touching the file - simulates the user closing
  // vim without writing.
  const dir = mkdtempSync(join(tmpdir(), "relay-idle-editor-"));
  const editor = join(dir, "noop.sh");
  writeFileSync(editor, "#!/bin/sh\nexit 0\n", { encoding: "utf-8" });
  chmodSync(editor, 0o755);
  return editor;
}

describe("openTextInExternalEditor", () => {
  test("captures edits the user saved in the external editor", async () => {
    const editor = makeFakeEditor("hello from editor\n");
    const result = await openTextInExternalEditor({ text: "draft", editorCommand: editor });

    expect(result.changed).toBe(true);
    expect(result.text).toBe("hello from editor");
    expect(result.exitCode).toBe(0);
  });

  test("returns the original text untouched when the editor does not save", async () => {
    const editor = makeIdleEditor();
    const result = await openTextInExternalEditor({ text: "untouched", editorCommand: editor });

    expect(result.changed).toBe(false);
    expect(result.text).toBe("untouched");
    expect(result.exitCode).toBe(0);
  });

  test("returns the original text when the editor binary is missing", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "relay-missing-editor-")), "does-not-exist");
    mkdirSync(join(missing, ".."), { recursive: true });

    const result = await openTextInExternalEditor({ text: "keep me", editorCommand: missing });

    expect(result.changed).toBe(false);
    expect(result.text).toBe("keep me");
    expect(result.exitCode).toBeNull();
  });

  test("removes the temp directory after every invocation, even when editors leave swap files behind", async () => {
    // Editor that drops a vim-style swap file next to the prompt file before
    // exiting without saving. The wrapping temp dir must still be cleaned up
    // so we don't leak directories on every F2 press.
    const dir = mkdtempSync(join(tmpdir(), "relay-leaky-editor-"));
    const editor = join(dir, "leaky.sh");
    writeFileSync(editor, ["#!/bin/sh", 'touch "$(dirname "$1")/.prompt.md.swp"', "exit 0", ""].join("\n"), {
      encoding: "utf-8",
    });
    chmodSync(editor, 0o755);

    const baseline = countRelayTempDirs();
    const result = await openTextInExternalEditor({ text: "draft", editorCommand: editor });

    expect(result.changed).toBe(false);
    expect(countRelayTempDirs()).toBe(baseline);
    expect(existsSync(dir)).toBe(true); // sanity: only the editor's own dir survives, not relay-editor-*
  });
});
