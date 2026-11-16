// rateLimit() against a real Redis 7 (@cubr/testkit): the fixed window, EXPIRE NX, weights, and
// failing open when Redis can't answer.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestRedis, describeIntegration } from '@cubr/testkit';
import { rateLimit, type Redis } from '../src/redis.js';

describeIntegration('rateLimit', () => {
  let redis: Redis;
  const key = () => `test:${randomUUID()}`;

  beforeAll(async () => {
    redis = await createTestRedis();
  });
  afterAll(() => {
    redis?.disconnect();
  });

  it('allows `limit` calls per window, refuses the rest and keeps the counter only for the window', async () => {
    const k = key();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rateLimit(redis, k, 3, 60));
    expect(results).toEqual([true, true, true, false]);
    expect(await redis.get(`rl:${k}`)).toBe('4');
    const ttl = await redis.ttl(`rl:${k}`);
    expect(ttl).toBeGreaterThan(55);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('does not stretch a running window, and starts a new one once it has ended', async () => {
    const k = key();
    expect(await rateLimit(redis, k, 1, 60)).toBe(true);
    await redis.pexpire(`rl:${k}`, 300); // the window is nearly over
    expect(await rateLimit(redis, k, 1, 60)).toBe(false);
    expect(await redis.pttl(`rl:${k}`)).toBeLessThanOrEqual(300);
    await vi.waitFor(async () => expect(await redis.exists(`rl:${k}`)).toBe(0), { timeout: 3000, interval: 20 });
    expect(await rateLimit(redis, k, 1, 60)).toBe(true);
    expect(await redis.get(`rl:${k}`)).toBe('1');
  });

  it('gives a counter left without a TTL one, instead of blocking that key for good', async () => {
    const k = key();
    await redis.set(`rl:${k}`, '25');
    expect(await rateLimit(redis, k, 20, 3600)).toBe(false);
    expect(await redis.ttl(`rl:${k}`)).toBeGreaterThan(3500);
  });

  it('counts a weighted call as several', async () => {
    const k = key();
    expect(await rateLimit(redis, k, 60, 60, 25)).toBe(true);
    expect(await rateLimit(redis, k, 60, 60, 35)).toBe(true); // exactly 60
    expect(await rateLimit(redis, k, 60, 60, 1)).toBe(false);
    expect(await redis.get(`rl:${k}`)).toBe('61');
  });

  it('keeps separate keys apart', async () => {
    const [a, b] = [key(), key()];
    expect(await rateLimit(redis, a, 1, 60)).toBe(true);
    expect(await rateLimit(redis, a, 1, 60)).toBe(false);
    expect(await rateLimit(redis, b, 1, 60)).toBe(true);
  });

  it('fails open when the connection is closed or the counter key holds something else', async () => {
    const closed = redis.duplicate();
    await closed.quit();
    expect(await rateLimit(closed, key(), 1, 60)).toBe(true);
    expect(await rateLimit(closed, key(), 1, 60)).toBe(true);

    const k = key();
    await redis.rpush(`rl:${k}`, 'not a counter');
    expect(await rateLimit(redis, k, 1, 60)).toBe(true);
    expect(await rateLimit(redis, k, 1, 60)).toBe(true);
  });
});
