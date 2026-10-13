/**
 * Pure statistics helpers for the rank estimator and the distribution chart.
 */

/**
 * World/country rank of a hypothetical result, using competition ranking ("1224"):
 * rank = 1 + number of people strictly faster. Ties share a rank.
 */
export function rankFromCounts(faster: number): number {
  return faster + 1;
}

/**
 * "% of competitors you are faster than" = 100 * strictly slower / total, 2 decimals.
 * null when nobody has a result (no meaningful percentile).
 */
export function percentBeaten(slower: number, total: number): number | null {
  if (total <= 0) return null;
  const pct = (100 * Math.max(0, Math.min(slower, total))) / total;
  return Math.round(pct * 100) / 100;
}

export interface Bucket {
  from: number; // inclusive
  to: number; // exclusive
  count: number;
}

/**
 * Merges the importer's fine histogram (equal-width buckets in raw WCA units) into at most
 * `requested` buckets. Each output bucket joins k = ceil(n / requested) neighbouring fine
 * buckets, so all buckets have the same width (only the very last one may be narrower when
 * n is not divisible by k). With 600 fine buckets every divisor of 600 (10, 20, 25, 30, 40,
 * 50, 60, 75, 100, ...) merges exactly.
 */
export function mergeBuckets(counts: number[], lo: number, width: number, requested: number): Bucket[] {
  const n = counts.length;
  if (n === 0) return [];
  const k = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(requested))));
  const out: Bucket[] = [];
  for (let i = 0; i < n; i += k) {
    const end = Math.min(i + k, n);
    let count = 0;
    for (let j = i; j < end; j++) count += counts[j];
    out.push({ from: lo + i * width, to: lo + end * width, count });
  }
  return out;
}
