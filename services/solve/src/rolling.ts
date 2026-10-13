import { averageOfN, currentAverage, effectiveMs, toApiValue, type SolveLike } from '@cubetype/cubestats';

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

/** Daily challenge ao5: exactly 5 attempts ordered by index → ao5 + per-attempt effective times. */
export function dailyResult(solves: SolveLike[]): { ao5: number | null; times: number[] } {
  const times = solves.map(effectiveMs);
  return {
    ao5: times.length === 5 ? toApiValue(averageOfN(times, 5)) : null,
    times: times.map((t) => toApiValue(t) as number),
  };
}

/** A recorded daily-challenge attempt (as submitted) of one event. */
export interface DailyAttempt extends SolveLike {
  event: string;
}

/**
 * GET /api/solves/daily, per event: the user's daily solves as they are now, plus the official ao5
 * from the recorded attempts (ordered by index; null until all five exist). Events whose solves
 * were deleted still appear with their attempts' result.
 */
export function dailyOverview<S extends { event: string }>(
  solves: S[],
  attempts: DailyAttempt[],
): Record<string, { solves: S[]; ao5: number | null }> {
  const events: Record<string, { solves: S[]; ao5: number | null }> = {};
  const entry = (event: string) => (events[event] ??= { solves: [], ao5: null });
  for (const s of solves) entry(s.event).solves.push(s);
  const byEvent = new Map<string, DailyAttempt[]>();
  for (const a of attempts) byEvent.set(a.event, [...(byEvent.get(a.event) ?? []), a]);
  for (const [event, list] of byEvent) entry(event).ao5 = dailyResult(list).ao5;
  return events;
}

/** Event payload value for one solve: effective ms, or null for a DNF (SPEC §8 `effectiveMs`). */
export function effectiveOrNull(s: SolveLike): number | null {
  const v = effectiveMs(s);
  return Number.isFinite(v) ? v : null;
}
