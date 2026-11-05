/**
 * Image downscaling for ACP image prompt blocks.
 *
 * WHY
 * ACP transports (notably alta's local dev queue store) cap the size of a single
 * prompt message at 128 KiB. A raw screenshot/photo easily blows past that once
 * base64-encoded, which surfaces to the user as an opaque "Internal error:
 * Failed to send prompt". To avoid that we shrink images before attaching them
 * so the encoded payload fits within a byte budget, re-encoding to JPEG and
 * stepping dimensions/quality down until it fits.
 *
 * LIBS + WHY (and what we deliberately did NOT use)
 *   - The resize math (box-filter downscale) is trivial and we own it below.
 *   - The hard part is decoding/encoding compressed formats. JPEG in particular
 *     (DCT/Huffman) is not something to hand-roll, so we use codecs.
 *   - We use `pngjs` (PNG) + `jpeg-js` (JPEG): two pure-JS, ZERO-dependency
 *     packages. Together they cover the formats that are both common AND commonly
 *     oversized (PNG screenshots, JPEG photos).
 *   - We rejected `jimp`: it pulls ~37 packages (gif/tiff/bmp/exif/file-type/...)
 *     for the same two-format job and bloats the lockfile. Its modular subset is
 *     still ~15-20 packages because `@jimp/core` drags in file-type et al.
 *   - `pngjs` ships no types; see src/types/pngjs.d.ts (a minimal local decl,
 *     chosen over adding the `@types/pngjs` dev dependency).
 *
 * FORMATS
 *   - Resizable here: png, jpeg (RESIZABLE_MIME).
 *   - Not resized: gif, webp, bmp, svg — sent as-is by the caller when already
 *     under budget, otherwise skipped with a log. (vs jimp we only lose resize
 *     for bmp/gif/tiff, all rare; webp/heic/avif are unsupported by jimp too.)
 *   - heic/avif (e.g. iPhone photos) are unsupported by every pure-JS option;
 *     supporting them would need a heavy native lib.
 *
 * TODO(image-formats): if oversized webp/gif turn out common in practice, add a
 *   webp/gif decode path (e.g. a small wasm codec) rather than reaching for jimp.
 */

import { Effect } from "effect";
import * as jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { RelayError } from "../effect/errors";
import { getRelayLogger } from "../logging/logger";

export interface EncodedImage {
  readonly data: string; // base64, no newlines
  readonly mimeType: string;
}

interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array; // RGBA, 4 bytes per pixel, row-major
}

// Base64 expands bytes by 4/3 (no newlines from Buffer.toString("base64")).
export function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

// Dimension caps (longest edge) and JPEG qualities tried, most-detailed first.
const MAX_EDGE_STEPS = [1568, 1280, 1024, 768, 512, 384, 256] as const;
const QUALITY_STEPS = [80, 65, 50, 35] as const;

// Formats we can raster-decode and re-encode. Limited to the raster types that
// are common and commonly oversized; gif/webp/bmp/svg are left for the caller's
// size check.
const RESIZABLE_MIME = new Set(["image/png", "image/jpeg"]);

function isResizableMime(mimeType: string): boolean {
  return RESIZABLE_MIME.has(mimeType);
}

function decodeImage(bytes: Uint8Array, mimeType: string): RgbaImage {
  if (mimeType === "image/png") {
    const png = PNG.sync.read(Buffer.from(bytes));
    return { width: png.width, height: png.height, data: png.data };
  }
  // image/jpeg
  const raw = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  return { width: raw.width, height: raw.height, data: raw.data };
}

/**
 * Downscale RGBA pixels with a box filter (average of the source pixels that map
 * to each destination pixel). Box averaging is the correct algorithm for
 * shrinking and avoids the aliasing of nearest-neighbor. Only used for
 * downscaling, so destination dimensions are always <= source.
 */
function downscale(image: RgbaImage, targetWidth: number, targetHeight: number): RgbaImage {
  const { width: srcW, height: srcH, data: src } = image;
  if (targetWidth >= srcW && targetHeight >= srcH) return image;
  const dstW = Math.max(1, targetWidth);
  const dstH = Math.max(1, targetHeight);
  const dst = new Uint8Array(dstW * dstH * 4);
  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = Math.floor((dy * srcH) / dstH);
    const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * srcH) / dstH));
    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = Math.floor((dx * srcW) / dstW);
      const sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * srcW) / dstW));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const si = (sy * srcW + sx) * 4;
          r += src[si];
          g += src[si + 1];
          b += src[si + 2];
          a += src[si + 3];
          count++;
        }
      }
      const di = (dy * dstW + dx) * 4;
      dst[di] = Math.round(r / count);
      dst[di + 1] = Math.round(g / count);
      dst[di + 2] = Math.round(b / count);
      dst[di + 3] = Math.round(a / count);
    }
  }
  return { width: dstW, height: dstH, data: dst };
}

function encodeJpeg(image: RgbaImage, quality: number): Uint8Array {
  return jpeg.encode({ data: image.data, width: image.width, height: image.height }, quality).data;
}

function encodeToBudget(bytes: Uint8Array, mimeType: string, maxEncodedBytes: number): EncodedImage | null {
  const originalEncoded = base64Length(bytes.byteLength);
  if (originalEncoded <= maxEncodedBytes) {
    return { data: Buffer.from(bytes).toString("base64"), mimeType };
  }

  if (!isResizableMime(mimeType)) {
    getRelayLogger().warn("acp.prompt.image.too_large", {
      mimeType,
      encodedBytes: originalEncoded,
      maxEncodedBytes,
      resizable: false,
    });
    return null;
  }

  const decoded = decodeImage(bytes, mimeType);
  const longestEdge = Math.max(decoded.width, decoded.height);
  for (const maxEdge of MAX_EDGE_STEPS) {
    // Skip steps that would upscale; always allow the smallest step as a floor.
    if (maxEdge >= longestEdge && maxEdge !== MAX_EDGE_STEPS[MAX_EDGE_STEPS.length - 1]) continue;
    const scale = Math.min(1, maxEdge / longestEdge);
    const candidate =
      scale < 1
        ? downscale(
            decoded,
            Math.max(1, Math.round(decoded.width * scale)),
            Math.max(1, Math.round(decoded.height * scale)),
          )
        : decoded;
    for (const quality of QUALITY_STEPS) {
      const buf = encodeJpeg(candidate, quality);
      if (base64Length(buf.length) <= maxEncodedBytes) {
        return { data: Buffer.from(buf).toString("base64"), mimeType: "image/jpeg" };
      }
    }
  }

  getRelayLogger().warn("acp.prompt.image.too_large", {
    mimeType,
    encodedBytes: originalEncoded,
    maxEncodedBytes,
    resizable: true,
  });
  return null;
}

/**
 * Fit an image's bytes into `maxEncodedBytes` (measured as base64 length).
 *
 * Yields the smallest acceptable encoding:
 *  - if the original already fits, it is returned unchanged
 *  - otherwise, for resizable formats (png/jpeg), the image is downscaled and
 *    re-encoded as JPEG until it fits the budget
 *  - yields null when it cannot be made to fit (unresizable format that is too
 *    large, or decoding failed)
 */
export function fitImageToBudget(
  bytes: Uint8Array,
  mimeType: string,
  maxEncodedBytes: number,
): Effect.Effect<EncodedImage | null> {
  return Effect.try({
    try: () => encodeToBudget(bytes, mimeType, maxEncodedBytes),
    catch: (cause) => new RelayError({ message: "Failed to resize image for ACP prompt", cause }),
  }).pipe(
    Effect.catch((error: RelayError) =>
      Effect.sync(() => {
        getRelayLogger().warn("acp.prompt.image.decode.error", { mimeType, error: error.message });
        return null;
      }),
    ),
  );
}
