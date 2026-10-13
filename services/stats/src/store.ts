import type { PoolClient } from '@cubetype/common';
import type { PbKind } from './domain/pbs.js';

/** Payload of a pb.updated event (SPEC §8). */
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
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['cubetype:stats:user', userId]);
}

/** Records the event id; returns false if it was already processed (duplicate delivery). */
export async function markProcessed(c: PoolClient, eventId: string): Promise<boolean> {
  const res = await c.query('INSERT INTO stats.processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId]);
  return res.rowCount === 1;
}

/**
 * Makes sure a user_totals row exists; updates the username when given.
 * Returns the stored username.
 */
export async function ensureUser(
  c: PoolClient,
  userId: string,
  username: string | null | undefined,
): Promise<{ username: string }> {
  const { rows } = await c.query<{ username: string }>(
    `INSERT INTO stats.user_totals (user_id, username) VALUES ($1, coalesce($2, ''))
     ON CONFLICT (user_id) DO UPDATE
       SET username = coalesce($2, stats.user_totals.username)
     RETURNING username`,
    [userId, username ?? null],
  );
  return rows[0];
}

export async function loadPbs(c: PoolClient, userId: string, event: string): Promise<Map<PbKind, PbRow>> {
  const { rows } = await c.query<PbRow>(
    'SELECT kind, value_ms, solve_id, achieved_at FROM stats.personal_bests WHERE user_id = $1 AND event = $2',
    [userId, event],
  );
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
