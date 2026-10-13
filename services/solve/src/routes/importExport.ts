import type { FastifyInstance } from 'fastify';
import { parse, withTx } from '@cubetype/common';
import { currentUser, tzFrom, type RouteContext } from '../context.js';
import { planImport, writeImport } from '../importer.js';
import { SOLVE_COLUMNS, toSession, toSolve, type Solve, type SolveRow } from '../mapping.js';
import { enqueue } from '../outbox.js';
import { listSessions } from '../repo.js';
import { importBody, MAX_FUTURE_SKEW_MS } from '../schemas.js';

/** A 100 000-solve csTimer import is ~15–20 MB of JSON. */
export const IMPORT_BODY_LIMIT = 25 * 1024 * 1024;

export function registerImportExportRoutes(app: FastifyInstance, { pool, auth }: RouteContext): void {
  /**
   * Bulk import (csTimer files are converted client-side with cubestats parseCsTimerExport).
   * Everything happens in ONE transaction: new sessions, solves in unnest() batches, and a
   * single `solves.imported` outbox row — consumers recompute the user's affected events.
   * Auth runs onRequest, i.e. before a large body is read and parsed.
   */
  app.post('/api/sessions/import', { onRequest: auth.requireAuth, bodyLimit: IMPORT_BODY_LIMIT }, async (req) => {
    const user = currentUser(req);
    const body = parse(importBody, req.body ?? {});
    const tz = tzFrom(req);

    // Legacy files sometimes carry timestamps from a wrong device clock: clamp the future to now
    // instead of rejecting a whole 100k-solve file.
    const maxTs = Date.now() + MAX_FUTURE_SKEW_MS;
    const nowIso = new Date().toISOString();
    for (const s of body.sessions) for (const v of s.solves) if (Date.parse(v.createdAt) > maxTs) v.createdAt = nowIso;

    const plan = planImport(body);
    const started = Date.now();
    const solves = await withTx(pool, async (client) => {
      const n = await writeImport(client, user.id, plan);
      await enqueue(client, 'solves.imported', { userId: user.id, username: user.username, events: plan.events, count: n, tz });
      return n;
    });
    req.log.info({ sessions: plan.sessions.length, solves, ms: Date.now() - started }, 'import committed');
    return { imported: { sessions: plan.sessions.length, solves } };
  });

  app.get('/api/solves/export', { onRequest: auth.requireAuth }, async (req) => {
    const user = currentUser(req);
    const sessions = await listSessions(pool, user.id);
    const { rows } = await pool.query<SolveRow>(
      `SELECT ${SOLVE_COLUMNS} FROM solve.solves WHERE user_id = $1 ORDER BY session_id, created_at, id`,
      [user.id],
    );
    const bySession = new Map<string, Solve[]>();
    for (const r of rows) {
      let list = bySession.get(r.session_id);
      if (!list) bySession.set(r.session_id, (list = []));
      list.push(toSolve(r));
    }
    return {
      exportedAt: new Date().toISOString(),
      sessions: sessions.map((s) => ({ ...toSession(s), solves: bySession.get(s.id) ?? [] })),
    };
  });
}
