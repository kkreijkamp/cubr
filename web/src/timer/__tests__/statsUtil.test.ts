import { describe, expect, it } from 'vitest';
import { effectiveMs, parseTimeInput, rollingAverage, sessionStats } from '@cubr/cubestats';
import {
  averageReport,
  averageWindow,
  detectPbs,
  fmtSolveLong,
  fmtSolveShort,
  parseAvgKey,
  parseManualEntry,
  pbFlags,
  statNs,
} from '../../components/timer/statsUtil';
import type { Solve } from '../../lib/types';

const mk = (times: (number | 'DNF')[]): Solve[] =>
  times.map((t, i) => ({
    id: `s${i}`,
    sessionId: 'x',
    event: '333',
    timeMs: t === 'DNF' ? 9999 : t,
    penalty: t === 'DNF' ? 'DNF' : 'OK',
    scramble: `scr ${i}`,
    comment: null,
    source: 'timer',
    createdAt: new Date(i * 1000).toISOString(),
  }));

describe('stat keys', () => {
  it('parses mo3/aoN', () => {
    expect(parseAvgKey('mo3')).toBe(3);
    expect(parseAvgKey('ao12')).toBe(12);
    expect(parseAvgKey('ao3')).toBeNull();
    expect(parseAvgKey('mo5')).toBeNull();
    expect(parseAvgKey('x')).toBeNull();
    expect(statNs(['ao100', 'mo3', 'ao5', 'ao5', 'bogus'])).toEqual([3, 5, 100]);
  });
});

describe('formatting', () => {
  it('truncates singles (averages: formatAverage, packages/cubestats/test/formatting.test.ts)', () => {
    expect(fmtSolveShort({ timeMs: 12349, penalty: 'OK' }, 2)).toBe('12.34');
    expect(fmtSolveShort({ timeMs: 12349, penalty: '+2' }, 2)).toBe('14.34+');
    expect(fmtSolveShort({ timeMs: 12349, penalty: 'DNF' }, 2)).toBe('DNF');
    expect(fmtSolveLong({ timeMs: 12349, penalty: 'DNF' }, 2)).toBe('DNF(12.34)');
    expect(fmtSolveLong({ timeMs: 1, penalty: 'DNF' }, 2)).toBe('DNF');
  });
});

describe('average windows', () => {
  it('marks best and worst as trimmed, DNF counting as worst', () => {
    const solves = mk([10000, 'DNF', 9000, 11000, 12000, 10500]);
    const w = averageWindow(solves, 5, 5, 11167);
    expect(w.start).toBe(1);
    expect(w.solves.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(Array.from(w.trimmed).sort()).toEqual([0, 1]); // DNF (worst) and 9.00 (best)
    const report = averageReport('best ao5', w, 2);
    expect(report).toContain('best ao5: 11.17');
    expect(report).toContain('1. (DNF)   scr 1');
    expect(report).toContain('2. (9.00)   scr 2');
  });
  it('mo3 trims nothing', () => {
    expect(averageWindow(mk([1000, 2000, 3000]), 2, 3, 2000).trimmed.size).toBe(0);
  });
});

describe('pb detection', () => {
  it('reports a new single and ao5 only against an existing best', () => {
    const before = mk([12000, 13000, 13000, 12500, 12800, 12100]);
    const after = [...before, ...mk([9000]).map((s) => ({ ...s, id: 'new' }))];
    const pbs = detectPbs(sessionStats(before, [5, 12, 100]), sessionStats(after, [5, 12, 100]));
    expect(pbs.map((p) => p.kind)).toEqual(['single', 'ao5']);
    // a first solve or too few solves never counts
    expect(detectPbs(sessionStats(mk([]), [5]), sessionStats(mk([5000]), [5]))).toEqual([]);
    expect(detectPbs(sessionStats(mk([9000, 8000]), [5]), sessionStats(mk([9000, 8000, 7000]), [5]))).toEqual([]);
  });
  it('ignores improvements that are not caused by the latest solve', () => {
    const before = mk([12000, 11000, 13000, 12500, 11800, 12100]);
    const after = mk([12000, 11000, 13000, 12500, 11800, 12100, 15000]);
    expect(detectPbs(sessionStats(before, [5]), sessionStats(after, [5]))).toEqual([]);
  });
  it('pbFlags: the first solve is a pb, then every one that beats all before it', () => {
    const ms = mk([12000, 11500, 'DNF', 11800, 12500, 11000, 11900, 10800]).map(effectiveMs);
    expect(pbFlags(ms)).toEqual([true, true, false, false, false, true, false, true]);
    // the first ao5 is a pb too
    expect(pbFlags(rollingAverage(ms, 5)).indexOf(true)).toBe(4);
  });
  it('pbFlags: ties, DNFs and missing averages never count', () => {
    expect(pbFlags([null, null, 900, Infinity, 900, 800, null, 850, 700])).toEqual([false, false, true, false, false, true, false, false, true]);
    expect(pbFlags([Infinity, 1000, 1000])).toEqual([false, true, false]);
  });
});

describe('manual entry', () => {
  const p = (s: string) => parseManualEntry(s, parseTimeInput);
  it('understands csTimer typing formats', () => {
    expect(p('12.34')).toEqual({ timeMs: 12340, penalty: 'OK' });
    expect(p('1234')).toEqual({ timeMs: 12340, penalty: 'OK' });
    expect(p('1:02.5')).toEqual({ timeMs: 62500, penalty: 'OK' });
    expect(p('14.34+')).toEqual({ timeMs: 12340, penalty: '+2' });
    expect(p('DNF(12.34)')).toEqual({ timeMs: 12340, penalty: 'DNF' });
    expect(p('dnf')).toEqual({ timeMs: 1, penalty: 'DNF' });
    expect(p('')).toBeNull();
    expect(p('abc')).toBeNull();
    expect(p('1.5+')).toBeNull();
  });
});
