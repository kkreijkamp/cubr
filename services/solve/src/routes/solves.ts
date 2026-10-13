import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { conflict, notFound, parse, withTx } from '@cubetype/common';
import { currentUser, FK_VIOLATION, pgCode, tzFrom, type RouteContext } from '../context.js';
import { SOLVE_COLUMNS, toSolve, type Solve, type SolveRow } from '../mapping.js';
import { enqueue } from '../outbox.js';
import { sessionRolling, solveDeletedPayload, solveEventPayload } from '../repo.js';
import type { Rolling } from '../rolling.js';
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
   * errors, and ON CONFLICT DO NOTHING guarantees one row and one event however often it retries.
   */
  app.post('/api/solves', authed, async (req, reply) => {
    const user = currentUser(req);
    const body = parse(createSolveBody, req.body ?? {});
    const tz = tzFrom(req);
    const createdAt = resolveCreatedAt(body.createdAt);
    const id = body.id ?? randomUUID();
    const source = body.source ?? 'timer';

    const result = await withTx(pool, async (client) => {
      // Row lock on the session serialises concurrent writes to one session, so every
      // solve.created carries a rolling ao5/ao12 that includes all earlier solves.
      const session = await client.query<{ event: string }>(
        'SELECT event FROM solve.sessions WHERE id = $1 AND user_id = $2 FOR NO KEY UPDATE',
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
        // Retry of an existing id: same user → 200 with the stored solve (no new event).
        const existing = await client.query<SolveRow>(`SELECT ${SOLVE_COLUMNS} FROM solve.solves WHERE id = $1`, [id]);
        const row = existing.rows[0];
        if (!row || row.user_id !== user.id) throw conflict('solve id already in use');
        return { created: false, row, rolling: await sessionRolling(client, row.session_id) };
      }

      const row = ins.rows[0];
      const rolling = await sessionRolling(client, row.session_id);
      await enqueue(client, 'solve.created', solveEventPayload(user, row, tz, rolling));
      return { created: true, row, rolling };
    }).catch(mapPgError);

    return reply.code(result.created ? 201 : 200).send({ solve: toSolve(result.row), rolling: result.rolling });
  });

  app.patch('/api/solves/:id', authed, async (req) => {
    const user = currentUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(patchSolveBody, req.body ?? {});
    const tz = tzFrom(req);

    return withTx(pool, async (client): Promise<{ solve: Solve; rolling?: Rolling }> => {
      const cur = await client.query<SolveRow>(
        `SELECT ${SOLVE_COLUMNS} FROM solve.solves WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [id, user.id],
      );
      const before = cur.rows[0];
      if (!before) throw notFound('solve not found');
      const penalty = body.penalty ?? before.penalty;
      const comment = body.comment !== undefined ? body.comment : before.comment;
      // No-op edits don't emit events (consumers recompute the event on every solve.updated).
      if (penalty === before.penalty && comment === before.comment) return { solve: toSolve(before) };

      const upd = await client.query<SolveRow>(
        `UPDATE solve.solves SET penalty = $3, comment = $4 WHERE id = $1 AND user_id = $2 RETURNING ${SOLVE_COLUMNS}`,
        [id, user.id, penalty, comment],
      );
      const row = upd.rows[0];
      const rolling = await sessionRolling(client, row.session_id);
      await enqueue(client, 'solve.updated', solveEventPayload(user, row, tz, rolling));
      return { solve: toSolve(row), rolling };
    });
  });

  app.delete('/api/solves/:id', authed, async (req, reply) => {
    const user = currentUser(req);
    const { id } = parse(idParams, req.params);
    const tz = tzFrom(req);
    await withTx(pool, async (client) => {
      const { rows } = await client.query<SolveRow>(
        `DELETE FROM solve.solves WHERE id = $1 AND user_id = $2 RETURNING ${SOLVE_COLUMNS}`,
        [id, user.id],
      );
      if (!rows[0]) throw notFound('solve not found');
      await enqueue(client, 'solve.deleted', solveDeletedPayload(user, rows[0], tz));
    });
    return reply.code(204).send();
  });
}
