// The daily challenge against a real Postgres (@cubr/testkit): five scrambles per daily event,
// generated on the first request of a day, stored, and the same for every request and every
// replica from then on. Searches come from a fake backend, so no cubing.js here.
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from '@cubr/common';
import { DAILY_EVENTS } from '@cubr/cubestats';
import { describeIntegration, startTestServer, type TestServer } from '@cubr/testkit';
import type { ScrambleBackend } from '../src/backends.js';
import { DAILY_SCRAMBLES, DailyChallenges } from '../src/daily.js';
import { ScrambleGenerator } from '../src/generator.js';
import { migrations } from '../src/migrations.js';
import { ScramblePool } from '../src/pool.js';
import { registerRoutes } from '../src/routes/index.js';
import { todayUtc } from '../src/validation.js';
import { fakeBackend, fakeCsTimer } from './fakes.js';

const DAY_MS = 86_400_000;
/** The date `n` days before today (UTC). Each test uses its own day, so rows and caches don't overlap. */
const daysAgo = (n: number) => todayUtc(new Date(Date.now() - n * DAY_MS));
const silent = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger;

describeIntegration('daily challenge', () => {
  let s: TestServer;
  let migrated = true;
  const backend = fakeBackend();
  const generator = new ScrambleGenerator(backend, { timeoutMs: 5000, maxQueue: 100 });
  const generateMany = vi.spyOn(generator, 'generateMany');

  beforeAll(async () => {
    s = await startTestServer({
      service: 'scramble',
      infoPrefixes: ['/api/scrambles'],
      schemas: [{ schema: 'scramble', migrations }],
      routes: ({ app, pool, redis, config }) =>
        registerRoutes(app, {
          generator,
          pool: new ScramblePool(redis),
          daily: new DailyChallenges({ pool, generator, isMigrated: () => migrated, log: app.log }),
          redis,
          internalToken: config.internalToken,
          cstimer: fakeCsTimer(),
        }),
    });
  });
  afterEach(() => {
    migrated = true;
    backend.behave = () => 0;
    generateMany.mockClear();
    vi.useRealTimers();
  });
  afterAll(async () => {
    await s?.close();
    await generator.close();
  });

  const getDaily = (date?: string) => s.request('GET', date === undefined ? '/api/scrambles/daily' : `/api/scrambles/daily?date=${encodeURIComponent(date)}`);
  /** What the table holds for a day, event -> scrambles. */
  async function stored(date: string): Promise<Record<string, string[]>> {
    const { rows } = await s.pool.query<{ event: string; scrambles: string[] }>('select event, scrambles from scramble.daily_challenges where day = $1', [
      date,
    ]);
    return Object.fromEntries(rows.map((r) => [r.event, r.scrambles]));
  }
  /** Another replica: the same database, but its own generator and an empty cache. */
  const replica = (gen: ScrambleGenerator = generator, pool: Pool = s.pool) =>
    new DailyChallenges({ pool, generator: gen, isMigrated: () => true, log: silent });
  const generatedEvents = () => generateMany.mock.calls.map(([event]) => event);

  it('generates five scrambles per daily event on the first request of a day, stores them and serves that set from then on', async () => {
    const date = daysAgo(1);
    const res = await getDaily(date);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.date).toBe(date);
    expect(Object.keys(body.events).sort()).toEqual([...DAILY_EVENTS].sort());
    for (const event of DAILY_EVENTS) {
      expect(body.events[event]).toHaveLength(DAILY_SCRAMBLES);
      expect(new Set(body.events[event]).size).toBe(DAILY_SCRAMBLES);
      for (const scramble of body.events[event]) expect(scramble).toMatch(new RegExp(`^${event} scramble`));
    }
    expect(generateMany.mock.calls.map(([event, count, priority]) => [event, count, priority])).toEqual(DAILY_EVENTS.map((e) => [e, 5, 'request']));
    expect(await stored(date)).toEqual(body.events);

    generateMany.mockClear();
    expect((await getDaily(date)).json()).toEqual(body);
    expect(await replica().get(date)).toEqual(body);
    expect(generateMany).not.toHaveBeenCalled();
  });

  it('defaults to today (UTC)', async () => {
    const before = todayUtc();
    const res = await getDaily();
    expect(res.statusCode).toBe(200);
    expect([before, todayUtc()]).toContain(res.json().date);
  });

  it.each([
    ['tomorrow', todayUtc(new Date(Date.now() + DAY_MS)), /future/],
    ['a day 31 days ago', daysAgo(31), /last 30 days/],
    ['an impossible date', '2026-02-30', /calendar date/],
    ['another format', '16/11/2026', /YYYY-MM-DD/],
  ])('answers 400 to %s and generates nothing', async (_what, date, message) => {
    const res = await getDaily(date);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({ code: 'BAD_REQUEST', message: expect.stringMatching(message) });
    expect(generateMany).not.toHaveBeenCalled();
  });

  it('lets concurrent requests on one replica share a single generation', async () => {
    const date = daysAgo(2);
    const responses = await Promise.all([getDaily(date), getDaily(date), getDaily(date)]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);
    expect(generatedEvents()).toEqual(DAILY_EVENTS);
  });

  it('makes two replicas that generate the same day at the same moment agree on one set', async () => {
    const date = daysAgo(3);
    // each replica's first search waits until the other's has started: both found the day empty
    let arrived = 0;
    let release!: () => void;
    const bothSearching = new Promise<void>((resolve) => (release = resolve));
    const racing = (tag: string): ScrambleBackend => {
      let n = 0;
      return {
        kind: 'in-process',
        size: 1,
        async run(_slot, event) {
          if (++n === 1) {
            if (++arrived === 2) release();
            await bothSearching;
          }
          return `${tag} ${event} ${n}`;
        },
        close: async () => {},
      };
    };
    const genA = new ScrambleGenerator(racing('A'), { timeoutMs: 5000, maxQueue: 100 });
    const genB = new ScrambleGenerator(racing('B'), { timeoutMs: 5000, maxQueue: 100 });
    const [a, b] = await Promise.all([replica(genA).get(date), replica(genB).get(date)]);
    expect(arrived).toBe(2);
    expect(a).toEqual(b);
    expect(await stored(date)).toEqual(a.events);
    for (const event of DAILY_EVENTS) {
      // an event's five scrambles all come from one replica's generation, never a mix
      expect(new Set(a.events[event].map((x: string) => x.split(' ')[0])).size).toBe(1);
    }
    await Promise.all([genA.close(), genB.close()]);
  });

  it('generates only the events a day is missing', async () => {
    const date = daysAgo(4);
    const mine = ["R U R'", 'F2 B2', 'L D', 'U2 R2', "R' U'"];
    await s.pool.query('insert into scramble.daily_challenges (day, event, scrambles) values ($1, $2, $3)', [date, '333', mine]);
    const body = (await getDaily(date)).json();
    expect(body.events['333']).toEqual(mine);
    expect(generatedEvents()).toEqual(DAILY_EVENTS.filter((e) => e !== '333'));
  });

  it('keeps what a failed generation stored, and completes the day on the next request without changing it', async () => {
    const date = daysAgo(5);
    backend.behave = (event) => (event === '444' ? new Error('search crashed') : 0);
    const failed = await getDaily(date);
    expect(failed.statusCode).toBe(503);
    expect(failed.json().error.code).toBe('UNAVAILABLE');
    const partial = await stored(date);
    expect(Object.keys(partial).sort()).toEqual(['222', '333']);

    backend.behave = () => 0;
    generateMany.mockClear();
    const body = (await getDaily(date)).json();
    expect(body.events['333']).toEqual(partial['333']);
    expect(body.events['222']).toEqual(partial['222']);
    expect(generatedEvents()).toEqual(['444', 'pyram', 'skewb']);
  });

  it('answers 503 until its table is migrated', async () => {
    migrated = false;
    const res = await getDaily(daysAgo(8));
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toEqual({ code: 'UNAVAILABLE', message: expect.stringMatching(/not ready/) });
    expect(generateMany).not.toHaveBeenCalled();
  });

  it('answers 503 and stores nothing when the generator is overloaded', async () => {
    const tiny = new ScrambleGenerator(fakeBackend(), { timeoutMs: 5000, maxQueue: 3 });
    const date = daysAgo(9);
    await expect(replica(tiny).get(date)).rejects.toMatchObject({
      statusCode: 503,
      code: 'UNAVAILABLE',
      message: expect.stringMatching(/could not be generated/),
    });
    expect(await stored(date)).toEqual({});
    await tiny.close();
  });

  describe('cache', () => {
    it('serves a day from memory for a minute, then re-reads it, and serves a stale copy while the database is down', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      let down = false;
      const queries: string[] = [];
      const flaky = {
        query: (text: string, values?: unknown[]) => {
          queries.push(text.trim().split(/\s+/)[0]);
          return down ? Promise.reject(new Error('connect ECONNREFUSED')) : s.pool.query(text, values);
        },
      } as unknown as Pool;
      const daily = replica(generator, flaky);
      const date = daysAgo(6);

      const body = await daily.get(date);
      expect(queries).toEqual(['select', 'insert', 'insert', 'insert', 'insert', 'insert', 'select']);
      expect(await daily.get(date)).toEqual(body);
      expect(queries).toHaveLength(7); // from memory

      vi.setSystemTime(Date.now() + 61_000);
      expect(await daily.get(date)).toEqual(body);
      expect(queries.slice(7)).toEqual(['select']); // re-read, nothing generated

      down = true;
      vi.setSystemTime(Date.now() + 61_000);
      expect(await daily.get(date)).toEqual(body); // a day's set never changes, so stale is still right
      await expect(daily.get(daysAgo(7))).rejects.toMatchObject({ statusCode: 503, message: expect.stringMatching(/database not reachable/) });
    });
  });
});
