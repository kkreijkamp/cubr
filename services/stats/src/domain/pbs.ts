import { averageOfN, bestRolling, effectiveMs, rollingAverage, type Penalty } from '@cubr/cubestats';

/** PB kinds in display order (SPEC section 7.3 CHECK constraint). */
export const PB_KINDS = ['single', 'mo3', 'ao5', 'ao12', 'ao50', 'ao100'] as const;
export type PbKind = (typeof PB_KINDS)[number];
export type RollingKind = Exclude<PbKind, 'single'>;

/** Window size of each rolling kind (mo3 is a mean, the others are trimmed averages). */
export const ROLLING_N: Record<RollingKind, number> = { mo3: 3, ao5: 5, ao12: 12, ao50: 50, ao100: 100 };
export const ROLLING_KINDS = Object.keys(ROLLING_N) as RollingKind[];

/** One solve as returned by solve-service `GET /internal/users/:id/solves`. */
export interface ListSolve {
  id: string;
  sessionId: string;
  timeMs: number;
  penalty: Penalty;
  createdAt: string;
  /** in a practice session: counts for no PB */
  practice?: boolean;
}

/** The solves that count for personal bests (a practice session's don't). */
export const countsForPbs = (solves: ListSolve[]): ListSolve[] => (solves.some((s) => s.practice) ? solves.filter((s) => !s.practice) : solves);

export interface PbValue {
  valueMs: number;
  solveId: string | null;
  achievedAt: string;
}

export type PbSet = Partial<Record<PbKind, PbValue>>;

export interface HistoryEntry {
  kind: PbKind;
  valueMs: number;
  achievedAt: string;
}

interface Prepared {
  solve: ListSolve;
  at: number; // epoch ms of createdAt
  order: number; // position in the input list (stable tie-break)
  eff: number; // effective ms, Infinity = DNF
}

/**
 * Groups the list by session, each session sorted chronologically (stable on equal timestamps,
 * so the solve-service order "session_id, created_at" is preserved).
 */
export function groupBySession(solves: ListSolve[]): Prepared[][] {
  const bySession = new Map<string, Prepared[]>();
  solves.forEach((solve, order) => {
    const p: Prepared = { solve, at: Date.parse(solve.createdAt), order, eff: effectiveMs(solve) };
    let arr = bySession.get(solve.sessionId);
    if (!arr) bySession.set(solve.sessionId, (arr = []));
    arr.push(p);
  });
  const out = [...bySession.values()];
  for (const arr of out) arr.sort((a, b) => a.at - b.at || a.order - b.order);
  return out;
}

function iso(p: Prepared): string {
  return new Date(p.at).toISOString();
}

/** True when `candidate` is a real (finite, positive) time that beats `current` (null = no PB yet). */
export function isImprovement(candidate: number | null | undefined, current: number | null | undefined): boolean {
  if (candidate === null || candidate === undefined || !Number.isFinite(candidate) || candidate <= 0) return false;
  return current === null || current === undefined || candidate < current;
}

/**
 * Personal bests from a user's full solve list for one event:
 *   single = best effective time; mo3/aoN = best rolling value within one session (bestRolling),
 *   min across sessions. DNF results never count as a PB, nor do practice sessions. Ties keep the
 *   earliest achievement.
 */
export function computePbs(solves: ListSolve[]): PbSet {
  const pbs: PbSet = {};
  const consider = (kind: PbKind, value: number, p: Prepared) => {
    if (!Number.isFinite(value)) return;
    const cur = pbs[kind];
    if (!cur || value < cur.valueMs || (value === cur.valueMs && p.at < Date.parse(cur.achievedAt))) {
      pbs[kind] = { valueMs: value, solveId: p.solve.id, achievedAt: iso(p) };
    }
  };
  for (const session of groupBySession(countsForPbs(solves))) {
    for (const p of session) consider('single', p.eff, p);
    const times = session.map((p) => p.eff);
    for (const kind of ROLLING_KINDS) {
      const best = bestRolling(times, ROLLING_N[kind]);
      // achievedAt / solveId of an average = the window's last solve
      if (best) consider(kind, best.value, session[best.index]);
    }
  }
  return pbs;
}

/**
 * PB progression: replays all solves chronologically (across sessions) and records every time a
 * kind's best improves (practice sessions left out). Used to rebuild pb_history after a full
 * recompute / import.
 */
export function replayHistory(solves: ListSolve[]): HistoryEntry[] {
  interface Candidate {
    at: number;
    order: number;
    kind: PbKind;
    value: number;
  }
  const candidates: Candidate[] = [];
  for (const session of groupBySession(countsForPbs(solves))) {
    const times = session.map((p) => p.eff);
    session.forEach((p) => {
      if (Number.isFinite(p.eff)) candidates.push({ at: p.at, order: p.order, kind: 'single', value: p.eff });
    });
    for (const kind of ROLLING_KINDS) {
      const rolling = rollingAverage(times, ROLLING_N[kind]);
      rolling.forEach((v, i) => {
        if (v !== null && Number.isFinite(v)) candidates.push({ at: session[i].at, order: session[i].order, kind, value: v });
      });
    }
  }
  candidates.sort((a, b) => a.at - b.at || a.order - b.order || PB_KINDS.indexOf(a.kind) - PB_KINDS.indexOf(b.kind));
  const best: Partial<Record<PbKind, number>> = {};
  const history: HistoryEntry[] = [];
  for (const c of candidates) {
    if (isImprovement(c.value, best[c.kind])) {
      best[c.kind] = c.value;
      history.push({ kind: c.kind, valueMs: c.value, achievedAt: new Date(c.at).toISOString() });
    }
  }
  return history;
}

/**
 * Incremental rolling values for a session tail (chronological effective times incl. the new
 * solve, at most 100): value of the latest window for each kind with enough solves.
 */
export function tailAverages(tail: number[], kinds: RollingKind[] = ROLLING_KINDS): Partial<Record<RollingKind, number>> {
  const out: Partial<Record<RollingKind, number>> = {};
  for (const kind of kinds) {
    const n = ROLLING_N[kind];
    if (tail.length >= n) out[kind] = averageOfN(tail.slice(tail.length - n), n);
  }
  return out;
}

/** Payload `rolling.ao5/ao12` -> candidate ms (positive number), DNF (-1) / null -> null. */
export function rollingFromPayload(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}
