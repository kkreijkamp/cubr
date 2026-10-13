import { describe, expect, it } from 'vitest';
import { dayKey, hourIn, isoWeekKey } from '../src/time.js';

describe('time helpers', () => {
  it('buckets by timezone', () => {
    const d = new Date('2026-10-14T22:30:00Z');
    expect(dayKey(d, 'UTC')).toBe('2026-10-14');
    expect(dayKey(d, 'Australia/Brisbane')).toBe('2026-10-15');
    expect(hourIn(d, 'Australia/Brisbane')).toBe(8);
    expect(dayKey(d, 'Not/AZone')).toBe('2026-10-14');
  });
  it('computes ISO weeks', () => {
    expect(isoWeekKey(new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01');
    expect(isoWeekKey(new Date('2026-10-14T12:00:00Z'))).toBe('2026-W42');
    expect(isoWeekKey(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
  });
});
