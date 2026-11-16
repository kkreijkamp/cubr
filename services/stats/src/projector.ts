import { DLQ_STREAM, withTx, type EventEnvelope, type Pool, type PoolClient, type Redis } from '@cubr/common';
import { effectiveMs } from '@cubr/cubestats';
import type { FastifyBaseLogger } from 'fastify';
import type { ZodType, ZodTypeDef } from 'zod';
import { makeBucketer, validTz } from './domain/buckets.js';
import { isImprovement, rollingFromPayload, tailAverages, type PbKind } from './domain/pbs.js';
import {
  sessionDeletedSchema,
  solveChangedSchema,
  solveCreatedSchema,
  solvesImportedSchema,
  userDeletedSchema,
  userEventSchema,
  type SolveCreated, sessionRenamedSchema, sessionsMergedSchema, sessionUpdatedSchema} from './eventSchemas.js';
import { recomputeEvent, type RecomputeDeps } from './recompute.js';
import { CACHE_KEY as GLOBAL_CACHE_KEY } from './routes/global.js';
import { ensureUser, loadPbs, lockUser, markProcessed, queuePbUpdated, queuePeriodsChanged, refreshTotals, upsertPb } from './store.js';

/** Every stats table with a user_id column (all of a deleted account's rows go). */
export const USER_TABLES = ['user_totals', 'personal_bests', 'pb_history', 'daily_activity', 'hourly', 'solve_ledger', 'deleted_sessions', 'sessions'] as const;

async function isDeletedUser(c: PoolClient, userId: string): Promise<boolean> {
  const { rowCount } = await c.query('SELECT 1 FROM stats.deleted_users WHERE user_id = $1', [userId]);
  return (rowCount ?? 0) > 0;
}

export interface ProjectorDeps {
  pool: Pool;
  redis: Redis;
  log: FastifyBaseLogger;
  solveUrl: string;
  /** X-Internal-Token for solve-service's /internal routes (recomputes) */
  internalToken: string;
  /** Publishes queued pb.updated events right after commit (best effort; a loop retries). */
  flushPbOutbox: () => Promise<unknown>;
}

/**
 * Event handler for the `stats` consumer group. Every event is applied in ONE transaction that
 * takes the per-user lock, records the event id in processed_events (duplicate deliveries are
 * skipped) and writes resulting pb.updated events to the outbox table.
 */
/**
 * Upserts a session's display name (from solve.created, session.renamed and session.updated), and
 * its practice flag where the event carries one.
 */
export async function upsertSessionName(c: PoolClient | Pool, sessionId: string, userId: string, event: string, name: string, practice?: boolean | null): Promise<void> {
  await c.query(
    `INSERT INTO stats.sessions (session_id, user_id, event, name, practice) VALUES ($1, $2, $3, $4, coalesce($5, false))
     ON CONFLICT (session_id) DO UPDATE
       SET name = excluded.name, event = excluded.event, practice = coalesce($5, stats.sessions.practice), updated_at = now()`,
    [sessionId, userId, event, name, practice ?? null],
  );
}

export function createProjector(deps: ProjectorDeps) {
  const { pool, log } = deps;
  const rdeps: RecomputeDeps = { solveUrl: deps.solveUrl, internalToken: deps.internalToken, log };

  /**
   * Runs `fn` in the per-user, de-duplicated transaction; `fn` returns how many pb.updated events
   * it queued, and the outbox is flushed after commit when there are any.
   */
  async function inUserTx(eventId: string, userId: string, fn: (c: PoolClient) => Promise<number | void>): Promise<void> {
    const queued = await withTx(pool, async (c) => {
      await lockUser(c, userId);
      if (!(await markProcessed(c, eventId))) {
        log.debug({ eventId }, 'duplicate event skipped');
        return 0;
      }
      if (await isDeletedUser(c, userId)) {
        log.debug({ eventId, userId }, 'event for a deleted account skipped');
        return 0;
      }
      return (await fn(c)) ?? 0;
    });
    if (queued > 0) {
      await deps.flushPbOutbox().catch((err) => log.warn({ err: (err as Error).message }, 'pb outbox flush failed (will retry)'));
    }
  }

  /** Validates a payload; malformed (non-retriable) events go straight to the dead-letter stream. */
  async function payload<T>(schema: ZodType<T, ZodTypeDef, unknown>, evt: EventEnvelope): Promise<T | null> {
    const res = schema.safeParse(evt.data);
    if (res.success) return res.data;
    const issue = res.error.issues[0];
    const error = `invalid payload: ${issue.path.join('.')}: ${issue.message}`;
    log.error({ type: evt.type, id: evt.id, error }, 'malformed event moved to dead-letter stream');
    await deps.redis.xadd(DLQ_STREAM, 'MAXLEN', '~', '10000', '*', 'group', 'stats', 'type', evt.type, 'data', JSON.stringify(evt.data), 'error', error);
    return null;
  }

  // ---- user.registered / user.updated: keep the display name; counters untouched
  async function onUser(evt: EventEnvelope) {
    const d = await payload(userEventSchema, evt);
    if (!d) return;
    await inUserTx(d.eventId, d.userId, async (c) => {
      await ensureUser(c, d.userId, d.username, null);
      if (d.createdAt) {
        await c.query('UPDATE stats.user_totals SET registered_at = LEAST(registered_at, $2) WHERE user_id = $1', [d.userId, d.createdAt]);
      }
    });
  }

  // ---- solve.created: incremental fast path
  async function onSolveCreated(evt: EventEnvelope) {
    const d = await payload(solveCreatedSchema, evt);
    if (!d) return;
    await inUserTx(d.eventId, d.userId, (c) => applySolveCreated(c, d));
  }

  async function applySolveCreated(c: PoolClient, d: SolveCreated): Promise<number> {
    const user = await ensureUser(c, d.userId, d.username, validTz(d.tz));
    const deletedSession = await c.query('SELECT 1 FROM stats.deleted_sessions WHERE session_id = $1', [d.sessionId]);
    if (deletedSession.rowCount) return 0; // late event for a session that is already gone

    const eff = effectiveMs(d);
    const effDb = Number.isFinite(eff) ? eff : null;
    // Per-solve idempotency: if the ledger already knows this solve (counted by a full recompute
    // that ran first, or tombstoned by solve.deleted) there is nothing to add.
    const ins = await c.query(
      `INSERT INTO stats.solve_ledger (solve_id, user_id, event, session_id, time_ms, effective_ms, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (solve_id) DO NOTHING`,
      [d.solveId, d.userId, d.event, d.sessionId, d.timeMs, effDb, d.createdAt],
    );
    if (!ins.rowCount) return 0;
    if (d.sessionName) await upsertSessionName(c, d.sessionId, d.userId, d.event, d.sessionName, d.practice);

    // A back-dated solve lands in the middle of its session and shifts the rolling windows, so an
    // incremental compare would be wrong: rebuild the event from solve-service instead (rare).
    const later = await c.query(
      'SELECT 1 FROM stats.solve_ledger WHERE session_id = $1 AND NOT deleted AND solve_id <> $2 AND created_at > $3 LIMIT 1',
      [d.sessionId, d.solveId, d.createdAt],
    );
    if (later.rowCount) {
      log.info({ userId: d.userId, solveId: d.solveId }, 'back-dated solve, recomputing event');
      const { queued } = await recomputeEvent(c, rdeps, { userId: d.userId, username: user.username, event: d.event, tz: user.tz });
      await refreshTotals(c, d.userId);
      return queued;
    }

    // aggregates (raw timeMs = time spent cubing; hourly mean uses effective times of non-DNF solves)
    const at = new Date(d.createdAt);
    const { day, hour } = makeBucketer(user.tz)(at);
    await c.query(
      `UPDATE stats.user_totals
          SET solves = solves + 1, total_ms = total_ms + $2,
              first_solve_at = LEAST(first_solve_at, $3), last_solve_at = GREATEST(last_solve_at, $3)
        WHERE user_id = $1`,
      [d.userId, d.timeMs, d.createdAt],
    );
    await c.query(
      `INSERT INTO stats.daily_activity (user_id, day, event, solves, total_ms) VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT (user_id, day, event) DO UPDATE
         SET solves = stats.daily_activity.solves + 1, total_ms = stats.daily_activity.total_ms + EXCLUDED.total_ms`,
      [d.userId, day, d.event, d.timeMs],
    );
    await c.query(
      `INSERT INTO stats.hourly (user_id, event, hour, solves, sum_ms, dnfs) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, event, hour) DO UPDATE
         SET solves = stats.hourly.solves + EXCLUDED.solves, sum_ms = stats.hourly.sum_ms + EXCLUDED.sum_ms,
             dnfs = stats.hourly.dnfs + EXCLUDED.dnfs`,
      [d.userId, d.event, hour, effDb === null ? 0 : 1, effDb ?? 0, effDb === null ? 1 : 0],
    );
    // a practice session's solve counts as cubing, never as a personal best
    if (d.practice) return 0;

    // PB candidates: single from this solve; ao5/ao12 from the payload's rolling values (computed
    // by solve-service over the session); mo3/ao50/ao100 from the session's last 100 solves in
    // the ledger (also used for ao5/ao12 if a publisher omitted `rolling`).
    const { rows: tailRows } = await c.query<{ effective_ms: number | null }>(
      `SELECT effective_ms FROM stats.solve_ledger WHERE session_id = $1 AND NOT deleted
        ORDER BY created_at DESC, seq DESC LIMIT 100`,
      [d.sessionId],
    );
    const tail = tailRows.reverse().map((r) => (r.effective_ms === null ? Number.POSITIVE_INFINITY : r.effective_ms));
    const fromTail = tailAverages(tail);
    const candidates: Partial<Record<PbKind, number | null>> = {
      single: effDb,
      mo3: fromTail.mo3 ?? null,
      ao5: d.rolling ? rollingFromPayload(d.rolling.ao5) : (fromTail.ao5 ?? null),
      ao12: d.rolling ? rollingFromPayload(d.rolling.ao12) : (fromTail.ao12 ?? null),
      ao50: fromTail.ao50 ?? null,
      ao100: fromTail.ao100 ?? null,
    };

    const current = await loadPbs(c, d.userId, d.event);
    const achievedAt = at.toISOString();
    let queued = 0;
    for (const [kind, value] of Object.entries(candidates) as [PbKind, number | null][]) {
      const prev = current.get(kind);
      if (!isImprovement(value, prev?.value_ms)) continue;
      const valueMs = value as number;
      await upsertPb(c, d.userId, d.event, kind, valueMs, d.solveId, achievedAt);
      await c.query(
        'INSERT INTO stats.pb_history (user_id, event, kind, value_ms, achieved_at) VALUES ($1, $2, $3, $4, $5)',
        [d.userId, d.event, kind, valueMs, achievedAt],
      );
      await queuePbUpdated(c, {
        userId: d.userId, username: user.username, event: d.event, kind,
        valueMs, previousMs: prev?.value_ms ?? null, achievedAt,
      });
      queued++;
    }
    // The leaderboard's day and week boards took this solve from solve.created already; re-reading
    // the bests afterwards keeps them exact when this solve raced with an edit or a deletion.
    await queuePeriodsChanged(c, { userId: d.userId, username: user.username, event: d.event });
    return queued + 1;
  }

  // ---- solve.updated / solve.deleted: full recompute of the event
  async function onSolveChanged(evt: EventEnvelope) {
    const d = await payload(solveChangedSchema, evt);
    if (!d) return;
    await inUserTx(d.eventId, d.userId, async (c) => {
      const user = await ensureUser(c, d.userId, d.username, validTz(d.tz));
      if (evt.type === 'solve.updated' && d.timeMs && d.penalty) {
        // comment-only edits do not change any statistic: skip the (expensive) recompute
        const eff = effectiveMs({ timeMs: d.timeMs, penalty: d.penalty });
        const { rows } = await c.query<{ time_ms: number; effective_ms: number | null }>(
          'SELECT time_ms, effective_ms FROM stats.solve_ledger WHERE solve_id = $1 AND NOT deleted',
          [d.solveId],
        );
        if (rows[0] && rows[0].time_ms === d.timeMs && rows[0].effective_ms === (Number.isFinite(eff) ? eff : null)) return 0;
      }
      if (evt.type === 'solve.deleted') {
        // tombstone: a late / re-delivered solve.created for this solve must not count it again
        await c.query(
          `INSERT INTO stats.solve_ledger (solve_id, user_id, event, session_id, time_ms, created_at, deleted)
           VALUES ($1, $2, $3, coalesce($4::uuid, '00000000-0000-0000-0000-000000000000'), coalesce($5::int, 0), coalesce($6::timestamptz, now()), true)
           ON CONFLICT (solve_id) DO UPDATE SET deleted = true`,
          [d.solveId, d.userId, d.event, d.sessionId ?? null, d.timeMs ?? null, d.createdAt ?? null],
        );
      }
      const { queued } = await recomputeEvent(c, rdeps, { userId: d.userId, username: user.username, event: d.event, tz: user.tz });
      await refreshTotals(c, d.userId);
      return queued;
    });
  }

  // ---- session.deleted: tombstone the session, recompute the event
  async function onSessionDeleted(evt: EventEnvelope) {
    const d = await payload(sessionDeletedSchema, evt);
    if (!d) return;
    await inUserTx(d.eventId, d.userId, async (c) => {
      const user = await ensureUser(c, d.userId, d.username, validTz(d.tz));
      await c.query(
        'INSERT INTO stats.deleted_sessions (session_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [d.sessionId, d.userId],
      );
      await c.query('DELETE FROM stats.sessions WHERE session_id = $1', [d.sessionId]);
      const { queued } = await recomputeEvent(c, rdeps, { userId: d.userId, username: user.username, event: d.event, tz: user.tz });
      await refreshTotals(c, d.userId);
      return queued;
    });
  }

  // ---- session.renamed: update the display name (no stats change)
  async function onSessionRenamed(evt: EventEnvelope) {
    const d = await payload(sessionRenamedSchema, evt);
    if (!d) return;
    await inUserTx(d.eventId, d.userId, async (c) => {
      await upsertSessionName(c, d.sessionId, d.userId, d.event, d.name);
      return 0;
    });
  }

  // ---- session.updated: marked as practice (or no longer): its solves leave (or rejoin) the PBs
  async function onSessionUpdated(evt: EventEnvelope) {
    const d = await payload(sessionUpdatedSchema, evt);
    if (!d) return;
    await inUserTx(d.eventId, d.userId, async (c) => {
      const user = await ensureUser(c, d.userId, d.username, validTz(d.tz));
      await upsertSessionName(c, d.sessionId, d.userId, d.event, d.name, d.practice);
      const { queued } = await recomputeEvent(c, rdeps, { userId: d.userId, username: user.username, event: d.event, tz: user.tz });
      await refreshTotals(c, d.userId);
      return queued;
    });
  }

  // ---- sessions.merged: sources are gone (tombstone + drop names), recompute the event -
  //      merging interleaves solves, so within-session rolling PBs (ao5, ao12, ...) change
  async function onSessionsMerged(evt: EventEnvelope) {
    const d = await payload(sessionsMergedSchema, evt);
    if (!d) return;
    await inUserTx(d.eventId, d.userId, async (c) => {
      const user = await ensureUser(c, d.userId, d.username, validTz(d.tz));
      await c.query(
        `INSERT INTO stats.deleted_sessions (session_id, user_id)
         SELECT unnest($1::uuid[]), $2 ON CONFLICT DO NOTHING`,
        [d.sourceIds, d.userId],
      );
      await c.query('DELETE FROM stats.sessions WHERE session_id = ANY($1::uuid[])', [d.sourceIds]);
      const { queued } = await recomputeEvent(c, rdeps, { userId: d.userId, username: user.username, event: d.event, tz: user.tz });
      await refreshTotals(c, d.userId);
      return queued;
    });
  }

  // ---- solves.imported: recompute every imported event
  async function onSolvesImported(evt: EventEnvelope) {
    const d = await payload(solvesImportedSchema, evt);
    if (!d) return;
    await inUserTx(d.eventId, d.userId, async (c) => {
      const user = await ensureUser(c, d.userId, d.username, validTz(d.tz));
      let events = [...new Set(d.events ?? [])];
      if (events.length === 0) {
        // publisher did not say which events: recompute everything we know for the user
        const { rows } = await c.query<{ event: string }>('SELECT DISTINCT event FROM stats.solve_ledger WHERE user_id = $1', [d.userId]);
        events = rows.map((r) => r.event);
      }
      let queued = 0;
      for (const event of events) {
        queued += (await recomputeEvent(c, rdeps, { userId: d.userId, username: user.username, event, tz: user.tz })).queued;
      }
      await refreshTotals(c, d.userId);
      return queued;
    });
  }

  // ---- user.deleted: the account is gone - drop every row of it and keep a tombstone, so events
  //      for it still on the way (a late solve.created, a queued pb.updated) are ignored
  async function onUserDeleted(evt: EventEnvelope) {
    const d = await payload(userDeletedSchema, evt);
    if (!d) return;
    await withTx(pool, async (c) => {
      await lockUser(c, d.userId);
      if (!(await markProcessed(c, d.eventId))) return;
      await c.query('INSERT INTO stats.deleted_users (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [d.userId]);
      for (const table of USER_TABLES) await c.query(`DELETE FROM stats.${table} WHERE user_id = $1`, [d.userId]);
      await c.query(`DELETE FROM stats.pb_outbox WHERE payload->>'userId' = $1`, [d.userId]);
    });
    // the global counters include the account's solves until their 10 s cache runs out
    await deps.redis.del(GLOBAL_CACHE_KEY).catch(() => 0);
    log.info({ userId: d.userId }, 'deleted the stats of a deleted account');
  }

  return async function handle(evt: EventEnvelope): Promise<void> {
    switch (evt.type) {
      case 'user.deleted':
        return onUserDeleted(evt);
      case 'user.registered':
      case 'user.updated':
        return onUser(evt);
      case 'solve.created':
        return onSolveCreated(evt);
      case 'solve.updated':
      case 'solve.deleted':
        return onSolveChanged(evt);
      case 'session.deleted':
        return onSessionDeleted(evt);
      case 'session.renamed':
        return onSessionRenamed(evt);
      case 'session.updated':
        return onSessionUpdated(evt);
      case 'sessions.merged':
        return onSessionsMerged(evt);
      case 'solves.imported':
        return onSolvesImported(evt);
      default:
        return;
    }
  };
}
