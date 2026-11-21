import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { badRequest, conflict, notFound, parse, withTx } from '@cubr/common';
import { currentUser, tzFrom, type RouteContext } from '../context.js';
import { SOLVE_COLUMNS, toSession, toSolve, type SessionRow, type SolveRow } from '../mapping.js';
import { enqueue } from '../outbox.js';
import { ensureDefaultSession, getSession, listSessions } from '../repo.js';
import { createSessionBody, idParams, mergeSessionsBody, patchSessionBody, resolveCreatedAt } from '../schemas.js';

/** GET /api/sessions/:id/solves returns at most this many (the latest ones, ascending). */
export const SESSION_SOLVES_CAP = 50_000;

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
    // a practice scramble's session is always a practice session: only the default scramble counts
    const scramble = body.scramble ?? null;
    const ins = await pool.query<SessionRow>(
      `INSERT INTO solve.sessions (id, user_id, name, event, practice, scramble, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, name, event, practice, scramble, created_at, updated_at, 0 AS solve_count`,
      [id, user.id, body.name, body.event, body.practice || scramble !== null, scramble, resolveCreatedAt(body.createdAt)],
    );
    if (ins.rowCount) return reply.code(201).send({ session: toSession(ins.rows[0]) });
    const existing = await getSession(pool, user.id, id);
    if (!existing) throw conflict('session id already in use');
    return reply.code(200).send({ session: toSession(existing) });
  });

  // Rename and/or mark as practice. The row lock makes "did practice change?" exact under
  // concurrent PATCHes, so session.updated is emitted once per real change.
  app.patch('/api/sessions/:id', authed, async (req) => {
    const user = currentUser(req);
    const { id } = parse(idParams, req.params);
    const { name, practice } = parse(patchSessionBody, req.body ?? {});
    const tz = tzFrom(req);
    const row = await withTx(pool, async (client) => {
      const before = await client.query<{ practice: boolean; scramble: string | null }>(
        'SELECT practice, scramble FROM solve.sessions WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [id, user.id],
      );
      if (!before.rows[0]) throw notFound('session not found');
      if (practice === false && before.rows[0].scramble) throw badRequest("practice: a practice scramble's session is always a practice session");
      const { rows } = await client.query<SessionRow>(
        `UPDATE solve.sessions s SET name = coalesce($3, s.name), practice = coalesce($4, s.practice), updated_at = now()
          WHERE s.id = $1 AND s.user_id = $2
         RETURNING s.id, s.name, s.event, s.practice, s.scramble, s.created_at, s.updated_at,
                   (SELECT count(*) FROM solve.solves v WHERE v.session_id = s.id) AS solve_count`,
        [id, user.id, name ?? null, practice ?? null],
      );
      const r = rows[0];
      // read models that show session names (stats) learn about the rename via the outbox
      if (name !== undefined) {
        await enqueue(client, 'session.renamed', {
          userId: user.id, username: user.username, sessionId: r.id, event: r.event, name: r.name,
        });
      }
      // its solves now count for PBs, or no longer do: stats recomputes the event
      if (practice !== undefined && practice !== before.rows[0].practice) {
        await enqueue(client, 'session.updated', {
          userId: user.id, username: user.username, sessionId: r.id, event: r.event, name: r.name, practice: r.practice, tz,
        });
      }
      return r;
    });
    return { session: toSession(row) };
  });

  // Cascades to the session's solves; consumers recompute the user's stats for the event.
  app.delete('/api/sessions/:id', authed, async (req, reply) => {
    const user = currentUser(req);
    const { id } = parse(idParams, req.params);
    const tz = tzFrom(req);
    await withTx(pool, async (client) => {
      const { rows } = await client.query<{ id: string; event: string }>(
        'DELETE FROM solve.sessions WHERE id = $1 AND user_id = $2 RETURNING id, event',
        [id, user.id],
      );
      if (!rows[0]) throw notFound('session not found');
      await enqueue(client, 'session.deleted', {
        userId: user.id, username: user.username, sessionId: rows[0].id, event: rows[0].event, tz,
      });
    });
    return reply.code(204).send();
  });

  // Merge: move every solve of the source sessions into the target session, then delete the
  // (now empty) sources - all in one transaction. Only sessions of the same event can be merged
  // (a solve's event is its session's event). sessions.merged makes stats recompute the event's
  // PBs, because combining sessions changes the within-session ao5/ao12 windows. The target keeps
  // its own practice flag, so merged-in solves count (or don't) as the target's do.
  app.post('/api/sessions/:id/merge', authed, async (req) => {
    const user = currentUser(req);
    const { id } = parse(idParams, req.params);
    const { sourceIds } = parse(mergeSessionsBody, req.body ?? {});
    const targetId = id.toLowerCase();
    if (sourceIds.includes(targetId)) throw badRequest('sourceIds must not include the target session');
    const tz = tzFrom(req);

    const result = await withTx(pool, async (client) => {
      // Lock every involved session in id order: concurrent merges/writes can't deadlock or race.
      const { rows } = await client.query<{ id: string; event: string; scramble: string | null }>(
        'SELECT id, event, scramble FROM solve.sessions WHERE user_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE',
        [user.id, [targetId, ...sourceIds]],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      const target = byId.get(targetId);
      if (!target) throw notFound('session not found');
      const missing = sourceIds.find((s) => !byId.has(s));
      if (missing) throw notFound(`session not found: ${missing}`);
      if (sourceIds.some((s) => byId.get(s)!.event !== target.event)) throw conflict('can only merge sessions of the same event');
      // a PLL session's times would land among the 3x3 ones (or the other way round)
      if (sourceIds.some((s) => (byId.get(s)!.scramble ?? null) !== (target.scramble ?? null))) throw conflict('can only merge sessions of the same scramble type');

      const moved = await client.query(
        'UPDATE solve.solves SET session_id = $1 WHERE user_id = $2 AND session_id = ANY($3::uuid[])',
        [targetId, user.id, sourceIds],
      );
      await client.query('DELETE FROM solve.sessions WHERE user_id = $1 AND id = ANY($2::uuid[])', [user.id, sourceIds]);
      const { rows: updated } = await client.query<SessionRow>(
        `UPDATE solve.sessions s SET updated_at = now() WHERE s.id = $1
         RETURNING s.id, s.name, s.event, s.practice, s.scramble, s.created_at, s.updated_at,
                   (SELECT count(*) FROM solve.solves v WHERE v.session_id = s.id) AS solve_count`,
        [targetId],
      );
      const solves = moved.rowCount ?? 0;
      await enqueue(client, 'sessions.merged', {
        userId: user.id, username: user.username, event: target.event, targetId, sourceIds, solves, tz,
      });
      return { session: updated[0], solves };
    });
    return { session: toSession(result.session), merged: { sessions: sourceIds.length, solves: result.solves } };
  });

  app.get('/api/sessions/:id/solves', authed, async (req) => {
    const user = currentUser(req);
    const { id } = parse(idParams, req.params);
    const { rowCount } = await pool.query('SELECT 1 FROM solve.sessions WHERE id = $1 AND user_id = $2', [id, user.id]);
    if (!rowCount) throw notFound('session not found');
    // Newest CAP+1 solves (the +1 detects truncation), returned oldest-first.
    const { rows } = await pool.query<SolveRow>(
      `SELECT ${SOLVE_COLUMNS} FROM solve.solves WHERE session_id = $1 AND user_id = $2
        ORDER BY created_at DESC, id DESC LIMIT ${SESSION_SOLVES_CAP + 1}`,
      [id, user.id],
    );
    const truncated = rows.length > SESSION_SOLVES_CAP;
    if (truncated) rows.pop();
    rows.reverse();
    return { solves: rows.map(toSolve), truncated };
  });
}
