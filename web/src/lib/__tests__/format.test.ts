import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDate, formatDateTime, formatNumber, timeAgo } from '../format';

describe('timeAgo', () => {
  const now = new Date(2026, 9, 14, 12, 0, 0);
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says "just now" for the last 45 seconds', () => {
    expect(timeAgo(ago(0))).toBe('just now');
    expect(timeAgo(ago(44))).toBe('just now');
  });

  it('uses the singular for one unit and the plural otherwise', () => {
    expect(timeAgo(ago(50))).toBe('1 minute ago');
    expect(timeAgo(ago(5 * 60))).toBe('5 minutes ago');
    expect(timeAgo(ago(3600))).toBe('1 hour ago');
    expect(timeAgo(ago(3 * 86400))).toBe('3 days ago');
    expect(timeAgo(ago(2 * 31557600))).toBe('2 years ago');
  });

  it('returns "-" for missing or invalid dates', () => {
    expect(timeAgo(null)).toBe('-');
    expect(timeAgo(undefined)).toBe('-');
    expect(timeAgo('not a date')).toBe('-');
  });
});

describe('formatDate / formatDateTime', () => {
  it('formats local calendar dates', () => {
    const iso = new Date(2026, 9, 14, 21, 5).toISOString();
    expect(formatDate(iso)).toBe('14 Oct 2026');
    expect(formatDateTime(iso)).toBe('14 Oct 2026 21:05');
  });

  it('returns "-" for missing or invalid dates', () => {
    expect(formatDate(null)).toBe('-');
    expect(formatDateTime('garbage')).toBe('-');
  });
});

describe('formatNumber', () => {
  it('adds thousands separators', () => {
    expect(formatNumber(12345)).toBe('12,345');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(null)).toBe('-');
  });
});
