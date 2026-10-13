import { publishEvent, newEventId, rateLimit, type Redis } from '@cubetype/common';
import type { FastifyBaseLogger } from 'fastify';

// Redis is a *soft* dependency for auth: when it is down, register/login/profile must still work.
// ioredis queues commands while reconnecting, so every Redis call on a request path is bounded
// by a short timeout and falls back to a safe default.

export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });
}

/** Rate limit that fails open (allowed) if Redis is slow or down. */
export function allow(redis: Redis, key: string, limit: number, windowSec: number): Promise<boolean> {
  return withTimeout(rateLimit(redis, key, limit, windowSec), 500, true);
}

/** Publishes a domain event; Redis problems are logged, never thrown (the request still succeeds). */
export async function publishSafely(
  redis: Redis,
  log: FastifyBaseLogger,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  const ok = await withTimeout(
    publishEvent(redis, type, { ...data, eventId: newEventId('auth') }).then(
      () => true,
      (err: Error) => {
        log.warn({ err: err.message, type }, 'failed to publish event');
        return true; // already logged
      },
    ),
    1500,
    false,
  );
  if (!ok) log.warn({ type }, 'publishing event timed out (redis unavailable?)');
}
