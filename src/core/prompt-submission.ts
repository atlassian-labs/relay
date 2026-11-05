export interface PromptImageAttachment {
  readonly id: number;
  readonly marker: string;
  /** Original image bytes encoded as base64; held in memory only. */
  readonly data: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly filename?: string;
  readonly sourcePath?: string;
}

export interface PromptSubmission {
  readonly text: string;
  readonly images: readonly PromptImageAttachment[];
  /** Hidden text reminders appended as additional ACP prompt text blocks. */
  readonly systemReminders?: readonly string[];
}

export type PromptInput = string | PromptSubmission;

const PROMPT_IMAGE_MARKER_RE = /\[image #(\d+) [^\]]*\]/g;

export function isPromptSubmission(value: PromptInput): value is PromptSubmission {
  return typeof value !== "string";
}

export function promptInputText(value: PromptInput): string {
  return typeof value === "string" ? value : value.text;
}

export function referencedPromptImageIds(text: string): Set<number> {
  const ids = new Set<number>();
  const re = new RegExp(PROMPT_IMAGE_MARKER_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) ids.add(Number.parseInt(match[1], 10));
  return ids;
}

export function filterPromptImagesForText(
  text: string,
  images: readonly PromptImageAttachment[],
): readonly PromptImageAttachment[] {
  const ids = referencedPromptImageIds(text);
  return images.filter((image) => ids.has(image.id));
}

export function withPromptInputText(value: PromptInput, text: string): PromptInput {
  if (typeof value === "string") return text;
  return { ...value, text, images: filterPromptImagesForText(text, value.images) };
}

export function withPromptInputSystemReminders(value: PromptInput, systemReminders: readonly string[]): PromptInput {
  if (systemReminders.length === 0) return value;
  if (typeof value === "string") return { text: value, images: [], systemReminders };
  return { ...value, systemReminders };
}
