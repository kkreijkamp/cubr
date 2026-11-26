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
  // Each kind's PBs depend only on that kind's values in time order: so the solves are put in time order
  // once (an index), and each kind is scanned in turn. (One candidate object per solve and kind, all sorted
  // together, ran a 192 MB heap out at the 250k-solve cap: six per solve. Measured 2026-11-26.)
  const sessions = groupBySession(countsForPbs(solves));
  const flat = sessions.flat();
  const n = flat.length;
  const chrono = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => flat[a].at - flat[b].at || flat[a].order - flat[b].order);
  const found: { kind: PbKind; k: number; value: number; p: Prepared }[] = [];
  const scan = (kind: PbKind, values: Float64Array) => {
    let best: number | undefined;
    for (const i of chrono) {
      const value = values[i];
      if (!isImprovement(value, best)) continue; // NaN (no value) and DNF never are
      best = value;
      found.push({ kind, k: PB_KINDS.indexOf(kind), value, p: flat[i] });
    }
  };
  scan(
    'single',
    Float64Array.from(flat, (p) => p.eff),
  );
  const times = sessions.map((session) => session.map((p) => p.eff));
  for (const kind of ROLLING_KINDS) {
    const values = new Float64Array(n).fill(NaN);
    let offset = 0;
    sessions.forEach((session, j) => {
      rollingAverage(times[j], ROLLING_N[kind]).forEach((v, i) => {
        if (v !== null) values[offset + i] = v;
      });
      offset += session.length;
    });
    scan(kind, values);
  }
  // in the order they happened (same moment: the list's order, then the kinds')
  found.sort((a, b) => a.p.at - b.p.at || a.p.order - b.p.order || a.k - b.k);
  return found.map((f) => ({ kind: f.kind, valueMs: f.value, achievedAt: new Date(f.p.at).toISOString() }));
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
