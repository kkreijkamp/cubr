import { dayKey, hourIn } from '@cubetype/common';
import { describe, expect, it } from 'vitest';
import { makeBucketer, validTz } from '../src/domain/buckets.js';

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
  }, 30_000); // ~2,500 Intl comparisons — can exceed the 5 s default on a busy machine
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
