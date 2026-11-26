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
export type PeriodValues = Partial<Record<PeriodKind, PeriodBest>>;
/** The best valid values, and under `flagged` the best (lowest) ones below the floors: the leaderboard
 *  tells a person why they aren't on a board when that is all they have. */
export type PeriodEntry = PeriodValues & { flagged?: PeriodValues };

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
 * Each solve's single and the rolling averages ending at it, with whether each may rank: a single at
 * or above the single floor; an average at or above the average floor that contains no impossible
 * single (an ao5 of three taps and two real solves can clear the floor, yet it's no real ao5).
 */
function sessionValues(solves: readonly PeriodSolve[], floors: PeriodFloors, ns: readonly number[]) {
  const times = solves.map((s) => (s.effectiveMs === null ? Number.POSITIVE_INFINITY : s.effectiveMs));
  const impossible = [0];
  for (const t of times) impossible.push(impossible[impossible.length - 1] + (Number.isFinite(t) && t < floors.single ? 1 : 0));
  const averages = ns.map((n) => rollingAverage(times, n));
  return solves.map((s, i) => ({
    at: s.createdAt,
    single: Number.isFinite(times[i]) ? { valueMs: times[i], ok: times[i] >= floors.single } : null,
    averages: ns.map((n, k) => {
      const v = averages[k][i];
      if (v === null || !Number.isFinite(v)) return null;
      const tainted = impossible[i + 1] - impossible[i + 1 - n] > 0;
      return { valueMs: v, ok: !tainted && v >= floors.average };
    }),
  }));
}

/**
 * `sessions`: each non-practice session's solves in session order (created_at, then arrival),
 * starting up to 4 solves before `since`, so that an ao5 ending at a solve after `since` has its
 * whole window. Only solves at or after `since` count, by the UTC day and ISO week they were done
 * in. A value below its floor (the leaderboard passes the anti-cheat floor: the WCA record), or an
 * average containing such a single, doesn't count, so one impossible time doesn't hide the real ones;
 * the lowest of those goes under `flagged`. A tie keeps the earlier solve, as the boards do.
 */
export function periodBests(sessions: readonly PeriodSolve[][], since: Date, floors: PeriodFloors = { single: 0, average: 0 }): PeriodBests {
  const out: PeriodBests = { days: {}, weeks: {} };
  const offer = (bucket: Record<string, PeriodEntry>, key: string, kind: PeriodKind, v: { valueMs: number; ok: boolean }, at: string) => {
    const entry = (bucket[key] ??= {});
    const into: PeriodValues = v.ok ? entry : (entry.flagged ??= {});
    if (better(into[kind], v.valueMs, at)) into[kind] = { valueMs: v.valueMs, achievedAt: at };
  };
  for (const solves of sessions) {
    for (const { at: when, single, averages } of sessionValues(solves, floors, [5])) {
      if (when.getTime() < since.getTime()) continue;
      const at = when.toISOString();
      const day = dayKey(when, 'UTC');
      const week = isoWeekKey(when, 'UTC');
      for (const [kind, v] of [
        ['single', single],
        ['ao5', averages[0]],
      ] as const) {
        if (!v) continue;
        offer(out.days, day, kind, v, at);
        offer(out.weeks, week, kind, v, at);
      }
    }
  }
  return out;
}

const better = (cur: PeriodBest | undefined, valueMs: number, at: string) => !cur || valueMs < cur.valueMs || (valueMs === cur.valueMs && at < cur.achievedAt);

export const ALL_TIME_KINDS = ['single', 'ao5', 'ao12'] as const;
export type AllTimeKind = (typeof ALL_TIME_KINDS)[number];
export type AllTimeValues = Partial<Record<AllTimeKind, PeriodBest>>;
/** The best valid single / ao5 / ao12, and under `flagged` the best ones below the floors. */
export type AllTimeBests = AllTimeValues & { flagged?: AllTimeValues };

/**
 * A person's all-time best single, ao5 and ao12 (within a session, as for PBs) that may rank (see
 * sessionValues), for the leaderboard's all-time boards when their PB is an impossible time: their
 * real solves still rank. `sessions` = every non-practice session's solves in session order. The
 * lowest values that may not rank go under `flagged`. A tie keeps the earlier solve.
 */
export function allTimeBests(sessions: readonly PeriodSolve[][], floors: PeriodFloors = { single: 0, average: 0 }): AllTimeBests {
  const out: AllTimeBests = {};
  for (const solves of sessions) {
    for (const { at: when, single, averages } of sessionValues(solves, floors, [5, 12])) {
      const at = when.toISOString();
      for (const [kind, v] of [
        ['single', single],
        ['ao5', averages[0]],
        ['ao12', averages[1]],
      ] as const) {
        if (!v) continue;
        const into: AllTimeValues = v.ok ? out : (out.flagged ??= {});
        if (better(into[kind], v.valueMs, at)) into[kind] = { valueMs: v.valueMs, achievedAt: at };
      }
    }
  }
  return out;
}
