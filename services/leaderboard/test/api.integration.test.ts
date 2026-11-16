// The leaderboard service against a real Redis (@cubr/testkit): the HTTP API (src/routes) over
// boards written the way production writes them, with domain events going through the ingest handler
// (src/ingest.ts) and its Lua scripts. Ordering, paging, ties, `me`, the period boards, the daily
// challenge, user ranks, private profiles, display info, anti-cheat flags and deleted accounts.
// Each test uses boards (event, kind, day) no other test writes to.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PRIVATE_USERS_KEY, type EventEnvelope } from '@cubr/common';
import { describeIntegration, startTestServer, type TestServer } from '@cubr/testkit';
import { floorFor } from '../src/floors.js';
import { makeHandler } from '../src/ingest.js';
import { DELETED_USERS_KEY, FLAGGED_KEY, USERS_KEY, allTimeKey, atKey, challengeKey, dailyKey, tsKey, weeklyKey } from '../src/keys.js';
import { registerRoutes } from '../src/routes/index.js';
import { defineScripts } from '../src/scripts.js';

/** World records the anti-cheat uses here (ms); other events fall back to the table in src/floors.ts. */
const RECORDS = { sq1: { single: 5_000, average: 6_000 } };

type User = { id: string; username: string };
let n = 0;
const newUser = (): User => ({ id: randomUUID(), username: `racer_${++n}` });

/** A stream entry as consumeEvents hands it to the handler. */
function evt(type: string, data: Record<string, unknown>): EventEnvelope {
  return { id: `1-${++n}`, type, data: { eventId: `test-${randomUUID()}`, occurredAt: new Date().toISOString(), ...data } } as EventEnvelope;
}
/** pb.updated as stats publishes it (valueMs null = the PB is gone). */
const pb = (u: User, event: string, kind: string, valueMs: number | null, occurredAt = new Date().toISOString()) =>
  evt('pb.updated', { userId: u.id, username: u.username, event, kind, valueMs, previousMs: null, achievedAt: valueMs === null ? null : occurredAt, occurredAt });
/** solve.created as solve-service publishes it (effectiveMs null = DNF). */
const solve = (u: User, event: string, effectiveMs: number | null, createdAt: string, extra: Record<string, unknown> = {}) =>
  evt('solve.created', {
    userId: u.id, username: u.username, event, sessionId: randomUUID(), solveId: randomUUID(), timeMs: effectiveMs ?? 10_000,
    penalty: effectiveMs === null ? 'DNF' : 'OK', effectiveMs, createdAt, tz: 'UTC', source: 'timer', rolling: { ao5: null, ao12: null }, practice: false, ...extra,
  });
/** daily.completed / daily.updated (ao5 -1 = DNF). */
const daily = (u: User, date: string, event: string, ao5: number, occurredAt: string, type = 'daily.completed') =>
  evt(type, { userId: u.id, username: u.username, date, event, ao5, times: [], tz: 'UTC', occurredAt });

/** Pins "now" (the current day / week, a solve's age) without faking the timers ioredis relies on. */
function pinNow(at: string): void {
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at));
}

describeIntegration('leaderboard API', () => {
  let s: TestServer;
  let handle: (evt: EventEnvelope) => Promise<void>;

  beforeAll(async () => {
    s = await startTestServer({
      service: 'leaderboard',
      infoPrefixes: ['/api/leaderboards'],
      routes: ({ app, redis, auth }) => {
        defineScripts(redis);
        return registerRoutes(app, { redis, auth });
      },
    });
    handle = makeHandler({ redis: s.redis, floors: { floor: async (event, kind) => floorFor(event, kind, RECORDS) }, log: s.app.log });
  });
  afterAll(async () => {
    await s?.close();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const feed = async (...evts: EventEnvelope[]) => {
    for (const e of evts) await handle(e);
  };
  const board = async (path: string, token?: string) => {
    const res = await s.request('GET', `/api/leaderboards/${path}`, { token });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  const ids = (b: { entries: { userId: string }[] }) => b.entries.map((e) => e.userId);

  describe('all-time boards', () => {
    it("rank fastest first, with each user's name, country, picture and when they set the time", async () => {
      const [a, b, c] = [newUser(), newUser(), newUser()];
      const avatar = `/api/users/${a.id}/avatar?v=0123456789ab`;
      await feed(
        evt('user.registered', { userId: a.id, username: a.username, country: 'AU', avatarUrl: avatar }),
        evt('user.registered', { userId: b.id, username: b.username, country: null, avatarUrl: null }),
        pb(a, '555', 'single', 50_000, '2026-10-01T10:00:00.000Z'),
        pb(b, '555', 'single', 40_000, '2026-10-02T10:00:00.000Z'),
        pb(c, '555', 'single', 45_000, '2026-10-03T10:00:00.000Z'),
      );
      expect(await board('555/single')).toEqual({
        event: '555', kind: 'single', period: 'all', periodKey: 'all', total: 3, page: 1, size: 50, me: null,
        entries: [
          { rank: 1, userId: b.id, username: b.username, country: null, avatarUrl: null, valueMs: 40_000, achievedAt: '2026-10-02T10:00:00.000Z' },
          { rank: 2, userId: c.id, username: c.username, country: null, avatarUrl: null, valueMs: 45_000, achievedAt: '2026-10-03T10:00:00.000Z' },
          { rank: 3, userId: a.id, username: a.username, country: 'AU', avatarUrl: avatar, valueMs: 50_000, achievedAt: '2026-10-01T10:00:00.000Z' },
        ],
      });
    });

    it('page through with absolute ranks', async () => {
      const users = Array.from({ length: 7 }, newUser);
      await feed(...users.map((u, i) => pb(u, '666', 'single', 100_000 + i * 1_000)));
      const second = await board('666/single?page=2&size=3');
      expect(second).toMatchObject({ total: 7, page: 2, size: 3 });
      expect(second.entries.map((e: { rank: number; userId: string }) => [e.rank, e.userId])).toEqual([[4, users[3].id], [5, users[4].id], [6, users[5].id]]);
      expect((await board('666/single?page=3&size=3')).entries.map((e: { rank: number }) => e.rank)).toEqual([7]);
      expect(await board('666/single?page=4&size=3')).toMatchObject({ total: 7, entries: [] });
    });

    it('order equal times by user id without sharing ranks', async () => {
      const tied = ['f0000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000000'];
      await feed(...tied.map((id, i) => pb({ id, username: `tied_${i}` }, '777', 'single', 300_000)));
      expect((await board('777/single')).entries.map((e: { rank: number; userId: string }) => [e.rank, e.userId])).toEqual([[1, tied[1]], [2, tied[2]], [3, tied[0]]]);
    });

    it("add the signed-in user's own rank and time as `me`, wherever they are on the board", async () => {
      const users = Array.from({ length: 4 }, newUser);
      await feed(...users.map((u, i) => pb(u, '444', 'single', 30_000 + i * 1_000)));
      const third = await board('444/single?size=2', await s.token(users[2]));
      expect(third.me).toEqual({ rank: 3, valueMs: 32_000 });
      expect(ids(third)).not.toContain(users[2].id);
      expect((await board('444/single', await s.token(newUser()))).me).toBeNull(); // not on the board
      expect((await board('444/single')).me).toBeNull();
      expect((await board('444/single', 'not-a-token')).me).toBeNull();
    });

    it('follow the exact PB from stats, a worse one after a delete included, and drop it when the PB is gone', async () => {
      const u = newUser();
      await feed(
        pb(u, '333oh', 'single', 30_000, '2026-10-01T10:00:00.000Z'),
        pb(u, '333oh', 'single', 25_000, '2026-10-02T10:00:00.000Z'),
        pb(u, '333oh', 'single', 28_000, '2026-10-03T10:00:00.000Z'), // the 25 s solve was deleted
      );
      expect((await board('333oh/single')).entries).toEqual([expect.objectContaining({ userId: u.id, valueMs: 28_000, achievedAt: '2026-10-03T10:00:00.000Z' })]);
      await feed(pb(u, '333oh', 'single', null, '2026-10-04T10:00:00.000Z'));
      expect((await board('333oh/single')).total).toBe(0);
      expect(await s.redis.hget(atKey(allTimeKey('333oh', 'single')), u.id)).toBeNull();
      await feed(pb(u, '333oh', 'single', 27_000, '2026-10-05T10:00:00.000Z'), pb(u, '333oh', 'single', -1, '2026-10-06T10:00:00.000Z'));
      expect((await board('333oh/single')).total).toBe(0);
    });

    it('ignore a pb.updated older than the last one applied for the user', async () => {
      const u = newUser();
      await feed(
        pb(u, '333bf', 'single', 60_000, '2026-10-02T10:00:00.000Z'),
        pb(u, '333bf', 'single', 50_000, '2026-10-01T10:00:00.000Z'), // delivered late
        pb(u, '333bf', 'single', null, '2026-10-01T12:00:00.000Z'), // a late removal
      );
      expect((await board('333bf/single')).entries.map((e: { valueMs: number }) => e.valueMs)).toEqual([60_000]);
    });

    it('do not exist for the kinds and events leaderboard does not rank', async () => {
      const u = newUser();
      await feed(pb(u, '333', 'mo3', 9_000), pb(u, '333', 'ao100', 9_500), pb(u, '333fm', 'single', 25));
      expect(await s.redis.exists('lb:333:mo3:all', 'lb:333:ao100:all', allTimeKey('333fm', 'single'))).toBe(0);
      expect(await board('333fm/single')).toMatchObject({ total: 0, entries: [] }); // FMC results are move counts
    });
  });

  describe('daily and weekly boards', () => {
    it("keep each user's best single and rolling ao5 of the solve's UTC day and ISO week", async () => {
      pinNow('2026-10-14T12:00:00Z');
      const u = newUser();
      await feed(
        solve(u, 'pyram', 6_000, '2026-10-14T10:00:00.000Z'),
        solve(u, 'pyram', 5_000, '2026-10-14T10:01:00.000Z', { rolling: { ao5: 6_500, ao12: null } }),
        solve(u, 'pyram', 5_500, '2026-10-14T10:02:00.000Z', { rolling: { ao5: 6_200, ao12: null } }),
        solve(u, 'pyram', 5_000, '2026-10-14T10:03:00.000Z', { rolling: { ao5: 6_300, ao12: null } }), // ties the best: the first keeps it
      );
      for (const [period, periodKey] of [['daily', '2026-10-14'], ['weekly', '2026-W42']]) {
        const single = await board(`pyram/single?period=${period}`);
        expect(single.periodKey).toBe(periodKey);
        expect(single.entries).toEqual([expect.objectContaining({ userId: u.id, valueMs: 5_000, achievedAt: '2026-10-14T10:01:00.000Z' })]);
        expect((await board(`pyram/ao5?period=${period}`)).entries).toEqual([expect.objectContaining({ valueMs: 6_200, achievedAt: '2026-10-14T10:02:00.000Z' })]);
      }
      // daily boards live 3 days, weekly ones 15 days
      for (const [key, ttl] of [[dailyKey('pyram', 'single', '2026-10-14'), 3 * 86_400], [weeklyKey('pyram', 'ao5', '2026-W42'), 15 * 86_400]] as const) {
        expect(await s.redis.ttl(key)).toBeGreaterThan(ttl - 60);
        expect(await s.redis.ttl(atKey(key))).toBeGreaterThan(ttl - 60);
      }
    });

    it("never rank a practice session's solve, a DNF or a solve older than the board", async () => {
      pinNow('2026-10-14T12:00:00Z');
      const u = newUser();
      await feed(
        solve(u, 'skewb', 3_000, '2026-10-14T10:00:00.000Z', { practice: true, rolling: { ao5: 3_500, ao12: null } }),
        solve(u, 'skewb', null, '2026-10-14T10:01:00.000Z', { rolling: { ao5: -1, ao12: null } }),
        solve(u, 'skewb', 4_000, '2026-09-20T10:00:00.000Z'), // 24 days ago: both its boards have expired
      );
      expect(await s.redis.keys('lb:skewb:*')).toEqual([]);
      expect((await board('skewb/single?period=daily')).total).toBe(0);
    });

    it('show the current UTC day and week unless ?key= asks for an earlier one', async () => {
      pinNow('2026-10-14T00:30:00Z');
      const u = newUser();
      await feed(
        solve(u, 'clock', 7_000, '2026-10-13T23:50:00.000Z'), // 40 minutes earlier: yesterday in UTC
        solve(u, 'clock', 8_000, '2026-10-14T00:10:00.000Z'),
      );
      expect(await board('clock/single?period=daily')).toMatchObject({ periodKey: '2026-10-14', total: 1, entries: [expect.objectContaining({ valueMs: 8_000 })] });
      expect(await board('clock/single?period=daily&key=2026-10-13')).toMatchObject({ periodKey: '2026-10-13', entries: [expect.objectContaining({ valueMs: 7_000 })] });
      // both days are in ISO week 42 (Monday 12 to Sunday 18 October)
      expect(await board('clock/single?period=weekly')).toMatchObject({ periodKey: '2026-W42', entries: [expect.objectContaining({ valueMs: 7_000 })] });
      expect(await board('clock/single?key=2026-10-13')).toMatchObject({ period: 'all', periodKey: 'all', total: 0 }); // no key on all-time boards
    });
  });

  describe('daily challenge', () => {
    it('ranks the day by ao5: the latest result wins, even a worse one, and a DNF leaves the board', async () => {
      const [a, b, c] = [newUser(), newUser(), newUser()];
      await feed(
        daily(a, '2026-10-14', '222', 4_000, '2026-10-14T08:00:00.000Z'),
        daily(b, '2026-10-14', '222', 3_500, '2026-10-14T09:00:00.000Z'),
        daily(c, '2026-10-14', '222', 5_000, '2026-10-14T09:30:00.000Z'),
        daily(a, '2026-10-14', '222', 4_500, '2026-10-14T10:00:00.000Z', 'daily.updated'), // a +2 marked afterwards
        daily(b, '2026-10-14', '222', -1, '2026-10-14T11:00:00.000Z', 'daily.updated'), // ... or a DNF
        daily(c, '2026-10-14', '222', 3_000, '2026-10-14T09:15:00.000Z', 'daily.updated'), // older than c's result: ignored
      );
      expect(await board('daily-challenge?date=2026-10-14&event=222')).toEqual({
        event: '222', kind: 'ao5', period: 'challenge', periodKey: '2026-10-14', total: 2, page: 1, size: 50, me: null,
        entries: [
          { rank: 1, userId: a.id, username: a.username, country: null, avatarUrl: null, valueMs: 4_500, achievedAt: '2026-10-14T10:00:00.000Z' },
          { rank: 2, userId: c.id, username: c.username, country: null, avatarUrl: null, valueMs: 5_000, achievedAt: '2026-10-14T09:30:00.000Z' },
        ],
      });
      expect((await board('daily-challenge?date=2026-10-13&event=222')).total).toBe(0);
      expect(await s.redis.ttl(challengeKey('2026-10-14', '222'))).toBe(-1); // kept as history
    });

    it("shows today's 3x3 challenge (UTC) by default, with the caller's own place", async () => {
      pinNow('2026-10-20T23:30:00Z');
      const [u, v] = [newUser(), newUser()];
      await feed(daily(u, '2026-10-20', '333', 9_000, '2026-10-20T23:00:00.000Z'), daily(v, '2026-10-20', '333', 8_000, '2026-10-20T23:10:00.000Z'));
      expect(await board('daily-challenge', await s.token(u))).toMatchObject({ event: '333', periodKey: '2026-10-20', total: 2, me: { rank: 2, valueMs: 9_000 } });
    });
  });

  describe('user ranks', () => {
    it("list the user's place on every all-time board they are on", async () => {
      const [u, faster, slower] = [newUser(), newUser(), newUser()];
      await feed(
        pb(faster, 'minx', 'single', 30_000), pb(u, 'minx', 'single', 35_000), pb(slower, 'minx', 'single', 40_000),
        pb(u, 'minx', 'ao5', 38_000),
        pb(slower, 'minx', 'ao12', 41_000), pb(u, 'minx', 'ao12', 42_000),
      );
      expect((await s.request('GET', `/api/leaderboards/users/${u.id}/ranks`)).json()).toEqual({
        ranks: [
          { event: 'minx', kind: 'single', period: 'all', rank: 2, total: 3, valueMs: 35_000 },
          { event: 'minx', kind: 'ao5', period: 'all', rank: 1, total: 1, valueMs: 38_000 },
          { event: 'minx', kind: 'ao12', period: 'all', rank: 2, total: 2, valueMs: 42_000 },
        ],
      });
      expect((await s.request('GET', `/api/leaderboards/users/${randomUUID()}/ranks`)).json()).toEqual({ ranks: [] });
    });

    it("answer 403 for a private profile unless its owner asks, while the boards still list them", async () => {
      const u = newUser();
      await feed(pb(u, '444bf', 'single', 120_000));
      await s.redis.sadd(PRIVATE_USERS_KEY, u.id);
      const url = `/api/leaderboards/users/${u.id}/ranks`;
      const anonymous = await s.request('GET', url);
      expect(anonymous.statusCode).toBe(403);
      expect(anonymous.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'This profile is private' } });
      expect((await s.request('GET', url.replace(u.id, u.id.toUpperCase()))).statusCode).toBe(403);
      expect((await s.request('GET', url, { token: await s.token(newUser()) })).statusCode).toBe(403);
      for (const own of [url, url.replace(u.id, u.id.toUpperCase())]) {
        const res = await s.request('GET', own, { token: await s.token(u) });
        expect(res.statusCode).toBe(200);
        expect(res.json().ranks).toEqual([{ event: '444bf', kind: 'single', period: 'all', rank: 1, total: 1, valueMs: 120_000 }]);
      }
      expect(ids(await board('444bf/single'))).toEqual([u.id]);
    });
  });

  describe('bad requests', () => {
    it.each([
      ['an unknown event', 'nope/single'],
      ['a kind without boards', '333/mo3'],
      ['ao12 on a weekly board', '333/ao12?period=weekly'],
      ['an unknown period', '333/single?period=monthly'],
      ['a day that does not exist', '333/single?period=daily&key=2026-02-30'],
      ['week 53 of a 52-week year', '333/single?period=weekly&key=2025-W53'],
      ['a week key on a daily board', '333/single?period=daily&key=2026-W42'],
      ['page 0', '333/single?page=0'],
      ['more than 100 per page', '333/single?size=101'],
      ['an event without a daily challenge', 'daily-challenge?event=333oh'],
      ['a challenge date in another format', 'daily-challenge?date=14/10/2026'],
      ['ranks for an id that is not a UUID', 'users/not-a-uuid/ranks'],
    ])('answer 400 to %s', async (_what, path) => {
      const res = await s.request('GET', `/api/leaderboards/${path}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
    });
  });

  describe('display info', () => {
    it('keeps the country and picture from user events when solve and PB events carry only the name', async () => {
      const u = newUser();
      const avatar = `/api/users/${u.id}/avatar?v=abcdef123456`;
      await feed(
        evt('user.registered', { userId: u.id, username: u.username, country: 'NZ', avatarUrl: avatar }),
        pb({ id: u.id, username: 'new_name' }, '333oh', 'ao5', 40_000),
      );
      expect(JSON.parse((await s.redis.hget(USERS_KEY, u.id))!)).toEqual({ username: 'new_name', country: 'NZ', avatarUrl: avatar });
      await feed(evt('user.updated', { userId: u.id, username: 'new_name', country: null, avatarUrl: 'https://evil.example/x.png' }));
      expect((await board('333oh/ao5')).entries).toEqual([expect.objectContaining({ userId: u.id, username: 'new_name', country: null, avatarUrl: null })]);
    });

    it('shows a user it has no display info for as "unknown"', async () => {
      const id = randomUUID();
      await s.redis.zadd(allTimeKey('333bf', 'ao5'), 70_000, id);
      expect((await board('333bf/ao5')).entries).toEqual([{ rank: 1, userId: id, username: 'unknown', country: null, avatarUrl: null, valueMs: 70_000, achievedAt: null }]);
    });
  });

  describe('anti-cheat', () => {
    it('keeps a time below the world record off the boards and flags it once per value and event', async () => {
      pinNow('2026-10-14T12:00:00Z');
      const u = newUser();
      const fast = solve(u, 'sq1', 4_000, '2026-10-14T10:00:00.000Z', { rolling: { ao5: 5_500, ao12: null } });
      await feed(fast, pb(u, 'sq1', 'single', 4_000));
      const boards = [dailyKey('sq1', 'single', '2026-10-14'), weeklyKey('sq1', 'single', '2026-W42'), dailyKey('sq1', 'ao5', '2026-10-14'), weeklyKey('sq1', 'ao5', '2026-W42'), allTimeKey('sq1', 'single')];
      expect(await s.redis.exists(...boards)).toBe(0);
      const flagged = (await s.redis.lrange(FLAGGED_KEY, 0, -1)).map((x) => JSON.parse(x)).filter((f) => f.userId === u.id);
      // newest first; the solve fed a daily and a weekly board, but each value is flagged once
      expect(flagged).toEqual([
        expect.objectContaining({ source: 'pb.updated', event: 'sq1', kind: 'single', valueMs: 4_000, floorMs: 5_000, board: allTimeKey('sq1', 'single') }),
        expect.objectContaining({ source: 'solve.created', event: 'sq1', kind: 'ao5', valueMs: 5_500, floorMs: 6_000, eventId: fast.data.eventId }),
        expect.objectContaining({ source: 'solve.created', event: 'sq1', kind: 'single', valueMs: 4_000, floorMs: 5_000, eventId: fast.data.eventId }),
      ]);
      await feed(pb(u, 'sq1', 'single', 5_000)); // the world record itself is fine
      expect((await board('sq1/single')).entries).toEqual([expect.objectContaining({ userId: u.id, valueMs: 5_000 })]);
    });
  });

  describe('deleted accounts', () => {
    it('leave every board, the display info and the anti-cheat list, and their later events are ignored', async () => {
      pinNow('2026-10-14T12:00:00Z');
      const [gone, stays] = [newUser(), newUser()];
      await feed(
        evt('user.registered', { userId: gone.id, username: gone.username, country: 'AU' }),
        pb(gone, '555bf', 'single', 300_000, '2026-10-14T09:00:00.000Z'),
        pb(stays, '555bf', 'single', 310_000, '2026-10-14T09:00:00.000Z'),
        solve(gone, '555bf', 300_000, '2026-10-14T10:00:00.000Z', { rolling: { ao5: 320_000, ao12: null } }),
        daily(gone, '2026-10-14', '333', 9_500, '2026-10-14T10:30:00.000Z'),
        solve(gone, 'sq1', 1_000, '2026-10-14T10:40:00.000Z'), // flagged
      );
      const boards = [
        allTimeKey('555bf', 'single'), dailyKey('555bf', 'single', '2026-10-14'), weeklyKey('555bf', 'single', '2026-W42'),
        dailyKey('555bf', 'ao5', '2026-10-14'), weeklyKey('555bf', 'ao5', '2026-W42'), challengeKey('2026-10-14', '333'),
      ];
      for (const key of boards) expect(await s.redis.zscore(key, gone.id), `${key} before`).not.toBeNull();

      await feed(evt('user.deleted', { userId: gone.id, username: gone.username }));
      for (const key of boards) {
        expect(await s.redis.zscore(key, gone.id), key).toBeNull();
        expect(await s.redis.hget(atKey(key), gone.id), key).toBeNull();
      }
      expect(await s.redis.hget(tsKey(allTimeKey('555bf', 'single')), gone.id)).toBeNull();
      expect(await s.redis.hget(tsKey(challengeKey('2026-10-14', '333')), gone.id)).toBeNull();
      expect(await s.redis.hget(USERS_KEY, gone.id)).toBeNull();
      expect((await s.redis.lrange(FLAGGED_KEY, 0, -1)).some((x) => x.includes(gone.id))).toBe(false);
      expect(await s.redis.sismember(DELETED_USERS_KEY, gone.id)).toBe(1);

      // events still on their way for the account bring nothing back
      await feed(
        pb(gone, '555bf', 'single', 290_000, '2026-10-14T13:00:00.000Z'),
        solve(gone, '555bf', 280_000, '2026-10-14T11:00:00.000Z'),
        daily(gone, '2026-10-14', '333', 9_000, '2026-10-14T11:30:00.000Z', 'daily.updated'),
        evt('user.updated', { userId: gone.id, username: gone.username, country: 'AU' }),
      );
      for (const key of boards) expect(await s.redis.zscore(key, gone.id), `${key} after`).toBeNull();
      expect(await s.redis.hget(USERS_KEY, gone.id)).toBeNull();
      expect(ids(await board('555bf/single'))).toEqual([stays.id]);
    });
  });
});
