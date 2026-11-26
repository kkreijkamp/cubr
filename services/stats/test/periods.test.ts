// The day and week bests (src/domain/periods.ts), pure: UTC days and ISO weeks, ao5 windows that
// reach back before `from`, DNFs, floors and ties.
import { describe, expect, it } from 'vitest';
import { allTimeBests, periodBests, type PeriodSolve } from '../src/domain/periods.js';

const solve = (effectiveMs: number | null, at: string): PeriodSolve => ({ effectiveMs, createdAt: new Date(at) });
const since = new Date('2026-11-16T00:00:00.000Z');

describe('periodBests', () => {
  it('buckets by UTC day and ISO week, whatever the timezone the solve was done in', () => {
    const r = periodBests(
      [
        [
          solve(30_000, '2026-11-15T23:59:59.999Z'),
          solve(20_000, '2026-11-16T00:00:00.000Z'),
          solve(25_000, '2026-11-22T23:59:00.000Z'),
          solve(10_000, '2026-11-23T00:00:00.000Z'),
        ],
      ],
      new Date('2026-11-09T00:00:00.000Z'),
    );
    expect(Object.keys(r.days)).toEqual(['2026-11-15', '2026-11-16', '2026-11-22', '2026-11-23']);
    expect(r.weeks['2026-W46'].single?.valueMs).toBe(30_000); // Sunday 15 November ends week 46
    expect(r.weeks['2026-W47'].single).toEqual({ valueMs: 20_000, achievedAt: '2026-11-16T00:00:00.000Z' });
    expect(r.weeks['2026-W48'].single?.valueMs).toBe(10_000);
  });

  it('leaves out solves before `from`, but lets them complete an ao5 ending after it', () => {
    const r = periodBests(
      [
        [
          solve(10_000, '2026-11-15T10:00:00Z'),
          solve(11_000, '2026-11-15T10:01:00Z'),
          solve(12_000, '2026-11-15T10:02:00Z'),
          solve(13_000, '2026-11-15T10:03:00Z'),
          solve(14_000, '2026-11-16T10:00:00Z'),
        ],
      ],
      since,
    );
    expect(r).toEqual({
      days: {
        '2026-11-16': { single: { valueMs: 14_000, achievedAt: '2026-11-16T10:00:00.000Z' }, ao5: { valueMs: 12_000, achievedAt: '2026-11-16T10:00:00.000Z' } },
      },
      weeks: {
        '2026-W47': { single: { valueMs: 14_000, achievedAt: '2026-11-16T10:00:00.000Z' }, ao5: { valueMs: 12_000, achievedAt: '2026-11-16T10:00:00.000Z' } },
      },
    });
  });

  it('keeps sessions apart: an ao5 never mixes two of them', () => {
    const a = [10_000, 10_000, 10_000].map((t, i) => solve(t, `2026-11-16T10:0${i}:00Z`));
    const b = [10_000, 10_000].map((t, i) => solve(t, `2026-11-16T11:0${i}:00Z`));
    expect(periodBests([a, b], since).days['2026-11-16'].ao5).toBeUndefined();
  });

  it('skips DNFs, a DNF ao5 (two DNFs), and values below the floors', () => {
    const r = periodBests(
      [
        [
          solve(null, '2026-11-16T10:00:00Z'),
          solve(null, '2026-11-16T10:01:00Z'),
          solve(400, '2026-11-16T10:02:00Z'),
          solve(20_000, '2026-11-16T10:03:00Z'),
          solve(21_000, '2026-11-16T10:04:00Z'),
        ],
      ],
      since,
      { single: 2_510, average: 3_510 },
    );
    expect(r.days['2026-11-16']).toEqual({
      single: { valueMs: 20_000, achievedAt: '2026-11-16T10:03:00.000Z' },
      flagged: { single: { valueMs: 400, achievedAt: '2026-11-16T10:02:00.000Z' } }, // below the floor: reported apart
    });
    // one DNF in an ao5 is trimmed as its worst time
    const one = periodBests(
      [[solve(null, '2026-11-16T10:00:00Z'), ...[10_000, 11_000, 12_000, 13_000].map((t, i) => solve(t, `2026-11-16T10:0${i + 1}:00Z`))]],
      since,
    );
    expect(one.days['2026-11-16'].ao5?.valueMs).toBe(12_000);
  });

  it('keeps the earlier solve on a tie, as the boards do', () => {
    const r = periodBests([[solve(15_000, '2026-11-16T10:00:00Z')], [solve(15_000, '2026-11-16T09:00:00Z')]], since);
    expect(r.days['2026-11-16'].single).toEqual({ valueMs: 15_000, achievedAt: '2026-11-16T09:00:00.000Z' });
  });

  it('answers nothing for no solves', () => {
    expect(periodBests([], since)).toEqual({ days: {}, weeks: {} });
  });
});

describe('allTimeBests (all-time boards while a PB is refused)', () => {
  const taps = [648, 612, 418, 481, 239].map((t, i) => solve(t, `2026-11-16T11:10:3${i}.000Z`));
  const floors = { single: 2_510, average: 3_510 };

  it("ranks the real solves and reports the refused ones apart (Barry's 16 November); an ao5 with a tap in it never ranks", () => {
    const r = allTimeBests([[...taps, solve(17_956, '2026-11-16T11:15:37.617Z'), solve(17_382, '2026-11-16T11:18:07.253Z')]], floors);
    expect(r).toEqual({
      single: { valueMs: 17_382, achievedAt: '2026-11-16T11:18:07.253Z' },
      flagged: { single: { valueMs: 239, achievedAt: '2026-11-16T11:10:34.000Z' }, ao5: { valueMs: 504, achievedAt: '2026-11-16T11:10:34.000Z' } },
    });
  });

  it('finds an ao5 and an ao12 of real solves in another session, and ignores DNFs', () => {
    const real = Array.from({ length: 12 }, (_, i) => solve(i === 3 ? null : 20_000 + i * 100, `2026-11-17T10:${String(i).padStart(2, '0')}:00.000Z`));
    const r = allTimeBests([taps, real], floors);
    expect(r.single?.valueMs).toBe(20_000);
    // one DNF in an average is trimmed as its worst time: 20.0 20.1 20.2 DNF 20.4 -> (20.1 + 20.2 + 20.4) / 3
    expect(r.ao5).toEqual({ valueMs: 20_233, achievedAt: '2026-11-17T10:04:00.000Z' });
    expect(r.ao12?.valueMs).toBe(20_630); // 20.1 ... 21.1 without 20.3 (the DNF), best and worst trimmed
    expect(r.flagged?.single?.valueMs).toBe(239);
  });

  it('without floors: the plain bests, nothing flagged', () => {
    expect(allTimeBests([taps], { single: 0, average: 0 })).toEqual({
      single: { valueMs: 239, achievedAt: '2026-11-16T11:10:34.000Z' },
      ao5: { valueMs: 504, achievedAt: '2026-11-16T11:10:34.000Z' },
    });
  });
});
