import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";
import { PNG } from "pngjs";
import { AcpPromptTooLargeError } from "../../src/effect/errors";
import { buildPromptContent, imageMimeForPath, type BuildPromptContentOptions } from "../../src/acp/prompt-content";

// 1x1 transparent PNG.
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const pathImageAttachmentNote = "Use the attached image content.";

function writeTmpPng(name: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "relay-img-"));
  const path = join(dir, name);
  writeFileSync(path, Buffer.from(pngBase64, "base64"));
  return { dir, path };
}

function build(text: string, options: BuildPromptContentOptions) {
  return Effect.runPromise(buildPromptContent(text, options));
}

function shellEscapeSpaces(filePath: string): string {
  return filePath.replace(/ /g, "\\ ");
}

describe("buildPromptContent", () => {
  test("returns only text when images are disabled", async () => {
    const blocks = await build("look at @foo.png", { includeImages: false });
    expect(blocks).toEqual([{ type: "text", text: "look at @foo.png" }]);
  });

  test("appends system reminders as hidden prefixed text blocks", async () => {
    const blocks = await build("visible prompt", {
      includeImages: false,
      systemReminders: ["keep it concise", "  ", "respect repo conventions\n"],
    });
    expect(blocks).toEqual([
      { type: "text", text: "visible prompt" },
      { type: "text", text: "system-reminder: keep it concise" },
      { type: "text", text: "system-reminder: respect repo conventions" },
    ]);
  });

  test("attaches image blocks for resolvable @path references", async () => {
    const { dir, path: imgPath } = writeTmpPng("pattern.png");
    const blocks = await build("whats in @pattern.png", { includeImages: true, cwd: dir });
    expect(blocks[0]).toEqual({ type: "text", text: "whats in @pattern.png" });
    const image = blocks.find((b) => b.type === "image");
    expect(image).toBeDefined();
    if (image && image.type === "image") {
      expect(image.mimeType).toBe("image/png");
      expect(image.data).toBe(pngBase64);
      expect(image.uri).toBe(`file://${imgPath}`);
    }
  });

  test("attaches sidecar image blocks referenced by image markers", async () => {
    const marker = "[image #1 photo.png]";
    const blocks = await build(`describe ${marker}`, {
      includeImages: true,
      images: [
        {
          id: 1,
          marker,
          data: pngBase64,
          mimeType: "image/png",
          byteLength: Buffer.byteLength(Buffer.from(pngBase64, "base64")),
          filename: "photo.png",
        },
      ],
    });

    expect(blocks[0]).toEqual({ type: "text", text: `describe ${marker}` });
    expect(blocks[1]).toEqual({ type: "image", data: pngBase64, mimeType: "image/png" });
    expect(blocks.some((b) => b.type === "text" && b.text === pathImageAttachmentNote)).toBe(false);
  });

  test("ignores unreferenced sidecar images", async () => {
    const blocks = await build("describe nothing", {
      includeImages: true,
      images: [
        {
          id: 1,
          marker: "[image #1 photo.png]",
          data: pngBase64,
          mimeType: "image/png",
          byteLength: Buffer.byteLength(Buffer.from(pngBase64, "base64")),
        },
      ],
    });

    expect(blocks).toEqual([{ type: "text", text: "describe nothing" }]);
  });

  test("ignores non-image and unresolvable references", async () => {
    const blocks = await build("see @missing.png and @notes.txt", { includeImages: true, cwd: tmpdir() });
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(0);
  });

  test("attaches bare pasted absolute image path (no @)", async () => {
    const { path: imgPath } = writeTmpPng("pasted.png");
    const blocks = await build(`what is in this image? ${imgPath}`, { includeImages: true });
    const image = blocks.find((b) => b.type === "image");
    expect(image).toBeDefined();
    if (image && image.type === "image") {
      expect(image.mimeType).toBe("image/png");
      expect(image.uri).toBe(`file://${imgPath}`);
    }
  });

  test("attaches file:// URI pasted path", async () => {
    const { path: imgPath } = writeTmpPng("drag drop.png");
    const blocks = await build(`look: file://${imgPath.replace(/ /g, "%20")}`, { includeImages: true });
    const image = blocks.find((b) => b.type === "image");
    expect(image).toBeDefined();
    if (image && image.type === "image") {
      expect(image.uri).toBe(`file://${imgPath}`);
    }
  });

  test("attaches quoted pasted path with spaces", async () => {
    const { path: imgPath } = writeTmpPng("my pic.png");
    const blocks = await build(`describe "${imgPath}"`, { includeImages: true });
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
  });

  test("attaches shell-escaped pasted paths with spaces", async () => {
    const { path: imgPath } = writeTmpPng("Screenshot 2026-06-05 at 9.20.35 AM.png");
    const blocks = await build(`describe ${shellEscapeSpaces(imgPath)}`, { includeImages: true });
    const image = blocks.find((b) => b.type === "image");
    expect(image).toBeDefined();
    if (image && image.type === "image") {
      expect(image.uri).toBe(`file://${imgPath}`);
    }
  });

  test("attaches unquoted @ references with spaces from file completion", async () => {
    const { dir, path: imgPath } = writeTmpPng("my pic.png");
    const blocks = await build("describe @my pic.png please", { includeImages: true, cwd: dir });
    const image = blocks.find((b) => b.type === "image");
    expect(image).toBeDefined();
    if (image && image.type === "image") {
      expect(image.uri).toBe(`file://${imgPath}`);
    }
  });

  test("does not duplicate when both @ and bare path resolve to same file", async () => {
    const { dir, path: imgPath } = writeTmpPng("dup.png");
    const blocks = await build(`@${imgPath} and again ${imgPath}`, { includeImages: true, cwd: dir });
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
  });

  test("does not match relative-looking incidental words", async () => {
    const blocks = await build("the bug is in src/logo.png handling", { includeImages: true, cwd: tmpdir() });
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(0);
  });

  test("imageMimeForPath maps known extensions", () => {
    expect(imageMimeForPath("a.PNG")).toBe("image/png");
    expect(imageMimeForPath("a.jpg")).toBe("image/jpeg");
    expect(imageMimeForPath("a.txt")).toBeUndefined();
  });

  test("downscales an oversized image to fit the byte budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-img-"));
    const imgPath = join(dir, "big.png");
    // Build a noisy 1200x1200 image that is large once encoded.
    const size = 1200;
    const png = new PNG({ width: size, height: size });
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const c = ((x * 2654435761) ^ (y * 40503)) >>> 0;
        const i = (y * size + x) * 4;
        png.data[i] = c & 0xff;
        png.data[i + 1] = (c >>> 8) & 0xff;
        png.data[i + 2] = (c >>> 16) & 0xff;
        png.data[i + 3] = 0xff;
      }
    }
    writeFileSync(imgPath, PNG.sync.write(png));

    const budget = 32 * 1024;
    const blocks = await build(`@${imgPath}`, {
      includeImages: true,
      cwd: dir,
      policy: { imageByteBudget: budget },
    });
    const image = blocks.find((b) => b.type === "image");
    expect(image).toBeDefined();
    if (image && image.type === "image") {
      expect(image.mimeType).toBe("image/jpeg");
      expect(image.data.length).toBeLessThanOrEqual(budget);
    }
  });

  test("skips an image that cannot fit the budget instead of attaching it", async () => {
    // SVG is not raster-resizable; an oversized one should be skipped.
    const dir = mkdtempSync(join(tmpdir(), "relay-img-"));
    const imgPath = join(dir, "huge.svg");
    const huge = `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${"x".repeat(5000)} --></svg>`;
    writeFileSync(imgPath, huge);

    const blocks = await build(`@${imgPath}`, {
      includeImages: true,
      cwd: dir,
      policy: { imageByteBudget: 1024 },
    });
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(0);
    expect(blocks[0]).toEqual({ type: "text", text: `@${imgPath}` });
  });

  test("does not insert a read-hint note by default", async () => {
    const { dir } = writeTmpPng("note.png");
    const blocks = await build("whats in @note.png", { includeImages: true, cwd: dir });
    expect(blocks.map((b) => b.type)).toEqual(["text", "image"]);
  });

  test("inserts a configured read-hint note immediately before attached path images", async () => {
    const { dir } = writeTmpPng("note.png");
    const blocks = await build("whats in @note.png", {
      includeImages: true,
      cwd: dir,
      policy: { pathImageAttachmentNote },
    });
    const noteIndex = blocks.findIndex((b) => b.type === "text" && b.text === pathImageAttachmentNote);
    const imageIndex = blocks.findIndex((b) => b.type === "image");
    expect(noteIndex).toBeGreaterThanOrEqual(0);
    expect(imageIndex).toBe(noteIndex + 1);
    // Original user text remains the first block.
    expect(blocks[0]).toEqual({ type: "text", text: "whats in @note.png" });
  });

  test("does not add the read-hint note when no image is attached", async () => {
    const blocks = await build("just text, no image here", {
      includeImages: true,
      cwd: tmpdir(),
      policy: { pathImageAttachmentNote },
    });
    expect(blocks.some((b) => b.type === "text" && b.text === pathImageAttachmentNote)).toBe(false);
  });

  test("fails before sending when the total prompt exceeds the budget", async () => {
    // Two images that each fit the per-image budget but together exceed the
    // (tiny) total budget should fail client-side with AcpPromptTooLargeError.
    const dir = mkdtempSync(join(tmpdir(), "relay-img-"));
    const aPath = join(dir, "a.png");
    const bPath = join(dir, "b.png");
    writeFileSync(aPath, Buffer.from(pngBase64, "base64"));
    writeFileSync(bPath, Buffer.from(pngBase64, "base64"));

    const exit = await Effect.runPromiseExit(
      buildPromptContent(`@${aPath} @${bPath}`, {
        includeImages: true,
        cwd: dir,
        policy: { promptByteBudget: 100 }, // absurdly small to force the guard
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(AcpPromptTooLargeError);
      if (error instanceof AcpPromptTooLargeError) {
        expect(error.maxBytes).toBe(100);
        expect(error.totalBytes).toBeGreaterThan(100);
      }
    }
  });

  test("does not apply the total-size guard to text-only prompts", async () => {
    // A huge text-only prompt is not blocked by the image total-size guard.
    const blocks = await build("x".repeat(200 * 1024), {
      includeImages: true,
      cwd: tmpdir(),
      policy: { promptByteBudget: 100 },
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
  });
});
