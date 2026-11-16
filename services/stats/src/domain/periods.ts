// The best single and ao5 of each UTC day and ISO week, for the leaderboard's daily and weekly
// boards (GET /internal/users/:id/period-bests). Pure: a person's sessions in, their bests out.
import { dayKey, isoWeekKey } from '@cubr/common';
import { rollingAverage } from '@cubr/cubestats';

/** One solve of the ledger (effectiveMs null = DNF). */
export interface PeriodSolve {
  effectiveMs: number | null;
  createdAt: Date;
}

export interface PeriodBest {
  valueMs: number;
  /** when the solve that set it (for an ao5, its fifth solve) was done */
  achievedAt: string;
}

export const PERIOD_KINDS = ['single', 'ao5'] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];
export type PeriodEntry = Partial<Record<PeriodKind, PeriodBest>>;

export interface PeriodBests {
  /** by UTC day, YYYY-MM-DD */
  days: Record<string, PeriodEntry>;
  /** by ISO week (UTC), YYYY-Www */
  weeks: Record<string, PeriodEntry>;
}

export interface PeriodFloors {
  single: number;
  average: number;
}

/**
 * `sessions`: each non-practice session's solves in session order (created_at, then arrival),
 * starting up to 4 solves before `since`, so that an ao5 ending at a solve after `since` has its
 * whole window. Only solves at or after `since` count, by the UTC day and ISO week they were done
 * in. A value below its floor (the leaderboard passes the anti-cheat floor: the WCA record) is
 * skipped, so one impossible time doesn't hide the real ones. A tie keeps the earlier solve, as
 * the boards do.
 */
export function periodBests(sessions: readonly PeriodSolve[][], since: Date, floors: PeriodFloors = { single: 0, average: 0 }): PeriodBests {
  const out: PeriodBests = { days: {}, weeks: {} };
  const offer = (bucket: Record<string, PeriodEntry>, key: string, kind: PeriodKind, valueMs: number, at: string) => {
    const entry = (bucket[key] ??= {});
    const cur = entry[kind];
    if (!cur || valueMs < cur.valueMs || (valueMs === cur.valueMs && at < cur.achievedAt)) entry[kind] = { valueMs, achievedAt: at };
  };
  for (const solves of sessions) {
    const times = solves.map((s) => (s.effectiveMs === null ? Number.POSITIVE_INFINITY : s.effectiveMs));
    const ao5 = rollingAverage(times, 5);
    solves.forEach((s, i) => {
      if (s.createdAt.getTime() < since.getTime()) return;
      const at = s.createdAt.toISOString();
      const day = dayKey(s.createdAt, 'UTC');
      const week = isoWeekKey(s.createdAt, 'UTC');
      const single = times[i];
      if (Number.isFinite(single) && single >= floors.single) {
        offer(out.days, day, 'single', single, at);
        offer(out.weeks, week, 'single', single, at);
      }
      const avg = ao5[i];
      if (avg !== null && Number.isFinite(avg) && avg >= floors.average) {
        offer(out.days, day, 'ao5', avg, at);
        offer(out.weeks, week, 'ao5', avg, at);
      }
    });
  }
  return out;
}
