// GET /api/scrambles/* against a real Redis (@cubr/testkit): the shared pool (LPOP order, LTRIM to
// the target), fresh=1 and the internal token, the per-IP request and generation budgets, Redis
// outages and generator failures. Searches come from a fake backend, so no cubing.js here.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, loadConfig } from '@cubr/common';
import { ALL_EVENT_IDS, EVENT_IDS } from '@cubr/cubestats';
import { describeIntegration, startTestServer, type TestServer } from '@cubr/testkit';
import { DailyChallenges } from '../src/daily.js';
import { ScrambleGenerator } from '../src/generator.js';
import { migrations } from '../src/migrations.js';
import { ScramblePool, poolKey } from '../src/pool.js';
import { registerRoutes } from '../src/routes/index.js';
import { GENERATED_PER_MIN, REQUESTS_PER_MIN, registerScrambleRoutes, type ScrambleRouteDeps } from '../src/routes/scrambles.js';
import { fakeBackend, fakeCsTimer } from './fakes.js';

/** A fresh client IP per call, so the per-IP limits only trip where a test means them to. */
let ipCount = 0;
const freshIp = () => `10.3.${Math.floor(++ipCount / 250)}.${(ipCount % 250) + 1}`;
const generated = (event: string) => expect.stringMatching(new RegExp(`^${event} scramble \\d+$`));

describeIntegration('scramble API', () => {
  let s: TestServer;
  const generator = new ScrambleGenerator(fakeBackend(), { timeoutMs: 5000, maxQueue: 100 });
  const cstimer = fakeCsTimer();
  const extraApps: { close(): Promise<unknown> }[] = [];

  beforeAll(async () => {
    s = await startTestServer({
      service: 'scramble',
      infoPrefixes: ['/api/scrambles'],
      schemas: [{ schema: 'scramble', migrations }],
      routes: ({ app, pool, redis, config }) =>
        registerRoutes(app, {
          generator,
          pool: new ScramblePool(redis),
          daily: new DailyChallenges({ pool, generator, isMigrated: () => true, log: app.log }),
          redis,
          internalToken: config.internalToken,
          cstimer,
        }),
    });
  });
  beforeEach(async () => {
    await s.redis.del(...EVENT_IDS.map(poolKey));
  });
  afterAll(async () => {
    await Promise.all(extraApps.map((a) => a.close()));
    await s?.close();
    await generator.close();
  });

  const get = (url: string, opts: { ip?: string; token?: string } = {}) =>
    s.request('GET', url, { ip: opts.ip ?? freshIp(), headers: opts.token === undefined ? {} : { 'x-internal-token': opts.token } });
  const stock = (event: string, ...scrambles: string[]) => s.redis.rpush(poolKey(event), ...scrambles);
  /** The scramble routes alone on another server, with their own settings. */
  async function scrambleApp(deps: Partial<ScrambleRouteDeps>) {
    const { app } = createServer({ ...loadConfig('scramble'), logLevel: 'silent' }, { infoPrefixes: [] });
    registerScrambleRoutes(app, { generator, pool: new ScramblePool(s.redis), redis: s.redis, internalToken: s.config.internalToken, cstimer, ...deps });
    await app.ready();
    extraApps.push(app);
    return app;
  }

  it('serves scrambles from the shared pool first, oldest first, and generates whatever it is short of', async () => {
    await stock('333', 'p1', 'p2', 'p3');
    const res = await get('/api/scrambles/333?count=5');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ event: '333', scrambles: ['p1', 'p2', 'p3', generated('333'), generated('333')], source: 'generated' });
    expect(await s.redis.llen(poolKey('333'))).toBe(0);

    await stock('333', 'q1', 'q2', 'q3');
    expect((await get('/api/scrambles/333?count=2')).json()).toEqual({ event: '333', scrambles: ['q1', 'q2'], source: 'pool' });
    expect(await s.redis.lrange(poolKey('333'), 0, -1)).toEqual(['q3']);
    expect((await get('/api/scrambles/333')).json().scrambles).toEqual(['q3']); // one by default
  });

  it('lists the supported events, cacheable for five minutes', async () => {
    const res = await get('/api/scrambles/events');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.json().events.map((e: { id: string }) => e.id)).toEqual(ALL_EVENT_IDS);
    const first = res.json().events[0];
    expect(first).toMatchObject({ id: '333', name: '3x3x3 Cube', short: '3x3', puzzle: '3x3x3', kind: 'wca' });
    expect(first.types[0]).toEqual({ id: '333', label: 'wca' });
    expect(first.types.find((t: { id: string }) => t.id === 'wvls')).toEqual({ id: 'wvls', label: 'wvls' });
    const minx = res.json().events.find((e: { id: string }) => e.id === 'minx');
    expect(minx.types.find((t: { id: string }) => t.id === 'mgms2l')).toEqual({ id: 'mgms2l', label: 's2l', pending: true });
    expect(res.json().events.find((e: { id: string }) => e.id === 'r234')).toMatchObject({ kind: 'other', puzzle: null });
  });

  it('makes practice scrambles and the other events on request, never from the pool', async () => {
    await stock('333', 'pool A', 'pool B');
    const pll = await get('/api/scrambles/333?count=2&type=pll');
    expect(pll.statusCode).toBe(200);
    expect(pll.json()).toMatchObject({ event: '333', type: 'pll', source: 'generated' });
    // the fake backend echoes the job: a 3x3 practice state to solve
    expect(pll.json().scrambles).toEqual([expect.stringMatching(/^solve:3x3x3:\{.*\} scramble \d+$/), expect.stringMatching(/^solve:3x3x3:\{.*\} scramble \d+$/)]);
    expect(await s.redis.llen(poolKey('333'))).toBe(2); // the pool's wca scrambles stay for wca solves
    const moves = await get('/api/scrambles/333?type=333o');
    expect(moves.json().scrambles[0].split(' ')).toHaveLength(25);
    // a relay takes its parts from the pools
    await stock('222', 'two'); await stock('444', 'four');
    expect((await get('/api/scrambles/r234')).json().scrambles).toEqual(['2x2: two\n3x3: pool A\n4x4: four']);
  });

  it("asks csTimer for the rest, at its lengths: other puzzles' defaults and their practice types", async () => {
    expect((await get('/api/scrambles/15p')).json()).toMatchObject({ event: '15p', type: '15prp', scrambles: [expect.stringMatching(/^15prp cstimer \d+$/)], source: 'generated' });
    expect((await get('/api/scrambles/sq1?type=sqrcsp&count=2')).json().scrambles).toEqual([expect.stringMatching(/^sqrcsp cstimer/), expect.stringMatching(/^sqrcsp cstimer/)]);
    expect((await get('/api/scrambles/333?type=2gen')).json().scrambles[0]).toMatch(/^2gen cstimer/);
    expect(cstimer.calls).toContain('15prp:0');
  });

  it("draws, with csTimer, the scrambles of puzzles cubr can't draw: an SVG that runs nothing, cached by the browser", async () => {
    const res = await get(`/api/scrambles/15p/image?scramble=${encodeURIComponent('R D L')}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(res.body).toMatch(/^<svg[^>]*><text>15prp<\/text>/);
    // relays go to csTimer in its own labels
    const relay = await get(`/api/scrambles/r234/image?scramble=${encodeURIComponent('2x2: R U\n3x3: F2\n4x4: Rw2')}`);
    expect(relay.statusCode).toBe(200);
    expect(relay.body).toContain('<desc>19</desc>'); // "2) R U\n3) F2\n4) Rw2"
    expect((await get('/api/scrambles/333/image?scramble=R')).statusCode).toBe(404); // cubr draws 3x3s itself
    expect((await get('/api/scrambles/334/image?scramble=R')).statusCode).toBe(404); // csTimer can't either
    expect((await get('/api/scrambles/15p/image')).statusCode).toBe(400);
    expect((await get('/api/scrambles/nope/image?scramble=R')).statusCode).toBe(404);
  });

  it('refuses a drawing with anything in it that could run or load something', async () => {
    const evil = { ...fakeCsTimer(), image: async () => '<svg onload="alert(1)"><rect/></svg>' };
    const app = await scrambleApp({ cstimer: evil });
    const res = await app.inject({ method: 'GET', url: `/api/scrambles/15p/image?scramble=R` });
    expect(res.statusCode).toBe(404);
  });

  it('answers 404 to a scramble type the event does not have, or one that is not available yet', async () => {
    expect((await get('/api/scrambles/333?type=nope')).statusCode).toBe(404);
    expect((await get('/api/scrambles/pyram?type=pll')).statusCode).toBe(404);
    expect((await get('/api/scrambles/minx?type=mgms2l')).statusCode).toBe(404); // newer than cubr's csTimer scramblers
    expect((await get('/api/scrambles/333?type=bad%20id')).statusCode).toBe(400);
  });

  it('generates past the pool for fresh=1 with the internal token, and ignores fresh=1 from everyone else', async () => {
    await stock('444', 'pool A', 'pool B', 'pool C', 'pool D');
    const internal = await get('/api/scrambles/444?count=2&fresh=1', { token: s.config.internalToken });
    expect(internal.json()).toEqual({ event: '444', scrambles: [generated('444'), generated('444')], source: 'generated' });
    expect(await s.redis.llen(poolKey('444'))).toBe(4);

    const pooled: string[] = [];
    for (const token of [undefined, 'not-the-internal-token', s.config.internalToken.slice(0, -1), `${s.config.internalToken}x`]) {
      const res = await get('/api/scrambles/444?fresh=1', { token });
      expect(res.json().source, `token ${token}`).toBe('pool');
      pooled.push(...res.json().scrambles);
    }
    expect(pooled).toEqual(['pool A', 'pool B', 'pool C', 'pool D']);
  });

  it.each([
    ['shorter than 16 characters', 'short-token'],
    ['empty', ''],
  ])('never grants internal access when the configured token is %s', async (_what, token) => {
    const app = await scrambleApp({ internalToken: token });
    const ip = freshIp();
    await stock('skewb', 'pooled');
    const res = await app.inject({ url: '/api/scrambles/skewb?fresh=1', headers: { 'x-internal-token': token, 'x-forwarded-for': ip } });
    expect(res.json()).toEqual({ event: 'skewb', scrambles: ['pooled'], source: 'pool' });
    expect(await s.redis.get(`rl:scramble-req:${ip}`)).toBe('1'); // and the limits applied
  });

  it('allows 120 requests a minute per address, pool hits included; other addresses and internal callers are unaffected', async () => {
    const ip = freshIp();
    await s.redis.set(`rl:scramble-req:${ip}`, REQUESTS_PER_MIN - 1, 'EX', 60);
    await stock('222', 's1', 's2', 's3', 's4');
    expect((await get('/api/scrambles/222', { ip })).statusCode).toBe(200);
    const over = await get('/api/scrambles/222', { ip });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('RATE_LIMITED');
    expect((await get('/api/scrambles/222')).statusCode).toBe(200);
    expect((await get('/api/scrambles/222', { ip, token: s.config.internalToken })).statusCode).toBe(200);
  });

  it('charges the generation budget per scramble generated, not per request, and serves the pool once it is spent', async () => {
    const ip = freshIp();
    await stock('pyram', 'p1', 'p2');
    expect((await get('/api/scrambles/pyram?count=5', { ip })).statusCode).toBe(200);
    expect(await s.redis.get(`rl:scramble-gen:${ip}`)).toBe('3');
    const ttl = await s.redis.ttl(`rl:scramble-gen:${ip}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);

    await stock('pyram', 'p3', 'p4');
    expect((await get('/api/scrambles/pyram?count=2', { ip })).json().source).toBe('pool');
    expect(await s.redis.get(`rl:scramble-gen:${ip}`)).toBe('3'); // pool hits are free

    for (const count of [25, 25, GENERATED_PER_MIN - 53]) expect((await get(`/api/scrambles/pyram?count=${count}`, { ip })).statusCode).toBe(200);
    const over = await get('/api/scrambles/pyram', { ip });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('RATE_LIMITED');
    await stock('pyram', 'last one');
    expect((await get('/api/scrambles/pyram?count=3', { ip })).json()).toEqual({ event: 'pyram', scrambles: ['last one'], source: 'pool' });
  });

  it('generates directly when Redis is unavailable: no pool, and the limits fail open', async () => {
    const down = s.redis.duplicate();
    await down.quit();
    const app = await scrambleApp({ pool: new ScramblePool(down), redis: down, internalToken: '' });
    const res = await app.inject({ url: '/api/scrambles/333?count=2' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ event: '333', scrambles: [generated('333'), generated('333')], source: 'generated' });
  });

  it('answers 503 when generation times out or the queue is full, and 500 without details when a search fails', async () => {
    const backend = fakeBackend();
    backend.behave = (event) => (event === '777' ? 'hang' : event === 'clock' ? new Error('cubing.js exploded at /app/node_modules') : 0);
    const gen = new ScrambleGenerator(backend, { timeoutMs: 50, maxQueue: 3 });
    const app = await scrambleApp({ generator: gen });
    const call = (url: string) => app.inject({ url, headers: { 'x-internal-token': s.config.internalToken } });

    const timedOut = await call('/api/scrambles/777?fresh=1');
    expect(timedOut.statusCode).toBe(503);
    expect(timedOut.json().error).toEqual({ code: 'UNAVAILABLE', message: expect.stringMatching(/timed out/) });
    const busy = await call('/api/scrambles/333?count=4&fresh=1');
    expect(busy.statusCode).toBe(503);
    expect(busy.json().error).toEqual({ code: 'UNAVAILABLE', message: expect.stringMatching(/busy/) });
    const failed = await call('/api/scrambles/clock?fresh=1');
    expect(failed.statusCode).toBe(500);
    expect(failed.json().error).toEqual({ code: 'INTERNAL', message: 'Internal server error' });
    await gen.close();
  });

  describe('ScramblePool', () => {
    it('trims a pool to its target when pushing, pops the oldest first and reports the size of every pool', async () => {
      const pool = new ScramblePool(s.redis);
      expect(await pool.push('sq1', Array.from({ length: 60 }, (_, i) => `sq1 #${i}`))).toBe(50); // target 50
      expect(await pool.take('sq1', 3)).toEqual(['sq1 #0', 'sq1 #1', 'sq1 #2']);
      const sizes = await pool.sizes();
      expect(Object.keys(sizes).sort()).toEqual([...EVENT_IDS].sort());
      expect(sizes).toMatchObject({ sq1: 47, '333': 0 });
      expect(await pool.take('clock', 5)).toEqual([]);
      expect(await pool.cachedSizes()).toMatchObject({ sizes: { sq1: 47 } });
    });
  });
});
