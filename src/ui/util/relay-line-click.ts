import type { RelayLine, RelayLineSegment } from "../../plugins/types";

export function handleRelayLineMouseAction(line: RelayLine, event: unknown, openUrl: (url: string) => void): void {
  const segment = actionableSegmentAt(line, event);
  if (segment && runRelayLineAction(segment, event, openUrl)) return;
  runRelayLineAction(line, event, openUrl);
}

function actionableSegmentAt(line: RelayLine, event: unknown): RelayLineSegment | null {
  const column = eventColumn(event);
  if (column === null || !line.segments) return null;

  let start = 0;
  for (const segment of line.segments) {
    const end = start + textWidth(segment.text);
    if (column >= start && column < end && hasAction(segment)) return segment;
    start = end;
  }
  return null;
}

function runRelayLineAction(
  target: Pick<RelayLine, "href" | "ctrlHref" | "onClick">,
  event: unknown,
  openUrl: (url: string) => void,
): boolean {
  if (target.onClick) {
    stopMousePropagation(event);
    void Promise.resolve(target.onClick()).catch(() => undefined);
    return true;
  }

  const url = ctrlPressed(event) && target.ctrlHref ? target.ctrlHref : target.href;
  if (!url) return false;
  stopMousePropagation(event);
  openUrl(url);
  return true;
}

function hasAction(segment: RelayLineSegment): boolean {
  return Boolean(segment.onClick || segment.href || segment.ctrlHref);
}

function eventColumn(event: unknown): number | null {
  const candidate = objectRecord(event);
  if (!candidate) return null;
  const x = finiteNumber(candidate.x);
  if (x === null) return null;

  const targetX = screenX(candidate.target);
  const sourceX = screenX(candidate.source);
  return Math.floor(x - (targetX ?? sourceX ?? 0));
}

function screenX(value: unknown): number | null {
  return finiteNumber(objectRecord(value)?.screenX);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stopMousePropagation(event: unknown): void {
  const candidate = objectRecord(event);
  const stopPropagation = candidate?.stopPropagation;
  if (typeof stopPropagation === "function") stopPropagation.call(event);
}

function ctrlPressed(event: unknown): boolean {
  const candidate = objectRecord(event);
  if (!candidate) return false;
  const modifiers = objectRecord(candidate.modifiers);
  if (modifiers?.ctrl === true) return true;
  return candidate.ctrlKey === true;
}

function textWidth(text: string): number {
  return [...String(text)].length;
}
