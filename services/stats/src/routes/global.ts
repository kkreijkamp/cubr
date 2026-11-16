import { dayKey, type Pool, type Redis } from '@cubr/common';
import type { FastifyInstance } from 'fastify';

export const CACHE_KEY = 'cache:stats:global';
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
  // Site-wide counters. Cache-aside in Redis for 10 s (fails open).
  app.get('/api/stats/global', async (_req, reply) => {
    const cached = await soft(() => redis.get(CACHE_KEY), null);
    if (cached) {
      reply.header('X-Cache', 'hit');
      return JSON.parse(cached);
    }
    const today = dayKey(new Date(), 'UTC');
    // "today" = the UTC day (SPEC 9.4). Not daily_activity: its days are in each solver's timezone.
    const from = new Date(`${today}T00:00:00.000Z`);
    const to = new Date(from.getTime() + 86_400_000);
    const [totals, todayRes] = await Promise.all([
      pool.query<{ users: number; solves: number; total_ms: number }>(
        `SELECT count(*)::int AS users, coalesce(sum(solves), 0)::bigint AS solves, coalesce(sum(total_ms), 0)::bigint AS total_ms
           FROM stats.user_totals`,
      ),
      pool.query<{ solves: number; users: number }>(
        `SELECT count(*)::bigint AS solves, count(DISTINCT user_id)::int AS users
           FROM stats.solve_ledger WHERE NOT deleted AND created_at >= $1 AND created_at < $2`,
        [from, to],
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
