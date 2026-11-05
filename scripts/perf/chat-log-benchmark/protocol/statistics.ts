export function nearestRankPercentile(samples: readonly number[], percentile: number): number | null {
  if (samples.length === 0) return null;
  if (!(percentile > 0 && percentile <= 1)) throw new RangeError("percentile must be greater than 0 and at most 1");

  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil(percentile * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? null;
}
