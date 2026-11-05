import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { readClipboardImage, type ClipboardCommandRunner } from "../../../src/ui/util/clipboard-image";

// 1x1 transparent PNG.
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const pngBytes = Buffer.from(pngBase64, "base64");

function tmpPngPath(name = "clip.png"): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-clip-img-"));
  const filePath = join(dir, name);
  writeFileSync(filePath, pngBytes);
  return filePath;
}

describe("readClipboardImage", () => {
  test("reads macOS PNG clipboard data through osascript temp file", async () => {
    const tempFilePath = join(mkdtempSync(join(tmpdir(), "relay-clip-mac-")), "clipboard.png");
    const commands: string[] = [];
    const runCommand: ClipboardCommandRunner = (command, args) => {
      commands.push(`${command} ${args.join(" ")}`);
      if (command === "osascript") {
        writeFileSync(tempFilePath, pngBytes);
        return Effect.succeed(Buffer.alloc(0));
      }
      return Effect.fail(new Error("unexpected command"));
    };

    const source = await Effect.runPromise(readClipboardImage({ platform: "darwin", runCommand, tempFilePath }));

    expect(source?.filename).toBe("clipboard.png");
    expect(source?.bytes.equals(pngBytes)).toBe(true);
    expect(commands[0]).toContain("«class PNGf»");
  });

  test("falls back to a clipboard image path on macOS", async () => {
    const imagePath = tmpPngPath("path fallback.png");
    const runCommand: ClipboardCommandRunner = (command) => {
      if (command === "osascript") return Effect.fail(new Error("no image bytes"));
      if (command === "pbpaste") return Effect.succeed(Buffer.from(imagePath));
      return Effect.fail(new Error("unexpected command"));
    };

    const source = await Effect.runPromise(readClipboardImage({ platform: "darwin", runCommand }));

    expect(source?.sourcePath).toBe(imagePath);
    expect(source?.filename).toBe("path fallback.png");
    expect(source?.bytes.equals(pngBytes)).toBe(true);
  });

  test("reads Wayland image/png clipboard bytes on Linux", async () => {
    const runCommand: ClipboardCommandRunner = (command, args) => {
      if (command === "wl-paste" && args.join(" ") === "--type image/png") return Effect.succeed(pngBytes);
      return Effect.fail(new Error("unexpected command"));
    };

    const source = await Effect.runPromise(readClipboardImage({ platform: "linux", runCommand }));

    expect(source?.filename).toBe("clipboard.png");
    expect(source?.bytes.equals(pngBytes)).toBe(true);
  });

  test("returns null on unsupported platforms", async () => {
    const source = await Effect.runPromise(readClipboardImage({ platform: "win32" }));
    expect(source).toBeNull();
  });
});
