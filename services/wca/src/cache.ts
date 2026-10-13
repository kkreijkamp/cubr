import type { Redis } from '@cubetype/common';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Cache-aside in Redis (keys `cache:wca:<datasetVersion>:<key>`, JSON strings with a TTL).
 *
 * - The dataset version (export date + import time) is part of every key, so after a new
 *   import the service simply stops reading the old entries; they expire on their own.
 * - Fails open: if Redis is down or slow the value is computed from Postgres instead
 *   (Redis is a soft dependency of this service).
 * - Concurrent misses for the same key inside one replica share a single DB query.
 */
export interface Cached<T> {
  value: T;
  hit: boolean;
}

const GET_TIMEOUT_MS = 100; // a local GET takes < 1 ms; slower means Redis is struggling

export function createCache(redis: Redis, log: FastifyBaseLogger) {
  const inflight = new Map<string, Promise<unknown>>();

  async function get(key: string): Promise<string | null> {
    if (redis.status !== 'ready') return null; // reconnecting: don't wait for it
    try {
      return await Promise.race([
        redis.get(key),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), GET_TIMEOUT_MS)),
      ]);
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'cache get failed');
      return null;
    }
  }

  return async function cached<T>(version: string, key: string, ttlSec: number, load: () => Promise<T>): Promise<Cached<T>> {
    const fullKey = `cache:wca:${version}:${key}`;
    const hit = await get(fullKey);
    if (hit !== null) {
      try {
        return { value: JSON.parse(hit) as T, hit: true };
      } catch {
        // corrupt entry: fall through and overwrite it
      }
    }
    let pending = inflight.get(fullKey) as Promise<T> | undefined;
    if (!pending) {
      pending = load().finally(() => inflight.delete(fullKey));
      inflight.set(fullKey, pending);
      pending
        .then((value) => {
          if (redis.status === 'ready') {
            redis.set(fullKey, JSON.stringify(value), 'EX', ttlSec).catch(() => {});
          }
        })
        .catch(() => {});
    }
    return { value: await pending, hit: false };
  };
}

export type CacheFn = ReturnType<typeof createCache>;
