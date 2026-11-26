// What the wca service does around imports (src/dataset.ts) and its Redis cache (src/cache.ts),
// against a real Postgres and Redis: 503 until the first import, picking up an import or a
// re-import within 10 seconds under a new cache namespace, answering from Postgres while Redis is
// down, and cache-aside details (TTL, one load for concurrent misses, corrupt entries, failed loads).
// Each test drops the wca schema and builds its own app, so every test starts before any import.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';
import { createServer } from '@cubr/common';
import { describeIntegration, startTestServer, type TestServer } from '@cubr/testkit';
import { createCache } from '../src/cache.js';
import { createDataset } from '../src/dataset.js';
import { createRepo } from '../src/repo.js';
import { registerRoutes } from '../src/routes/index.js';
import { createService } from '../src/service.js';
import { fixture, importWca } from './fixture.js';

/** A Redis client whose server is gone (an outage). */
function deadRedis(): Redis {
  const dead = new Redis({ host: '127.0.0.1', port: 1, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
  dead.on('error', () => {});
  return dead;
}

describeIntegration('wca dataset and cache', () => {
  let s: TestServer;

  beforeAll(async () => {
    s = await startTestServer({ service: 'wca', infoPrefixes: [], routes: () => {} });
  });
  afterAll(async () => {
    await s?.close();
  });
  beforeEach(async () => {
    await s.pool.query('DROP SCHEMA IF EXISTS wca CASCADE');
    await s.redis.flushdb();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The wca service as src/index.ts builds it, with a fresh dataset memo. */
  async function wcaApp(redis: Redis = s.redis) {
    const dataset = createDataset(s.pool);
    const { app } = createServer(s.config, { infoPrefixes: ['/api/wca'], info: () => dataset.info() });
    await registerRoutes(app, createService({ repo: createRepo(s.pool), dataset, cache: createCache(redis, app.log) }), s.config.internalToken);
    await app.ready();
    return app;
  }

  describe('before the first import', () => {
    it('answers 503 "WCA data not loaded yet" on every data route and reports dataLoaded false', async () => {
      const app = await wcaApp();
      try {
        const urls = [
          '/api/wca/meta',
          '/api/wca/records',
          '/api/wca/rank?event=333&value=12000',
          '/api/wca/distribution?event=333',
          '/api/wca/persons?q=ada',
          '/api/wca/persons/2010AAAA01',
          '/api/wca/countries',
        ];
        for (const url of urls) {
          const res = await app.inject({ url });
          expect(res.statusCode, url).toBe(503);
          expect(res.json(), url).toEqual({ error: { code: 'UNAVAILABLE', message: 'WCA data not loaded yet' } });
        }
        expect((await app.inject({ url: '/internal/records', headers: { 'x-internal-token': s.config.internalToken } })).statusCode).toBe(503);
        expect((await app.inject({ url: '/api/wca/_info' })).json()).toMatchObject({ dataLoaded: false });
      } finally {
        await app.close();
      }
    });
  });

  describe('imports', () => {
    it('serves the first import within 10 seconds of it landing', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const app = await wcaApp();
      try {
        expect((await app.inject({ url: '/api/wca/meta' })).statusCode).toBe(503);
        await importWca(s.config.databaseUrl, fixture());
        vi.setSystemTime(Date.now() + 10_001);
        expect((await app.inject({ url: '/api/wca/meta' })).statusCode).toBe(200);
        expect((await app.inject({ url: '/api/wca/_info' })).json()).toMatchObject({
          dataLoaded: true,
          wca: { exportDate: '2026-10-14T00:00:00.000Z', exportVersion: 'v2.0.2', counts: expect.objectContaining({ persons_current: 10 }) },
        });
      } finally {
        await app.close();
      }
    });

    it('serves a re-import from a new cache namespace within 10 seconds, leaving the old entries to expire', async () => {
      await importWca(s.config.databaseUrl, fixture());
      vi.useFakeTimers({ toFake: ['Date'] });
      const app = await wcaApp();
      try {
        expect((await app.inject({ url: '/api/wca/records' })).headers['x-cache']).toBe('MISS');
        await vi.waitFor(async () => expect(await s.redis.keys('cache:wca:*:records')).toHaveLength(1));
        const [oldKey] = await s.redis.keys('cache:wca:*:records');
        expect((await app.inject({ url: '/api/wca/records' })).headers['x-cache']).toBe('HIT');

        // a week later: a new world record
        const next = fixture({ exportDate: '2026-10-21T00:00:00Z' });
        next.persons.push(['Neo Record', 'm', '2016NEOR01', 1, 'China']);
        next.ranksSingle.push([350, '2016NEOR01', '333', 1, 1, 1]);
        await importWca(s.config.databaseUrl, next);
        vi.setSystemTime(Date.now() + 10_001);
        const after = await app.inject({ url: '/api/wca/records' });
        expect(after.headers['x-cache']).toBe('MISS');
        expect(after.json().records[0].single).toMatchObject({ value: 3_500, personId: '2016NEOR01', personName: 'Neo Record' });
        expect((await app.inject({ url: '/api/wca/meta' })).json().exportDate).toBe('2026-10-21T00:00:00.000Z');
        expect(await s.redis.exists(oldKey)).toBe(1);
        await vi.waitFor(async () => expect(await s.redis.keys('cache:wca:*:records')).toHaveLength(2));
      } finally {
        await app.close();
      }
    });
  });

  describe('without Redis', () => {
    it('answers every request from Postgres', async () => {
      await importWca(s.config.databaseUrl, fixture());
      const dead = deadRedis();
      const app = await wcaApp(dead);
      try {
        for (let i = 0; i < 2; i++) {
          const res = await app.inject({ url: '/api/wca/records' });
          expect(res.statusCode).toBe(200);
          expect(res.headers['x-cache']).toBe('MISS');
        }
        expect((await app.inject({ url: '/api/wca/rank?event=333&value=12000' })).json().world).toEqual({ rank: 5, total: 9, percentile: 33.33 });
        expect((await app.inject({ url: '/api/wca/persons/2010AAAA01' })).statusCode).toBe(200);
      } finally {
        await app.close();
        dead.disconnect();
      }
    });
  });

  describe('createCache', () => {
    const cached = () => createCache(s.redis, s.app.log);

    it('stores a value under cache:wca:<version>:<key> with its TTL and serves it from there', async () => {
      const cache = cached();
      const load = vi.fn(async () => ({ n: 1 }));
      expect(await cache('v1', 'thing', 60, load)).toEqual({ value: { n: 1 }, hit: false });
      await vi.waitFor(async () => expect(await s.redis.get('cache:wca:v1:thing')).toBe('{"n":1}'));
      const ttl = await s.redis.ttl('cache:wca:v1:thing');
      expect(ttl).toBeGreaterThan(50);
      expect(ttl).toBeLessThanOrEqual(60);
      expect(await cache('v1', 'thing', 60, load)).toEqual({ value: { n: 1 }, hit: true });
      expect(load).toHaveBeenCalledTimes(1);
      expect(await cache('v2', 'thing', 60, async () => ({ n: 2 }))).toEqual({ value: { n: 2 }, hit: false });
    });

    it('runs one load for concurrent misses of the same key', async () => {
      let lookups = 0;
      // the real client, counting finished GETs: once all five are back, every caller has joined a load
      const counting = new Proxy(s.redis, {
        get(target, prop) {
          if (prop === 'get') return (key: string) => target.get(key).finally(() => lookups++);
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const cache = createCache(counting, s.app.log);
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const load = vi.fn(async () => {
        await gate;
        return { n: 42 };
      });
      const results = Promise.all(Array.from({ length: 5 }, () => cache('v1', 'shared', 60, load)));
      await vi.waitFor(() => expect(lookups).toBe(5));
      open();
      expect(await results).toEqual(Array.from({ length: 5 }, () => ({ value: { n: 42 }, hit: false })));
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('recomputes a corrupt entry and overwrites it', async () => {
      await s.redis.set('cache:wca:v1:corrupt', '{not json', 'EX', 60);
      expect(await cached()('v1', 'corrupt', 60, async () => [1, 2])).toEqual({ value: [1, 2], hit: false });
      await vi.waitFor(async () => expect(await s.redis.get('cache:wca:v1:corrupt')).toBe('[1,2]'));
    });

    it('keeps nothing from a failed load, so the next request tries again', async () => {
      const cache = cached();
      const load = vi.fn().mockRejectedValueOnce(new Error('postgres went away')).mockResolvedValueOnce('fine');
      await expect(cache('v1', 'flaky', 60, load)).rejects.toThrow('postgres went away');
      expect(await s.redis.exists('cache:wca:v1:flaky')).toBe(0);
      expect(await cache('v1', 'flaky', 60, load)).toEqual({ value: 'fine', hit: false });
      expect(load).toHaveBeenCalledTimes(2);
    });
  });
});
