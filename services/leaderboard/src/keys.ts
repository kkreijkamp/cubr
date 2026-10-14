import { dayKey, isoWeekKey } from '@cubetype/common';
import { isEventId } from '@cubetype/cubestats';

// ---------------------------------------------------------------------------------------------
// Redis key builders and period / paging math (pure, unit-tested). Keyspace: docs/SPEC.md §7.6.
//
//   lb:<event>:<kind>:all            zset  all-time board (score = ms, member = userId)
//   lb:<event>:<kind>:w:<YYYY-Www>   zset  weekly board   (TTL 15 d)
//   lb:<event>:<kind>:d:<YYYY-MM-DD> zset  daily board    (TTL 3 d)
//   lb:dc:<YYYY-MM-DD>:<event>       zset  daily-challenge ao5 board
//   <board>:at                       hash  userId → achievedAt (ISO) for the score on <board>
//   <board>:ts                       hash  userId → occurredAt (epoch ms) of the last applied
//                                          pb.updated (all-time boards only; drops stale events)
//   lb:users                         hash  userId → JSON {username, country, avatarUrl}
//   lb:flagged                       list  rejected (anti-cheat) entries, newest first, capped
//   lb:meta:built / lb:rebuild-lock  string
// ---------------------------------------------------------------------------------------------

export const KINDS = ['single', 'ao5', 'ao12'] as const;
export type Kind = (typeof KINDS)[number];

export const PERIODS = ['all', 'weekly', 'daily'] as const;
export type Period = (typeof PERIODS)[number];

/** Kinds that exist per period (weekly/daily boards are fed from solve.created: single + rolling ao5). */
export const PERIOD_KINDS: Record<Period, readonly Kind[]> = {
  all: KINDS,
  weekly: ['single', 'ao5'],
  daily: ['single', 'ao5'],
};

export const USERS_KEY = 'lb:users';
export const FLAGGED_KEY = 'lb:flagged';
export const FLAGGED_MAX = 1000;
export const META_BUILT_KEY = 'lb:meta:built';
export const REBUILD_LOCK_KEY = 'lb:rebuild-lock';

export const DAILY_TTL_SEC = 3 * 86_400;
export const WEEKLY_TTL_SEC = 15 * 86_400;

export const isKind = (k: string): k is Kind => (KINDS as readonly string[]).includes(k);

/** FMC results are move counts, not times, so 333fm has no (time-based) boards. */
export const hasBoards = (event: string): boolean => isEventId(event) && event !== '333fm';

export const allTimeKey = (event: string, kind: Kind) => `lb:${event}:${kind}:all`;
export const dailyKey = (event: string, kind: Kind, day: string) => `lb:${event}:${kind}:d:${day}`;
export const weeklyKey = (event: string, kind: Kind, week: string) => `lb:${event}:${kind}:w:${week}`;
export const challengeKey = (date: string, event: string) => `lb:dc:${date}:${event}`;
export const atKey = (board: string) => `${board}:at`;
export const tsKey = (board: string) => `${board}:ts`;

export function boardKey(event: string, kind: Kind, period: Period, periodKey: string): string {
  if (period === 'weekly') return weeklyKey(event, kind, periodKey);
  if (period === 'daily') return dailyKey(event, kind, periodKey);
  return allTimeKey(event, kind);
}

// Boards are global, so day/week buckets are computed in UTC (not the solver's timezone).
export const utcDay = (d: Date): string => dayKey(d, 'UTC');
export const utcWeek = (d: Date): string => isoWeekKey(d, 'UTC');

/** periodKey of the *current* board for a period: 'all' | 'YYYY-Www' | 'YYYY-MM-DD' (UTC). */
export function currentPeriodKey(period: Period, now: Date = new Date()): string {
  if (period === 'weekly') return utcWeek(now);
  if (period === 'daily') return utcDay(now);
  return 'all';
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isValidDay(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === s;
}

/** Number of ISO weeks (52 or 53) in an ISO week-numbering year: Dec 28 is always in the last week. */
export function isoWeeksInYear(year: number): number {
  return Number(utcWeek(new Date(Date.UTC(year, 11, 28))).slice(-2));
}

/** True for an existing ISO week written as YYYY-Www. */
export function isValidWeek(s: string): boolean {
  const m = /^(\d{4})-W(\d{2})$/.exec(s);
  if (!m) return false;
  const w = Number(m[2]);
  return w >= 1 && w <= isoWeeksInYear(Number(m[1]));
}

/** 1-based page → inclusive ZRANGE indexes. */
export function pageRange(page: number, size: number): { start: number; stop: number } {
  const start = (page - 1) * size;
  return { start, stop: start + size - 1 };
}

/**
 * Rank of the i-th entry of a page starting at index `start`. Ranks are simply position + 1:
 * equal times do not share a rank; ties are ordered by userId (Redis' lexicographic tie-break).
 */
export const rankAt = (start: number, i: number): number => start + i + 1;
