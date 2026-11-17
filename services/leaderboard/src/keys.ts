import { dayKey, isoWeekKey } from '@cubr/common';
import { isEventId } from '@cubr/cubestats';

// ---------------------------------------------------------------------------------------------
// Redis key builders and period / paging math (pure, unit-tested). Keyspace: docs/SPEC.md section 7.6.
//
//   lb:<event>:<kind>:all            zset  all-time board (score = ms, member = userId)
//   lb:<event>:<kind>:w:<YYYY-Www>   zset  weekly board   (TTL 15 d)
//   lb:<event>:<kind>:d:<YYYY-MM-DD> zset  daily board    (TTL 3 d)
//   lb:dc:<YYYY-MM-DD>:<event>       zset  daily-challenge ao5 board
//   <board>:at                       hash  userId -> achievedAt (ISO) for the score on <board>
//   <board>:ts                       hash  userId -> occurredAt (epoch ms) of the last applied
//                                          exact write (pb.updated, daily.completed / daily.updated,
//                                          periods.changed; drops stale events)
//   <board>:flagged                  hash  userId -> JSON {valueMs, floorMs, achievedAt}: the
//                                          user's best time the anti-cheat refused on this board,
//                                          so the API can tell them why they aren't on it
//   lb:users                         hash  userId -> JSON {username, country, avatarUrl}
//   lb:flagged                       list  rejected (anti-cheat) entries, newest first, capped
//   lb:meta:built / lb:rebuild-lock  string
//   lb:deleted-users                 set   deleted accounts (their events are ignored)
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
export const DELETED_USERS_KEY = 'lb:deleted-users';

/**
 * What removing a deleted account takes for each lb:* key: HDEL from the per-board :at / :ts /
 * :flagged hashes, ZREM from the boards; the bookkeeping keys are left alone (lb:users and lb:flagged
 * are cleaned separately).
 */
export function purgePlan(keys: string[]): { op: 'zrem' | 'hdel'; key: string }[] {
  const skip = new Set([USERS_KEY, FLAGGED_KEY, META_BUILT_KEY, REBUILD_LOCK_KEY, DELETED_USERS_KEY]);
  const hashes = /:(at|ts|flagged)$/;
  return keys.filter((k) => !skip.has(k)).map((key) => ({ op: hashes.test(key) ? 'hdel' : 'zrem', key }));
}

/** Whether an lb:flagged entry (JSON) is about this user. */
export function flaggedBy(entry: string, userId: string): boolean {
  try {
    return (JSON.parse(entry) as { userId?: unknown }).userId === userId;
  } catch {
    return false;
  }
}

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
export const flaggedKey = (board: string) => `${board}:flagged`;
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

const DAY_MS = 86_400_000;

/**
 * The daily and weekly boards a change can still touch: the ones solve.created writes to (solves
 * up to 3 days / 15 days old), so the UTC days and ISO weeks of the last 3 and 15 days. `from` is
 * the Monday (00:00 UTC) of the oldest of those weeks: solves from then on decide them all.
 */
export function livePeriods(now: Date = new Date()): { days: string[]; weeks: string[]; from: string } {
  const days = new Set<string>();
  for (let k = 0; k <= DAILY_TTL_SEC / 86_400; k++) days.add(utcDay(new Date(now.getTime() - k * DAY_MS)));
  const weeks = new Set<string>();
  for (let k = 0; k <= WEEKLY_TTL_SEC / 86_400; k++) weeks.add(utcWeek(new Date(now.getTime() - k * DAY_MS)));
  const oldest = new Date(now.getTime() - (WEEKLY_TTL_SEC / 86_400) * DAY_MS);
  const sinceMonday = (oldest.getUTCDay() + 6) % 7; // Monday = 0 ... Sunday = 6
  const from = new Date(Date.UTC(oldest.getUTCFullYear(), oldest.getUTCMonth(), oldest.getUTCDate() - sinceMonday));
  return { days: [...days], weeks: [...weeks], from: from.toISOString() };
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

/** 1-based page -> inclusive ZRANGE indexes. */
export function pageRange(page: number, size: number): { start: number; stop: number } {
  const start = (page - 1) * size;
  return { start, stop: start + size - 1 };
}

/**
 * Rank of the i-th entry of a page starting at index `start`. Ranks are simply position + 1:
 * equal times do not share a rank; ties are ordered by userId (Redis' lexicographic tie-break).
 */
export const rankAt = (start: number, i: number): number => start + i + 1;
