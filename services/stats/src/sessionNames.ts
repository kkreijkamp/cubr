import { fetchJson, internalHeaders, type Pool, type PoolClient } from '@cubetype/common';
import type { FastifyBaseLogger } from 'fastify';
import { sessionListSchema } from './eventSchemas.js';

const LOCK = 'stats:session-name-backfill';
const BATCH_USERS = 25;

/**
 * Self-healing read model for session display names. New solves carry their session's name in
 * solve.created, but solves that arrive through a bulk import (or predate this feature) don't -
 * so every 20 s one replica (advisory lock) finds users whose ledger references sessions without a
 * name and copies that user's session list from solve-service. Sessions solve-service doesn't know
 * are stored with name '' so they aren't fetched again (the UI shows a generic label).
 * The backfill only inserts missing names: a name that arrived through an event meanwhile (for
 * example a newer rename) always wins.
 */
export function startSessionNameBackfill(deps: { pool: Pool; solveUrl: string; internalToken: string; log: FastifyBaseLogger }): () => void {
  const { pool, solveUrl, internalToken, log } = deps;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** One pass; rejects when Postgres or solve-service is unreachable (the loop logs and retries). */
  async function tick(): Promise<void> {
    let c: PoolClient | undefined;
    let failed: Error | undefined;
    try {
      c = await pool.connect();
      const { rows: lock } = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [LOCK]);
      if (!lock[0]?.ok) return; // another replica is doing it
      try {
        const { rows } = await c.query<{ user_id: string }>(
          `SELECT DISTINCT l.user_id
             FROM stats.solve_ledger l
             LEFT JOIN stats.sessions s ON s.session_id = l.session_id
            WHERE NOT l.deleted AND s.session_id IS NULL
            LIMIT ${BATCH_USERS}`,
        );
        for (const { user_id: userId } of rows) {
          if (stopped) return;
          const res = sessionListSchema.parse(
            await fetchJson(`${solveUrl}/internal/users/${userId}/sessions`, { timeoutMs: 5000, headers: internalHeaders(internalToken) }),
          );
          for (const s of res.sessions) {
            await c.query(
              `INSERT INTO stats.sessions (session_id, user_id, event, name, practice) VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (session_id) DO NOTHING`,
              [s.id, userId, s.event, s.name, s.practice === true],
            );
          }
          // ledger sessions solve-service no longer has: remember them as unnamed so we don't loop
          await c.query(
            `INSERT INTO stats.sessions (session_id, user_id, event, name)
             SELECT DISTINCT l.session_id, l.user_id, l.event, ''
               FROM stats.solve_ledger l
               LEFT JOIN stats.sessions s ON s.session_id = l.session_id
              WHERE l.user_id = $1 AND NOT l.deleted AND s.session_id IS NULL
             ON CONFLICT (session_id) DO NOTHING`,
            [userId],
          );
        }
        if (rows.length) log.info({ users: rows.length }, 'backfilled session names');
      } finally {
        await c.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK]).catch(() => {});
      }
    } catch (err) {
      failed = err as Error;
      throw err;
    } finally {
      c?.release(failed); // a client that failed is discarded instead of going back to the pool
    }
  }

  // The pass is chained to its own timer: a failed pass is logged and the next one is always
  // scheduled, so a database blip can neither stop the loop nor crash the process.
  function scheduleNext(delayMs: number): void {
    timer = setTimeout(() => {
      tick()
        .catch((err) => log.warn({ err: (err as Error).message }, 'session name backfill failed (will retry)'))
        .finally(() => {
          if (!stopped) scheduleNext(20_000);
        });
    }, delayMs);
  }
  scheduleNext(5_000);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
