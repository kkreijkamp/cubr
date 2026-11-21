import { randomUUID } from 'node:crypto';
import { withTx, type AuthUser, type Pool, type PoolClient } from '@cubr/common';
import { iso, type SessionRow, type SolveRow } from './mapping.js';
import { effectiveOrNull, rollingFromSolves, ROLLING_WINDOW, type Rolling } from './rolling.js';
import { defaultSessionName, practiceSessionName, type Penalty } from '@cubr/cubestats';

// SQL shared by several routes. Every query is scoped by user_id: a user can never see or
// touch another user's rows (foreign ids simply look like "not found").

type Db = Pool | PoolClient;

const SESSION_SELECT = `
SELECT s.id, s.name, s.event, s.practice, s.scramble, s.created_at, s.updated_at,
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

const DEFAULT_EVENT = '333';
/** A new account's sessions: "3x3" and its practice session "3x3 practice", in that order. */
export const DEFAULT_SESSIONS = [
  { name: defaultSessionName(DEFAULT_EVENT), event: DEFAULT_EVENT, practice: false },
  { name: practiceSessionName(DEFAULT_EVENT), event: DEFAULT_EVENT, practice: true },
] as const;

/**
 * Creates the default sessions (DEFAULT_SESSIONS) for a user who has none. The practice one is
 * a millisecond younger, so lists ordered by created_at keep "3x3" first (it stays the session the
 * timer opens). A per-user advisory lock makes concurrent first requests create exactly one pair.
 */
export async function ensureDefaultSession(pool: Pool, userId: string): Promise<void> {
  await withTx(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`solve:sessions:${userId}`]);
    const { rowCount } = await client.query('SELECT 1 FROM solve.sessions WHERE user_id = $1 LIMIT 1', [userId]);
    if (rowCount) return;
    const [normal, practice] = DEFAULT_SESSIONS;
    await client.query(
      `INSERT INTO solve.sessions (id, user_id, name, event, practice, created_at) VALUES
         ($1, $2, $3, $4, $5, now()),
         ($6, $2, $7, $8, $9, now() + interval '1 millisecond')`,
      [randomUUID(), userId, normal.name, normal.event, normal.practice, randomUUID(), practice.name, practice.event, practice.practice],
    );
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

/** `solve.created` / `solve.updated` payload (SPEC section 8). */
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

/** `solve.deleted` payload (SPEC section 8). */
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
