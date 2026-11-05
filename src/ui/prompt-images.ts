import * as path from "node:path";
import { existsSync, readFileSync, statSync } from "../platform/fs";
import { getHomeEnv } from "../platform/env";
import type { PromptImageAttachment, PromptSubmission } from "../core/prompt-submission";

export const PROMPT_IMAGE_OMITTED_HISTORY_MARKER = "[image omitted from history]";

const PROMPT_IMAGE_MARKER_RE = /\[image #(\d+) [^\]]*\]/g;
const IMAGE_PATH_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

export interface PromptImageSource {
  readonly bytes: Buffer;
  readonly filename?: string;
  readonly sourcePath?: string;
}

export type PromptImageLoadResult =
  | { readonly ok: true; readonly attachment: PromptImageAttachment }
  | { readonly ok: false; readonly message: string };

export interface PromptImageMarkerSpan {
  readonly start: number;
  readonly end: number;
  readonly marker: string;
  readonly imageId: number;
}

export function hasPromptImageMarkers(text: string): boolean {
  return /\[image #\d+ /.test(text);
}

export function findPromptImageMarkers(text: string): PromptImageMarkerSpan[] {
  const results: PromptImageMarkerSpan[] = [];
  const re = new RegExp(PROMPT_IMAGE_MARKER_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    results.push({
      start: match.index,
      end: match.index + match[0].length,
      marker: match[0],
      imageId: Number.parseInt(match[1], 10),
    });
  }
  return results;
}

export interface PromptImageAttachmentLayout {
  readonly bodyText: string;
  readonly markers: readonly string[];
  readonly attachmentRow: string;
}

export type PromptImageMarkerSegment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly text: string; readonly imageId: number };

export function promptImageMarkerSegments(text: string): PromptImageMarkerSegment[] {
  const spans = findPromptImageMarkers(text);
  if (spans.length === 0) return [{ type: "text", text }];

  const segments: PromptImageMarkerSegment[] = [];
  let offset = 0;
  for (const span of spans) {
    if (span.start > offset) segments.push({ type: "text", text: text.slice(offset, span.start) });
    segments.push({ type: "image", text: span.marker, imageId: span.imageId });
    offset = span.end;
  }
  if (offset < text.length) segments.push({ type: "text", text: text.slice(offset) });
  return segments;
}

export function promptImageAttachmentMarkers(text: string): string[] {
  const seen = new Set<number>();
  const markers: string[] = [];
  for (const span of findPromptImageMarkers(text)) {
    if (seen.has(span.imageId)) continue;
    seen.add(span.imageId);
    markers.push(span.marker);
  }
  return markers;
}

function removePromptImageMarkersFromLine(line: string): string {
  if (!hasPromptImageMarkers(line)) return line;
  const leadingWhitespace = line.match(/^[\t ]*/)?.[0] ?? "";
  const content = line
    .slice(leadingWhitespace.length)
    .replace(PROMPT_IMAGE_MARKER_RE, "")
    .replace(/[\t ]{2,}/g, " ")
    .replace(/[\t ]+$/g, "");
  return `${leadingWhitespace}${content}`;
}

export function promptImageAttachmentLayout(text: string): PromptImageAttachmentLayout {
  const markers = promptImageAttachmentMarkers(text);
  if (markers.length === 0) return { bodyText: text, markers, attachmentRow: "" };
  const withoutMarkers = text.split("\n").map(removePromptImageMarkersFromLine).join("\n");
  const bodyText = (/^[\t ]*\[image #\d+ /.test(text) ? withoutMarkers.replace(/^\n+/, "") : withoutMarkers)
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  const attachmentRow = markers.join(" ");
  return { bodyText, markers, attachmentRow };
}

export function withPromptImageAttachmentRow(text: string): string {
  const layout = promptImageAttachmentLayout(text);
  if (layout.markers.length === 0) return text;
  return layout.bodyText ? `${layout.bodyText}\n\n${layout.attachmentRow}` : `\n\n${layout.attachmentRow}`;
}

export function referencedPromptImages(
  text: string,
  images: readonly PromptImageAttachment[],
): PromptImageAttachment[] {
  const byId = new Map(images.map((image) => [image.id, image]));
  const seen = new Set<number>();
  const referenced: PromptImageAttachment[] = [];
  for (const span of findPromptImageMarkers(text)) {
    if (seen.has(span.imageId)) continue;
    const image = byId.get(span.imageId);
    if (!image) continue;
    seen.add(span.imageId);
    referenced.push(image);
  }
  return referenced;
}

export function createPromptSubmission(
  text: string,
  images: readonly PromptImageAttachment[] = promptImageStore.all(),
): PromptSubmission {
  return { text, images: referencedPromptImages(text, images) };
}

export function sanitizePromptImagesForHistory(text: string, images: readonly PromptImageAttachment[]): string {
  return referencedPromptImages(text, images).length > 0
    ? text.replace(PROMPT_IMAGE_MARKER_RE, PROMPT_IMAGE_OMITTED_HISTORY_MARKER)
    : text;
}

export function cleanupPastedImagePath(rawText: string): string {
  let cleaned = rawText.trim();
  if ((cleaned.startsWith("'") && cleaned.endsWith("'")) || (cleaned.startsWith('"') && cleaned.endsWith('"'))) {
    cleaned = cleaned.slice(1, -1);
  }
  if (cleaned.startsWith("file://")) {
    const withoutScheme = cleaned.slice("file://".length);
    const normalized = withoutScheme.startsWith("/") ? withoutScheme : `/${withoutScheme}`;
    try {
      cleaned = decodeURIComponent(normalized);
    } catch {
      cleaned = normalized;
    }
  } else if (cleaned.startsWith("~")) {
    const home = getHomeEnv();
    if (home) cleaned = path.join(home, cleaned.slice(1));
  }
  // Terminal drag-and-drop often shell-escapes spaces and punctuation.
  return cleaned.replace(/\\([\\\s'"()\[\]{}&;$`!*?|<>])/g, "$1");
}

export function readPromptImageFile(filePath: string): PromptImageSource | null {
  const cleaned = cleanupPastedImagePath(filePath);
  if (!path.isAbsolute(cleaned)) return null;
  if (!IMAGE_PATH_EXTS.has(path.extname(cleaned).toLowerCase())) return null;
  try {
    if (!existsSync(cleaned) || !statSync(cleaned).isFile()) return null;
    return { bytes: readFileSync(cleaned), sourcePath: cleaned, filename: path.basename(cleaned) };
  } catch {
    return null;
  }
}

export function detectImageMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8) {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.every((value, index) => bytes[index] === value)) return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const header = Buffer.from(bytes.slice(0, 6)).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12) {
    const riff = Buffer.from(bytes.slice(0, 4)).toString("ascii");
    const webp = Buffer.from(bytes.slice(8, 12)).toString("ascii");
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  const prefix = Buffer.from(bytes.slice(0, Math.min(bytes.length, 512)))
    .toString("utf8")
    .trimStart()
    .toLowerCase();
  if (prefix.startsWith("<svg") || (prefix.startsWith("<?xml") && prefix.includes("<svg"))) return "image/svg+xml";
  return null;
}

function formatPromptImageMarker(id: number, filename?: string): string {
  const name = (filename?.trim() || "image").replace(/[\[\]]/g, "");
  return `[image #${id} ${name}]`;
}

export class PromptImageStore {
  private readonly images = new Map<number, PromptImageAttachment>();

  all(): PromptImageAttachment[] {
    return Array.from(this.images.values());
  }

  reset(): void {
    this.images.clear();
  }

  restore(images: readonly PromptImageAttachment[] = []): void {
    this.images.clear();
    for (const image of images) this.images.set(image.id, image);
  }

  removeImageIds(ids: readonly number[]): void {
    for (const id of ids) this.images.delete(id);
  }

  referencedImages(text: string): PromptImageAttachment[] {
    return referencedPromptImages(text, this.all());
  }

  addSourceWithId(id: number, source: PromptImageSource): PromptImageLoadResult {
    if (source.bytes.length === 0) return { ok: false, message: "Image is empty" };
    const mimeType = detectImageMimeType(source.bytes);
    if (!mimeType) return { ok: false, message: "Unsupported image format" };
    const marker = formatPromptImageMarker(id, source.filename);
    const attachment: PromptImageAttachment = {
      id,
      marker,
      data: source.bytes.toString("base64"),
      mimeType,
      byteLength: source.bytes.length,
      ...(source.filename ? { filename: source.filename } : {}),
      ...(source.sourcePath ? { sourcePath: source.sourcePath } : {}),
    };
    this.images.set(id, attachment);
    return { ok: true, attachment };
  }

  addPathWithId(id: number, filePath: string): PromptImageLoadResult {
    const source = readPromptImageFile(filePath);
    if (!source) return { ok: false, message: "No supported image file found" };
    return this.addSourceWithId(id, source);
  }
}

export const promptImageStore = new PromptImageStore();
