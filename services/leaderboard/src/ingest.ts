import type { EventEnvelope, Redis } from '@cubr/common';
import type { FastifyBaseLogger } from 'fastify';
import { isBelowFloor, type FloorSource } from './floors.js';
import {
  DAILY_TTL_SEC,
  DELETED_USERS_KEY,
  FLAGGED_KEY,
  FLAGGED_MAX,
  USERS_KEY,
  WEEKLY_TTL_SEC,
  allTimeKey,
  atKey,
  challengeKey,
  dailyKey,
  flaggedBy,
  hasBoards,
  isKind,
  isValidDay,
  livePeriods,
  PERIOD_KINDS,
  purgePlan,
  tsKey,
  utcDay,
  utcWeek,
  weeklyKey,
  type Kind,
} from './keys.js';
import type { PeriodBests, PeriodSource } from './periods.js';

// ---------------------------------------------------------------------------------------------
// Turns domain events (SPEC section 8) into board writes. The plan* functions are pure (unit-tested);
// makeHandler executes the plan against Redis with the anti-cheat check in front of every write.
// All writes are idempotent (exact set / keep-best), so at-least-once redelivery is harmless.
// ---------------------------------------------------------------------------------------------

export const CONSUMED_TYPES = ['pb.updated', 'solve.created', 'periods.changed', 'daily.completed', 'daily.updated', 'user.registered', 'user.updated', 'user.deleted'];

/** A keep-best write (ZADD LT) to a period board. */
export interface BestWrite {
  board: string;
  event: string;
  kind: Kind;
  valueMs: number;
  achievedAt: string;
  ttlSec: number;
}

/** An exact write (or removal when valueMs is null) to a daily or weekly board, after periods.changed. */
export interface PeriodWrite {
  board: string;
  kind: Kind;
  valueMs: number | null;
  achievedAt: string;
  ttlSec: number;
}

/** An exact write (or removal when valueMs is null) to an all-time or daily-challenge board. */
export interface PbWrite {
  board: string;
  event: string;
  kind: Kind;
  valueMs: number | null;
  achievedAt: string;
  occurredAtMs: number;
}

type Data = Record<string, unknown>;

const positiveMs = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;

function parseTime(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** pb.updated -> exact all-time write, or removal when the PB no longer exists (null / -1). */
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
  const occurredAtMs = parseTime(d.occurredAt) ?? nowMs;
  const achievedAt = new Date(parseTime(d.achievedAt) ?? occurredAtMs).toISOString();
  return { board: allTimeKey(event, kind), event, kind, valueMs, achievedAt, occurredAtMs };
}

/**
 * solve.created -> daily + weekly boards for the single (effectiveMs; null = DNF -> skipped) and the
 * session's rolling ao5. Buckets are UTC days / ISO weeks of the solve's createdAt. Solves older
 * than a board's lifetime (3 d / 15 d) are skipped so replays don't resurrect expired boards, and
 * so are a practice session's (the all-time boards follow stats' PBs, which leave them out too).
 */
export function planSolveCreated(d: Data, nowMs = Date.now()): BestWrite[] {
  const event = String(d.event ?? '');
  if (!hasBoards(event) || d.practice === true) return [];
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

/**
 * periods.changed -> an exact write for every live daily and weekly board of the event: stats' best
 * of that day or week (already at or above the anti-cheat floor), or no entry when there is none.
 * So a deleted or penalised solve, a deleted or practice session and a merge all show up there.
 */
export function planPeriodRefresh(event: string, bests: PeriodBests, live: { days: string[]; weeks: string[] }): PeriodWrite[] {
  if (!hasBoards(event)) return [];
  const out: PeriodWrite[] = [];
  const plan = (periods: string[], bucket: PeriodBests['days'], kinds: readonly Kind[], key: (k: Kind, p: string) => string, ttlSec: number) => {
    for (const p of periods) {
      for (const kind of kinds) {
        const b = bucket[p]?.[kind as 'single' | 'ao5'];
        out.push({ board: key(kind, p), kind, valueMs: b?.valueMs ?? null, achievedAt: b?.achievedAt ?? '', ttlSec });
      }
    }
  };
  plan(live.days, bests.days, PERIOD_KINDS.daily, (k, p) => dailyKey(event, k, p), DAILY_TTL_SEC);
  plan(live.weeks, bests.weeks, PERIOD_KINDS.weekly, (k, p) => weeklyKey(event, k, p), WEEKLY_TTL_SEC);
  return out;
}

/**
 * daily.completed / daily.updated -> exact write to the daily-challenge ao5 board: the latest result
 * wins (a penalty marked after the solve can make it worse), and a DNF ao5 (-1) removes the entry.
 * Kept without TTL (history).
 */
export function planDailyResult(d: Data, nowMs = Date.now()): PbWrite | null {
  const event = String(d.event ?? '');
  const date = String(d.date ?? '');
  if (!hasBoards(event) || !isValidDay(date)) return null;
  let valueMs: number | null = null;
  if (d.ao5 !== -1 && d.ao5 !== null) {
    valueMs = positiveMs(d.ao5);
    if (valueMs === null) return null; // garbage value: ignore rather than delete
  }
  const occurredAtMs = parseTime(d.occurredAt) ?? nowMs;
  return { board: challengeKey(date, event), event, kind: 'ao5', valueMs, achievedAt: new Date(occurredAtMs).toISOString(), occurredAtMs };
}

/** Only same-origin avatar paths from the auth service are stored (no arbitrary image URLs). */
const AVATAR_PATH_RE = /^\/api\/users\/[0-9a-f-]{36}\/avatar\?v=[0-9a-f]{6,64}$/;

type UserInfo = { userId: string; username: string; country?: string | null; avatarUrl?: string | null };

/** Display info carried by an event: username always; country and avatarUrl only for user.* events. */
export function planUserInfo(type: string, d: Data): UserInfo | null {
  if (typeof d.userId !== 'string' || !d.userId) return null;
  if (typeof d.username !== 'string' || !d.username) return null;
  const info: UserInfo = { userId: d.userId, username: d.username };
  if (type.startsWith('user.') && 'country' in d) {
    info.country = typeof d.country === 'string' && d.country ? d.country : null;
  }
  if (type.startsWith('user.') && 'avatarUrl' in d) {
    info.avatarUrl = typeof d.avatarUrl === 'string' && AVATAR_PATH_RE.test(d.avatarUrl) ? d.avatarUrl : null;
  }
  return info;
}

export interface IngestDeps {
  redis: Redis;
  floors: FloorSource;
  log: FastifyBaseLogger;
  /** stats' day and week bests, read after periods.changed (without it that event is ignored) */
  periods?: PeriodSource;
}

export function makeHandler({ redis, floors, log, periods }: IngestDeps) {
  /**
   * Anti-cheat gate: true if the value may be written, otherwise it is recorded in lb:flagged
   * once per event/kind/value per domain event (one solve feeds both a daily and a weekly board).
   */
  async function passesFloor(
    evt: EventEnvelope,
    w: { board: string; event: string; kind: Kind; valueMs: number },
    flagged: Set<string>,
  ) {
    const floorMs = await floors.floor(w.event, w.kind);
    if (!isBelowFloor(w.valueMs, floorMs)) return true;
    const id = `${w.event}:${w.kind}:${w.valueMs}`;
    if (flagged.has(id)) return false;
    flagged.add(id);
    const entry = {
      userId: evt.data.userId,
      username: evt.data.username ?? null,
      event: w.event,
      kind: w.kind,
      valueMs: w.valueMs,
      floorMs,
      board: w.board,
      source: evt.type,
      eventId: evt.data.eventId,
      flaggedAt: new Date().toISOString(),
    };
    await redis.multi().lpush(FLAGGED_KEY, JSON.stringify(entry)).ltrim(FLAGGED_KEY, 0, FLAGGED_MAX - 1).exec();
    log.warn(entry, 'anti-cheat: value below world-record floor flagged');
    return false;
  }

  async function writeBest(evt: EventEnvelope, w: BestWrite, flagged: Set<string>) {
    if (!(await passesFloor(evt, w, flagged))) return;
    const occurredAtMs = parseTime((evt.data as Data).occurredAt) ?? Date.now();
    await redis.lbBest(w.board, atKey(w.board), tsKey(w.board), w.valueMs, evt.data.userId as string, w.achievedAt, w.ttlSec, occurredAtMs);
  }

  /**
   * periods.changed: the user's solves for an event changed, so their entry on every live daily
   * and weekly board is set to stats' best of that day or week (above the anti-cheat floor), or
   * removed. Each write carries the event's time: an older one, or a late solve.created from
   * before it, is ignored (the scripts' ts-hash).
   */
  async function refreshPeriods(userId: string, d: Data) {
    const event = String(d.event ?? '');
    if (!periods || !hasBoards(event)) return;
    const live = livePeriods();
    const [minSingle, minAverage] = await Promise.all([floors.floor(event, 'single'), floors.floor(event, 'ao5')]);
    const bests = await periods.bests({ userId, event, from: live.from, minSingle: minSingle ?? 0, minAverage: minAverage ?? 0 });
    const occurredAtMs = parseTime(d.occurredAt) ?? Date.now();
    for (const w of planPeriodRefresh(event, bests, live)) {
      await redis.lbSetPeriod(w.board, atKey(w.board), tsKey(w.board), userId, w.valueMs ?? '', w.achievedAt, occurredAtMs, w.ttlSec);
    }
  }

  /** A deleted account leaves every board, the display info and the anti-cheat list. */
  async function purgeUser(userId: string) {
    // first, so an event for the account handled meanwhile can't put it back
    await redis.sadd(DELETED_USERS_KEY, userId);
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'lb:*', 'COUNT', 500);
      cursor = next;
      const plan = purgePlan(keys);
      if (plan.length) {
        const p = redis.pipeline();
        for (const { op, key } of plan) {
          if (op === 'hdel') p.hdel(key, userId);
          else p.zrem(key, userId);
        }
        await p.exec();
      }
    } while (cursor !== '0');
    await redis.hdel(USERS_KEY, userId);
    for (const entry of await redis.lrange(FLAGGED_KEY, 0, -1)) {
      if (flaggedBy(entry, userId)) await redis.lrem(FLAGGED_KEY, 0, entry);
    }
    log.info({ userId }, 'deleted account removed from the leaderboards');
  }

  return async function handle(evt: EventEnvelope): Promise<void> {
    const d = evt.data as Data;
    const userId = d.userId;
    if (typeof userId !== 'string' || !userId) return;
    if (evt.type === 'user.deleted') return purgeUser(userId);
    if (await redis.sismember(DELETED_USERS_KEY, userId)) return; // late event for a deleted account
    const flagged = new Set<string>();

    const info = planUserInfo(evt.type, d);
    if (info) {
      const hasCountry = info.country !== undefined;
      const hasAvatar = info.avatarUrl !== undefined;
      await redis.lbUser(USERS_KEY, info.userId, info.username, hasCountry ? '1' : '0', info.country ?? '', hasAvatar ? '1' : '0', info.avatarUrl ?? '');
    }

    switch (evt.type) {
      case 'pb.updated':
      case 'daily.completed':
      case 'daily.updated': {
        const w = evt.type === 'pb.updated' ? planPbUpdated(d) : planDailyResult(d);
        if (!w) return;
        if (w.valueMs !== null && !(await passesFloor(evt, { ...w, valueMs: w.valueMs }, flagged))) return;
        await redis.lbSetPb(w.board, atKey(w.board), tsKey(w.board), userId, w.valueMs ?? '', w.achievedAt, w.occurredAtMs);
        return;
      }
      case 'solve.created':
        for (const w of planSolveCreated(d)) await writeBest(evt, w, flagged);
        return;
      case 'periods.changed':
        return refreshPeriods(userId, d);
      default:
        return; // user.* - display info handled above
    }
  };
}
