import { randomUUID } from 'node:crypto';
import { withTx, type AuthUser, type Pool, type PoolClient } from '@cubetype/common';
import { iso, type SessionRow, type SolveRow } from './mapping.js';
import { effectiveOrNull, rollingFromSolves, ROLLING_WINDOW, type Rolling } from './rolling.js';
import type { Penalty } from '@cubetype/cubestats';

// SQL shared by several routes. Every query is scoped by user_id: a user can never see or
// touch another user's rows (foreign ids simply look like "not found").

type Db = Pool | PoolClient;

const SESSION_SELECT = `
SELECT s.id, s.name, s.event, s.created_at, s.updated_at,
       (SELECT count(*) FROM solve.solves v WHERE v.session_id = s.id) AS solve_count
  FROM solve.sessions s`;

export async function listSessions(db: Db, userId: string): Promise<SessionRow[]> {
  const { rows } = await db.query<SessionRow>(`${SESSION_SELECT} WHERE s.user_id = $1 ORDER BY s.created_at, s.id`, [userId]);
  return rows;
}

export async function getSession(db: Db, userId: string, id: string): Promise<SessionRow | null> {
  const { rows } = await db.query<SessionRow>(`${SESSION_SELECT} WHERE s.id = $1 AND s.user_id = $2`, [id, userId]);
  return rows[0] ?? null;
}

export const DEFAULT_SESSION = { name: '3x3', event: '333' } as const;

/**
 * Creates the default "3x3" session for a user who has none. A per-user advisory lock makes
 * two concurrent first requests create exactly one session.
 */
export async function ensureDefaultSession(pool: Pool, userId: string): Promise<void> {
  await withTx(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`solve:sessions:${userId}`]);
    const { rowCount } = await client.query('SELECT 1 FROM solve.sessions WHERE user_id = $1 LIMIT 1', [userId]);
    if (rowCount) return;
    await client.query('INSERT INTO solve.sessions (id, user_id, name, event) VALUES ($1, $2, $3, $4)', [
      randomUUID(), userId, DEFAULT_SESSION.name, DEFAULT_SESSION.event,
    ]);
  });
}

/** The session's current ao5/ao12 from its latest 12 solves (sees uncommitted rows of `db`'s transaction). */
export async function sessionRolling(db: Db, sessionId: string): Promise<Rolling> {
  const { rows } = await db.query<{ time_ms: number; penalty: Penalty }>(
    `SELECT time_ms, penalty FROM solve.solves WHERE session_id = $1
      ORDER BY created_at DESC, id DESC LIMIT ${ROLLING_WINDOW}`,
    [sessionId],
  );
  return rollingFromSolves(rows.reverse().map((r) => ({ timeMs: r.time_ms, penalty: r.penalty })));
}

/** `solve.created` / `solve.updated` payload (SPEC §8). */
export function solveEventPayload(user: AuthUser, row: SolveRow, tz: string, rolling: Rolling): Record<string, unknown> {
  return {
    userId: user.id,
    username: user.username,
    event: row.event,
    sessionId: row.session_id,
    solveId: row.id,
    timeMs: row.time_ms,
    penalty: row.penalty,
    effectiveMs: effectiveOrNull({ timeMs: row.time_ms, penalty: row.penalty }),
    createdAt: iso(row.created_at),
    tz,
    source: row.source,
    rolling,
    ...(row.daily_date ? { dailyDate: row.daily_date, dailyIndex: row.daily_index } : {}),
  };
}

/** `solve.deleted` payload (SPEC §8). */
export function solveDeletedPayload(user: AuthUser, row: SolveRow, tz: string): Record<string, unknown> {
  return {
    userId: user.id,
    username: user.username,
    event: row.event,
    sessionId: row.session_id,
    solveId: row.id,
    timeMs: row.time_ms,
    penalty: row.penalty,
    createdAt: iso(row.created_at),
    tz,
    source: row.source,
  };
}
