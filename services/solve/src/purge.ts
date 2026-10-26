import { withTx, type EventEnvelope, type Pool } from '@cubetype/common';
import type { FastifyBaseLogger } from 'fastify';
import { uuid } from './schemas.js';

/** Event types the `solve` consumer group handles. */
export const PURGE_TYPES = ['user.deleted'];

/**
 * user.deleted (from auth): the account is gone, so its data goes too - its sessions (their
 * solves cascade), its daily-challenge attempts and any of its events still waiting in the outbox
 * (stats and leaderboard drop the user themselves). Re-deliveries find nothing left to delete.
 */
export function makeUserPurge({ pool, log }: { pool: Pool; log: FastifyBaseLogger }) {
  return async function handle(evt: EventEnvelope): Promise<void> {
    if (evt.type !== 'user.deleted') return;
    const userId = evt.data.userId;
    if (!uuid.safeParse(userId).success) {
      log.warn({ id: evt.id, userId }, 'user.deleted without a valid userId skipped');
      return;
    }
    const deleted = await withTx(pool, async (c) => {
      const attempts = await c.query('DELETE FROM solve.daily_attempts WHERE user_id = $1', [userId]);
      const solves = await c.query('DELETE FROM solve.solves WHERE user_id = $1', [userId]);
      const sessions = await c.query('DELETE FROM solve.sessions WHERE user_id = $1', [userId]);
      const outbox = await c.query(`DELETE FROM solve.outbox WHERE published_at IS NULL AND payload->>'userId' = $1`, [userId]);
      return { sessions: sessions.rowCount, solves: solves.rowCount, dailyAttempts: attempts.rowCount, outbox: outbox.rowCount };
    });
    log.info({ userId, ...deleted }, 'deleted the data of a deleted account');
  };
}
