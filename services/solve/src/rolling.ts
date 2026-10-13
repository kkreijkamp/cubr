import { currentAverage, effectiveMs, toApiValue, type SolveLike } from '@cubetype/cubestats';

/** API-encoded averages: ms, -1 = DNF, null = not enough solves. */
export interface Rolling {
  ao5: number | null;
  ao12: number | null;
}

/** How many of the session's latest solves are needed to compute `Rolling`. */
export const ROLLING_WINDOW = 12;

/**
 * The session's current ao5/ao12 from its latest solves in chronological order (oldest first).
 * Only the last 12 matter; extra solves are ignored.
 */
export function rollingFromSolves(solves: SolveLike[]): Rolling {
  const times = solves.slice(-ROLLING_WINDOW).map(effectiveMs);
  return {
    ao5: toApiValue(currentAverage(times, 5)),
    ao12: toApiValue(currentAverage(times, 12)),
  };
}

/** Event payload value for one solve: effective ms, or null for a DNF (SPEC §8 `effectiveMs`). */
export function effectiveOrNull(s: SolveLike): number | null {
  const v = effectiveMs(s);
  return Number.isFinite(v) ? v : null;
}
