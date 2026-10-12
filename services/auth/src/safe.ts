import { rateLimit, type Redis } from '@cubetype/common';

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
