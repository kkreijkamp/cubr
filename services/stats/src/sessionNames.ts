import { fetchJson, type Pool } from '@cubetype/common';
import type { FastifyBaseLogger } from 'fastify';
import { sessionListSchema } from './eventSchemas.js';
import { upsertSessionName } from './projector.js';

const LOCK = 'stats:session-name-backfill';
const BATCH_USERS = 25;

/**
 * Self-healing read model for session display names. New solves carry their session's name in
 * solve.created, but solves that arrive through a bulk import (or predate this feature) don't —
 * so every 20 s one replica (advisory lock) finds users whose ledger references sessions without a
 * name and copies that user's session list from solve-service. Sessions solve-service doesn't know
 * are stored with name '' so they aren't fetched again (the UI shows a generic label).
 */
export function startSessionNameBackfill(deps: { pool: Pool; solveUrl: string; log: FastifyBaseLogger }): () => void {
  const { pool, solveUrl, log } = deps;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    const c = await pool.connect();
    try {
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
          const res = sessionListSchema.parse(await fetchJson(`${solveUrl}/internal/users/${userId}/sessions`, { timeoutMs: 5000 }));
          const known = new Set<string>();
          for (const s of res.sessions) {
            known.add(s.id);
            await upsertSessionName(c, s.id, userId, s.event, s.name);
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
      log.warn({ err: (err as Error).message }, 'session name backfill failed (will retry)');
    } finally {
      c.release();
    }
  }

  const loop = async () => {
    if (stopped) return;
    await tick();
    if (!stopped) timer = setTimeout(loop, 20_000);
  };
  timer = setTimeout(loop, 5_000);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
