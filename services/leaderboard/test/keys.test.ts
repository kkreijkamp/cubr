import { describe, expect, it } from 'vitest';
import {
  PERIOD_KINDS,
  allTimeKey,
  atKey,
  boardKey,
  challengeKey,
  currentPeriodKey,
  dailyKey,
  hasBoards,
  isKind,
  isValidDay,
  pageRange,
  rankAt,
  tsKey,
  weeklyKey,
} from '../src/keys.js';

describe('key builders', () => {
  it('match the SPEC §7.6 keyspace', () => {
    expect(allTimeKey('333', 'single')).toBe('lb:333:single:all');
    expect(dailyKey('333oh', 'ao5', '2026-10-14')).toBe('lb:333oh:ao5:d:2026-10-14');
    expect(weeklyKey('pyram', 'single', '2026-W42')).toBe('lb:pyram:single:w:2026-W42');
    expect(challengeKey('2026-10-14', '222')).toBe('lb:dc:2026-10-14:222');
    expect(atKey('lb:333:single:all')).toBe('lb:333:single:all:at');
    expect(tsKey('lb:333:single:all')).toBe('lb:333:single:all:ts');
  });
  it('boardKey picks the period', () => {
    expect(boardKey('333', 'ao12', 'all', 'all')).toBe('lb:333:ao12:all');
    expect(boardKey('333', 'ao5', 'weekly', '2026-W01')).toBe('lb:333:ao5:w:2026-W01');
    expect(boardKey('333', 'single', 'daily', '2026-01-01')).toBe('lb:333:single:d:2026-01-01');
  });
  it('kinds and events', () => {
    expect(isKind('ao12')).toBe(true);
    expect(isKind('mo3')).toBe(false);
    expect(PERIOD_KINDS.weekly).toEqual(['single', 'ao5']);
    expect(hasBoards('333')).toBe(true);
    expect(hasBoards('333fm')).toBe(false);
    expect(hasBoards('333mbf')).toBe(false);
  });
});

describe('period keys (UTC)', () => {
  it('computes the current day / ISO week in UTC', () => {
    // 23:30 on Sunday 2026-01-04 UTC = Monday in Brisbane, but boards are UTC
    const d = new Date('2026-01-04T23:30:00Z');
    expect(currentPeriodKey('all', d)).toBe('all');
    expect(currentPeriodKey('daily', d)).toBe('2026-01-04');
    expect(currentPeriodKey('weekly', d)).toBe('2026-W01');
    expect(currentPeriodKey('weekly', new Date('2026-01-05T00:00:00Z'))).toBe('2026-W02');
  });
  it('handles ISO week-year boundaries', () => {
    expect(currentPeriodKey('weekly', new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    expect(currentPeriodKey('weekly', new Date('2024-12-30T12:00:00Z'))).toBe('2025-W01');
  });
  it('validates day keys', () => {
    expect(isValidDay('2026-10-14')).toBe(true);
    expect(isValidDay('2024-02-29')).toBe(true);
    expect(isValidDay('2026-02-29')).toBe(false);
    expect(isValidDay('2026-13-01')).toBe(false);
    expect(isValidDay('2026-1-01')).toBe(false);
  });
});

describe('paging / ranks', () => {
  it('maps pages to inclusive ZRANGE indexes', () => {
    expect(pageRange(1, 50)).toEqual({ start: 0, stop: 49 });
    expect(pageRange(3, 10)).toEqual({ start: 20, stop: 29 });
  });
  it('rank = absolute position + 1', () => {
    expect(rankAt(0, 0)).toBe(1);
    expect(rankAt(20, 4)).toBe(25);
  });
});
