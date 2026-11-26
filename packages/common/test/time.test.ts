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

describe('the formatters behind dayKey and hourIn', () => {
  it('are made once per zone: a new one per call held native memory a recompute ran to gigabytes with', () => {
    const Real = Intl.DateTimeFormat;
    let made = 0;
    const counting = function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      made++;
      return new Real(...args);
    };
    Object.defineProperty(Intl, 'DateTimeFormat', { value: counting, configurable: true, writable: true });
    try {
      const tz = 'Pacific/Chatham'; // a zone no other test here uses, so its formatters are new
      for (let i = 0; i < 5000; i++) {
        dayKey(new Date(Date.UTC(2026, 0, 1) + i * 900_000), tz);
        hourIn(new Date(Date.UTC(2026, 0, 1) + i * 900_000), tz);
      }
      expect(made).toBe(2);
      // and still right: Chatham is UTC+13:45 in January
      expect(dayKey(new Date('2026-01-01T10:15:00Z'), tz)).toBe('2026-01-02');
      expect(hourIn(new Date('2026-01-01T10:15:00Z'), tz)).toBe(0);
      // an unknown zone falls back to UTC, and is remembered as unknown
      expect(dayKey(new Date('2026-01-01T23:00:00Z'), 'Mars/Olympus_Mons')).toBe('2026-01-01');
      expect(hourIn(new Date('2026-01-01T23:00:00Z'), 'Mars/Olympus_Mons')).toBe(23);
      expect(made).toBe(4); // tried once each, not again
      dayKey(new Date(), 'Mars/Olympus_Mons');
      expect(made).toBe(4);
    } finally {
      Object.defineProperty(Intl, 'DateTimeFormat', { value: Real, configurable: true, writable: true });
    }
  });
});
