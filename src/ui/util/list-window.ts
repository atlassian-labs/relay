export function centeredWindowStart(index: number, total: number, visibleCount: number): number {
  const count = Math.max(1, visibleCount);
  if (total <= count) return 0;
  const selected = Math.max(0, Math.min(index, total - 1));
  const start = Math.max(0, selected - Math.floor(count / 2));
  return Math.min(start, Math.max(0, total - count));
}

export function listRangeLabel(start: number, visibleCount: number, total: number): string {
  if (total <= visibleCount) return "";
  return `${start + 1}-${Math.min(total, start + visibleCount)}/${total}`;
}
