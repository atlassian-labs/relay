type CursorPosition = {
  line?: unknown;
  row?: unknown;
};

type TextareaMetricsRef = {
  logicalCursor?: CursorPosition;
  editBuffer?: {
    cursor?: CursorPosition;
    lineCount?: unknown;
  };
  lineCount?: unknown;
};

type TextareaTextRef = {
  plainText?: unknown;
  editBuffer?: {
    getText?: () => unknown;
  };
};

function numericCoordinate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readTextareaText(ref: unknown): string {
  if (!ref) return "";
  try {
    const textarea = ref as TextareaTextRef;
    if (typeof textarea.plainText === "string") return textarea.plainText;
    const bufferText = textarea.editBuffer?.getText?.();
    return typeof bufferText === "string" ? bufferText : "";
  } catch {
    return "";
  }
}

export function terminalColumns(): number {
  return process.stdout.columns || 100;
}

export function terminalRows(): number {
  return process.stdout.rows || 30;
}

export function getTextareaCursorRow(ref: unknown): number {
  try {
    const textarea = ref as TextareaMetricsRef | null | undefined;
    const cursor = textarea?.logicalCursor ?? textarea?.editBuffer?.cursor;
    return numericCoordinate(cursor?.line) ?? numericCoordinate(cursor?.row) ?? 0;
  } catch {
    return 0;
  }
}

export function getTextareaLineCount(ref: unknown): number {
  try {
    const textarea = ref as TextareaMetricsRef | null | undefined;
    return numericCoordinate(textarea?.lineCount) ?? numericCoordinate(textarea?.editBuffer?.lineCount) ?? 1;
  } catch {
    return 1;
  }
}
