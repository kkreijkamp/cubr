import type { EventEnvelope, Redis } from '@cubetype/common';
import {
  DAILY_TTL_SEC,
  USERS_KEY,
  WEEKLY_TTL_SEC,
  allTimeKey,
  atKey,
  dailyKey,
  hasBoards,
  isKind,
  utcDay,
  utcWeek,
  weeklyKey,
  type Kind,
} from './keys.js';

// ---------------------------------------------------------------------------------------------
// Turns domain events (SPEC §8) into board writes. The plan* functions are pure (unit-tested);
// makeHandler executes the plan against Redis.
// All writes are idempotent (exact set / keep-best), so at-least-once redelivery is harmless.
// ---------------------------------------------------------------------------------------------

export const CONSUMED_TYPES = ['pb.updated', 'solve.created', 'user.registered', 'user.updated'];

/** A keep-best write (ZADD LT) to a period board. */
export interface BestWrite {
  board: string;
  event: string;
  kind: Kind;
  valueMs: number;
  achievedAt: string;
  ttlSec: number;
}

/** An exact write (or removal when valueMs is null) to an all-time board. */
export interface PbWrite {
  board: string;
  event: string;
  kind: Kind;
  valueMs: number | null;
  achievedAt: string;
}

type Data = Record<string, unknown>;

const positiveMs = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;

function parseTime(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** pb.updated → exact all-time write, or removal when the PB no longer exists (null / -1). */
export function planPbUpdated(d: Data, nowMs = Date.now()): PbWrite | null {
  const event = String(d.event ?? '');
  const kind = String(d.kind ?? '');
  if (!hasBoards(event) || !isKind(kind)) return null; // mo3/ao50/ao100 have no boards
  let valueMs: number | null;
  if (d.valueMs === null || d.valueMs === undefined || d.valueMs === -1) valueMs = null;
  else {
    valueMs = positiveMs(d.valueMs);
    if (valueMs === null) return null; // garbage value: ignore rather than delete
  }
  const achievedAt = new Date(parseTime(d.achievedAt) ?? parseTime(d.occurredAt) ?? nowMs).toISOString();
  return { board: allTimeKey(event, kind), event, kind, valueMs, achievedAt };
}

/**
 * solve.created → daily + weekly boards for the single (effectiveMs; null = DNF → skipped) and the
 * session's rolling ao5. Buckets are UTC days / ISO weeks of the solve's createdAt. Solves older
 * than a board's lifetime (3 d / 15 d) are skipped so replays don't resurrect expired boards.
 */
export function planSolveCreated(d: Data, nowMs = Date.now()): BestWrite[] {
  const event = String(d.event ?? '');
  if (!hasBoards(event)) return [];
  const createdMs = parseTime(d.createdAt) ?? parseTime(d.occurredAt) ?? nowMs;
  const created = new Date(createdMs);
  const achievedAt = created.toISOString();
  const ageSec = (nowMs - createdMs) / 1000;
  const day = utcDay(created);
  const week = utcWeek(created);

  const values: [Kind, number | null][] = [
    ['single', positiveMs(d.effectiveMs)],
    ['ao5', positiveMs((d.rolling as Data | undefined)?.ao5)],
  ];
  const out: BestWrite[] = [];
  for (const [kind, valueMs] of values) {
    if (valueMs === null) continue;
    if (ageSec <= DAILY_TTL_SEC) {
      out.push({ board: dailyKey(event, kind, day), event, kind, valueMs, achievedAt, ttlSec: DAILY_TTL_SEC });
    }
    if (ageSec <= WEEKLY_TTL_SEC) {
      out.push({ board: weeklyKey(event, kind, week), event, kind, valueMs, achievedAt, ttlSec: WEEKLY_TTL_SEC });
    }
  }
  return out;
}

type UserInfo = { userId: string; username: string; country?: string | null };

/** Display info carried by an event: username always; country only for user.* events. */
export function planUserInfo(type: string, d: Data): UserInfo | null {
  if (typeof d.userId !== 'string' || !d.userId) return null;
  if (typeof d.username !== 'string' || !d.username) return null;
  const info: UserInfo = { userId: d.userId, username: d.username };
  if (type.startsWith('user.') && 'country' in d) {
    info.country = typeof d.country === 'string' && d.country ? d.country : null;
  }
  return info;
}

export interface IngestDeps {
  redis: Redis;
}

export function makeHandler({ redis }: IngestDeps) {
  /** Merges display info into lb:users; the country is only replaced when the event carried one. */
  async function saveUserInfo(info: UserInfo) {
    const raw = await redis.hget(USERS_KEY, info.userId);
    let cur: Record<string, unknown> = {};
    if (raw) {
      try {
        cur = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* corrupt entry: overwrite it */
      }
    }
    const next = { ...cur, username: info.username, ...(info.country !== undefined ? { country: info.country } : {}) };
    const json = JSON.stringify(next);
    if (json !== raw) await redis.hset(USERS_KEY, info.userId, json);
  }

  /** Keep-best write: ZADD LT only ever lowers a score; achievedAt follows the score. */
  async function writeBest(evt: EventEnvelope, w: BestWrite) {
    const userId = evt.data.userId as string;
    const changed = await redis.zadd(w.board, 'LT', 'CH', w.valueMs, userId);
    if (changed === 1) await redis.hset(atKey(w.board), userId, w.achievedAt);
    await redis.multi().expire(w.board, w.ttlSec).expire(atKey(w.board), w.ttlSec).exec();
  }

  return async function handle(evt: EventEnvelope): Promise<void> {
    const d = evt.data as Data;
    const userId = d.userId;
    if (typeof userId !== 'string' || !userId) return;

    const info = planUserInfo(evt.type, d);
    if (info) await saveUserInfo(info);

    switch (evt.type) {
      case 'pb.updated': {
        const w = planPbUpdated(d);
        if (!w) return;
        if (w.valueMs === null) await redis.multi().zrem(w.board, userId).hdel(atKey(w.board), userId).exec();
        else await redis.multi().zadd(w.board, w.valueMs, userId).hset(atKey(w.board), userId, w.achievedAt).exec();
        return;
      }
      case 'solve.created':
        for (const w of planSolveCreated(d)) await writeBest(evt, w);
        return;
      default:
        return; // user.* — display info handled above
    }
  };
}
