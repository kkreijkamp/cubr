import type { Redis } from '@cubr/common';
import { EVENT_IDS } from '@cubr/cubestats';
import { parseFlag, type FlaggedValue } from './floors.js';
import { KINDS, USERS_KEY, allTimeKey, atKey, flaggedKey, pageRange, rankAt, type Kind } from './keys.js';

// Read side: turns sorted sets + side hashes into the response shapes of SPEC section 9.5.

export interface BoardEntry {
  rank: number;
  userId: string;
  username: string;
  country: string | null;
  avatarUrl: string | null;
  valueMs: number;
  achievedAt: string | null;
}

export interface BoardPage {
  total: number;
  entries: BoardEntry[];
  me: { rank: number; valueMs: number } | null;
  /** the caller's own best time on this board that the anti-cheat refused (they're told why) */
  flagged: FlaggedValue | null;
}

/** Parses a lb:users value; unknown users show as 'unknown' so clients can always render a name. */
export function parseUserInfo(raw: string | null | undefined): { username: string; country: string | null; avatarUrl: string | null } {
  if (raw) {
    try {
      const v = JSON.parse(raw) as { username?: unknown; country?: unknown; avatarUrl?: unknown };
      return {
        username: typeof v.username === 'string' && v.username ? v.username : 'unknown',
        country: typeof v.country === 'string' && v.country ? v.country : null,
        avatarUrl: typeof v.avatarUrl === 'string' && v.avatarUrl.startsWith('/api/users/') ? v.avatarUrl : null,
      };
    } catch {
      /* fall through */
    }
  }
  return { username: 'unknown', country: null, avatarUrl: null };
}

/** Splits a ZRANGE ... WITHSCORES reply [member, score, member, score, ...]. */
export function splitWithScores(flat: string[]): { ids: string[]; scores: number[] } {
  const ids: string[] = [];
  const scores: number[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    ids.push(flat[i]);
    scores.push(Number(flat[i + 1]));
  }
  return { ids, scores };
}

function unwrap<T>(results: [Error | null, unknown][] | null): T[] {
  if (!results) throw new Error('redis pipeline aborted');
  return results.map(([err, value]) => {
    if (err) throw err;
    return value as T;
  });
}

/** One page of a board, plus the caller's own position when `meId` is given. */
export async function readBoard(redis: Redis, key: string, page: number, size: number, meId?: string): Promise<BoardPage> {
  const { start, stop } = pageRange(page, size);
  const p = redis.pipeline().zcard(key).zrange(key, start, stop, 'WITHSCORES');
  if (meId) p.zrank(key, meId).zscore(key, meId).hget(flaggedKey(key), meId);
  const [total, flat, myRank, myScore, myFlag] = unwrap<unknown>(await p.exec()) as [number, string[], number | null, string | null, string | null];

  const { ids, scores } = splitWithScores(flat);
  let users: (string | null)[] = [];
  let ats: (string | null)[] = [];
  if (ids.length) {
    [users, ats] = unwrap<(string | null)[]>(
      await redis
        .pipeline()
        .hmget(USERS_KEY, ...ids)
        .hmget(atKey(key), ...ids)
        .exec(),
    );
  }
  const entries = ids.map((userId, i): BoardEntry => {
    const info = parseUserInfo(users[i]);
    return { rank: rankAt(start, i), userId, ...info, valueMs: scores[i], achievedAt: ats[i] ?? null };
  });

  const me = meId && myRank !== null && myRank !== undefined && myScore !== null ? { rank: myRank + 1, valueMs: Number(myScore) } : null;
  return { total, entries, me, flagged: meId ? parseFlag(myFlag) : null };
}

export interface UserRank {
  event: string;
  kind: Kind;
  period: 'all';
  rank: number;
  total: number;
  valueMs: number;
}

/** The user's position on every all-time board they appear on (16 events x 3 kinds, one pipeline). */
export async function readUserRanks(redis: Redis, userId: string): Promise<UserRank[]> {
  const boards = EVENT_IDS.flatMap((event) => KINDS.map((kind) => ({ event, kind, key: allTimeKey(event, kind) })));
  const p = redis.pipeline();
  for (const b of boards) p.zrank(b.key, userId).zscore(b.key, userId).zcard(b.key);
  const r = unwrap<unknown>(await p.exec());
  const ranks: UserRank[] = [];
  boards.forEach((b, i) => {
    const rank = r[i * 3] as number | null;
    const score = r[i * 3 + 1] as string | null;
    const total = r[i * 3 + 2] as number;
    if (rank === null || score === null) return;
    ranks.push({ event: b.event, kind: b.kind, period: 'all', rank: rank + 1, total, valueMs: Number(score) });
  });
  return ranks;
}
