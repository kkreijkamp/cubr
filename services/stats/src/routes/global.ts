import { dayKey, type Pool, type Redis } from '@cubetype/common';
import type { FastifyInstance } from 'fastify';

const CACHE_KEY = 'cache:stats:global';
const CACHE_TTL_SEC = 10;
const REDIS_TIMEOUT_MS = 300;

/** Redis call that resolves to `fallback` instead of failing or hanging (cache is optional). */
async function soft<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await Promise.race([op(), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), REDIS_TIMEOUT_MS))]);
  } catch {
    return fallback;
  }
}

export async function registerGlobalRoutes(app: FastifyInstance, pool: Pool, redis: Redis): Promise<void> {
  // Site-wide counters for the landing / status page. Cache-aside in Redis for 10 s (fails open).
  app.get('/api/stats/global', async (_req, reply) => {
    const cached = await soft(() => redis.get(CACHE_KEY), null);
    if (cached) {
      reply.header('X-Cache', 'hit');
      return JSON.parse(cached);
    }
    const today = dayKey(new Date(), 'UTC');
    const [totals, todayRes] = await Promise.all([
      pool.query<{ users: number; solves: number; total_ms: number }>(
        `SELECT count(*)::int AS users, coalesce(sum(solves), 0)::bigint AS solves, coalesce(sum(total_ms), 0)::bigint AS total_ms
           FROM stats.user_totals`,
      ),
      pool.query<{ solves: number; users: number }>(
        `SELECT coalesce(sum(solves), 0)::bigint AS solves, count(DISTINCT user_id)::int AS users
           FROM stats.daily_activity WHERE day = $1`,
        [today],
      ),
    ]);
    const body = {
      users: totals.rows[0].users,
      solves: totals.rows[0].solves,
      totalMs: totals.rows[0].total_ms,
      solvesToday: todayRes.rows[0].solves,
      activeUsersToday: todayRes.rows[0].users,
      day: today,
      computedAt: new Date().toISOString(),
    };
    await soft(() => redis.set(CACHE_KEY, JSON.stringify(body), 'EX', CACHE_TTL_SEC), null);
    reply.header('X-Cache', 'miss');
    return body;
  });
}
