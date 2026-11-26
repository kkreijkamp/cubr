import { averageOfN, currentAverage, effectiveMs, toApiValue, type SolveLike } from '@cubr/cubestats';

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

/** Daily challenge ao5: exactly 5 attempts ordered by index -> ao5 + per-attempt effective times. */
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
  /** which of the five, and its solve (which may have been deleted since) */
  index?: number;
  solveId?: string;
}

/** One official attempt as GET /api/solves/daily lists it. */
export interface OfficialAttempt {
  index: number;
  timeMs: number;
  penalty: SolveLike['penalty'];
  solveId: string;
}

/**
 * GET /api/solves/daily, per event: the user's daily solves as they are now, the official attempts
 * (index, time, penalty and solve, ordered by index: what the page's five slots show, so an attempt
 * whose solve was deleted still shows as used; the October review's #5), and the official ao5 from
 * them (null until all five exist). Events whose solves were deleted still appear with their attempts.
 */
export function dailyOverview<S extends { event: string }>(
  solves: S[],
  attempts: DailyAttempt[],
): Record<string, { solves: S[]; attempts: OfficialAttempt[]; ao5: number | null }> {
  const events: Record<string, { solves: S[]; attempts: OfficialAttempt[]; ao5: number | null }> = {};
  const entry = (event: string) => (events[event] ??= { solves: [], attempts: [], ao5: null });
  for (const s of solves) entry(s.event).solves.push(s);
  const byEvent = new Map<string, DailyAttempt[]>();
  for (const a of attempts) byEvent.set(a.event, [...(byEvent.get(a.event) ?? []), a]);
  for (const [event, list] of byEvent) {
    entry(event).ao5 = dailyResult(list).ao5;
    entry(event).attempts = list
      .filter((a): a is DailyAttempt & { index: number; solveId: string } => typeof a.index === 'number' && typeof a.solveId === 'string')
      .map((a) => ({ index: a.index, timeMs: a.timeMs, penalty: a.penalty, solveId: a.solveId }));
  }
  return events;
}

/** Event payload value for one solve: effective ms, or null for a DNF (SPEC section 8 `effectiveMs`). */
export function effectiveOrNull(s: SolveLike): number | null {
  const v = effectiveMs(s);
  return Number.isFinite(v) ? v : null;
}
