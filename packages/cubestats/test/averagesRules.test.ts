import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AVERAGES,
  DNF,
  averageOfN,
  avgKey,
  bestRolling,
  currentAverage,
  effectiveMs,
  fromApiValue,
  isDnf,
  meanOf,
  rollingAverage,
  sessionStats,
  toApiValue,
  trimFor,
  trimmedAverage,
  type SolveLike,
} from '../src/averages.js';

describe('trimFor (ceil 5 % from each end, nothing below 5)', () => {
  it.each([
    [1, 0], [3, 0], [4, 0], [5, 1], [12, 1], [20, 1], [21, 2], [25, 2], [40, 2], [41, 3], [50, 3], [100, 5], [101, 6], [1000, 50],
  ])('an average of %i trims %i', (n, trim) => {
    expect(trimFor(n)).toBe(trim);
  });
});

describe('trimmed averages and means', () => {
  it('is DNF for no times, or when trimming leaves nothing', () => {
    expect(trimmedAverage([], 0)).toBe(DNF);
    expect(trimmedAverage([1000, 2000], 1)).toBe(DNF);
    expect(meanOf([])).toBe(DNF);
  });

  it('allows as many DNFs as it trims, and no more (ao5, ao12, ao25, ao100)', () => {
    const times = (n: number, dnfs: number) => Array.from({ length: n }, (_, i) => (i < dnfs ? DNF : 10_000 + i));
    for (const n of [5, 12, 25, 100]) {
      const trim = trimFor(n);
      expect(averageOfN(times(n, trim), n), `ao${n} with ${trim} DNF`).not.toBe(DNF);
      expect(averageOfN(times(n, trim + 1), n), `ao${n} with ${trim + 1} DNF`).toBe(DNF);
    }
  });

  it('removes the best and worst results before averaging, and rounds to whole ms', () => {
    // ao12: drop 1 000 and 99 000, mean of 10 001 ... 10 010
    const times = [99_000, ...Array.from({ length: 10 }, (_, i) => 10_001 + i), 1000];
    expect(averageOfN(times, 12)).toBe(Math.round((10_001 + 10_010) / 2));
    expect(trimmedAverage([1000, 1001, 1001, 1001, 9999], 1)).toBe(1001);
    expect(meanOf([1000, 1000, 1001])).toBe(1000); // 1000.33
    expect(meanOf([1000, 1001, 1001])).toBe(1001); // 1000.67
  });

  it('mo3 trims nothing, so an outlier counts; an average of 4 has no trim either', () => {
    expect(averageOfN([1000, 1000, 10_000], 3)).toBe(4000);
    expect(averageOfN([1000, 2000, 3000, 6000], 4)).toBe(3000);
    expect(averageOfN([1000, 2000, 3000, DNF], 4)).toBe(DNF);
  });

  it('does not reorder the caller’s array', () => {
    const times = [3000, 1000, DNF, 2000, 5000];
    trimmedAverage(times, 1);
    rollingAverage(times, 5);
    expect(times).toEqual([3000, 1000, DNF, 2000, 5000]);
  });
});

describe('rolling averages', () => {
  const naive = (times: number[], n: number) => times.map((_, i) => (i < n - 1 ? null : averageOfN(times.slice(i - n + 1, i + 1), n)));

  it.each([1, 2, 3, 4, 5, 12, 25, 50])('match a window-by-window computation for n = %i, with clusters of DNFs', (n) => {
    // DNF clusters long enough to make some windows DNF and leave others just under the limit
    const times = Array.from({ length: 400 }, (_, i) => (i % 37 < 3 || i % 101 === 0 ? DNF : 6000 + ((i * 7919) % 9000)));
    expect(rollingAverage(times, n)).toEqual(naive(times, n));
  });

  it('is all null with fewer than n times', () => {
    expect(rollingAverage([1000, 2000], 3)).toEqual([null, null]);
    expect(rollingAverage([], 5)).toEqual([]);
  });

  it('bestRolling keeps the earliest of equal bests, and reports DNF when every window is DNF', () => {
    expect(bestRolling([5000, 1000, 1000, 1000, 5000, 1000, 1000, 1000], 3)).toEqual({ value: 1000, index: 3 });
    expect(bestRolling([DNF, DNF, DNF, DNF], 3)).toEqual({ value: DNF, index: 2 });
    expect(bestRolling([1000, 2000], 3)).toBeNull();
  });

  it('currentAverage uses the latest n times only', () => {
    expect(currentAverage([DNF, DNF, 1000, 2000, 3000], 3)).toBe(2000);
    expect(currentAverage([1000, 2000], 3)).toBeNull();
  });
});

describe('sessionStats', () => {
  const s = (timeMs: number, penalty: SolveLike['penalty'] = 'OK'): SolveLike => ({ timeMs, penalty });

  it('counts, best (first of equals), worst, mean and sample SD over finished solves, +2 included', () => {
    const st = sessionStats([s(10000), s(12000), s(11000, '+2'), s(9000), s(15000, 'DNF'), s(9000)]);
    expect(st).toMatchObject({ count: 6, solved: 5, dnfs: 1, best: 9000, bestIndex: 3, worst: 13000, mean: 10600, sd: 1817 });
    expect(st.averages.mo3).toEqual({ current: DNF, best: 11333, bestIndex: 3 });
    expect(st.averages.ao5).toEqual({ current: 11333, best: 11333, bestIndex: 5 });
    expect(st.averages.ao12).toEqual({ current: null, best: null, bestIndex: null });
    expect(Object.keys(st.averages)).toEqual(DEFAULT_AVERAGES.map(avgKey));
  });

  it('has nothing to show for no solves, and no single or mean when every solve is a DNF', () => {
    expect(sessionStats([])).toMatchObject({ count: 0, solved: 0, dnfs: 0, best: null, bestIndex: null, worst: null, mean: null, sd: null });
    const dnfs = sessionStats([s(1000, 'DNF'), s(2000, 'DNF'), s(3000, 'DNF')], [3]);
    expect(dnfs).toMatchObject({ count: 3, solved: 0, dnfs: 3, best: null, worst: null, mean: null, sd: null });
    expect(dnfs.averages).toEqual({ mo3: { current: DNF, best: DNF, bestIndex: 2 } });
  });

  it('has no SD with a single finished solve', () => {
    expect(sessionStats([s(1000), s(2000, 'DNF')]).sd).toBeNull();
  });

  it('computes only the averages asked for', () => {
    expect(Object.keys(sessionStats([s(1000)], [5, 12, 100]).averages)).toEqual(['ao5', 'ao12', 'ao100']);
  });
});

describe('API encoding', () => {
  it('sends a DNF as -1 and n/a as null, and reads them back', () => {
    for (const v of [null, undefined, DNF, 0, 9876]) expect(fromApiValue(toApiValue(v))).toBe(v === undefined ? null : v);
    expect(toApiValue(DNF)).toBe(-1);
    expect(fromApiValue(-1)).toBe(DNF);
    expect(toApiValue(undefined)).toBeNull();
  });

  it('effective times and DNF checks', () => {
    expect(effectiveMs({ timeMs: 9000, penalty: 'OK' })).toBe(9000);
    expect(effectiveMs({ timeMs: 9000, penalty: '+2' })).toBe(11000);
    expect(isDnf(effectiveMs({ timeMs: 9000, penalty: 'DNF' }))).toBe(true);
    expect(isDnf(9000)).toBe(false);
    expect(isDnf(null)).toBe(false);
    expect([3, 5, 12].map(avgKey)).toEqual(['mo3', 'ao5', 'ao12']);
  });
});
