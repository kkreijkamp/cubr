import { dayKey, hourIn } from '@cubetype/common';
import { describe, expect, it } from 'vitest';
import { bucketSolves, makeBucketer, validTz } from '../src/domain/buckets.js';

describe('bucketSolves', () => {
  it('buckets by day and hour in the given timezone', () => {
    const solves = [
      // 2026-10-13T15:30Z = 2026-10-14 01:30 in Brisbane (UTC+10)
      { timeMs: 10_000, penalty: 'OK' as const, createdAt: '2026-10-13T15:30:00.000Z' },
      { timeMs: 12_000, penalty: '+2' as const, createdAt: '2026-10-13T15:45:00.000Z' },
      { timeMs: 9_000, penalty: 'DNF' as const, createdAt: '2026-10-13T16:10:00.000Z' },
      // 2026-10-13T13:59Z = 2026-10-13 23:59 Brisbane
      { timeMs: 11_000, penalty: 'OK' as const, createdAt: '2026-10-13T13:59:00.000Z' },
    ];
    const { days, hours } = bucketSolves(solves, 'Australia/Brisbane');
    expect(days).toEqual([
      { day: '2026-10-13', solves: 1, totalMs: 11_000 },
      // total = raw times (time spent cubing), DNF included
      { day: '2026-10-14', solves: 3, totalMs: 31_000 },
    ]);
    expect(hours).toEqual([
      { hour: 1, solves: 2, sumMs: 24_000, dnfs: 0 }, // 10.00 + 14.00 (+2 counts in the mean)
      { hour: 2, solves: 0, sumMs: 0, dnfs: 1 },
      { hour: 23, solves: 1, sumMs: 11_000, dnfs: 0 },
    ]);
  });

  it('uses UTC buckets for UTC', () => {
    const { days, hours } = bucketSolves([{ timeMs: 5000, penalty: 'OK', createdAt: '2026-10-13T23:59:59.999Z' }], 'UTC');
    expect(days[0].day).toBe('2026-10-13');
    expect(hours[0].hour).toBe(23);
  });
});

describe('makeBucketer (15-minute memo)', () => {
  it('matches dayKey/hourIn for every minute across a DST change and odd offsets', () => {
    // Australia/Sydney DST starts 2026-10-04 02:00 local (= 2026-10-03T16:00Z); Nepal is UTC+5:45
    for (const tz of ['Australia/Sydney', 'Asia/Kathmandu', 'America/St_Johns', 'UTC']) {
      const bucket = makeBucketer(tz);
      const start = Date.parse('2026-10-03T12:00:00Z');
      for (let t = start; t < start + 12 * 3600_000; t += 60_000 + 7_000) {
        const d = new Date(t);
        expect(bucket(d)).toEqual({ day: dayKey(d, tz), hour: hourIn(d, tz) });
      }
    }
  }, 30_000); // ~2,500 Intl comparisons - can exceed the 5 s default on a busy machine
});

describe('validTz', () => {
  it('accepts IANA names and rejects junk', () => {
    expect(validTz('Australia/Brisbane')).toBe('Australia/Brisbane');
    expect(validTz('UTC')).toBe('UTC');
    expect(validTz('Not/AZone')).toBeNull();
    expect(validTz('')).toBeNull();
    expect(validTz(undefined)).toBeNull();
  });
});
