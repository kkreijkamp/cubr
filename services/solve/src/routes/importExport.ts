import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { badRequest, parse, rateLimit, rateLimited, withTx, type Pool, type PoolClient } from '@cubr/common';
import { currentUser, tzFrom, type RouteContext } from '../context.js';
import { findExisting, leaveOutExisting, planImport, writeImport } from '../importer.js';
import { SOLVE_COLUMNS, toSession, toSolve, type SolveRow } from '../mapping.js';
import { enqueue } from '../outbox.js';
import { listSessions } from '../repo.js';
import { importBody, MAX_FUTURE_SKEW_MS } from '../schemas.js';

/** A 100 000-solve csTimer import is ~15-20 MB of JSON. */
export const IMPORT_BODY_LIMIT = 25 * 1024 * 1024;

/**
 * Per-user limits (review 2026-10-16 #4). An import can carry 100k solves and an export walks the
 * whole account, so neither may run in a loop; and an account can't grow without bound, which also
 * bounds the stats service's per-event recompute.
 */
export const IMPORTS_PER_HOUR = 10;
export const EXPORTS_PER_HOUR = 10;
export const MAX_SOLVES_PER_ACCOUNT = 250_000;

/** Solves per query while streaming an export: memory stays flat whatever the account's size. */
export const EXPORT_BATCH = 2000;

/** 400 if `adding` more solves would take the account past MAX_SOLVES_PER_ACCOUNT. */
export function assertImportFits(existing: number, adding: number, max = MAX_SOLVES_PER_ACCOUNT): void {
  if (existing + adding > max) {
    throw badRequest(
      `An account can hold at most ${max.toLocaleString('en-US')} solves: this one has ${existing.toLocaleString('en-US')}, ` +
        `and the import adds ${adding.toLocaleString('en-US')}`,
    );
  }
}

type Db = Pool | PoolClient;
type ExportRow = SolveRow & { created_key: string };

/**
 * GET /api/solves/export as JSON text, the same document as before ({exportedAt, sessions:
 * [{...session, solves: [...]}]}, sessions by creation, solves by time), built one batch of solves
 * at a time instead of holding the account twice (rows + string) under a 192 MB heap. Pages by
 * (created_at, id) with created_at as text, so microseconds survive the round trip.
 */
export async function* exportChunks(db: Db, userId: string, batch = EXPORT_BATCH, now = new Date()): AsyncGenerator<string> {
  const sessions = await listSessions(db, userId);
  yield `{"exportedAt":${JSON.stringify(now.toISOString())},"sessions":[`;
  for (const [i, session] of sessions.entries()) {
    const head = JSON.stringify(toSession(session));
    yield `${i > 0 ? ',' : ''}${head.slice(0, -1)},"solves":[`;
    let after: [string, string] | null = null;
    let first = true;
    for (;;) {
      const { rows }: { rows: ExportRow[] } = await db.query<ExportRow>(
        `SELECT ${SOLVE_COLUMNS}, created_at::text AS created_key FROM solve.solves
          WHERE user_id = $1 AND session_id = $2${after ? ' AND (created_at, id) > ($3::timestamptz, $4::uuid)' : ''}
          ORDER BY created_at, id LIMIT ${batch}`,
        after ? [userId, session.id, ...after] : [userId, session.id],
      );
      if (rows.length > 0) {
        let out = '';
        for (const r of rows) {
          out += (first ? '' : ',') + JSON.stringify(toSolve(r));
          first = false;
        }
        yield out;
      }
      if (rows.length < batch) break;
      const last: ExportRow = rows[rows.length - 1];
      after = [last.created_key, last.id];
    }
    yield ']}';
  }
  yield ']}';
}

export function registerImportExportRoutes(app: FastifyInstance, { pool, redis, auth }: RouteContext): void {
  // onRequest, right after auth: a refused import is answered before its 25 MB body is read
  const limit = (what: 'import' | 'export', perHour: number) => async (req: FastifyRequest) => {
    if (!(await rateLimit(redis, `solve-${what}:${currentUser(req).id}`, perHour, 3600))) {
      throw rateLimited(`Too many ${what}s, try again in an hour`);
    }
  };

  /**
   * Bulk import (cubr, csTimer and other timers' files are converted client-side with cubestats parseTimerFile).
   * Everything happens in ONE transaction: new sessions, solves in unnest() batches, and a
   * single `solves.imported` outbox row - consumers recompute the user's affected events.
   * Solves the account already has are left out (a second import, or a retry after a failure,
   * adds only what's missing); a session already imported before continues where it was.
   * Auth runs onRequest, i.e. before a large body is read and parsed.
   */
  app.post('/api/sessions/import', { onRequest: [auth.requireAuth, limit('import', IMPORTS_PER_HOUR)], bodyLimit: IMPORT_BODY_LIMIT }, async (req) => {
    const user = currentUser(req);
    const body = parse(importBody, req.body ?? {});
    const tz = tzFrom(req);

    // Legacy files sometimes carry timestamps from a wrong device clock: clamp the future to now
    // instead of rejecting a whole 100k-solve file.
    const maxTs = Date.now() + MAX_FUTURE_SKEW_MS;
    const nowIso = new Date().toISOString();
    for (const s of body.sessions) for (const v of s.solves) if (Date.parse(v.createdAt) > maxTs) v.createdAt = nowIso;

    const planned = planImport(body);
    const started = Date.now();
    const { plan, solves } = await withTx(pool, async (client) => {
      // one import per account at a time, so two can't both pass the size check (or both miss the other's solves)
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`solve:import:${user.id}`]);
      const plan = leaveOutExisting(planned, await findExisting(client, user.id, planned.rows));
      const { rows } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM solve.solves WHERE user_id = $1', [user.id]);
      assertImportFits(rows[0]?.n ?? 0, plan.rows.length);
      const n = await writeImport(client, user.id, plan);
      if (n > 0) await enqueue(client, 'solves.imported', { userId: user.id, username: user.username, events: plan.events, count: n, tz });
      return { plan, solves: n };
    });
    req.log.info({ sessions: plan.sessions.length, solves, skipped: plan.skipped, continued: plan.continued, ms: Date.now() - started }, 'import committed');
    return { imported: { sessions: plan.sessions.length, solves }, skipped: plan.skipped, continued: plan.continued };
  });

  /** Streamed from one read-only snapshot, so a solve saved meanwhile can't appear half-way. */
  app.get('/api/solves/export', { onRequest: [auth.requireAuth, limit('export', EXPORTS_PER_HOUR)] }, async (req, reply) => {
    const user = currentUser(req);
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    } catch (err) {
      client.release();
      throw err;
    }
    async function* body(): AsyncGenerator<string> {
      let done = false;
      try {
        yield* exportChunks(client, user.id);
        done = true;
      } finally {
        // also runs when the client goes away mid-download (the stream is destroyed)
        await client.query(done ? 'COMMIT' : 'ROLLBACK').catch(() => {});
        client.release();
      }
    }
    reply.type('application/json; charset=utf-8').header('cache-control', 'no-store');
    return reply.send(Readable.from(body()));
  });
}
