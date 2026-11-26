// Daily-challenge reminders against a real Postgres and Redis: the subscription routes, the
// once-a-minute pass (with the push service faked) and the purge of a deleted account.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateVAPIDKeys } from 'web-push';
import type { EventEnvelope } from '@cubr/common';
import { describeIntegration, startTestServer, type TestServer } from '@cubr/testkit';
import { migrations } from '../src/migrations.js';
import { makeUserPurge } from '../src/purge.js';
import { REMINDER, remindOnce, type Send } from '../src/reminders.js';
import { registerRoutes } from '../src/routes/index.js';

const vapid = { subject: 'mailto:test@example.com', ...generateVAPIDKeys() };
const keys = { p256dh: `B${'a'.repeat(86)}`, auth: 'abcdefghijklmnopqrstuv' };
const endpointOf = () => `https://push.example.com/send/${randomUUID()}`;

describeIntegration('daily reminders', () => {
  let s: TestServer;
  let off: TestServer;
  let n = 0;
  beforeAll(async () => {
    const opts = { service: 'solve', infoPrefixes: ['/api/solves'], schemas: [{ schema: 'solve', migrations }] };
    s = await startTestServer({ ...opts, routes: ({ app, config, pool, redis, auth }) => registerRoutes(app, { config, pool, redis, auth }, vapid) });
    off = await startTestServer({ ...opts, routes: ({ app, config, pool, redis, auth }) => registerRoutes(app, { config, pool, redis, auth }, null) });
  });
  afterAll(async () => {
    await s?.close();
    await off?.close();
  });
  beforeEach(async () => {
    await s.pool.query('DELETE FROM solve.push_subscriptions');
  });

  const newUser = async () => {
    const user = { id: randomUUID(), username: `reminded_${++n}` };
    return { ...user, token: await s.token(user) };
  };
  const put = (token: string, body: unknown, server = s) => server.request('PUT', '/api/solves/daily/reminders', { token, body });
  const rows = async () =>
    (await s.pool.query('SELECT endpoint, user_id, remind_minute, tz, last_day::text FROM solve.push_subscriptions ORDER BY created_at')).rows;

  describe('the routes', () => {
    it('give the public key, or null where reminders are not set up', async () => {
      expect((await s.request('GET', '/api/solves/daily/reminders/key')).json()).toEqual({ publicKey: vapid.publicKey });
      expect((await off.request('GET', '/api/solves/daily/reminders/key')).json()).toEqual({ publicKey: null });
      const token = await off.token({ id: randomUUID(), username: 'without_keys' }); // each test server signs its own
      expect((await put(token, { endpoint: endpointOf(), keys, remindMinute: 600, tz: 'Australia/Brisbane' }, off)).statusCode).toBe(503);
    });

    it('turn a browser on, move it to another time, and turn it off; signed-in people only', async () => {
      const u = await newUser();
      const endpoint = endpointOf();
      expect((await s.request('PUT', '/api/solves/daily/reminders', { body: { endpoint, keys, remindMinute: 600, tz: 'UTC' } })).statusCode).toBe(401);
      const on = await put(u.token, { endpoint, keys, remindMinute: 600, tz: 'Australia/Brisbane' });
      expect(on.statusCode, on.body).toBe(200);
      expect(on.json()).toEqual({ reminder: { remindMinute: 600, tz: 'Australia/Brisbane' } });
      expect((await put(u.token, { endpoint, keys, remindMinute: 1080, tz: 'Europe/Amsterdam' })).statusCode).toBe(200);
      expect(await rows()).toEqual([{ endpoint, user_id: u.id, remind_minute: 1080, tz: 'Europe/Amsterdam', last_day: null }]);
      // someone else can't turn it off
      const other = await newUser();
      expect((await s.request('DELETE', '/api/solves/daily/reminders', { token: other.token, body: { endpoint } })).statusCode).toBe(204);
      expect(await rows()).toHaveLength(1);
      expect((await s.request('DELETE', '/api/solves/daily/reminders', { token: u.token, body: { endpoint } })).statusCode).toBe(204);
      expect(await rows()).toEqual([]);
    });

    it('refuse what is not a browser subscription, an unknown time zone or a time past the day', async () => {
      const u = await newUser();
      const ok = { endpoint: endpointOf(), keys, remindMinute: 600, tz: 'UTC' };
      for (const bad of [
        { ...ok, endpoint: 'http://push.example.com/x' },
        { ...ok, endpoint: 'not a url' },
        { ...ok, keys: { ...keys, auth: 'x' } },
        { ...ok, remindMinute: 1440 },
        { ...ok, tz: 'Mars/Olympus_Mons' },
        { ...ok, extra: true },
      ])
        expect((await put(u.token, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    });
  });

  describe('the once-a-minute pass', () => {
    const log = { info: vi.fn(), warn: vi.fn() } as never;
    async function subscribe(remindMinute = 600, tz = 'Australia/Brisbane') {
      const u = await newUser();
      const endpoint = endpointOf();
      expect((await put(u.token, { endpoint, keys, remindMinute, tz })).statusCode).toBe(200);
      return { ...u, endpoint };
    }
    // Brisbane is UTC+10 all year: 10:00 there is 00:00 UTC, the moment a new challenge starts
    const at = (iso: string) => new Date(iso);

    it('sends at the chosen local time, once that day, and not before or hours late', async () => {
      const u = await subscribe(600);
      const send = vi.fn<Send>().mockResolvedValue({ statusCode: 201, body: '', headers: {} });
      expect(await remindOnce({ pool: s.pool, vapid, log, send }, at('2026-12-01T23:59:00Z'))).toMatchObject({ sent: 0 }); // 09:59
      expect(await remindOnce({ pool: s.pool, vapid, log, send }, at('2026-12-02T00:05:00Z'))).toMatchObject({ sent: 1 }); // 10:05
      expect(send).toHaveBeenCalledWith(
        { endpoint: u.endpoint, keys },
        JSON.stringify(REMINDER),
        expect.objectContaining({ vapidDetails: vapid, TTL: 10_800 }),
      );
      expect(await remindOnce({ pool: s.pool, vapid, log, send }, at('2026-12-02T00:10:00Z'))).toMatchObject({ sent: 0 }); // once a day
      expect((await rows())[0].last_day).toBe('2026-12-02');
      // the next day, a pass that comes 3.5 hours late sends nothing (a service that was down)
      expect(await remindOnce({ pool: s.pool, vapid, log, send }, at('2026-12-03T03:30:00Z'))).toMatchObject({ sent: 0 });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("skips someone who has already played today's challenge (an attempt, or one started)", async () => {
      const played = await subscribe(600);
      const started = await subscribe(600);
      const idle = await subscribe(600);
      await s.pool.query(
        `INSERT INTO solve.daily_attempts (user_id, daily_date, event, daily_index, solve_id, time_ms, penalty) VALUES ($1, '2026-12-02', '222', 0, $2, 3000, 'OK')`,
        [played.id, randomUUID()],
      );
      await s.pool.query(`INSERT INTO solve.daily_starts (user_id, daily_date, event, daily_index) VALUES ($1, '2026-12-02', '333', 0)`, [started.id]);
      const send = vi.fn<Send>().mockResolvedValue({ statusCode: 201, body: '', headers: {} });
      expect(await remindOnce({ pool: s.pool, vapid, log, send }, at('2026-12-02T00:05:00Z'))).toEqual({ sent: 1, played: 2, gone: 0, failed: 0 });
      expect(send.mock.calls.map((c) => c[0].endpoint)).toEqual([idle.endpoint]);
    });

    it('deletes a subscription the push service says is gone, and gives up for the day on other failures', async () => {
      const gone = await subscribe(600);
      const failing = await subscribe(600);
      const send = vi.fn<Send>(async (sub) => {
        throw Object.assign(new Error('push service says no'), { statusCode: sub.endpoint === gone.endpoint ? 410 : 503 });
      });
      expect(await remindOnce({ pool: s.pool, vapid, log, send }, at('2026-12-02T00:05:00Z'))).toEqual({ sent: 0, played: 0, gone: 1, failed: 1 });
      expect((await rows()).map((r) => [r.endpoint, r.last_day])).toEqual([[failing.endpoint, '2026-12-02']]);
    });

    it('go with the account when it is deleted', async () => {
      const u = await subscribe(600);
      await makeUserPurge({ pool: s.pool, log })({ id: '1-0', type: 'user.deleted', data: { userId: u.id } } as unknown as EventEnvelope);
      expect(await rows()).toEqual([]);
    });
  });
});
