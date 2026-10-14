import type { FastifyInstance } from 'fastify';
import { parse, requireInternal } from '@cubetype/common';
import type { RouteContext } from '../context.js';
import { internalParams, internalQuery } from '../schemas.js';

/**
 * Service-to-service routes. Not under /api, so the gateway/Ingress never routes them, and every
 * call must carry the shared X-Internal-Token (INTERNAL_API_TOKEN; not enforced while unset in
 * local development).
 * GET /internal/users/:userId/solves?event= feeds the stats service's PB recompute.
 * GET /internal/users/:userId/sessions lets read models backfill session names.
 */
export function registerInternalRoutes(app: FastifyInstance, { config, pool }: RouteContext): void {
  const internalOnly = { preHandler: requireInternal(config.internalToken, app.log) };

  app.get('/internal/users/:userId/solves', internalOnly, async (req, reply) => {
    const { userId } = parse(internalParams, req.params);
    const { event } = parse(internalQuery, req.query ?? {});
    const where = event ? 'user_id = $1 AND event = $2' : 'user_id = $1';
    // rowMode 'array' + created_at rendered by Postgres keeps 200k-row responses cheap.
    const { rows } = await pool.query<[string, string, number, string, string]>({
      text: `SELECT id, session_id, time_ms, penalty,
                    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
               FROM solve.solves WHERE ${where} ORDER BY session_id, created_at, id`,
      values: event ? [userId.toLowerCase(), event] : [userId.toLowerCase()],
      rowMode: 'array',
    });
    const solves = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      solves[i] = { id: r[0], sessionId: r[1], timeMs: r[2], penalty: r[3], createdAt: r[4] };
    }
    return reply.send({ solves });
  });

  app.get('/internal/users/:userId/sessions', internalOnly, async (req) => {
    const { userId } = parse(internalParams, req.params);
    const { rows } = await pool.query<{ id: string; name: string; event: string }>(
      'SELECT id, name, event FROM solve.sessions WHERE user_id = $1 ORDER BY created_at, id',
      [userId.toLowerCase()],
    );
    return { sessions: rows };
  });
}
