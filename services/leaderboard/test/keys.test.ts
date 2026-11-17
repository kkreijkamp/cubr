import { describe, expect, it } from 'vitest';
import {
  DELETED_USERS_KEY,
  FLAGGED_KEY,
  META_BUILT_KEY,
  PERIOD_KINDS,
  REBUILD_LOCK_KEY,
  USERS_KEY,
  allTimeKey,
  atKey,
  boardKey,
  challengeKey,
  currentPeriodKey,
  dailyKey,
  flaggedKey,
  flaggedBy,
  hasBoards,
  isKind,
  isValidDay,
  livePeriods,
  isValidWeek,
  isoWeeksInYear,
  pageRange,
  purgePlan,
  rankAt,
  tsKey,
  weeklyKey,
} from '../src/keys.js';

describe('key builders', () => {
  it('match the SPEC section 7.6 keyspace', () => {
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
  it('validates week keys incl. 53-week years', () => {
    expect(isoWeeksInYear(2026)).toBe(53);
    expect(isoWeeksInYear(2025)).toBe(52);
    expect(isValidWeek('2026-W53')).toBe(true);
    expect(isValidWeek('2025-W53')).toBe(false);
    expect(isValidWeek('2026-W00')).toBe(false);
    expect(isValidWeek('2026-W5')).toBe(false);
    expect(isValidWeek('2026-10-14')).toBe(false);
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

describe('deleting an account', () => {
  const U = '00000000-0000-4000-8000-000000000001';
  it('removes the user from boards (ZREM) and their :at / :ts / :flagged hashes (HDEL), not from the bookkeeping keys', () => {
    const board = allTimeKey('333', 'single');
    const keys = [board, atKey(board), tsKey(board), flaggedKey(board), dailyKey('333', 'ao5', '2026-10-26'), challengeKey('2026-10-26', '333'), USERS_KEY, FLAGGED_KEY, META_BUILT_KEY, REBUILD_LOCK_KEY, DELETED_USERS_KEY];
    expect(purgePlan(keys)).toEqual([
      { op: 'zrem', key: board },
      { op: 'hdel', key: atKey(board) },
      { op: 'hdel', key: tsKey(board) },
      { op: 'hdel', key: flaggedKey(board) },
      { op: 'zrem', key: dailyKey('333', 'ao5', '2026-10-26') },
      { op: 'zrem', key: challengeKey('2026-10-26', '333') },
    ]);
  });
  it('finds their anti-cheat entries', () => {
    expect(flaggedBy(JSON.stringify({ userId: U, valueMs: 1000 }), U)).toBe(true);
    expect(flaggedBy(JSON.stringify({ userId: 'someone-else' }), U)).toBe(false);
    expect(flaggedBy('not json', U)).toBe(false);
  });
});

describe('livePeriods (the daily and weekly boards a periods.changed refreshes)', () => {
  it('lists the UTC days of the last 3 days and the ISO weeks of the last 15, from the Monday of the oldest week', () => {
    expect(livePeriods(new Date('2026-11-17T09:00:00Z'))).toEqual({
      days: ['2026-11-17', '2026-11-16', '2026-11-15', '2026-11-14'],
      weeks: ['2026-W47', '2026-W46', '2026-W45'],
      from: '2026-11-02T00:00:00.000Z', // 15 days back is Monday 2 November
    });
  });

  it('crosses a year, and starts from a Monday when 15 days back is a Sunday', () => {
    expect(livePeriods(new Date('2027-01-02T00:30:00Z'))).toEqual({
      days: ['2027-01-02', '2027-01-01', '2026-12-31', '2026-12-30'],
      weeks: ['2026-W53', '2026-W52', '2026-W51'],
      from: '2026-12-14T00:00:00.000Z', // 15 days back is Friday 18 December, in the week of Monday 14
    });
    expect(livePeriods(new Date('2026-11-23T12:00:00Z')).from).toBe('2026-11-02T00:00:00.000Z'); // Sunday 8 Nov -> Monday 2 Nov
  });
});
