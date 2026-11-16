// leaderboard's Lua scripts (src/scripts.ts) and the rebuild after Redis lost its data
// (src/rebuild.ts), run against a real Redis: keep-best and exact writes with their achievedAt and
// stale-event guards, the display-info merge, and refilling the all-time boards from stats' PBs.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchOptions, Redis } from '@cubr/common';
import { createTestRedis, describeIntegration } from '@cubr/testkit';
import { floorFor, type FloorSource } from '../src/floors.js';
import { DELETED_USERS_KEY, FLAGGED_KEY, META_BUILT_KEY, REBUILD_LOCK_KEY, USERS_KEY, allTimeKey, atKey, tsKey, type Kind } from '../src/keys.js';
import { rebuildOnce, startRebuildLoop, type StatsPb } from '../src/rebuild.js';
import { defineScripts } from '../src/scripts.js';

const log = { info() {}, warn() {}, error() {}, debug() {} } as never;
/** No WCA records loaded: the fallback floors of src/floors.ts apply. */
const floors: FloorSource = { floor: async (event, kind) => floorFor(event, kind, null) };

describeIntegration('leaderboard Redis scripts and rebuild', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = await createTestRedis();
    defineScripts(redis);
  });
  afterAll(() => {
    redis?.disconnect();
  });

  /** A board key of its own for each test. */
  const freshBoard = () => `lb:test:${randomUUID()}`;

  describe('lbBest (daily, weekly and challenge boards)', () => {
    it('adds an entry, lowers it only for a better value, and moves achievedAt only with the value', async () => {
      const board = freshBoard();
      const u = randomUUID();
      expect(await redis.lbBest(board, atKey(board), 10_000, u, 'first', 0)).toBe(1);
      expect(await redis.lbBest(board, atKey(board), 11_000, u, 'worse', 0)).toBe(0);
      expect(await redis.lbBest(board, atKey(board), 10_000, u, 'equal', 0)).toBe(0); // whoever got there first keeps it
      expect([await redis.zscore(board, u), await redis.hget(atKey(board), u)]).toEqual(['10000', 'first']);
      expect(await redis.lbBest(board, atKey(board), 9_000, u, 'better', 0)).toBe(1);
      expect([await redis.zscore(board, u), await redis.hget(atKey(board), u)]).toEqual(['9000', 'better']);
      expect(await redis.ttl(board)).toBe(-1); // 0 = no expiry
    });

    it('refreshes the expiry of the board and its achievedAt hash on every write, even one that changes nothing', async () => {
      const board = freshBoard();
      const u = randomUUID();
      await redis.lbBest(board, atKey(board), 10_000, u, 'first', 1_000);
      await redis.expire(board, 5);
      await redis.expire(atKey(board), 5);
      expect(await redis.lbBest(board, atKey(board), 12_000, u, 'worse', 1_000)).toBe(0);
      expect(await redis.ttl(board)).toBeGreaterThan(990);
      expect(await redis.ttl(atKey(board))).toBeGreaterThan(990);
    });
  });

  describe('lbSetPb (all-time and challenge boards)', () => {
    it('sets the exact value, worse ones included, and records when and from which event time', async () => {
      const board = freshBoard();
      const u = randomUUID();
      expect(await redis.lbSetPb(board, atKey(board), tsKey(board), u, 10_000, 'A', 1_000)).toBe(1);
      expect(await redis.lbSetPb(board, atKey(board), tsKey(board), u, 12_000, 'B', 2_000)).toBe(1);
      expect([await redis.zscore(board, u), await redis.hget(atKey(board), u), await redis.hget(tsKey(board), u)]).toEqual(['12000', 'B', '2000']);
    });

    it('drops a write older than the last one applied, but applies one from the same moment', async () => {
      const board = freshBoard();
      const u = randomUUID();
      await redis.lbSetPb(board, atKey(board), tsKey(board), u, 12_000, 'B', 2_000);
      expect(await redis.lbSetPb(board, atKey(board), tsKey(board), u, 9_000, 'stale', 1_999)).toBe(-1);
      expect([await redis.zscore(board, u), await redis.hget(atKey(board), u)]).toEqual(['12000', 'B']);
      expect(await redis.lbSetPb(board, atKey(board), tsKey(board), u, 11_000, 'same time', 2_000)).toBe(1);
      expect(await redis.zscore(board, u)).toBe('11000');
    });

    it('removes the entry for an empty score, and an older write cannot bring it back', async () => {
      const board = freshBoard();
      const [u, other] = [randomUUID(), randomUUID()];
      await redis.lbSetPb(board, atKey(board), tsKey(board), u, 10_000, 'A', 1_000);
      await redis.lbSetPb(board, atKey(board), tsKey(board), other, 11_000, 'O', 1_000);
      expect(await redis.lbSetPb(board, atKey(board), tsKey(board), u, '', '', 2_000)).toBe(0);
      expect([await redis.zscore(board, u), await redis.hget(atKey(board), u), await redis.hget(tsKey(board), u)]).toEqual([null, null, '2000']);
      expect(await redis.lbSetPb(board, atKey(board), tsKey(board), u, 9_000, 'replayed', 1_500)).toBe(-1);
      expect(await redis.zrange(board, 0, -1)).toEqual([other]);
    });
  });

  describe('lbUser (display info)', () => {
    const info = async (u: string) => JSON.parse((await redis.hget(USERS_KEY, u))!);
    const avatar = '/api/users/00000000-0000-4000-8000-000000000001/avatar?v=abc123';

    it('creates the entry and says whether anything changed', async () => {
      const u = randomUUID();
      expect(await redis.lbUser(USERS_KEY, u, 'ann', '1', 'AU', '1', avatar)).toBe(1);
      expect(await info(u)).toEqual({ username: 'ann', country: 'AU', avatarUrl: avatar });
      expect(await redis.lbUser(USERS_KEY, u, 'ann', '1', 'AU', '1', avatar)).toBe(0);
      expect(await redis.lbUser(USERS_KEY, u, 'ann', '0', '', '0', '')).toBe(0);
    });

    it('touches the country and picture only when the event carried them, and stores an empty one as null', async () => {
      const u = randomUUID();
      await redis.lbUser(USERS_KEY, u, 'ann', '1', 'AU', '1', avatar);
      expect(await redis.lbUser(USERS_KEY, u, 'ann_renamed', '0', '', '0', '')).toBe(1);
      expect(await info(u)).toEqual({ username: 'ann_renamed', country: 'AU', avatarUrl: avatar });
      expect(await redis.lbUser(USERS_KEY, u, 'ann_renamed', '1', '', '1', '')).toBe(1);
      expect(await info(u)).toEqual({ username: 'ann_renamed', country: null, avatarUrl: null });
    });

    it('replaces an entry that is not valid JSON', async () => {
      const u = randomUUID();
      await redis.hset(USERS_KEY, u, '{not json');
      expect(await redis.lbUser(USERS_KEY, u, 'ann', '0', '', '0', '')).toBe(1);
      expect(await info(u)).toEqual({ username: 'ann' });
    });
  });

  describe('rebuild from stats', () => {
    beforeEach(async () => {
      await redis.flushdb();
    });

    /** stats' GET /internal/pbs?kind=, answering from these rows. */
    const statsPbs = (byKind: Partial<Record<Kind, unknown[]>>) =>
      vi.fn(async (url: string, _opts?: FetchOptions) => ({ pbs: byKind[new URL(url).searchParams.get('kind') as Kind] ?? [] }));
    const deps = (fetcher: (url: string, opts?: FetchOptions) => Promise<unknown>) => ({ redis, statsUrl: 'http://stats', internalToken: 'internal-secret', podName: 'pod-a', floors, log, fetcher });
    const row = (userId: string, username: string, event: string, kind: string, valueMs: number | null, achievedAt = '2026-10-01T00:00:00.000Z'): StatsPb =>
      ({ userId, username, event, kind, valueMs, achievedAt });

    it('fills the all-time boards and names from stats, skipping rows no board takes and times below the floor', async () => {
      const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
      await redis.lbUser(USERS_KEY, a, 'ann', '1', 'AU', '0', ''); // known before Redis lost the boards
      const fetcher = statsPbs({
        single: [
          row(a, 'ann_new', '444', 'single', 30_000, '2026-10-01T00:00:00.000Z'),
          row(b, 'bob', '444', 'single', 31_000, '2026-10-02T00:00:00.000Z'),
          row(c, 'cy', '444', 'single', 1_000), // below the 4x4 floor
          row(a, 'ann_new', '333fm', 'single', 25), // FMC has no boards
          row(b, 'bob', '444', 'mo3', 33_000), // not the kind asked for
        ],
        ao5: [row(a, 'ann_new', '444', 'ao5', -1)],
      });
      expect(await rebuildOnce(deps(fetcher))).toEqual({ entries: 2, skipped: 3, flagged: 1 });
      expect(await redis.zrange(allTimeKey('444', 'single'), 0, -1, 'WITHSCORES')).toEqual([a, '30000', b, '31000']);
      expect(await redis.hget(atKey(allTimeKey('444', 'single')), b)).toBe('2026-10-02T00:00:00.000Z');
      expect(await redis.exists(allTimeKey('444', 'ao5'), allTimeKey('333fm', 'single'))).toBe(0);
      expect(JSON.parse((await redis.hget(USERS_KEY, a))!)).toEqual({ username: 'ann_new', country: 'AU' }); // the country stays
      expect(await redis.llen(FLAGGED_KEY)).toBe(0); // flagged when its event arrived, not again on every rebuild
      expect(fetcher.mock.calls.map(([url, opts]) => [url, opts?.headers])).toEqual(
        ['single', 'ao5', 'ao12'].map((kind) => [`http://stats/internal/pbs?kind=${kind}`, { 'x-internal-token': 'internal-secret' }]),
      );
    });

    it('lets a pb.updated that happened after the snapshot win, and overwrites older entries', async () => {
      const board = allTimeKey('555', 'ao5');
      const [newer, older] = [randomUUID(), randomUUID()];
      await redis.lbSetPb(board, atKey(board), tsKey(board), newer, 50_000, 'live', Date.now() + 60_000); // occurred after the snapshot
      await redis.lbSetPb(board, atKey(board), tsKey(board), older, 70_000, 'old', Date.now() - 60_000);
      await rebuildOnce(deps(statsPbs({ ao5: [row(newer, 'new', '555', 'ao5', 55_000), row(older, 'old', '555', 'ao5', 60_000)] })));
      expect(await redis.zscore(board, newer)).toBe('50000');
      expect(await redis.zscore(board, older)).toBe('60000');
    });

    // stats can still list a deleted account when the rebuild reads its PBs
    it('does not bring a deleted account back onto the boards', async () => {
      const [gone, stays] = [randomUUID(), randomUUID()];
      await redis.sadd(DELETED_USERS_KEY, gone);
      // stats has not handled the user.deleted yet when the rebuild reads its PBs
      await rebuildOnce(deps(statsPbs({ single: [row(gone, 'gone_user', '444', 'single', 30_000), row(stays, 'stays', '444', 'single', 31_000)] })));
      expect(await redis.zrange(allTimeKey('444', 'single'), 0, -1)).toEqual([stays]);
      expect(await redis.hget(USERS_KEY, gone)).toBeNull();
    });

    it('writes nothing when stats fails part-way, or answers something malformed', async () => {
      const u = randomUUID();
      const failing = vi.fn(async (url: string) => {
        if (url.endsWith('kind=ao12')) throw new Error('stats unavailable');
        return { pbs: [row(u, 'x', '666', new URL(url).searchParams.get('kind')!, 100_000)] };
      });
      await expect(rebuildOnce(deps(failing))).rejects.toThrow('stats unavailable');
      expect(await redis.exists(allTimeKey('666', 'single'), allTimeKey('666', 'ao5'))).toBe(0);
      await expect(rebuildOnce(deps(async () => ({ nope: true })))).rejects.toThrow(/malformed/);
    });

    it('rebuilds once lb:meta:built is missing, marks the boards built and releases its lock', async () => {
      const u = randomUUID();
      const loop = startRebuildLoop(deps(statsPbs({ single: [row(u, 'ann', '777', 'single', 300_000)] })));
      try {
        await vi.waitFor(() => expect(loop.status().state).toBe('built'));
        expect(loop.status().lastRebuild).toMatchObject({ entries: 1, skipped: 0, flagged: 0 });
        expect(await redis.get(META_BUILT_KEY)).toBe(loop.status().builtAt);
        expect(await redis.get(REBUILD_LOCK_KEY)).toBeNull();
        expect(await redis.zscore(allTimeKey('777', 'single'), u)).toBe('300000');
      } finally {
        loop.stop();
      }
    });

    it('leaves the rebuild to the replica holding the lock', async () => {
      await redis.set(REBUILD_LOCK_KEY, 'pod-b', 'EX', 120);
      const fetcher = statsPbs({});
      const loop = startRebuildLoop(deps(fetcher));
      try {
        await vi.waitFor(() => expect(loop.status().state).toBe('waiting-for-lock'));
        expect(fetcher).not.toHaveBeenCalled();
        expect(await redis.get(REBUILD_LOCK_KEY)).toBe('pod-b');
      } finally {
        loop.stop();
      }
    });

    it('keeps its hands off boards already marked built', async () => {
      await redis.set(META_BUILT_KEY, '2026-10-01T00:00:00.000Z');
      const fetcher = statsPbs({});
      const loop = startRebuildLoop(deps(fetcher));
      try {
        await vi.waitFor(() => expect(loop.status()).toMatchObject({ state: 'built', builtAt: '2026-10-01T00:00:00.000Z' }));
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        loop.stop();
      }
    });
  });
});
