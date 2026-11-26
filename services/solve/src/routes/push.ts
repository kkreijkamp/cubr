import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, isValidTimeZone, parse, rateLimit, rateLimited, unavailable } from '@cubr/common';
import type { VapidDetails } from 'web-push';
import { currentUser, type RouteContext } from '../context.js';

/** Changes to one account's reminders an hour: turning them on, off or to another time, per device. */
export const PUSH_CHANGES_PER_HOUR = 30;

// The subscription as the browser gives it (PushSubscription.toJSON()): the endpoint is a capability
// URL at the browser maker's push service, so it travels in bodies only, never in a logged URL.
const endpoint = z.string().max(1000).url().startsWith('https://');
export const pushSubscriptionBody = z
  .object({
    endpoint,
    keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}={0,2}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{16,32}={0,2}$/) }).strict(),
    /** minutes after local midnight: 600 = 10:00 */
    remindMinute: z.number().int().min(0).max(1439),
    tz: z.string().max(64).refine(isValidTimeZone, 'unknown time zone'),
  })
  .strict();
export const pushEndpointBody = z.object({ endpoint }).strict();

export function registerPushRoutes(app: FastifyInstance, { pool, redis, auth }: RouteContext, vapid: VapidDetails | null): void {
  const limit = async (userId: string) => {
    if (!(await rateLimit(redis, `solve-push:${userId}`, PUSH_CHANGES_PER_HOUR, 3600))) throw rateLimited('Too many reminder changes, try again in an hour');
  };

  /** The VAPID public key a browser subscribes with; null when reminders aren't set up here. */
  app.get('/api/solves/daily/reminders/key', async () => ({ publicKey: vapid?.publicKey ?? null }));

  /** Turns this browser's reminders on, or moves them to another time (one row per browser). */
  app.put('/api/solves/daily/reminders', { onRequest: auth.requireAuth }, async (req) => {
    const user = currentUser(req);
    if (!vapid) throw unavailable('Reminders are not set up on this server');
    const body = parse(pushSubscriptionBody, req.body ?? {});
    await limit(user.id);
    // Postgres must know the zone too (its list and the browser's can differ on old names)
    try {
      await pool.query('SELECT now() AT TIME ZONE $1', [body.tz]);
    } catch {
      throw badRequest('unknown time zone');
    }
    await pool.query(
      `INSERT INTO solve.push_subscriptions (endpoint, user_id, p256dh, auth, remind_minute, tz)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
             remind_minute = EXCLUDED.remind_minute, tz = EXCLUDED.tz, updated_at = now()`,
      [body.endpoint, user.id, body.keys.p256dh, body.keys.auth, body.remindMinute, body.tz],
    );
    return { reminder: { remindMinute: body.remindMinute, tz: body.tz } };
  });

  /** Turns this browser's reminders off (signing out does too). */
  app.delete('/api/solves/daily/reminders', { onRequest: auth.requireAuth }, async (req, reply) => {
    const user = currentUser(req);
    const body = parse(pushEndpointBody, req.body ?? {});
    await limit(user.id);
    await pool.query('DELETE FROM solve.push_subscriptions WHERE endpoint = $1 AND user_id = $2', [body.endpoint, user.id]);
    return reply.code(204).send();
  });
}
