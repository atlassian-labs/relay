/**
 * Prompt content assembly for ACP prompts.
 *
 * WHY THIS EXISTS
 * Relay used to send every user prompt as a single ACP `text` block, so an image
 * path like `@/tmp/pic.png` reached the agent as a literal string and the model
 * never saw the picture. When the agent advertises `promptCapabilities.image`
 * (alta does), we now resolve local image references, read them, and attach them
 * as ACP `image` content blocks alongside the text so the agent can actually see
 * them. Text-only prompts are unchanged (still just `[{ type: "text", text }]`).
 *
 * REFERENCE DETECTION
 * Two reference styles are detected:
 *  - `@path` tokens (explicit attach via the `@` autocomplete affordance)
 *  - bare path tokens (absolute `/...`, home `~/...`, or `file://` URIs) that a
 *    user pasted or dropped into the prompt. Pasted paths are short enough that
 *    relay's paste compaction leaves them as inline text, so by submit time
 *    they look like a normal path token.
 * Every candidate must have an image extension AND resolve to an existing local
 * file before it is attached, which keeps false positives low.
 *
 * FORMATS
 * Detected/attached: png, jpg/jpeg, gif, webp, bmp, svg (see IMAGE_MIME_BY_EXT).
 * Auto-resized when oversized: png + jpeg only (see image-resize.ts). Other
 * formats are sent as-is when under budget, otherwise skipped with a log.
 *
 * SIZE LIMITS
 * Generic ACP prompt building does not impose transport budgets by default. An
 * agent behavior profile can provide an image byte budget and/or whole-prompt
 * byte budget when a provider needs client-side guardrails. See image-resize.ts
 * for how oversized images are shrunk when a policy supplies a budget.
 *
 * TODO(image-history): images do NOT survive a history reload round-trip today.
 *   - alta DOES persist the image (base64) in its session store
 *     (~/.alta/rivetkit/databases/<session>.db), BUT on `session/load` it skips
 *     image/file parts when rebuilding history. See alta
 *     packages/acp-protocol/src/message-converter.ts `mapV2Part`:
 *     "image, file, source, step-start, data-* — skipped for now (no ACP history
 *     block equivalent)". So after a reload the model no longer sees the image,
 *     only the text of the original message + the prior assistant reply.
 *   - relay also does not handle an incoming `image` content block on replay
 *     (src/application/acp-mapping.ts only extracts text) nor render images inline.
 *   Full round-trip needs BOTH: (1) alta to emit an image/file block from
 *   `mapV2Part` on replay, and (2) relay to map+render it in mapping.ts.
 *
 * TODO(image-render): we never display the attached image in the chat UI (live
 *   or replayed). OpenTUI has no kitty-graphics renderable; the realistic path is
 *   a half-block cell-art preview via `drawSuperSampleBuffer`. Until then, the
 *   only visible trace of an attachment is the `@path` text the user typed.
 */

import * as path from "node:path";
import { Effect } from "effect";
import { existsSync, readFileSync, statSync } from "../platform/fs";
import { getHomeEnv } from "../platform/env";
import { getRelayLogger } from "../logging/logger";
import { AcpPromptTooLargeError } from "../effect/errors";
import { filterPromptImagesForText, type PromptImageAttachment } from "../core/prompt-submission";
import { base64Length, fitImageToBudget } from "./image-resize";

export interface AcpTextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface AcpImageBlock {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
  readonly uri?: string;
}

export type AcpPromptBlock = AcpTextBlock | AcpImageBlock;

export interface PromptContentPolicy {
  /** Optional per-image base64 budget. Images are resized or skipped only when set. */
  readonly imageByteBudget?: number;
  /** Optional whole-prompt serialized byte budget. Checked only when images are attached. */
  readonly promptByteBudget?: number;
  /** Optional text note inserted before path-backed image blocks. */
  readonly pathImageAttachmentNote?: string;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

export function imageMimeForPath(filePath: string): string | undefined {
  return IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()];
}

// Matches quoted path-like tokens. The final path check still requires an
// image extension and an existing file, so this intentionally scans all quotes.
const QUOTED_PATH_RE = /"([^"]+)"|'([^']+)'/g;

// Extension detector used while scanning path prefixes that may contain spaces.
const IMAGE_EXTENSION_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?=$|[\s)"'\]}>,;:!?`])/giu;

function shellUnescapePathToken(token: string): string {
  return token.replace(/\\(.)/gu, "$1");
}

function hasImageExtension(token: string): boolean {
  IMAGE_EXTENSION_RE.lastIndex = 0;
  return IMAGE_EXTENSION_RE.test(token);
}

function imageTokenPrefixes(segment: string): string[] {
  const tokens: string[] = [];
  IMAGE_EXTENSION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMAGE_EXTENSION_RE.exec(segment)) !== null) {
    const token = segment.slice(0, match.index + match[0].length).trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

function stripFileUri(token: string): string {
  if (!token.startsWith("file://")) return token;
  const withoutScheme = token.slice("file://".length);
  // file:///abs/path -> /abs/path ; file://host/path is uncommon locally, keep as-is path part
  const normalized = withoutScheme.startsWith("/") ? withoutScheme : `/${withoutScheme}`;
  try {
    return decodeURIComponent(normalized);
  } catch {
    return normalized;
  }
}

function candidateVariants(rawToken: string): string[] {
  const trimmed = rawToken.trim();
  const unescaped = shellUnescapePathToken(trimmed);
  return trimmed === unescaped ? [trimmed] : [trimmed, unescaped];
}

function resolveCandidate(rawToken: string, cwd?: string): string | null {
  for (const variant of candidateVariants(rawToken)) {
    let candidate = stripFileUri(variant);
    if (candidate === "~" || candidate.startsWith("~/")) {
      const home = getHomeEnv();
      if (!home) continue;
      candidate = path.join(home, candidate.slice(1));
    }
    const abs = path.isAbsolute(candidate) ? candidate : path.join(cwd ?? process.cwd(), candidate);
    try {
      if (existsSync(abs) && statSync(abs).isFile()) return abs;
    } catch {
      continue;
    }
  }
  return null;
}

function lineEndIndex(text: string, start: number): number {
  const newline = text.indexOf("\n", start);
  return newline === -1 ? text.length : newline;
}

function collectQuotedPathTokens(text: string): string[] {
  const tokens: string[] = [];
  QUOTED_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QUOTED_PATH_RE.exec(text)) !== null) {
    const token = match[1] ?? match[2];
    if (token && hasImageExtension(token)) tokens.push(token);
  }
  return tokens;
}

function collectAtReferenceTokens(text: string): string[] {
  const tokens: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "@") continue;
    const start = index + 1;
    const quote = text[start];
    if (quote === '"' || quote === "'") {
      const end = text.indexOf(quote, start + 1);
      if (end !== -1) {
        const token = text.slice(start + 1, end);
        if (hasImageExtension(token)) tokens.push(token);
      }
      continue;
    }
    tokens.push(...imageTokenPrefixes(text.slice(start, lineEndIndex(text, start))));
  }
  return tokens;
}

function isPathStartBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  return /[\s(\[{"'<:=`]/u.test(text[index - 1]);
}

function isBarePathStart(text: string, index: number): boolean {
  return text.startsWith("file://", index) || text.startsWith("~/", index) || text[index] === "/";
}

function collectBarePathTokens(text: string): string[] {
  const tokens: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (!isPathStartBoundary(text, index) || !isBarePathStart(text, index)) continue;
    tokens.push(...imageTokenPrefixes(text.slice(index, lineEndIndex(text, index))));
  }
  return tokens;
}

function uniqueTokens(tokens: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }
  return unique;
}

function collectCandidateTokens(text: string): string[] {
  return uniqueTokens([
    ...collectAtReferenceTokens(text),
    ...collectBarePathTokens(text),
    ...collectQuotedPathTokens(text),
  ]);
}

export interface BuildPromptContentOptions {
  readonly includeImages: boolean;
  readonly cwd?: string;
  /** In-memory image sidecars referenced by `[image #N filename]` markers. */
  readonly images?: readonly PromptImageAttachment[];
  /** Hidden text reminders appended as extra ACP text blocks after the visible prompt content. */
  readonly systemReminders?: readonly string[];
  /** Optional provider-specific content policy selected by the active agent profile. */
  readonly policy?: PromptContentPolicy;
}

/**
 * Build ACP prompt content blocks from prompt text. When `includeImages` is
 * true, image references that resolve to local image files are attached as
 * image content blocks (in addition to remaining in the text for context).
 *
 * Detected references: `@path` tokens and bare/pasted paths (absolute, `~/`,
 * or `file://`). Each must have an image extension and resolve to an existing
 * file. Duplicate resolved paths are attached once.
 *
 * When a policy supplies `imageByteBudget`, images are downscaled/re-encoded so
 * each fits that base64 budget. Images that cannot be made to fit are skipped
 * and logged.
 *
 * When a policy supplies `promptByteBudget`, the assembled prompt is measured
 * against that cap and fails with {@link AcpPromptTooLargeError} before sending.
 * This only applies when at least one image is attached, so text-only prompts
 * are never blocked here.
 */
export function buildPromptContent(
  text: string,
  options: BuildPromptContentOptions,
): Effect.Effect<AcpPromptBlock[], AcpPromptTooLargeError> {
  return Effect.gen(function* () {
    const blocks: AcpPromptBlock[] = [{ type: "text", text }];
    if (!options.includeImages) return appendSystemReminderBlocks(blocks, options.systemReminders);

    const policy = options.policy;
    const candidates = collectCandidateTokens(text);

    const imageBlocks: AcpImageBlock[] = [];

    for (const image of filterPromptImagesForText(text, options.images ?? [])) {
      const bytes = Buffer.from(image.data, "base64");
      const fitted = yield* encodeImageForPolicy(bytes, image.mimeType, policy);
      if (!fitted) {
        getRelayLogger().warn("acp.prompt.image.skipped", {
          marker: image.marker,
          filename: image.filename,
          mimeType: image.mimeType,
          encodedBytes: base64Length(bytes.byteLength),
          imageByteBudget: policy?.imageByteBudget,
        });
        continue;
      }
      imageBlocks.push({ type: "image", data: fitted.data, mimeType: fitted.mimeType });
    }

    const seen = new Set<string>();
    for (const token of candidates) {
      const resolved = resolveCandidate(token, options.cwd);
      if (!resolved || seen.has(resolved)) continue;
      const mimeType = imageMimeForPath(resolved);
      if (!mimeType) continue;
      seen.add(resolved);
      const bytes = readImageBytes(resolved);
      if (!bytes) continue;
      const fitted = yield* encodeImageForPolicy(bytes, mimeType, policy);
      if (!fitted) {
        getRelayLogger().warn("acp.prompt.image.skipped", {
          path: resolved,
          mimeType,
          encodedBytes: base64Length(bytes.byteLength),
          imageByteBudget: policy?.imageByteBudget,
        });
        continue;
      }
      imageBlocks.push({ type: "image", data: fitted.data, mimeType: fitted.mimeType, uri: `file://${resolved}` });
    }

    // Prepend the read-hint note only for path-backed images. Sidecar/clipboard
    // images have no local path for the agent to re-read, and persisting this as
    // user-visible text makes it show up when sessions are replayed.
    if (imageBlocks.length > 0) {
      const needsPathReadHint = imageBlocks.some((block) => block.uri?.startsWith("file://") === true);
      if (needsPathReadHint && policy?.pathImageAttachmentNote) {
        blocks.push({ type: "text", text: policy.pathImageAttachmentNote });
      }
      blocks.push(...imageBlocks);
    }

    appendSystemReminderBlocks(blocks, options.systemReminders);

    if (imageBlocks.length > 0 && policy?.promptByteBudget !== undefined) {
      const totalBytes = Buffer.byteLength(JSON.stringify(blocks));
      if (totalBytes > policy.promptByteBudget) {
        getRelayLogger().warn("acp.prompt.too_large.total", {
          totalBytes,
          promptByteBudget: policy.promptByteBudget,
          imageCount: imageBlocks.length,
        });
        return yield* Effect.fail(
          new AcpPromptTooLargeError({
            message: `Prompt is too large to send (${formatKiB(totalBytes)}, limit ~${formatKiB(policy.promptByteBudget)}). Attach fewer or smaller images.`,
            totalBytes,
            maxBytes: policy.promptByteBudget,
          }),
        );
      }
    }

    return blocks;
  });
}

function appendSystemReminderBlocks(
  blocks: AcpPromptBlock[],
  reminders: readonly string[] | undefined,
): AcpPromptBlock[] {
  for (const reminder of reminders ?? []) {
    const trimmed = reminder.trim();
    if (trimmed) blocks.push({ type: "text", text: `system-reminder: ${trimmed}` });
  }
  return blocks;
}

function encodeImageForPolicy(
  bytes: Uint8Array,
  mimeType: string,
  policy: PromptContentPolicy | undefined,
): Effect.Effect<{ readonly data: string; readonly mimeType: string } | null> {
  if (policy?.imageByteBudget === undefined) {
    return Effect.succeed({ data: Buffer.from(bytes).toString("base64"), mimeType });
  }
  return fitImageToBudget(bytes, mimeType, policy.imageByteBudget);
}

function formatKiB(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

function readImageBytes(resolved: string): Buffer | null {
  try {
    return readFileSync(resolved);
  } catch (err) {
    getRelayLogger().warn("acp.prompt.image.read.error", {
      path: resolved,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
