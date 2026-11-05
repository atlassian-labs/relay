import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PasteStore, handlePasteEvent } from "../../../src/ui/paste";
import { createPromptSubmission, promptImageStore } from "../../../src/ui/prompt-images";
import { insertImagePathAtCursor } from "../../../src/ui/util/paste-textarea";

// 1x1 transparent PNG.
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function writeTmpImage(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-paste-img-"));
  const path = join(dir, name);
  writeFileSync(path, Buffer.from(pngBase64, "base64"));
  return path;
}

function shellEscapeSpaces(filePath: string): string {
  return filePath.replace(/ /g, "\\ ");
}

function expectSidecar(marker: string, sourcePath: string, filename: string): void {
  expect(createPromptSubmission(marker).images).toEqual([
    expect.objectContaining({ marker, sourcePath, filename, mimeType: "image/png" }),
  ]);
}

describe("PasteStore image markers", () => {
  beforeEach(() => promptImageStore.reset());
  test("collapses a pasted image path to [image #N name] showing only the file name", () => {
    const store = new PasteStore();
    const imgPath = writeTmpImage("photo.png");
    const marker = store.transformPaste(imgPath);
    expect(marker).toBe("[image #1 photo.png]");
    // Marker must not contain the directory path, only the file name.
    expect(marker).not.toContain("/");
  });

  test("keeps the image marker in text and stores image bytes as a sidecar", () => {
    const store = new PasteStore();
    const imgPath = writeTmpImage("pic.jpg");
    const marker = store.transformPaste(imgPath);
    expect(store.expandPasteMarkers(marker)).toBe(marker);
    expectSidecar(marker, imgPath, "pic.jpg");
  });

  test("strips surrounding quotes from a dragged path", () => {
    const store = new PasteStore();
    const imgPath = writeTmpImage("dragged.png");
    const marker = store.transformPaste(`"${imgPath}"`);
    expect(marker).toBe("[image #1 dragged.png]");
    expect(store.expandPasteMarkers(marker)).toBe(marker);
    expectSidecar(marker, imgPath, "dragged.png");
  });

  test("handles a file:// URI paste", () => {
    const store = new PasteStore();
    const imgPath = writeTmpImage("uri pic.png");
    const marker = store.transformPaste(`file://${imgPath.replace(/ /g, "%20")}`);
    expect(marker).toBe("[image #1 uri pic.png]");
    expect(store.expandPasteMarkers(marker)).toBe(marker);
    expectSidecar(marker, imgPath, "uri pic.png");
  });

  test("handles a shell-escaped image path paste", () => {
    const store = new PasteStore();
    const imgPath = writeTmpImage("Screenshot 2026-06-05 at 9.20.35 AM.png");
    const marker = store.transformPaste(shellEscapeSpaces(imgPath));
    expect(marker).toBe("[image #1 Screenshot 2026-06-05 at 9.20.35 AM.png]");
    expect(store.expandPasteMarkers(marker)).toBe(marker);
    expectSidecar(marker, imgPath, "Screenshot 2026-06-05 at 9.20.35 AM.png");
  });

  test("treats the image marker as an atomic placeholder", () => {
    const store = new PasteStore();
    const imgPath = writeTmpImage("atomic.png");
    const marker = store.transformPaste(imgPath);
    const spans = store.findAllPlaceholders(`see ${marker} here`);
    expect(spans).toHaveLength(1);
    expect(spans[0].marker).toBe(marker);
    expect(spans[0].kind).toBe("image");
    expect(store.hasPasteMarkers(marker)).toBe(true);
  });

  test("paste events insert image markers in place in the editor", () => {
    const store = new PasteStore();
    const imgPath = writeTmpImage("row.png");
    const result = handlePasteEvent(store, imgPath, "describe this", false, null);

    expect(result).toEqual({
      handled: true,
      insertText: "[image #1 row.png]",
      preventDefault: true,
    });
  });

  test("attaches an image path at the editor cursor with sidecar data", () => {
    const store = new PasteStore();
    const imgPath = writeTmpImage("sketch.png");
    let text = "look: ";
    const ref = {
      get plainText() {
        return text;
      },
      cursorOffset: text.length,
      hasSelection: () => false,
      setText: (value: string) => {
        text = value;
      },
    };

    expect(insertImagePathAtCursor(ref, store, imgPath)).toBe(true);
    expect(text).toBe("look: [image #1 sketch.png]");
    expectSidecar("[image #1 sketch.png]", imgPath, "sketch.png");
  });

  test("does not create a marker for a non-existent image path", () => {
    const store = new PasteStore();
    const result = store.transformPaste("/tmp/does-not-exist-12345.png");
    expect(result).toBe("/tmp/does-not-exist-12345.png");
  });

  test("does not create a marker for a non-image file path", () => {
    const store = new PasteStore();
    const txtPath = writeTmpImage("notes.txt");
    const result = store.transformPaste(txtPath);
    expect(result).toBe(txtPath);
  });

  test("does not treat a relative path as an image marker", () => {
    const store = new PasteStore();
    const result = store.transformPaste("src/logo.png");
    expect(result).toBe("src/logo.png");
  });
});
