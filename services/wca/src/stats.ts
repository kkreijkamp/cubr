/**
 * Pure statistics helpers for the rank estimator.
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
