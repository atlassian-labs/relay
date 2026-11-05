import type { RelayEditorChromeElement, RelayEditorChromeSurface, RelayLine, RelayLineSegment } from "../../plugins";

export interface EditorChromeElementInput {
  readonly surface: RelayEditorChromeSurface;
  readonly element: RelayEditorChromeElement;
  readonly line: RelayLine;
  readonly index?: number;
  readonly active?: boolean;
}

export type EditorChromeElementResolver = (input: EditorChromeElementInput) => RelayLine;

export function combineRelayLines(lines: readonly RelayLine[], separator = ""): RelayLine {
  const visible = lines.filter((line) => line.text.length > 0 || (line.segments?.length ?? 0) > 0);
  const segments: RelayLineSegment[] = [];
  visible.forEach((line, index) => {
    if (index > 0 && separator) segments.push({ text: separator });
    if (line.segments?.length) {
      for (const segment of line.segments) segments.push(mergeLineStyle(line, segment));
    } else {
      segments.push(mergeLineStyle(line, { text: line.text }));
    }
  });
  return { text: segments.map((segment) => segment.text).join(""), segments };
}

function mergeLineStyle(line: RelayLine, segment: RelayLineSegment): RelayLineSegment {
  return {
    text: segment.text,
    ...((segment.fg ?? line.fg) ? { fg: segment.fg ?? line.fg } : {}),
    ...((segment.bg ?? line.bg) ? { bg: segment.bg ?? line.bg } : {}),
    ...(segment.bold === true || line.bold === true ? { bold: true } : {}),
    ...(segment.underline === true || line.underline === true ? { underline: true } : {}),
    ...(segment.strikethrough === true || line.strikethrough === true ? { strikethrough: true } : {}),
    ...((segment.href ?? line.href) ? { href: segment.href ?? line.href } : {}),
    ...((segment.ctrlHref ?? line.ctrlHref) ? { ctrlHref: segment.ctrlHref ?? line.ctrlHref } : {}),
    ...((segment.onClick ?? line.onClick) ? { onClick: segment.onClick ?? line.onClick } : {}),
  };
}
