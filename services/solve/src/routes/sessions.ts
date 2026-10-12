import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { conflict, notFound, parse } from '@cubetype/common';
import { currentUser, type RouteContext } from '../context.js';
import { SOLVE_COLUMNS, toSession, toSolve, type SessionRow, type SolveRow } from '../mapping.js';
import { ensureDefaultSession, getSession, listSessions } from '../repo.js';
import { createSessionBody, idParams, patchSessionBody } from '../schemas.js';

export function registerSessionRoutes(app: FastifyInstance, { pool, auth }: RouteContext): void {
  const authed = { onRequest: auth.requireAuth };

  app.get('/api/sessions', authed, async (req) => {
    const user = currentUser(req);
    let rows = await listSessions(pool, user.id);
    if (rows.length === 0) {
      await ensureDefaultSession(pool, user.id);
      rows = await listSessions(pool, user.id);
    }
    return { sessions: rows.map(toSession) };
  });

  // Idempotent on a client-supplied id: a retry returns the existing session (200).
  app.post('/api/sessions', authed, async (req, reply) => {
    const user = currentUser(req);
    const body = parse(createSessionBody, req.body ?? {});
    const id = body.id ?? randomUUID();
    const ins = await pool.query<SessionRow>(
      `INSERT INTO solve.sessions (id, user_id, name, event) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, name, event, created_at, updated_at, 0 AS solve_count`,
      [id, user.id, body.name, body.event],
    );
    if (ins.rowCount) return reply.code(201).send({ session: toSession(ins.rows[0]) });
    const existing = await getSession(pool, user.id, id);
    if (!existing) throw conflict('session id already in use');
    return reply.code(200).send({ session: toSession(existing) });
  });

  app.patch('/api/sessions/:id', authed, async (req) => {
    const user = currentUser(req);
    const { id } = parse(idParams, req.params);
    const { name } = parse(patchSessionBody, req.body ?? {});
    const { rows } = await pool.query<SessionRow>(
      `UPDATE solve.sessions s SET name = $3, updated_at = now() WHERE s.id = $1 AND s.user_id = $2
       RETURNING s.id, s.name, s.event, s.created_at, s.updated_at,
                 (SELECT count(*) FROM solve.solves v WHERE v.session_id = s.id) AS solve_count`,
      [id, user.id, name],
    );
    if (!rows[0]) throw notFound('session not found');
    return { session: toSession(rows[0]) };
  });

  // Cascades to the session's solves.
  app.delete('/api/sessions/:id', authed, async (req, reply) => {
    const user = currentUser(req);
    const { id } = parse(idParams, req.params);
    const { rowCount } = await pool.query('DELETE FROM solve.sessions WHERE id = $1 AND user_id = $2', [id, user.id]);
    if (!rowCount) throw notFound('session not found');
    return reply.code(204).send();
  });

  app.get('/api/sessions/:id/solves', authed, async (req) => {
    const user = currentUser(req);
    const { id } = parse(idParams, req.params);
    const { rowCount } = await pool.query('SELECT 1 FROM solve.sessions WHERE id = $1 AND user_id = $2', [id, user.id]);
    if (!rowCount) throw notFound('session not found');
    const { rows } = await pool.query<SolveRow>(
      `SELECT ${SOLVE_COLUMNS} FROM solve.solves WHERE session_id = $1 AND user_id = $2 ORDER BY created_at, id`,
      [id, user.id],
    );
    return { solves: rows.map(toSolve) };
  });
}
