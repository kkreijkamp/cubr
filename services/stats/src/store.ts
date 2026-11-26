import { newEventId, type PoolClient } from '@cubr/common';
import type { PbKind } from './domain/pbs.js';

/** Payload of a pb.updated event (SPEC section 8). */
export interface PbChange {
  userId: string;
  username: string;
  event: string;
  kind: PbKind;
  valueMs: number | null; // null = the PB no longer exists
  previousMs: number | null;
  achievedAt: string | null;
}

export interface PbRow {
  kind: PbKind;
  value_ms: number;
  solve_id: string | null;
  achieved_at: Date;
}

/**
 * Serialises all event handling for one user across replicas (transaction-scoped advisory lock).
 * Two-key form so it cannot collide with other services' single-key advisory locks.
 */
export async function lockUser(c: PoolClient, userId: string): Promise<void> {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['cubr:stats:user', userId]);
}

/** Records the event id; returns false if it was already processed (duplicate delivery). */
export async function markProcessed(c: PoolClient, eventId: string): Promise<boolean> {
  const res = await c.query('INSERT INTO stats.processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId]);
  return res.rowCount === 1;
}

/**
 * Makes sure a user_totals row exists; updates the username / last seen timezone when given.
 * Returns the stored username and timezone.
 */
export async function ensureUser(
  c: PoolClient,
  userId: string,
  username: string | null | undefined,
  tz: string | null,
): Promise<{ username: string; tz: string }> {
  const { rows } = await c.query<{ username: string; tz: string }>(
    `INSERT INTO stats.user_totals (user_id, username, tz) VALUES ($1, coalesce($2, ''), coalesce($3, 'UTC'))
     ON CONFLICT (user_id) DO UPDATE
       SET username = coalesce($2, stats.user_totals.username), tz = coalesce($3, stats.user_totals.tz)
     RETURNING username, tz`,
    [userId, username ?? null, tz],
  );
  return rows[0];
}

/**
 * Queues periods.changed: the user's solves for `event` changed (one more, or one edited, deleted,
 * moved...), so the leaderboard re-reads their best of each day and week (GET
 * /internal/users/:id/period-bests). Same transaction as the change, published after it commits.
 */
export async function queuePeriodsChanged(c: PoolClient, change: { userId: string; username: string; event: string }): Promise<void> {
  const payload = { eventId: newEventId('stats'), occurredAt: new Date().toISOString(), ...change };
  await c.query(`INSERT INTO stats.pb_outbox (type, payload) VALUES ('periods.changed', $1)`, [JSON.stringify(payload)]);
}

/** Queues a pb.updated event in the outbox (same transaction as the PB change). */
export async function queuePbUpdated(c: PoolClient, change: PbChange): Promise<void> {
  const payload = { eventId: newEventId('stats'), occurredAt: new Date().toISOString(), ...change };
  await c.query('INSERT INTO stats.pb_outbox (payload) VALUES ($1)', [JSON.stringify(payload)]);
}

export async function loadPbs(c: PoolClient, userId: string, event: string): Promise<Map<PbKind, PbRow>> {
  const { rows } = await c.query<PbRow>('SELECT kind, value_ms, solve_id, achieved_at FROM stats.personal_bests WHERE user_id = $1 AND event = $2', [
    userId,
    event,
  ]);
  return new Map(rows.map((r) => [r.kind, r]));
}

export async function upsertPb(
  c: PoolClient,
  userId: string,
  event: string,
  kind: PbKind,
  valueMs: number,
  solveId: string | null,
  achievedAt: string,
): Promise<void> {
  await c.query(
    `INSERT INTO stats.personal_bests (user_id, event, kind, value_ms, solve_id, achieved_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, event, kind) DO UPDATE
       SET value_ms = EXCLUDED.value_ms, solve_id = EXCLUDED.solve_id, achieved_at = EXCLUDED.achieved_at`,
    [userId, event, kind, valueMs, solveId, achievedAt],
  );
}

/** user_totals solves / total_ms / first / last across all events, from the solve ledger. */
export async function refreshTotals(c: PoolClient, userId: string): Promise<void> {
  await c.query(
    `UPDATE stats.user_totals u
        SET solves = s.n, total_ms = s.t, first_solve_at = s.f, last_solve_at = s.l
       FROM (SELECT count(*)::int AS n, coalesce(sum(time_ms), 0)::bigint AS t,
                    min(created_at) AS f, max(created_at) AS l
               FROM stats.solve_ledger WHERE user_id = $1 AND NOT deleted) s
      WHERE u.user_id = $1`,
    [userId],
  );
}
