import type { FastifyBaseLogger } from 'fastify';
import { sendNotification, WebPushError, type PushSubscription, type SendResult, type VapidDetails } from 'web-push';
import type { Pool, Redis } from '@cubr/common';

/**
 * Daily-challenge reminders (Web Push). Each browser that turned them on has a row in
 * solve.push_subscriptions with the minute of the day it wants one, in its own time zone (10:00 unless
 * changed). Once a minute, one instance (a Redis lock) finds the rows whose time has come today and sends
 * each a notification, unless the person has already played today's challenge (an attempt or a started
 * one, any event). A subscription the push service says is gone is deleted; any other failure gives up
 * for the day (reminders are best effort). Without VAPID keys (the local stack, CI) none are sent.
 */

/** The VAPID keys from the environment, or null when reminders aren't set up. */
export function vapidFromEnv(env: NodeJS.ProcessEnv = process.env): VapidDetails | null {
  const publicKey = env.VAPID_PUBLIC_KEY ?? '';
  const privateKey = env.VAPID_PRIVATE_KEY ?? '';
  if (!publicKey || !privateKey) return null;
  return { subject: env.VAPID_SUBJECT || 'mailto:hello@cubr.dev', publicKey, privateKey };
}

/** A reminder comes this long after its time at the latest (say the service was down at 10:00). */
export const LATE_MINUTES = 180;
/** The push service keeps an undelivered reminder this long (a phone that is off), then drops it. */
export const REMINDER_TTL_S = 3 * 3600;
const TICK_MS = 60_000;
const BATCH = 500;

export const REMINDER = { title: 'cubr: daily challenge', body: "today's five scrambles are up - one try each", url: '/daily' };

interface DueRow {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  local_day: string;
  played: boolean;
}

/**
 * The subscriptions whose reminder time has come on their local day `at` (and not more than
 * LATE_MINUTES ago), not yet reminded that day, with whether the person has played today's challenge
 * (the challenge's day is UTC's).
 */
export async function dueReminders(pool: Pool, at: Date, limit = BATCH): Promise<DueRow[]> {
  const { rows } = await pool.query<DueRow>(
    `WITH p AS (
       SELECT s.*, ($1::timestamptz AT TIME ZONE s.tz) AS local
         FROM solve.push_subscriptions s
     )
     SELECT p.endpoint, p.user_id, p.p256dh, p.auth, p.local::date::text AS local_day,
            EXISTS (SELECT 1 FROM solve.daily_attempts a WHERE a.user_id = p.user_id AND a.daily_date = ($1::timestamptz AT TIME ZONE 'UTC')::date)
         OR EXISTS (SELECT 1 FROM solve.daily_starts d WHERE d.user_id = p.user_id AND d.daily_date = ($1::timestamptz AT TIME ZONE 'UTC')::date) AS played
       FROM p
      WHERE (p.last_day IS NULL OR p.last_day < p.local::date)
        AND extract(hour FROM p.local) * 60 + extract(minute FROM p.local) >= p.remind_minute
        AND extract(hour FROM p.local) * 60 + extract(minute FROM p.local) < p.remind_minute + $2
      ORDER BY p.endpoint
      LIMIT $3`,
    [at.toISOString(), LATE_MINUTES, limit],
  );
  return rows;
}

export type Send = (subscription: PushSubscription, payload: string, options: Parameters<typeof sendNotification>[2]) => Promise<SendResult>;

/** One pass: sends what's due at `at`. Returns what happened, for the log and the tests. */
export async function remindOnce(
  deps: { pool: Pool; vapid: VapidDetails; log: FastifyBaseLogger; send?: Send },
  at: Date,
): Promise<{ sent: number; played: number; gone: number; failed: number }> {
  const send = deps.send ?? sendNotification;
  const out = { sent: 0, played: 0, gone: 0, failed: 0 };
  const done = (endpoint: string, day: string) =>
    deps.pool.query('UPDATE solve.push_subscriptions SET last_day = $2::date WHERE endpoint = $1', [endpoint, day]);
  for (const row of await dueReminders(deps.pool, at)) {
    if (row.played) {
      out.played++;
      await done(row.endpoint, row.local_day);
      continue;
    }
    try {
      await send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify(REMINDER), {
        TTL: REMINDER_TTL_S,
        urgency: 'normal',
        vapidDetails: deps.vapid,
        timeout: 10_000,
      });
      out.sent++;
      await done(row.endpoint, row.local_day);
    } catch (e) {
      const status = e instanceof WebPushError ? e.statusCode : (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // unsubscribed in the browser, or expired: the push service won't take it again
        out.gone++;
        await deps.pool.query('DELETE FROM solve.push_subscriptions WHERE endpoint = $1', [row.endpoint]);
      } else {
        out.failed++;
        deps.log.warn({ status, err: (e as Error).message }, 'daily reminder not sent');
        await done(row.endpoint, row.local_day);
      }
    }
  }
  return out;
}

/** Starts the once-a-minute pass (one instance at a time, through a Redis lock); stop() ends it. */
export function startReminders(deps: { pool: Pool; redis: Redis; vapid: VapidDetails | null; log: FastifyBaseLogger; send?: Send }): { stop(): void } {
  if (!deps.vapid) {
    deps.log.info('daily reminders off: no VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY');
    return { stop: () => undefined };
  }
  const vapid = deps.vapid;
  deps.log.info('daily reminders on: a pass every minute');
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if ((await deps.redis.set('solve:reminders:lock', '1', 'PX', TICK_MS - 5_000, 'NX')) !== 'OK') return;
      const r = await remindOnce({ ...deps, vapid }, new Date());
      if (r.sent || r.gone || r.failed) deps.log.info(r, 'daily reminders');
    } catch (e) {
      deps.log.warn({ err: (e as Error).message }, 'daily reminders pass failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
