import { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';

export type { Redis };

/**
 * Creates an ioredis client that reconnects forever with capped backoff and fails individual
 * commands fast while Redis is unavailable (so callers can degrade gracefully).
 */
export function createRedis(redisUrl: string, log?: FastifyBaseLogger): Redis {
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    retryStrategy: (times) => Math.min(times * 250, 3000),
  });
  let lastLog = 0;
  client.on('error', (err) => {
    const now = Date.now();
    if (now - lastLog > 10_000) {
      lastLog = now;
      log?.warn({ err: err.message }, 'redis error');
    }
  });
  return client;
}

/**
 * Fixed-window rate limiter. Returns true if the call is allowed. Fails open if Redis is down.
 * INCR and EXPIRE NX go out as one MULTI, so a counter can never be left without a TTL (which
 * would block the key for good). EXPIRE NX needs Redis 7.
 */
export async function rateLimit(redis: Redis, key: string, limit: number, windowSec: number): Promise<boolean> {
  try {
    const k = `rl:${key}`;
    const res = await redis.multi().incr(k).expire(k, windowSec, 'NX').exec();
    const [err, n] = res?.[0] ?? [];
    if (err || typeof n !== 'number') return true;
    return n <= limit;
  } catch {
    return true;
  }
}
