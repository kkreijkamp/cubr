/**
 * WCA-style statistics. Effective times are numbers in ms where a DNF is `Infinity`.
 * Rolling/aggregate results use `null` for "not enough solves" and `Infinity` for DNF.
 */
export type Penalty = 'OK' | '+2' | 'DNF';

export interface SolveLike {
  timeMs: number;
  penalty: Penalty;
}

export const DNF = Number.POSITIVE_INFINITY;

/** Time including penalty; DNF -> Infinity. */
export function effectiveMs(s: SolveLike): number {
  if (s.penalty === 'DNF') return DNF;
  return s.penalty === '+2' ? s.timeMs + 2000 : s.timeMs;
}

export function isDnf(v: number | null | undefined): boolean {
  return v === DNF;
}

/**
 * How many best AND worst results are trimmed from an average of `n` (csTimer default:
 * ceil(5%) each side): ao5-ao20 -> 1, ao25 -> 2, ao50 -> 3, ao100 -> 5, ao1000 -> 50.
 * mo3 (a mean) trims nothing.
 */
export function trimFor(n: number): number {
  if (n < 5) return 0;
  return Math.ceil(n * 0.05);
}

/**
 * Average of exactly the given effective times with `trim` removed from each end.
 * If more than `trim` results are DNF the average is DNF. Result rounded to whole ms.
 */
export function trimmedAverage(times: number[], trim: number): number {
  if (times.length === 0) return DNF;
  const sorted = [...times].sort((a, b) => a - b);
  const dnfs = sorted.length - countFinite(sorted);
  if (dnfs > trim) return DNF;
  const kept = sorted.slice(trim, sorted.length - trim);
  if (kept.length === 0) return DNF;
  return Math.round(kept.reduce((a, b) => a + b, 0) / kept.length);
}

function countFinite(xs: number[]): number {
  let c = 0;
  for (const x of xs) if (Number.isFinite(x)) c++;
  return c;
}

/** Mean of the last 3 (any DNF -> DNF). */
export function meanOf(times: number[]): number {
  if (times.length === 0) return DNF;
  if (times.some((t) => !Number.isFinite(t))) return DNF;
  return Math.round(times.reduce((a, b) => a + b, 0) / times.length);
}

/** Value of an "average of n" (mo3 when n === 3) over exactly n effective times. */
export function averageOfN(times: number[], n: number): number {
  return n === 3 ? meanOf(times) : trimmedAverage(times, trimFor(n));
}

function insertSorted(arr: number[], v: number): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, v);
}

function removeSorted(arr: number[], v: number): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 1);
}

/**
 * Rolling average of n over a chronological list of effective times.
 * out[i] = average of times[i-n+1..i], or null when i < n-1. O(N*n) worst case via a sorted window.
 */
export function rollingAverage(times: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(times.length).fill(null);
  if (times.length < n) return out;
  const trim = n === 3 ? 0 : trimFor(n);
  const window: number[] = [];
  let sum = 0; // sum of finite values inside window
  let dnfs = 0;
  for (let i = 0; i < times.length; i++) {
    const v = times[i];
    insertSorted(window, v);
    if (Number.isFinite(v)) sum += v;
    else dnfs++;
    if (i >= n) {
      const old = times[i - n];
      removeSorted(window, old);
      if (Number.isFinite(old)) sum -= old;
      else dnfs--;
    }
    if (i >= n - 1) {
      if (n === 3) {
        out[i] = dnfs > 0 ? DNF : Math.round(sum / 3);
      } else if (dnfs > trim) {
        out[i] = DNF;
      } else {
        // window is sorted; trimmed sum = total finite sum - lowest trim - highest trim (finite part)
        let low = 0;
        for (let k = 0; k < trim; k++) low += window[k];
        let high = 0;
        for (let k = n - trim; k < n; k++) high += Number.isFinite(window[k]) ? window[k] : 0;
        out[i] = Math.round((sum - low - high) / (n - 2 * trim));
      }
    }
  }
  return out;
}

/** Best (lowest) rolling average of n and the index (of its last solve). */
export function bestRolling(times: number[], n: number): { value: number; index: number } | null {
  const r = rollingAverage(times, n);
  let best: { value: number; index: number } | null = null;
  for (let i = 0; i < r.length; i++) {
    const v = r[i];
    if (v === null) continue;
    if (!best || v < best.value) best = { value: v, index: i };
  }
  return best;
}

/** Current (latest) average of n, or null if fewer than n solves. */
export function currentAverage(times: number[], n: number): number | null {
  if (times.length < n) return null;
  return averageOfN(times.slice(times.length - n), n);
}

export interface StatLine {
  current: number | null;
  best: number | null;
  bestIndex: number | null;
}

export interface SessionStats {
  count: number;
  solved: number;
  dnfs: number;
  best: number | null;
  bestIndex: number | null;
  worst: number | null;
  mean: number | null;
  sd: number | null;
  averages: Record<string, StatLine>; // keys: mo3, ao5, ao12, ao50, ao100, ao1000 ...
}

export const DEFAULT_AVERAGES = [3, 5, 12, 50, 100, 1000];

export function avgKey(n: number): string {
  return n === 3 ? 'mo3' : `ao${n}`;
}

/** Everything the timer sidebar shows, from a chronological list of solves. */
export function sessionStats(solves: SolveLike[], ns: number[] = DEFAULT_AVERAGES): SessionStats {
  const times = solves.map(effectiveMs);
  const finite = times.filter((t) => Number.isFinite(t));
  let best: number | null = null;
  let bestIndex: number | null = null;
  let worst: number | null = null;
  times.forEach((t, i) => {
    if (Number.isFinite(t) && (best === null || t < best)) {
      best = t;
      bestIndex = i;
    }
    if (Number.isFinite(t) && (worst === null || t > worst)) worst = t;
  });
  const mean = finite.length ? Math.round(finite.reduce((a, b) => a + b, 0) / finite.length) : null;
  let sd: number | null = null;
  if (finite.length > 1 && mean !== null) {
    const m = finite.reduce((a, b) => a + b, 0) / finite.length;
    sd = Math.round(Math.sqrt(finite.reduce((a, b) => a + (b - m) ** 2, 0) / (finite.length - 1)));
  }
  const averages: Record<string, StatLine> = {};
  for (const n of ns) {
    if (times.length < n) {
      averages[avgKey(n)] = { current: null, best: null, bestIndex: null };
      continue;
    }
    const b = bestRolling(times, n);
    averages[avgKey(n)] = { current: currentAverage(times, n), best: b?.value ?? null, bestIndex: b?.index ?? null };
  }
  return { count: times.length, solved: finite.length, dnfs: times.length - finite.length, best, bestIndex, worst, mean, sd, averages };
}

/** JSON encoding used by the APIs: ms number, -1 for DNF, null for n/a. */
export function toApiValue(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return Number.isFinite(v) ? v : -1;
}

/** Inverse of toApiValue. */
export function fromApiValue(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return v === -1 ? DNF : v;
}
