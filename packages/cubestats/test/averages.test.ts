import { describe, expect, it } from 'vitest';
import { DNF, averageOfN, bestRolling, effectiveMs, rollingAverage, sessionStats, toApiValue, trimFor, trimmedAverage } from '../src/averages.js';
import { formatSolve, formatTime, parseTimeInput } from '../src/format.js';

describe('trimFor', () => {
  it('matches WCA / csTimer defaults', () => {
    expect(trimFor(3)).toBe(0);
    expect(trimFor(5)).toBe(1);
    expect(trimFor(12)).toBe(1);
    expect(trimFor(50)).toBe(3);
    expect(trimFor(100)).toBe(5);
    expect(trimFor(1000)).toBe(50);
  });
});

describe('averages', () => {
  it('computes a WCA ao5', () => {
    expect(trimmedAverage([10000, 12000, 11000, 9000, 15000], 1)).toBe(11000);
  });
  it('one DNF in ao5 counts as worst', () => {
    expect(trimmedAverage([10000, 12000, DNF, 9000, 11000], 1)).toBe(11000);
  });
  it('two DNFs make the ao5 a DNF', () => {
    expect(trimmedAverage([10000, DNF, DNF, 9000, 11000], 1)).toBe(DNF);
  });
  it('mo3 is DNF with any DNF', () => {
    expect(averageOfN([1000, 2000, DNF], 3)).toBe(DNF);
    expect(averageOfN([1000, 2000, 3000], 3)).toBe(2000);
  });
  it('applies +2', () => {
    expect(effectiveMs({ timeMs: 10000, penalty: '+2' })).toBe(12000);
    expect(effectiveMs({ timeMs: 10000, penalty: 'DNF' })).toBe(DNF);
  });
  it('rolling average equals naive computation', () => {
    const times = Array.from({ length: 300 }, (_, i) => (i % 17 === 0 ? DNF : 8000 + ((i * 7919) % 5000)));
    for (const n of [3, 5, 12, 50, 100]) {
      const r = rollingAverage(times, n);
      for (let i = 0; i < times.length; i++) {
        const naive = i < n - 1 ? null : averageOfN(times.slice(i - n + 1, i + 1), n);
        expect(r[i]).toBe(naive);
      }
    }
  });
  it('finds best rolling ao5', () => {
    const times = [20000, 10000, 10000, 10000, 10000, 10000, 30000];
    expect(bestRolling(times, 5)).toEqual({ value: 10000, index: 4 });
  });
  it('session stats', () => {
    const solves = [
      { timeMs: 10000, penalty: 'OK' as const },
      { timeMs: 12000, penalty: 'OK' as const },
      { timeMs: 11000, penalty: '+2' as const },
      { timeMs: 9000, penalty: 'OK' as const },
      { timeMs: 15000, penalty: 'DNF' as const },
    ];
    const st = sessionStats(solves);
    expect(st.count).toBe(5);
    expect(st.solved).toBe(4);
    expect(st.best).toBe(9000);
    expect(st.averages.ao5.current).toBe(Math.round((10000 + 12000 + 13000) / 3));
    expect(st.averages.ao12.current).toBeNull();
    expect(toApiValue(DNF)).toBe(-1);
  });
});

describe('formatting', () => {
  it('formats times', () => {
    expect(formatTime(9876)).toBe('9.87');
    expect(formatTime(9876, 3)).toBe('9.876');
    expect(formatTime(62345)).toBe('1:02.34');
    expect(formatTime(3723450)).toBe('1:02:03.45');
    expect(formatTime(DNF)).toBe('DNF');
    expect(formatTime(-1)).toBe('DNF');
    expect(formatTime(null)).toBe('-');
    expect(formatSolve(12340, '+2')).toBe('14.34+');
    expect(formatSolve(12340, 'DNF')).toBe('DNF(12.34)');
  });
  it('parses manual input', () => {
    expect(parseTimeInput('12.34')).toBe(12340);
    expect(parseTimeInput('1:02.34')).toBe(62340);
    expect(parseTimeInput('1234')).toBe(12340);
    expect(parseTimeInput('10234')).toBe(62340);
    expect(parseTimeInput('dnf')).toBe(DNF);
    expect(parseTimeInput('abc')).toBeNull();
  });
});
