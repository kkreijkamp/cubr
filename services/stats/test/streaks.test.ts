import { describe, expect, it } from 'vitest';
import { addDays, computeStreaks, dayNumber, dayString } from '../src/domain/streaks.js';

describe('day arithmetic', () => {
  it('round-trips and crosses month / leap-year boundaries', () => {
    expect(dayString(dayNumber('2024-02-28'))).toBe('2024-02-28');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(dayNumber('1970-01-02')).toBe(1);
  });
});

describe('computeStreaks', () => {
  const today = '2026-10-14';

  it('returns zeros for no activity', () => {
    expect(computeStreaks([], today)).toEqual({ activeDays: 0, currentStreak: 0, longestStreak: 0 });
  });

  it('counts a streak ending today', () => {
    expect(computeStreaks(['2026-10-12', '2026-10-13', '2026-10-14'], today)).toEqual({
      activeDays: 3, currentStreak: 3, longestStreak: 3,
    });
  });

  it('still counts a streak that ended yesterday (today not practised yet)', () => {
    expect(computeStreaks(['2026-10-11', '2026-10-12', '2026-10-13'], today).currentStreak).toBe(3);
  });

  it('breaks the current streak after a missed day', () => {
    const s = computeStreaks(['2026-10-10', '2026-10-11', '2026-10-12'], today);
    expect(s.currentStreak).toBe(0);
    expect(s.longestStreak).toBe(3);
  });

  it('finds the longest run anywhere, ignoring duplicates and order', () => {
    const days = ['2026-01-05', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-02', '2026-10-14', '2026-01-04', '2026-03-01'];
    expect(computeStreaks(days, today)).toEqual({ activeDays: 7, currentStreak: 1, longestStreak: 5 });
  });

  it('treats a day ahead of "today" (bucketed further east) as today', () => {
    expect(computeStreaks(['2026-10-14', '2026-10-15'], today).currentStreak).toBe(2);
  });

  it('streaks across a month boundary', () => {
    expect(computeStreaks(['2026-09-29', '2026-09-30', '2026-10-01'], '2026-10-01').currentStreak).toBe(3);
  });
});
