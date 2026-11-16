import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Redis } from '@cubr/common';
import { GENERATED_PER_MIN, REQUESTS_PER_MIN, registerScrambleRoutes } from '../src/routes/scrambles.js';
import type { ScrambleGenerator } from '../src/generator.js';
import type { ScramblePool } from '../src/pool.js';

const TOKEN = 'internal-token-0123456789';

/** Just enough of ioredis for rateLimit(): MULTI with INCRBY + EXPIRE. */
function fakeRedis() {
  const counts = new Map<string, number>();
  const redis = {
    multi() {
      const ops: (() => [null, number])[] = [];
      const chain = {
        incrby(k: string, w: number) {
          ops.push(() => {
            const n = (counts.get(k) ?? 0) + w;
            counts.set(k, n);
            return [null, n];
          });
          return chain;
        },
        expire() {
          ops.push(() => [null, 1]);
          return chain;
        },
        async exec() {
          return ops.map((op) => op());
        },
      };
      return chain;
    },
  };
  return { redis: redis as unknown as Redis, counts };
}

async function setup(opts: { stock?: number; poolOn?: boolean } = {}) {
  let stock = opts.stock ?? 0;
  const generateMany = vi.fn(async (_event: string, n: number) => Array.from({ length: n }, (_, i) => `gen ${i}`));
  const take = vi.fn(async (_event: string, n: number) => {
    const k = Math.min(n, stock);
    stock -= k;
    return Array.from({ length: k }, (_, i) => `pool ${i}`);
  });
  const { redis, counts } = fakeRedis();
  const app = Fastify();
  registerScrambleRoutes(app, {
    generator: { generateMany } as unknown as ScrambleGenerator,
    pool: { available: () => opts.poolOn ?? true, take } as unknown as ScramblePool,
    redis,
    internalToken: TOKEN,
  });
  await app.ready();
  const get = (url: string, internal = false) => app.inject({ method: 'GET', url, headers: internal ? { 'x-internal-token': TOKEN } : {} });
  return { app, get, generateMany, take, counts };
}

describe('GET /api/scrambles/:event limits', () => {
  it('ignores fresh=1 from the internet: served from the pool', async () => {
    const { get, generateMany } = await setup({ stock: 10 });
    const res = await get('/api/scrambles/333?count=3&fresh=1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: 'pool', scrambles: ['pool 0', 'pool 1', 'pool 2'] });
    expect(generateMany).not.toHaveBeenCalled();
  });

  it('lets internal callers use fresh=1 without any limit', async () => {
    const { get, generateMany } = await setup({ stock: 1000 });
    for (let i = 0; i < 5; i++) {
      const res = await get('/api/scrambles/444?count=25&fresh=1', true);
      expect(res.statusCode).toBe(200);
      expect(res.json().source).toBe('generated');
    }
    expect(generateMany).toHaveBeenCalledTimes(5);
  });

  it('counts generated scrambles per IP and refuses past the budget', async () => {
    const { get, generateMany } = await setup({ stock: 0 });
    const per = 25;
    const allowed = Math.floor(GENERATED_PER_MIN / per);
    for (let i = 0; i < allowed; i++) expect((await get(`/api/scrambles/444?count=${per}`)).statusCode).toBe(200);
    const over = await get(`/api/scrambles/444?count=${per}`);
    expect(over.statusCode).toBe(429);
    expect(generateMany).toHaveBeenCalledTimes(allowed);
  });

  it('hands out what the pool had once the generation budget is spent', async () => {
    const { get, counts } = await setup({ stock: 4 });
    counts.set('rl:scramble-gen:127.0.0.1', GENERATED_PER_MIN);
    const res = await get('/api/scrambles/333?count=10');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: 'pool', scrambles: ['pool 0', 'pool 1', 'pool 2', 'pool 3'] });
  });

  it('caps requests per IP, even when the pool serves them', async () => {
    const { get, counts } = await setup({ stock: 10_000 });
    counts.set('rl:scramble-req:127.0.0.1', REQUESTS_PER_MIN - 1);
    expect((await get('/api/scrambles/333')).statusCode).toBe(200);
    expect((await get('/api/scrambles/333')).statusCode).toBe(429);
    expect((await get('/api/scrambles/333', true)).statusCode).toBe(200);
  });

  it('still answers 404 for an unknown event', async () => {
    const { get } = await setup();
    expect((await get('/api/scrambles/333mbf')).statusCode).toBe(404);
  });
});
