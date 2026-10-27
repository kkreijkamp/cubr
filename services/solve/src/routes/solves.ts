import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { conflict, notFound, parse, withTx, type AuthUser, type PoolClient } from '@cubetype/common';
import type { Penalty } from '@cubetype/cubestats';
import { currentUser, FK_VIOLATION, pgCode, pgConstraint, tzFrom, UNIQUE_VIOLATION, type RouteContext } from '../context.js';
import { SOLVE_COLUMNS, toSolve, type Solve, type SolveRow } from '../mapping.js';
import { enqueue } from '../outbox.js';
import { sessionRolling, solveDeletedPayload, solveEventPayload } from '../repo.js';
import { dailyOverview, dailyResult, type Rolling } from '../rolling.js';
import { assertDailyAllowed, createSolveBody, dailyQuery, idParams, patchSolveBody, resolveCreatedAt, utcDay } from '../schemas.js';

/** Translates constraint violations raised inside a solve transaction into API errors. */
function mapPgError(err: unknown): never {
  if (pgCode(err) === UNIQUE_VIOLATION && pgConstraint(err) === 'solves_daily_unique') {
    throw conflict('daily attempt already recorded');
  }
  if (pgCode(err) === FK_VIOLATION) throw notFound('session not found'); // deleted concurrently
  throw err;
}

/**
 * Records the official attempt of a daily solve (one per user/date/event/index, kept as submitted).
 * An index that was used before stays used even if its solve was deleted since -> 409, so a known
 * scramble can't be redone; only the same solve id (a retry) may hold it again. Returns true for a
 * new attempt.
 */
async function recordDailyAttempt(client: PoolClient, user: AuthUser, row: SolveRow): Promise<boolean> {
  const key = [user.id, row.daily_date, row.event, row.daily_index];
  const ins = await client.query(
    `INSERT INTO solve.daily_attempts (user_id, daily_date, event, daily_index, solve_id, time_ms, penalty)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [...key, row.id, row.time_ms, row.penalty],
  );
  if (ins.rowCount) return true;
  const { rows } = await client.query<{ solve_id: string }>(
    'SELECT solve_id FROM solve.daily_attempts WHERE user_id = $1 AND daily_date = $2 AND event = $3 AND daily_index = $4',
    key,
  );
  if (rows[0]?.solve_id !== row.id) throw conflict('daily attempt already recorded');
  return false;
}

/**
 * After a new daily attempt: if the user now has all 5 attempts for (date, event), queue
 * `daily.completed` with the official ao5 from the attempts as submitted (same transaction, so it
 * is emitted exactly once; later edits or deletes of the solves don't change it).
 */
async function completeDailyIfDone(client: PoolClient, user: AuthUser, date: string, event: string, tz: string): Promise<void> {
  const { rows } = await client.query<{ time_ms: number; penalty: Penalty }>(
    `SELECT time_ms, penalty FROM solve.daily_attempts
      WHERE user_id = $1 AND daily_date = $2 AND event = $3 ORDER BY daily_index`,
    [user.id, date, event],
  );
  if (rows.length < 5) return;
  const { ao5, times } = dailyResult(rows.map((r) => ({ timeMs: r.time_ms, penalty: r.penalty })));
  await enqueue(client, 'daily.completed', { userId: user.id, username: user.username, date, event, ao5, times, tz });
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
    const daily = body.daily;
    const source = daily ? 'daily' : (body.source ?? 'timer');

    const result = await withTx(pool, async (client) => {
      // Row lock on the session serialises concurrent writes to one session, so every
      // solve.created carries a rolling ao5/ao12 that includes all earlier solves.
      const session = await client.query<{ event: string; name: string; practice: boolean }>(
        'SELECT event, name, practice FROM solve.sessions WHERE id = $1 AND user_id = $2 FOR NO KEY UPDATE',
        [body.sessionId, user.id],
      );
      if (!session.rows[0]) throw notFound('session not found');
      const event = session.rows[0].event; // a solve always belongs to its session's event

      if (daily) {
        assertDailyAllowed(daily.date, event);
        // Serialise attempts of one (user, date, event) so the "all 5 done" check can't race.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`solve:daily:${user.id}:${daily.date}:${event}`]);
      }

      const ins = await client.query<SolveRow>(
        `INSERT INTO solve.solves
           (id, user_id, session_id, event, time_ms, penalty, scramble, comment, source, daily_date, daily_index, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO NOTHING
         RETURNING ${SOLVE_COLUMNS}`,
        [id, user.id, body.sessionId, event, body.timeMs, body.penalty, body.scramble, body.comment ?? null, source,
          daily?.date ?? null, daily?.index ?? null, createdAt],
      );

      if (!ins.rows[0]) {
        // Retry of an existing id: same user -> 200 with the stored solve (no new event).
        const existing = await client.query<SolveRow>(`SELECT ${SOLVE_COLUMNS} FROM solve.solves WHERE id = $1`, [id]);
        const row = existing.rows[0];
        if (!row || row.user_id !== user.id) throw conflict('solve id already in use');
        return { created: false, row, rolling: await sessionRolling(client, row.session_id) };
      }

      const row = ins.rows[0];
      const newAttempt = daily ? await recordDailyAttempt(client, user, row) : false;
      const rolling = await sessionRolling(client, row.session_id);
      // sessionName lets read models (stats) label sessions without querying this service;
      // practice keeps the solve off personal bests (stats) and the boards (leaderboard)
      await enqueue(client, 'solve.created', {
        ...solveEventPayload(user, row, tz, rolling), sessionName: session.rows[0].name, practice: session.rows[0].practice,
      });
      if (daily && newAttempt) await completeDailyIfDone(client, user, daily.date, event, tz);
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

  // The user's daily-challenge solves for one UTC day, grouped by event, with the official ao5.
  app.get('/api/solves/daily', authed, async (req) => {
    const user = currentUser(req);
    const q = parse(dailyQuery, req.query ?? {});
    const date = q.date ?? utcDay(Date.now());
    const [solves, attempts] = await Promise.all([
      pool.query<SolveRow>(
        `SELECT ${SOLVE_COLUMNS} FROM solve.solves WHERE user_id = $1 AND daily_date = $2 ORDER BY event, daily_index`,
        [user.id, date],
      ),
      pool.query<{ event: string; time_ms: number; penalty: Penalty }>(
        'SELECT event, time_ms, penalty FROM solve.daily_attempts WHERE user_id = $1 AND daily_date = $2 ORDER BY event, daily_index',
        [user.id, date],
      ),
    ]);
    const official = attempts.rows.map((a) => ({ event: a.event, timeMs: a.time_ms, penalty: a.penalty }));
    return { date, events: dailyOverview(solves.rows.map(toSolve), official) };
  });
}
