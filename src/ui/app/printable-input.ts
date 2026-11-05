export type PrintableKeyboardEvent = {
  ctrl?: boolean;
  meta?: boolean;
  option?: boolean;
  alt?: boolean;
  sequence?: unknown;
  name?: unknown;
};

export function isPrintableInputText(value: string): boolean {
  if (!value) return false;
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) return false;
  }
  return true;
}

const SGR_MOUSE_REPORT_PATTERN = /^<\d+;\d+;\d+[Mm]/;
const SGR_MOUSE_REPORT_PREFIX_PATTERN = /^(?:<|<\d+|<\d+;|<\d+;\d+|<\d+;\d+;|<\d+;\d+;\d+)$/;

export type SgrMouseReportStripResult = {
  readonly text: string;
  readonly stripped: boolean;
};

function csiPrefixLengthAt(value: string, offset: number): number {
  if (value.startsWith("\u001b[", offset)) return 2;
  return value.charCodeAt(offset) === 0x9b ? 1 : 0;
}

function sgrMouseReportLengthAt(value: string, offset: number): number {
  const csiPrefixLength = csiPrefixLengthAt(value, offset);
  const match = SGR_MOUSE_REPORT_PATTERN.exec(value.slice(offset + csiPrefixLength));
  return match ? csiPrefixLength + match[0].length : 0;
}

export function stripSgrMouseReportSequences(value: string): SgrMouseReportStripResult {
  let text = "";
  let stripped = false;
  let offset = 0;
  while (offset < value.length) {
    const reportLength = sgrMouseReportLengthAt(value, offset);
    if (reportLength > 0) {
      stripped = true;
      offset += reportLength;
      continue;
    }
    text += value[offset];
    offset++;
  }
  return { text, stripped };
}

export function stripLeadingSgrMouseReportSequences(value: string): SgrMouseReportStripResult {
  let offset = 0;
  let stripped = false;
  while (offset < value.length) {
    const reportLength = sgrMouseReportLengthAt(value, offset);
    if (reportLength === 0) break;
    stripped = true;
    offset += reportLength;
  }
  return { text: value.slice(offset), stripped };
}

export function isSgrMouseReportSequence(value: string): boolean {
  if (!value) return false;
  const result = stripSgrMouseReportSequences(value);
  return result.stripped && result.text.length === 0;
}

export function isSgrMouseReportPrefix(value: string): boolean {
  return SGR_MOUSE_REPORT_PREFIX_PATTERN.test(value);
}

export function isSgrMouseReportInput(evt: PrintableKeyboardEvent): boolean {
  const sequence = typeof evt.sequence === "string" ? evt.sequence : "";
  if (stripSgrMouseReportSequences(sequence).stripped) return true;
  const name = typeof evt.name === "string" ? evt.name : "";
  return stripSgrMouseReportSequences(name).stripped;
}

export function printableInputFromEvent(evt: PrintableKeyboardEvent): string | null {
  if (evt.ctrl || evt.meta || evt.option || evt.alt) return null;
  const sequence = typeof evt.sequence === "string" ? evt.sequence : "";
  const sequenceResult = stripSgrMouseReportSequences(sequence);
  if (sequenceResult.stripped) return isPrintableInputText(sequenceResult.text) ? sequenceResult.text : null;
  if (isPrintableInputText(sequence)) return sequence;
  const name = typeof evt.name === "string" ? evt.name : "";
  const nameResult = stripSgrMouseReportSequences(name);
  if (nameResult.stripped) return isPrintableInputText(nameResult.text) ? nameResult.text : null;
  if (name === "space") return " ";
  if (name.length === 1 && isPrintableInputText(name)) return name;
  return null;
}
