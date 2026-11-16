import { describe, expect, it } from 'vitest';
import { rateLimit, type Redis } from '../src/redis.js';

/** Just enough of ioredis' MULTI for rateLimit: INCRBY and EXPIRE NX on an in-memory store. */
function fakeRedis(opts: { failExec?: boolean } = {}) {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  const redis = {
    multi() {
      const ops: Array<() => [Error | null, unknown]> = [];
      const tx = {
        incrby(key: string, by: number) {
          ops.push(() => {
            const n = (counts.get(key) ?? 0) + by;
            counts.set(key, n);
            return [null, n];
          });
          return tx;
        },
        expire(key: string, seconds: number, mode?: 'NX') {
          ops.push(() => {
            if (mode === 'NX' && ttls.has(key)) return [null, 0];
            ttls.set(key, seconds);
            return [null, 1];
          });
          return tx;
        },
        async exec() {
          if (opts.failExec) throw new Error('connection is closed');
          return ops.map((op) => op());
        },
      };
      return tx;
    },
  };
  return { redis: redis as unknown as Redis, counts, ttls };
}

describe('rateLimit', () => {
  it('allows up to the limit within a window', async () => {
    const { redis, counts, ttls } = fakeRedis();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rateLimit(redis, 'login:1.2.3.4', 3, 60));
    expect(results).toEqual([true, true, true, false]);
    expect(counts.get('rl:login:1.2.3.4')).toBe(4);
    expect(ttls.get('rl:login:1.2.3.4')).toBe(60);
  });

  it('gives a counter without a TTL one instead of blocking it for good', async () => {
    const { redis, counts, ttls } = fakeRedis();
    counts.set('rl:register:5.6.7.8', 25); // e.g. left behind by a lost EXPIRE
    expect(await rateLimit(redis, 'register:5.6.7.8', 20, 3600)).toBe(false);
    expect(ttls.get('rl:register:5.6.7.8')).toBe(3600);
  });

  it('does not extend a running window', async () => {
    const { redis, ttls } = fakeRedis();
    await rateLimit(redis, 'k', 10, 60);
    ttls.set('rl:k', 12); // 12 s left
    await rateLimit(redis, 'k', 10, 60);
    expect(ttls.get('rl:k')).toBe(12);
  });

  it('counts a weighted call as several', async () => {
    const { redis, counts } = fakeRedis();
    expect(await rateLimit(redis, 'gen:1.2.3.4', 60, 60, 25)).toBe(true);
    expect(await rateLimit(redis, 'gen:1.2.3.4', 60, 60, 25)).toBe(true);
    expect(await rateLimit(redis, 'gen:1.2.3.4', 60, 60, 25)).toBe(false);
    expect(counts.get('rl:gen:1.2.3.4')).toBe(75);
  });

  it('fails open when Redis is unavailable', async () => {
    const { redis } = fakeRedis({ failExec: true });
    expect(await rateLimit(redis, 'k', 1, 60)).toBe(true);
  });
});
