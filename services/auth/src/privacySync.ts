import type { FastifyBaseLogger } from 'fastify';
import { PRIVATE_USERS_KEY, type Pool, type Redis } from '@cubr/common';

/**
 * Re-adds every private profile to the Redis set the other services read (after a Redis restart
 * without its data, for example). Only adds: removals happen solely when a user makes the profile
 * public again (PATCH /api/auth/me), so a sync racing a toggle can never expose a private profile.
 */
export async function syncPrivateUsers(pool: Pool, redis: Redis): Promise<number> {
  const { rows } = await pool.query<{ id: string }>('select id from auth.users where profile_private');
  if (rows.length > 0) await redis.sadd(PRIVATE_USERS_KEY, ...rows.map((r) => r.id.toLowerCase()));
  return rows.length;
}

/** Runs syncPrivateUsers now and every `everyMs`; returns a stop function. */
export function startPrivacySync(pool: Pool, redis: Redis, log: FastifyBaseLogger, everyMs = 10 * 60_000): () => void {
  let last = -1;
  const run = () =>
    syncPrivateUsers(pool, redis).then(
      (n) => {
        if (n !== last) log.info({ private: n }, 'private-profile set synced');
        last = n;
      },
      (err: Error) => log.warn({ err: err.message }, 'private-profile sync failed, retrying later'),
    );
  void run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
