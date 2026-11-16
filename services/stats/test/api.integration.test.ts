// The stats service's HTTP API against a real Postgres and Redis (@cubr/testkit), with the read
// model built the way production builds it: domain events through the projector, recomputes reading
// a stand-in solve-service (./harness.ts). The five per-user routes and private profiles, the cached
// global counters, and the internal PB listing leaderboard rebuilds from.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';
import { createServer, makeAuth, PRIVATE_USERS_KEY, revokedKey, signToken } from '@cubr/common';
import { describeIntegration } from '@cubr/testkit';
import { CACHE_KEY } from '../src/routes/global.js';
import { registerRoutes } from '../src/routes/index.js';
import { envelope, newCuber, startStats, type Cuber, type StatsTestServer } from './harness.js';

const PROFILE_ROUTES = ['summary', 'activity', 'pb-history', 'hourly', 'solves'];

/** Pins "now" (today, streaks) without faking the timers pg and ioredis rely on. */
function pinNow(at: string): void {
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at));
}

describeIntegration('stats API', () => {
  let s: StatsTestServer;

  beforeAll(async () => {
    s = await startStats();
  });
  afterAll(async () => {
    await s?.close();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const get = async (url: string, token?: string) => {
    const res = await s.request('GET', url, { token });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };

  /** The stats routes on a Redis that refuses every command (an outage). */
  async function appWithDeadRedis() {
    const dead = new Redis({ host: '127.0.0.1', port: 1, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
    dead.on('error', () => {});
    const { app } = createServer(s.config, { infoPrefixes: [] });
    await registerRoutes(app, { pool: s.pool, redis: dead, internalToken: s.config.internalToken, auth: makeAuth(s.config.jwtSecret, dead) });
    return {
      inject: (url: string, token?: string) => app.inject({ url, headers: token ? { authorization: `Bearer ${token}` } : {} }),
      async close() {
        await app.close();
        dead.disconnect();
      },
    };
  }

  describe('summary', () => {
    it('answers zeros for a user it has never heard of, not a 404', async () => {
      const id = randomUUID();
      expect(await get(`/api/stats/users/${id}/summary`)).toEqual({
        userId: id,
        username: null,
        totals: { solves: 0, totalMs: 0, firstSolveAt: null, lastSolveAt: null, activeDays: 0, currentStreak: 0, longestStreak: 0, activeYears: [] },
        events: [],
      });
    });

    it('totals every solve and gives each event its count, time spent, mean of the non-DNF solves and six PB kinds', async () => {
      pinNow('2026-10-14T12:00:00Z');
      const u = newCuber();
      const cube = s.solve.session(u, '333');
      const two = s.solve.session(u, '222');
      const at = (hour: number) => `2026-10-14T0${hour}:00:00.000Z`;
      const made = [
        s.solve.solve(u, cube, 9_000, at(1), 'DNF'),
        s.solve.solve(u, cube, 10_000, at(2)),
        s.solve.solve(u, cube, 12_000, at(3), '+2'),
        s.solve.solve(u, cube, 11_000, at(4)),
        s.solve.solve(u, cube, 13_000, at(5)),
        s.solve.solve(u, two, 3_000, at(6)),
        s.solve.solve(u, two, 4_000, at(7)),
      ];
      await s.feed(...made.map((m) => m.event));
      const pb = (i: number, valueMs: number) => ({ valueMs, solveId: made[i].solve.id, achievedAt: made[i].solve.createdAt });
      expect(await get(`/api/stats/users/${u.id}/summary`)).toEqual({
        userId: u.id,
        username: u.username,
        totals: { solves: 7, totalMs: 62_000, firstSolveAt: at(1), lastSolveAt: at(7), activeDays: 1, currentStreak: 1, longestStreak: 1, activeYears: [2026] },
        // most solves first; time spent counts the raw times (the DNF too), the mean the +2 but not the DNF
        events: [
          {
            event: '333', solves: 5, totalMs: 55_000, meanMs: 12_000,
            pbs: { single: pb(1, 10_000), mo3: pb(3, 11_667), ao5: pb(4, 12_667), ao12: null, ao50: null, ao100: null },
          },
          {
            event: '222', solves: 2, totalMs: 7_000, meanMs: 3_500,
            pbs: { single: pb(5, 3_000), mo3: null, ao5: null, ao12: null, ao50: null, ao100: null },
          },
        ],
      });
    });

    it("counts streaks over the days in the owner's timezone, ending today or yesterday there", async () => {
      const u = newCuber('Australia/Brisbane'); // UTC+10, no daylight saving
      const session = s.solve.session(u, '333');
      // Brisbane days: 2025-12-31 and 2026-01-01 | 1-3 Oct | 11-14 Oct
      const instants = [
        '2025-12-31T13:30:00Z', // 23:30 on 31 December
        '2025-12-31T14:30:00Z', // 00:30 on 1 January 2026 (still 2025 in UTC)
        '2026-10-01T02:00:00Z', '2026-10-02T02:00:00Z', '2026-10-03T02:00:00Z',
        '2026-10-11T02:00:00Z', '2026-10-12T02:00:00Z', '2026-10-13T02:00:00Z',
        '2026-10-13T15:30:00Z', // 01:30 on 14 October (13 October in UTC)
      ];
      await s.feed(...instants.map((t, i) => s.solve.solve(u, session, 10_000 + i, t).event));
      const totals = async (now: string) => {
        pinNow(now);
        return (await get(`/api/stats/users/${u.id}/summary`)).totals;
      };
      // noon on 14 October in Brisbane
      expect(await totals('2026-10-14T02:00:00Z')).toMatchObject({ activeDays: 9, currentStreak: 4, longestStreak: 4, activeYears: [2026, 2025] });
      // 23:00 on 15 October: yesterday's run still counts
      expect((await totals('2026-10-15T13:00:00Z')).currentStreak).toBe(4);
      // 01:00 on 16 October in Brisbane, still the 15th in UTC: the run is broken
      expect(await totals('2026-10-15T15:00:00Z')).toMatchObject({ currentStreak: 0, longestStreak: 4 });
    });
  });

  describe('activity', () => {
    it("lists the days with solves in the 365 days ending today in the owner's timezone, all events together", async () => {
      const u = newCuber('Australia/Brisbane');
      const cube = s.solve.session(u, '333');
      const pyra = s.solve.session(u, 'pyram');
      await s.feed(
        s.solve.solve(u, cube, 20_000, '2025-10-14T02:00:00Z').event, // 365 days before today: outside
        s.solve.solve(u, cube, 19_000, '2025-10-15T02:00:00Z').event, // the first day of the window
        s.solve.solve(u, cube, 15_000, '2026-10-13T20:00:00Z').event, // 06:00 on 14 October in Brisbane
        s.solve.solve(u, pyra, 5_000, '2026-10-14T01:00:00Z').event,
      );
      pinNow('2026-10-14T02:00:00Z');
      expect(await get(`/api/stats/users/${u.id}/activity`)).toEqual({
        from: '2025-10-15',
        to: '2026-10-14',
        days: [
          { date: '2025-10-15', solves: 1, totalMs: 19_000 },
          { date: '2026-10-14', solves: 2, totalMs: 20_000 },
        ],
      });
    });

    it('narrows to one event, and takes a single bound as the start or end of a 365-day window', async () => {
      const u = newCuber();
      const cube = s.solve.session(u, '333');
      const pyra = s.solve.session(u, 'pyram');
      await s.feed(
        s.solve.solve(u, cube, 10_000, '2026-03-01T10:00:00Z').event,
        s.solve.solve(u, pyra, 4_000, '2026-03-01T11:00:00Z').event,
        s.solve.solve(u, cube, 9_000, '2026-06-01T10:00:00Z').event,
      );
      const activity = (q: string) => get(`/api/stats/users/${u.id}/activity?${q}`);
      expect(await activity('from=2026-03-01&to=2026-03-31')).toEqual({
        from: '2026-03-01', to: '2026-03-31', days: [{ date: '2026-03-01', solves: 2, totalMs: 14_000 }],
      });
      expect(await activity('from=2026-01-01&to=2026-12-31&event=pyram')).toEqual({
        from: '2026-01-01', to: '2026-12-31', days: [{ date: '2026-03-01', solves: 1, totalMs: 4_000 }],
      });
      expect(await activity('from=2026-03-02')).toEqual({
        from: '2026-03-02', to: '2027-03-01', days: [{ date: '2026-06-01', solves: 1, totalMs: 9_000 }],
      });
      expect(await activity('to=2026-03-01')).toEqual({
        from: '2025-03-02', to: '2026-03-01', days: [{ date: '2026-03-01', solves: 2, totalMs: 14_000 }],
      });
    });

    it.each([
      ['a start after the end', 'from=2026-05-02&to=2026-05-01'],
      ['a date that does not exist', 'from=2026-02-30'],
      ['a date without leading zeros', 'to=2026-1-01'],
      ['an event cubr does not have', 'event=333mbf'],
    ])('answers 400 to %s', async (_what, query) => {
      const res = await s.request('GET', `/api/stats/users/${randomUUID()}/activity?${query}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
    });
  });

  describe('pb-history', () => {
    it('returns every PB improvement oldest first, for 3x3 unless ?event= names another event', async () => {
      const u = newCuber();
      const cube = s.solve.session(u, '333');
      const made = [12_000, 11_000, 13_000, 10_000].map((t, i) => s.solve.solve(u, cube, t, `2026-09-0${i + 1}T10:00:00.000Z`));
      const two = s.solve.solve(u, s.solve.session(u, '222'), 3_000, '2026-09-05T10:00:00.000Z');
      await s.feed(...made.map((m) => m.event), two.event);
      const at = (i: number) => made[i].solve.createdAt;
      expect(await get(`/api/stats/users/${u.id}/pb-history`)).toEqual({
        event: '333',
        history: [
          { kind: 'single', valueMs: 12_000, achievedAt: at(0) },
          { kind: 'single', valueMs: 11_000, achievedAt: at(1) },
          { kind: 'mo3', valueMs: 12_000, achievedAt: at(2) },
          { kind: 'single', valueMs: 10_000, achievedAt: at(3) },
          { kind: 'mo3', valueMs: 11_333, achievedAt: at(3) },
        ],
      });
      expect(await get(`/api/stats/users/${u.id}/pb-history?event=222`)).toEqual({
        event: '222',
        history: [{ kind: 'single', valueMs: 3_000, achievedAt: two.solve.createdAt }],
      });
      expect((await s.request('GET', `/api/stats/users/${u.id}/pb-history?event=nope`)).statusCode).toBe(400);
    });
  });

  describe('hourly', () => {
    it("has the 24 hours of the owner's timezone: every attempt counted, the mean over the non-DNF ones", async () => {
      const u = newCuber('Australia/Brisbane');
      const cube = s.solve.session(u, '333');
      const two = s.solve.session(u, '222');
      await s.feed(
        s.solve.solve(u, cube, 10_000, '2026-10-13T23:10:00Z').event, // 09:10 in Brisbane
        s.solve.solve(u, cube, 12_000, '2026-10-13T23:40:00Z', '+2').event,
        s.solve.solve(u, cube, 9_000, '2026-10-13T23:50:00Z', 'DNF').event,
        s.solve.solve(u, cube, 8_000, '2026-10-14T03:00:00Z', 'DNF').event, // 13:00: only a DNF
        s.solve.solve(u, two, 3_000, '2026-10-14T05:00:00Z').event, // 15:00
      );
      const all = await get(`/api/stats/users/${u.id}/hourly`);
      expect(all.event).toBeNull();
      expect(all.hours.map((h: { hour: number }) => h.hour)).toEqual([...Array(24).keys()]);
      expect(all.hours.filter((h: { solves: number }) => h.solves > 0)).toEqual([
        { hour: 9, solves: 3, meanMs: 12_000, dnfs: 1 },
        { hour: 13, solves: 1, meanMs: null, dnfs: 1 },
        { hour: 15, solves: 1, meanMs: 3_000, dnfs: 0 },
      ]);
      expect(all.hours[0]).toEqual({ hour: 0, solves: 0, meanMs: null, dnfs: 0 });
      const twos = await get(`/api/stats/users/${u.id}/hourly?event=222`);
      expect(twos.event).toBe('222');
      expect(twos.hours.filter((h: { solves: number }) => h.solves > 0)).toEqual([{ hour: 15, solves: 1, meanMs: 3_000, dnfs: 0 }]);
    });
  });

  describe('solves (history chart)', () => {
    it("returns the chronological series with each session's name, size and practice flag", async () => {
      const u = newCuber();
      const main = s.solve.session(u, '333', { name: 'Main' });
      const practice = s.solve.session(u, '333', { name: '3x3 practice', practice: true });
      const a = s.solve.solve(u, main, 10_000, '2026-10-01T10:00:00.000Z');
      const b = s.solve.solve(u, practice, 9_000, '2026-10-01T10:05:00.000Z', '+2');
      const c = s.solve.solve(u, main, 9_500, '2026-10-01T10:10:00.000Z', 'DNF');
      await s.feed(a.event, b.event, c.event);
      const sec = (iso: string) => Date.parse(iso) / 1000;
      expect(await get(`/api/stats/users/${u.id}/solves`)).toEqual({
        event: '333',
        total: 3,
        truncated: false,
        sessions: [
          { id: main.id, name: 'Main', solves: 2, firstAt: a.solve.createdAt, lastAt: c.solve.createdAt },
          { id: practice.id, name: '3x3 practice', practice: true, solves: 1, firstAt: b.solve.createdAt, lastAt: b.solve.createdAt },
        ],
        // [unixSeconds, timeMs, effectiveMs | null (DNF), sessionIndex]
        solves: [
          [sec(a.solve.createdAt), 10_000, 10_000, 0],
          [sec(b.solve.createdAt), 9_000, 11_000, 1],
          [sec(c.solve.createdAt), 9_500, null, 0],
        ],
      });
    });

    it('shows a session it has no name for yet (a bulk import) as null', async () => {
      const u = newCuber();
      const imported = s.solve.session(u, '444', { name: 'From csTimer' });
      s.solve.solve(u, imported, 50_000, '2026-01-01T10:00:00.000Z');
      await s.feed(s.solve.imported(u, ['444']));
      expect((await get(`/api/stats/users/${u.id}/solves?event=444`)).sessions).toEqual([
        { id: imported.id, name: null, solves: 1, firstAt: '2026-01-01T10:00:00.000Z', lastAt: '2026-01-01T10:00:00.000Z' },
      ]);
    });

    it('returns only the newest `limit` solves, oldest first, and says that older ones were left out', async () => {
      const u = newCuber();
      const session = s.solve.session(u, 'skewb');
      const made = [7_000, 6_000, 8_000, 5_000, 9_000].map((t, i) => s.solve.solve(u, session, t, `2026-10-0${i + 1}T10:00:00.000Z`));
      await s.feed(...made.map((m) => m.event));
      const two = await get(`/api/stats/users/${u.id}/solves?event=skewb&limit=2`);
      expect(two).toMatchObject({ event: 'skewb', total: 5, truncated: true });
      expect(two.solves.map((r: number[]) => r[1])).toEqual([5_000, 9_000]);
      expect(two.sessions).toEqual([expect.objectContaining({ id: session.id, solves: 5 })]);
      expect((await get(`/api/stats/users/${u.id}/solves?event=skewb&limit=5`)).truncated).toBe(false);
    });

    it.each(['limit=0', 'limit=50001', 'limit=2.5', 'event=nope'])('answers 400 to ?%s', async (query) => {
      const res = await s.request('GET', `/api/stats/users/${randomUUID()}/solves?${query}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
    });
  });

  describe('private profiles', () => {
    /** A user with a solve whose profile is private (auth mirrors the flag into this Redis set). */
    async function privateCuber(): Promise<Cuber> {
      const u = newCuber();
      await s.feed(s.solve.solve(u, s.solve.session(u, '333'), 10_000, '2026-10-01T10:00:00Z').event);
      await s.redis.sadd(PRIVATE_USERS_KEY, u.id);
      return u;
    }

    it.each(PROFILE_ROUTES)('/%s answers 403 to strangers, signed in or not, and serves the owner', async (route) => {
      const u = await privateCuber();
      const url = `/api/stats/users/${u.id}/${route}`;
      const anonymous = await s.request('GET', url);
      expect(anonymous.statusCode).toBe(403);
      expect(anonymous.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'This profile is private' } });
      expect((await s.request('GET', url, { token: await s.token(newCuber()) })).statusCode).toBe(403);
      // the same id in capitals is the same user
      expect((await s.request('GET', url.replace(u.id, u.id.toUpperCase()))).statusCode).toBe(403);
      expect((await s.request('GET', url, { token: await s.token(u) })).statusCode).toBe(200);
      expect((await s.request('GET', url.replace(u.id, u.id.toUpperCase()), { token: await s.token(u) })).statusCode).toBe(200);
    });

    it('shows the owner their own numbers, and everyone once the profile is public again', async () => {
      const u = await privateCuber();
      expect((await get(`/api/stats/users/${u.id}/summary`, await s.token(u))).totals.solves).toBe(1);
      await s.redis.srem(PRIVATE_USERS_KEY, u.id);
      expect((await get(`/api/stats/users/${u.id}/summary`)).totals.solves).toBe(1);
    });

    it('treats the owner as a stranger when their token is logged out or not signed by auth', async () => {
      const u = await privateCuber();
      const url = `/api/stats/users/${u.id}/summary`;
      const token = await s.token(u);
      const { jti } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { jti: string };
      await s.redis.set(revokedKey(jti), '1');
      expect((await s.request('GET', url, { token })).statusCode).toBe(403);
      const forged = await signToken('not-the-secret', u);
      expect((await s.request('GET', url, { token: forged.token })).statusCode).toBe(403);
      expect((await s.request('GET', url, { token: await s.token(u) })).statusCode).toBe(200);
    });

    it('hides every profile from strangers while Redis cannot answer, but still serves the owner', async () => {
      const u = newCuber(); // a public profile
      await s.feed(s.solve.solve(u, s.solve.session(u, '333'), 10_000, '2026-10-01T10:00:00Z').event);
      const down = await appWithDeadRedis();
      try {
        for (const route of PROFILE_ROUTES) {
          const url = `/api/stats/users/${u.id}/${route}`;
          expect((await down.inject(url)).statusCode, route).toBe(403);
          expect((await down.inject(url, await s.token(newCuber()))).statusCode, route).toBe(403);
          expect((await down.inject(url, await s.token(u))).statusCode, route).toBe(200);
        }
      } finally {
        await down.close();
      }
    });

    it.each(PROFILE_ROUTES)('/%s answers 400 to a user id that is not a UUID', async (route) => {
      const res = await s.request('GET', `/api/stats/users/not-a-uuid/${route}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
    });
  });

  describe('global counters', () => {
    const global = async () => {
      const res = await s.request('GET', '/api/stats/global');
      expect(res.statusCode).toBe(200);
      return { body: res.json(), cache: res.headers['x-cache'] };
    };

    it("counts users, solves and time across everyone, and today's solves and solvers by the UTC day", async () => {
      pinNow('2026-07-20T12:00:00Z');
      await s.redis.del(CACHE_KEY);
      const before = (await global()).body;
      const a = newCuber();
      const b = newCuber('Australia/Brisbane');
      const sa = s.solve.session(a, '333');
      await s.feed(
        s.solve.solve(a, sa, 12_000, '2026-07-19T12:00:00Z').event, // yesterday
        s.solve.solve(a, sa, 10_000, '2026-07-20T08:00:00Z').event,
        s.solve.solve(a, sa, 11_000, '2026-07-20T09:00:00Z', 'DNF').event,
        s.solve.solve(b, s.solve.session(b, '222'), 4_000, '2026-07-20T01:00:00Z').event, // 11:00 on the 20th in Brisbane too
      );
      await s.redis.del(CACHE_KEY);
      const after = await global();
      expect(after.cache).toBe('miss');
      expect(after.body).toEqual({
        users: before.users + 2,
        solves: before.solves + 4,
        totalMs: before.totalMs + 37_000,
        solvesToday: before.solvesToday + 3,
        activeUsersToday: before.activeUsersToday + 2,
        day: '2026-07-20',
        computedAt: '2026-07-20T12:00:00.000Z',
      });
    });

    it("counts today's solves by the UTC day they were made in, whatever the solver's timezone", async () => {
      pinNow('2026-07-21T22:00:00Z');
      await s.redis.del(CACHE_KEY);
      const before = (await global()).body;
      const u = newCuber('Australia/Brisbane');
      // made today in UTC; already 06:00 on the 22nd in Brisbane
      await s.feed(s.solve.solve(u, s.solve.session(u, '333'), 10_000, '2026-07-21T20:00:00Z').event);
      await s.redis.del(CACHE_KEY);
      expect((await global()).body).toMatchObject({ day: '2026-07-21', solvesToday: before.solvesToday + 1, activeUsersToday: before.activeUsersToday + 1 });
    });

    it('serves the counters from the Redis cache for 10 seconds', async () => {
      await s.redis.del(CACHE_KEY);
      const first = await global();
      expect(first.cache).toBe('miss');
      const ttl = await s.redis.ttl(CACHE_KEY);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(10);
      const u = newCuber();
      await s.feed(s.solve.solve(u, s.solve.session(u, '333'), 10_000, new Date()).event);
      const second = await global();
      expect(second.cache).toBe('hit');
      expect(second.body).toEqual(first.body);
      await s.redis.del(CACHE_KEY); // as if the 10 s had run out
      const third = await global();
      expect(third.cache).toBe('miss');
      expect(third.body.solves).toBe(first.body.solves + 1);
    });

    it('answers from Postgres when Redis is down', async () => {
      const down = await appWithDeadRedis();
      try {
        const res = await down.inject('/api/stats/global');
        expect(res.statusCode).toBe(200);
        expect(res.headers['x-cache']).toBe('miss');
        expect(res.json()).toMatchObject({ users: expect.any(Number), solves: expect.any(Number), solvesToday: expect.any(Number) });
      } finally {
        await down.close();
      }
    });

    it('drops a deleted account from the counters at once instead of when the cache runs out', async () => {
      const u = newCuber();
      await s.feed(s.solve.solve(u, s.solve.session(u, '333'), 10_000, new Date()).event);
      await s.redis.del(CACHE_KEY);
      const before = (await global()).body;
      await s.feed(envelope('user.deleted', { userId: u.id, username: u.username }));
      const after = await global();
      expect(after.cache).toBe('miss');
      expect(after.body).toMatchObject({ users: before.users - 1, solves: before.solves - 1, totalMs: before.totalMs - 10_000 });
    });
  });

  describe('internal PB listing', () => {
    const internal = (query = '', token: string | null = s.config.internalToken) =>
      s.request('GET', `/internal/pbs${query}`, token === null ? {} : { headers: { 'x-internal-token': token } });

    it('requires the internal token', async () => {
      expect((await internal('', null)).statusCode).toBe(403);
      const wrong = await internal('', 'wrong-token');
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json().error.code).toBe('FORBIDDEN');
      expect((await internal()).statusCode).toBe(200);
    });

    it('lists the PB rows with usernames, filtered by event and kind, fastest first', async () => {
      const a = newCuber();
      const b = newCuber();
      const aSolve = s.solve.solve(a, s.solve.session(a, 'sq1'), 20_000, '2026-10-01T10:00:00.000Z');
      const bSession = s.solve.session(b, 'sq1');
      const bSolves = [15_000, 16_000, 17_000, 18_000, 19_000].map((t, i) => s.solve.solve(b, bSession, t, `2026-10-01T11:0${i}:00.000Z`));
      await s.feed(aSolve.event, ...bSolves.map((x) => x.event));
      const row = (u: Cuber, kind: string, valueMs: number, m: { solve: { id: string; createdAt: string } }) =>
        ({ userId: u.id, username: u.username, event: 'sq1', kind, valueMs, solveId: m.solve.id, achievedAt: m.solve.createdAt });
      expect((await internal('?event=sq1&kind=single')).json()).toEqual({
        pbs: [row(b, 'single', 15_000, bSolves[0]), row(a, 'single', 20_000, aSolve)],
      });
      expect((await internal('?event=sq1&kind=ao5')).json()).toEqual({ pbs: [row(b, 'ao5', 17_000, bSolves[4])] });
      // without a kind: by kind, then fastest first
      expect((await internal('?event=sq1')).json().pbs.map((p: { kind: string; valueMs: number }) => [p.kind, p.valueMs])).toEqual([
        ['ao5', 17_000], ['mo3', 16_000], ['single', 15_000], ['single', 20_000],
      ]);
    });

    it.each(['?kind=mo4', '?event=nope'])('answers 400 to %s', async (query) => {
      expect((await internal(query)).statusCode).toBe(400);
    });
  });
});
