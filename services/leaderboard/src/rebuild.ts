import { fetchJson, internalHeaders, type FetchOptions, type Redis } from '@cubr/common';
import type { FastifyBaseLogger } from 'fastify';
import { isBelowFloor, type FloorSource } from './floors.js';
import {
  KINDS,
  META_BUILT_KEY,
  REBUILD_LOCK_KEY,
  USERS_KEY,
  allTimeKey,
  atKey,
  hasBoards,
  tsKey,
  type Kind,
} from './keys.js';

// ---------------------------------------------------------------------------------------------
// Boards are a derived read model: if Redis loses its data, all-time boards are rebuilt from the
// source of truth (stats-service PBs). Runs in the background (never blocks listen):
//   every 60 s: if lb:meta:built is missing -> take lb:rebuild-lock (SET NX EX 120, so only one
//   replica rebuilds) -> GET stats /internal/pbs per kind -> pipelined upserts -> SET lb:meta:built.
// If stats is unreachable we retry with exponential backoff (1 s ... 30 s); the boards keep serving
// whatever they already contain in the meantime.
// ---------------------------------------------------------------------------------------------

const CHECK_EVERY_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;
const LOCK_TTL_SEC = 120;
const PIPELINE_CHUNK = 1000;

export interface StatsPb {
  userId: string;
  username?: string;
  event: string;
  kind: string;
  valueMs: number | null;
  achievedAt?: string;
}

export interface RebuildStatus {
  state: 'starting' | 'built' | 'rebuilding' | 'waiting-for-lock' | 'retrying';
  builtAt: string | null;
  lastRebuild: { at: string; entries: number; skipped: number; flagged: number; ms: number } | null;
  lastError: string | null;
  nextRetryMs: number | null;
}

type Fetcher = (url: string, opts?: FetchOptions) => Promise<unknown>;

export interface RebuildDeps {
  redis: Redis;
  statsUrl: string;
  /** sent as X-Internal-Token to stats' /internal/pbs */
  internalToken: string;
  podName: string;
  floors: FloorSource;
  log: FastifyBaseLogger;
  fetcher?: Fetcher;
}

/** Validates one PB row from stats and returns the board write, or null to skip it. */
export function toBoardWrite(pb: StatsPb, kind: Kind): { board: string; valueMs: number; achievedAt: string } | null {
  if (!pb || typeof pb.userId !== 'string' || !pb.userId) return null;
  if (pb.kind !== kind || !hasBoards(pb.event)) return null;
  if (typeof pb.valueMs !== 'number' || !Number.isFinite(pb.valueMs) || pb.valueMs <= 0) return null;
  const t = typeof pb.achievedAt === 'string' ? Date.parse(pb.achievedAt) : NaN;
  return {
    board: allTimeKey(pb.event, kind),
    valueMs: Math.round(pb.valueMs),
    achievedAt: new Date(Number.isNaN(t) ? Date.now() : t).toISOString(),
  };
}

/** One full rebuild of the all-time boards. Throws if stats is unavailable. */
export async function rebuildOnce(deps: RebuildDeps): Promise<{ entries: number; skipped: number; flagged: number }> {
  const { redis, statsUrl, floors } = deps;
  const fetcher = deps.fetcher ?? fetchJson;
  // Snapshot time: pb.updated events that occurred after this still win over the snapshot
  // (see the occurredAt guard in scripts.ts), older ones are already reflected in it.
  const snapshotMs = Date.now();

  // Fetch everything first so a stats failure half-way doesn't leave a partial rebuild.
  const perKind: [Kind, StatsPb[]][] = [];
  for (const kind of KINDS) {
    const res = (await fetcher(`${statsUrl}/internal/pbs?kind=${kind}`, {
      timeoutMs: 15_000,
      retries: 1,
      headers: internalHeaders(deps.internalToken),
    })) as {
      pbs?: StatsPb[];
    } | null;
    if (!res || !Array.isArray(res.pbs)) throw new Error(`malformed /internal/pbs response for kind ${kind}`);
    perKind.push([kind, res.pbs]);
  }

  let entries = 0;
  let skipped = 0;
  let flagged = 0;
  let pipe = redis.pipeline();
  let queued = 0;
  const flush = async () => {
    if (queued === 0) return;
    const results = await pipe.exec();
    const failed = results?.find(([err]) => err);
    if (failed) throw failed[0];
    pipe = redis.pipeline();
    queued = 0;
  };

  for (const [kind, pbs] of perKind) {
    for (const pb of pbs) {
      const w = toBoardWrite(pb, kind);
      if (!w) {
        skipped++;
        continue;
      }
      if (isBelowFloor(w.valueMs, await floors.floor(pb.event, kind))) {
        flagged++; // not re-flagged on every rebuild; it was flagged when the event arrived
        continue;
      }
      pipe.lbSetPb(w.board, atKey(w.board), tsKey(w.board), pb.userId, w.valueMs, w.achievedAt, snapshotMs);
      queued++;
      if (typeof pb.username === 'string' && pb.username) {
        pipe.lbUser(USERS_KEY, pb.userId, pb.username, '0', '', '0', ''); // keeps known country/avatar
        queued++;
      }
      entries++;
      if (queued >= PIPELINE_CHUNK) await flush();
    }
  }
  await flush();
  return { entries, skipped, flagged };
}

// Only delete the lock if this pod still owns it.
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export function startRebuildLoop(deps: RebuildDeps) {
  const { redis, log, podName } = deps;
  const status: RebuildStatus = { state: 'starting', builtAt: null, lastRebuild: null, lastError: null, nextRetryMs: null };
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let backoff = 1000;

  const retryLater = (err: unknown): number => {
    const delay = backoff;
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    status.state = 'retrying';
    status.lastError = (err as Error).message;
    status.nextRetryMs = delay;
    log.warn({ err: status.lastError }, `leaderboard rebuild failed, retrying in ${delay}ms`);
    return delay;
  };

  /** One check; returns the delay until the next one. */
  async function tick(): Promise<number> {
    let builtAt: string | null;
    try {
      builtAt = await redis.get(META_BUILT_KEY);
    } catch (err) {
      return retryLater(err);
    }
    if (builtAt) {
      status.state = 'built';
      status.builtAt = builtAt;
      status.lastError = null;
      status.nextRetryMs = null;
      backoff = 1000;
      return CHECK_EVERY_MS;
    }

    let locked: string | null;
    try {
      locked = await redis.set(REBUILD_LOCK_KEY, podName, 'EX', LOCK_TTL_SEC, 'NX');
    } catch (err) {
      return retryLater(err);
    }
    if (locked !== 'OK') {
      status.state = 'waiting-for-lock'; // another replica is rebuilding
      return 5000;
    }

    status.state = 'rebuilding';
    const t0 = Date.now();
    log.info('lb:meta:built missing -> rebuilding all-time boards from stats');
    try {
      const r = await rebuildOnce(deps);
      const at = new Date().toISOString();
      await redis.set(META_BUILT_KEY, at);
      status.state = 'built';
      status.builtAt = at;
      status.lastError = null;
      status.nextRetryMs = null;
      status.lastRebuild = { at, ...r, ms: Date.now() - t0 };
      backoff = 1000;
      log.info(status.lastRebuild, 'leaderboard rebuild complete');
      return CHECK_EVERY_MS;
    } catch (err) {
      return retryLater(err);
    } finally {
      await redis.eval(RELEASE_LOCK, 1, REBUILD_LOCK_KEY, podName).catch(() => {});
    }
  }

  const loop = async () => {
    if (stopped) return;
    const delay = await tick().catch(retryLater);
    if (!stopped) timer = setTimeout(loop, delay);
  };
  void loop();

  return {
    status: () => ({ ...status }),
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
