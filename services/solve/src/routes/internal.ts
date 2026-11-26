import type { FastifyInstance } from 'fastify';
import { parse, requireInternal } from '@cubr/common';
import type { RouteContext } from '../context.js';
import { internalParams, internalQuery, SOLVES_CURSOR_RE } from '../schemas.js';

/**
 * Service-to-service routes. Not under /api, so the gateway/Ingress never routes them, and every
 * call must carry the shared X-Internal-Token (INTERNAL_API_TOKEN; not enforced while unset in
 * local development).
 * GET /internal/users/:userId/solves?event= feeds the stats service's PB recompute (a practice
 * session's solves carry practice: true, so they count for no PB).
 * GET /internal/users/:userId/sessions lets read models backfill session names.
 */
export function registerInternalRoutes(app: FastifyInstance, { config, pool }: RouteContext): void {
  const internalOnly = { preHandler: requireInternal(config.internalToken, app.log) };

  app.get('/internal/users/:userId/solves', internalOnly, async (req, reply) => {
    const { userId } = parse(internalParams, req.params);
    const { event, limit, after } = parse(internalQuery, req.query ?? {});
    // In pages when asked (stats does: a 250k-solve list in one go ran its 192 MB heap out), each
    // continuing after the previous page's last row; `next` is null on the last page.
    const values: unknown[] = [userId.toLowerCase()];
    let where = 'v.user_id = $1';
    if (event) where += ` AND v.event = $${values.push(event)}`;
    if (after) {
      const [, sessionId, at, id] = SOLVES_CURSOR_RE.exec(after)!;
      const s = values.push(sessionId);
      const t = values.push(at);
      const i = values.push(id);
      where += ` AND (v.session_id, v.created_at, v.id) > ($${s}::uuid, $${t}::timestamp AT TIME ZONE 'UTC', $${i}::uuid)`;
    }
    // rowMode 'array' + created_at rendered by Postgres keeps 200k-row responses cheap.
    const { rows } = await pool.query<[string, string, number, string, string, boolean, string]>({
      text: `SELECT v.id, v.session_id, v.time_ms, v.penalty,
                    to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), s.practice,
                    to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
               FROM solve.solves v JOIN solve.sessions s ON s.id = v.session_id
              WHERE ${where} ORDER BY v.session_id, v.created_at, v.id${limit ? ` LIMIT ${limit}` : ''}`,
      values,
      rowMode: 'array',
    });
    const solves = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const solve = { id: r[0], sessionId: r[1], timeMs: r[2], penalty: r[3], createdAt: r[4] };
      solves[i] = r[5] ? { ...solve, practice: true } : solve;
    }
    const last = rows[rows.length - 1];
    const next = limit && rows.length === limit ? `${last[1]}_${last[6]}_${last[0]}` : null;
    return reply.send({ solves, next });
  });

  app.get('/internal/users/:userId/sessions', internalOnly, async (req) => {
    const { userId } = parse(internalParams, req.params);
    const { rows } = await pool.query<{ id: string; name: string; event: string; practice: boolean }>(
      'SELECT id, name, event, practice FROM solve.sessions WHERE user_id = $1 ORDER BY created_at, id',
      [userId.toLowerCase()],
    );
    return { sessions: rows };
  });
}
