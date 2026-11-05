import { spawn } from "../../platform/process";
import { getLinkId } from "@opentui/core";

export interface MarkdownLink {
  label: string;
  url: string;
}

export type LinkTextPart = { type: "text"; text: string } | { type: "url"; text: string; url: string };

const MARKDOWN_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s<>)\]]+/g;
const TRAILING_URL_PUNCTUATION_RE = /[.,;:!?]+$/;

/**
 * Markdown handling owns explicit link syntax; bare-URL extraction should not
 * report URL-like label or destination text as separate URL parts.
 */
function protectedMarkdownLinkRanges(markdown: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  MARKDOWN_LINK_RE.lastIndex = 0;
  while ((match = MARKDOWN_LINK_RE.exec(markdown)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function isInRange(index: number, ranges: ReadonlyArray<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

export function splitBareUrls(text: string): LinkTextPart[] {
  const parts: LinkTextPart[] = [];
  const protectedRanges = protectedMarkdownLinkRanges(text);
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  BARE_URL_RE.lastIndex = 0;
  while ((match = BARE_URL_RE.exec(text)) !== null) {
    if (isInRange(match.index, protectedRanges)) continue;

    const rawUrl = match[0];
    const url = rawUrl.replace(TRAILING_URL_PUNCTUATION_RE, "");
    if (!url) continue;

    const endIndex = match.index + url.length;
    if (match.index > lastIndex) parts.push({ type: "text", text: text.slice(lastIndex, match.index) });
    parts.push({ type: "url", text: url, url });
    lastIndex = endIndex;
  }

  if (lastIndex < text.length) parts.push({ type: "text", text: text.slice(lastIndex) });
  return parts.length > 0 ? parts : [{ type: "text", text }];
}

/**
 * Keep this conservative: single `_` and `~` are common in prose and should
 * not force bare URLs back through the markdown renderer.
 */
const MARKDOWN_BLOCK_STRUCTURE_RE = /(^|\n)\s*(```|#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\|)/;
// Reference definitions alone are ambiguous with log-style prefixes like
// `[ERROR]: https://...`, so reference-style markdown is detected from the
// reference usage syntax instead.
const MARKDOWN_INLINE_STRUCTURE_RE = /[`*]|_{2}|~{2}|!\[[^\]]*\]|\[[^\]]+\]\(|\[[^\]\n]+\]\[[^\]\n]*\]/;

function hasMarkdownStructure(text: string): boolean {
  return MARKDOWN_BLOCK_STRUCTURE_RE.test(text) || MARKDOWN_INLINE_STRUCTURE_RE.test(text);
}

/**
 * URL text can contain markdown-like characters. Only non-URL text should
 * decide whether the markdown renderer still owns this block.
 */
export function shouldRenderLinkedPlainText(content: string): boolean {
  const parts = splitBareUrls(content);
  const textOutsideUrls = parts.map((part) => (part.type === "text" ? part.text : "")).join("");
  return parts.some((part) => part.type === "url") && !hasMarkdownStructure(textOutsideUrls);
}

export function extractMarkdownLinks(markdown: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  MARKDOWN_LINK_RE.lastIndex = 0;
  while ((match = MARKDOWN_LINK_RE.exec(markdown)) !== null) {
    const url = match[2];
    if (!seen.has(url)) {
      seen.add(url);
      links.push({ label: match[1] || url, url });
    }
  }

  for (const part of splitBareUrls(markdown)) {
    if (part.type !== "url") continue;
    if (!seen.has(part.url)) {
      seen.add(part.url);
      links.push({ label: part.url, url: part.url });
    }
  }

  return links;
}

type LinkRenderer = {
  readonly currentRenderBuffer?: {
    readonly width?: unknown;
    readonly height?: unknown;
    readonly buffers?: {
      readonly attributes?: unknown;
    };
  };
  readonly lib?: {
    readonly linkGetUrl?: (id: number) => unknown;
    readonly attributesGetLinkId?: (attribute: number) => unknown;
  };
};

const UNDERLINE_BIT = 0x08;

function rendererLinkUrl(renderer: LinkRenderer, id: number): string | null {
  const url = renderer.lib?.linkGetUrl?.(id);
  return typeof url === "string" && url.length > 0 ? url : null;
}

function hasUnderlineAttribute(attribute: number): boolean {
  return (attribute & UNDERLINE_BIT) !== 0;
}

/**
 * Current render buffers carry packed native attributes; the JS helper is a
 * fallback for synthetic attributes and renderers without a native decoder.
 */
function linkIdForAttribute(renderer: LinkRenderer, attribute: number): number {
  const nativeId = renderer.lib?.attributesGetLinkId?.(attribute);
  if (typeof nativeId === "number") return nativeId;
  return getLinkId(attribute);
}

function linkUrlForAttribute(renderer: LinkRenderer, attribute: number): string | null {
  const id = linkIdForAttribute(renderer, attribute);
  return id > 0 ? rendererLinkUrl(renderer, id) : null;
}

/**
 * A soft-wrapped continuation cell can keep underline styling even when the
 * link id is stored on a neighboring cell in the same wrapped run.
 */
function linkedUrlInUnderlineRun(
  renderer: LinkRenderer,
  attributes: Uint32Array,
  clickedIndex: number,
  maxDistance: number,
): string | null {
  for (let index = clickedIndex + 1; index < Math.min(clickedIndex + maxDistance, attributes.length); index++) {
    const attribute = attributes[index];
    if (!hasUnderlineAttribute(attribute)) break;
    const url = linkUrlForAttribute(renderer, attribute);
    if (url) return url;
  }

  for (let index = clickedIndex - 1; index >= Math.max(clickedIndex - maxDistance, 0); index--) {
    const attribute = attributes[index];
    if (!hasUnderlineAttribute(attribute)) break;
    const url = linkUrlForAttribute(renderer, attribute);
    if (url) return url;
  }

  return null;
}

export function getLinkUrlAtScreenPosition(renderer: unknown, mouseX: number, mouseY: number): string | null {
  try {
    const candidate = renderer as LinkRenderer | null;
    const screenBuf = candidate?.currentRenderBuffer;
    if (!screenBuf || typeof screenBuf.width !== "number" || typeof screenBuf.height !== "number") return null;
    const width = screenBuf.width;
    const height = screenBuf.height;
    if (mouseX < 0 || mouseX >= width || mouseY < 0 || mouseY >= height) return null;

    const attrs = screenBuf.buffers?.attributes;
    if (!(attrs instanceof Uint32Array)) return null;
    const rowStart = mouseY * width;
    const clickedAttr = attrs[rowStart + mouseX];

    const directUrl = linkUrlForAttribute(candidate, clickedAttr);
    if (directUrl) return directUrl;

    if (!hasUnderlineAttribute(clickedAttr)) return null;

    const wrappedUrl = linkedUrlInUnderlineRun(candidate, attrs, rowStart + mouseX, 100);
    if (wrappedUrl) return wrappedUrl;

    for (let x = mouseX + 1; x < Math.min(mouseX + 100, width); x++) {
      const url = linkUrlForAttribute(candidate, attrs[rowStart + x]);
      if (url) return url;
    }

    for (let x = mouseX - 1; x >= Math.max(mouseX - 100, 0); x--) {
      const url = linkUrlForAttribute(candidate, attrs[rowStart + x]);
      if (url) return url;
    }
  } catch {
    // Buffer may be mid-render or destroyed.
  }
  return null;
}

export function openUrl(url: string): void {
  try {
    const platform = process.platform;
    const child =
      platform === "darwin"
        ? spawn("open", [url], { stdio: "ignore", detached: true })
        : platform === "win32"
          ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true })
          : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Best-effort only.
  }
}

export * as Links from "./links";
