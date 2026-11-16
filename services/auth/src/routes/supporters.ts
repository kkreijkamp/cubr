import type { FastifyInstance } from 'fastify';
import { badRequest, forbidden, rateLimited, unavailable } from '@cubr/common';
import type { Deps } from './index.js';
import { allow } from '../safe.js';
import { kofiTokenMatches, parseKofiData, SUPPORTERS_LIST_MAX } from '../supporters.js';

/**
 * Ko-fi supporters: the webhook Ko-fi calls after a payment, and the public list on the about page.
 * KOFI_VERIFICATION_TOKEN (auth container only) must be set, or the webhook refuses everything.
 */
export async function registerSupporterRoutes(app: FastifyInstance, { pool, redis }: Deps) {
  const token = process.env.KOFI_VERIFICATION_TOKEN ?? '';
  if (!token) app.log.warn('KOFI_VERIFICATION_TOKEN is not set: the Ko-fi webhook refuses every request');

  // POST /api/supporters/kofi - form-encoded `data` (JSON). Encapsulated so the form parser and
  // its small body limit apply to this route only.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });
    scope.post('/api/supporters/kofi', { bodyLimit: 64 * 1024 }, async (req) => {
      if (!(await allow(redis, `kofi:${req.ip}`, 60, 60))) throw rateLimited('Too many requests');
      if (!token) throw unavailable('The Ko-fi webhook is not configured');
      const payload = parseKofiData((req.body as Record<string, unknown> | undefined)?.data);
      if (!payload) throw badRequest('data: expected Ko-fi webhook JSON');
      if (!kofiTokenMatches(token, payload.token)) {
        req.log.warn('ko-fi webhook with a wrong verification token');
        throw forbidden('Wrong verification token');
      }
      const r = payload.record;
      // ON CONFLICT: Ko-fi retries the same message_id until it sees a 200
      const ins = await pool.query(
        `insert into auth.supporters (message_id, kind, name, is_public, is_subscription, tier, received_at)
         values ($1, $2, $3, $4, $5, $6, $7) on conflict (message_id) do nothing`,
        [r.messageId, r.kind, r.name, r.isPublic, r.isSubscription, r.tier, r.receivedAt],
      );
      req.log.info({ kind: r.kind, public: r.isPublic, subscription: r.isSubscription, duplicate: ins.rowCount === 0 }, 'ko-fi support received');
      return { ok: true };
    });
  });

  // GET /api/supporters -> {supporters: [{name, member}]}: public names, most recent first, one
  // entry per name; member = a subscription payment in the last 35 days.
  app.get('/api/supporters', async (_req, reply) => {
    const { rows } = await pool.query<{ name: string; member: boolean }>(
      `select (array_agg(name order by received_at desc))[1] as name,
              coalesce(bool_or(is_subscription and received_at > now() - interval '35 days'), false) as member
         from auth.supporters
        where is_public and not hidden and name is not null
        group by lower(name)
        order by max(received_at) desc
        limit $1`,
      [SUPPORTERS_LIST_MAX],
    );
    reply.header('cache-control', 'public, max-age=60');
    return { supporters: rows };
  });
}
