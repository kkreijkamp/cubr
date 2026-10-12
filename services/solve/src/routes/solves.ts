import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { conflict, notFound, parse, withTx } from '@cubetype/common';
import { currentUser, FK_VIOLATION, pgCode, type RouteContext } from '../context.js';
import { SOLVE_COLUMNS, toSolve, type SolveRow } from '../mapping.js';
import { createSolveBody, idParams, patchSolveBody, resolveCreatedAt } from '../schemas.js';

/** Translates constraint violations raised inside a solve transaction into API errors. */
function mapPgError(err: unknown): never {
  if (pgCode(err) === FK_VIOLATION) throw notFound('session not found'); // deleted concurrently
  throw err;
}

export function registerSolveRoutes(app: FastifyInstance, { pool, auth }: RouteContext): void {
  const authed = { onRequest: auth.requireAuth };

  /**
   * Create a solve. Idempotent on `id`: the web client retries with the same id after network
   * errors, and ON CONFLICT DO NOTHING guarantees one row however often it retries.
   */
  app.post('/api/solves', authed, async (req, reply) => {
    const user = currentUser(req);
    const body = parse(createSolveBody, req.body ?? {});
    const createdAt = resolveCreatedAt(body.createdAt);
    const id = body.id ?? randomUUID();
    const source = body.source ?? 'timer';

    const result = await withTx(pool, async (client) => {
      const session = await client.query<{ event: string }>(
        'SELECT event FROM solve.sessions WHERE id = $1 AND user_id = $2',
        [body.sessionId, user.id],
      );
      if (!session.rows[0]) throw notFound('session not found');
      const event = session.rows[0].event; // a solve always belongs to its session's event

      const ins = await client.query<SolveRow>(
        `INSERT INTO solve.solves
           (id, user_id, session_id, event, time_ms, penalty, scramble, comment, source, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO NOTHING
         RETURNING ${SOLVE_COLUMNS}`,
        [id, user.id, body.sessionId, event, body.timeMs, body.penalty, body.scramble, body.comment ?? null, source, createdAt],
      );

      if (!ins.rows[0]) {
        // Retry of an existing id: same user → 200 with the stored solve.
        const existing = await client.query<SolveRow>(`SELECT ${SOLVE_COLUMNS} FROM solve.solves WHERE id = $1`, [id]);
        const row = existing.rows[0];
        if (!row || row.user_id !== user.id) throw conflict('solve id already in use');
        return { created: false, row };
      }
      return { created: true, row: ins.rows[0] };
    }).catch(mapPgError);

    return reply.code(result.created ? 201 : 200).send({ solve: toSolve(result.row) });
  });

  app.patch('/api/solves/:id', authed, async (req) => {
    const user = currentUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(patchSolveBody, req.body ?? {});

    return withTx(pool, async (client) => {
      const cur = await client.query<SolveRow>(
        `SELECT ${SOLVE_COLUMNS} FROM solve.solves WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [id, user.id],
      );
      const before = cur.rows[0];
      if (!before) throw notFound('solve not found');
      const penalty = body.penalty ?? before.penalty;
      const comment = body.comment !== undefined ? body.comment : before.comment;
      if (penalty === before.penalty && comment === before.comment) return { solve: toSolve(before) };

      const upd = await client.query<SolveRow>(
        `UPDATE solve.solves SET penalty = $3, comment = $4 WHERE id = $1 AND user_id = $2 RETURNING ${SOLVE_COLUMNS}`,
        [id, user.id, penalty, comment],
      );
      return { solve: toSolve(upd.rows[0]) };
    });
  });

  app.delete('/api/solves/:id', authed, async (req, reply) => {
    const user = currentUser(req);
    const { id } = parse(idParams, req.params);
    const { rowCount } = await pool.query('DELETE FROM solve.solves WHERE id = $1 AND user_id = $2', [id, user.id]);
    if (!rowCount) throw notFound('solve not found');
    return reply.code(204).send();
  });
}
