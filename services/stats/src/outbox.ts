import { publishEvent, withTx, type Pool, type Redis } from '@cubetype/common';
import type { FastifyBaseLogger } from 'fastify';

const BATCH = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PbRelay {
  /** Publishes queued pb.updated events (oldest first). Returns how many were published. */
  flush(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
  pending(): Promise<number | null>;
}

/**
 * Relays stats.pb_outbox → Redis stream `cubetype:events` as `pb.updated`.
 * Only one replica relays at a time (transaction-scoped advisory lock), which keeps events in
 * order. Rows are deleted only after XADD succeeded, so a crash or Redis outage can cause a
 * re-publish (same eventId — consumers are idempotent) but never a lost event.
 */
export function createPbRelay(pool: Pool, redis: Redis, log: FastifyBaseLogger, intervalMs = 1000): PbRelay {
  let busy = false;
  let running = false;
  let loop: Promise<void> | null = null;

  /** One batch; `more` = a full batch went out and there may be more rows waiting. */
  async function flushBatch(): Promise<{ published: number; more: boolean }> {
    return withTx(pool, async (c) => {
      const { rows: lock } = await c.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtext($1), 0) AS ok',
        ['cubetype:stats:pb-outbox'],
      );
      if (!lock[0].ok) return { published: 0, more: false }; // another replica is relaying right now
      const { rows } = await c.query<{ id: number; payload: Record<string, unknown> }>(
        'SELECT id, payload FROM stats.pb_outbox ORDER BY id LIMIT $1',
        [BATCH],
      );
      const done: number[] = [];
      let failure: unknown = null;
      for (const r of rows) {
        try {
          await publishEvent(redis, 'pb.updated', r.payload);
          done.push(r.id);
        } catch (err) {
          failure = err;
          break;
        }
      }
      if (done.length) await c.query('DELETE FROM stats.pb_outbox WHERE id = ANY($1::bigint[])', [done]);
      if (failure) log.warn({ err: (failure as Error).message, pending: rows.length - done.length }, 'pb.updated publish failed, will retry');
      return { published: done.length, more: !failure && rows.length === BATCH };
    });
  }

  async function flush(): Promise<number> {
    if (busy) return 0;
    busy = true;
    let total = 0;
    try {
      for (;;) {
        const { published, more } = await flushBatch();
        total += published;
        if (!more) return total;
      }
    } finally {
      busy = false;
    }
  }

  return {
    flush,
    start() {
      if (running) return;
      running = true;
      loop = (async () => {
        while (running) {
          try {
            const n = await flush();
            if (n > 0) log.debug({ published: n }, 'relayed pb.updated events');
          } catch (err) {
            log.warn({ err: (err as Error).message }, 'pb outbox relay error');
          }
          await sleep(intervalMs);
        }
      })();
    },
    async stop() {
      running = false;
      await Promise.race([loop, sleep(3000)]);
    },
    async pending() {
      try {
        const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM stats.pb_outbox');
        return rows[0].n;
      } catch {
        return null;
      }
    },
  };
}

/** Hourly cleanup of the event de-duplication table (entries older than 30 days). */
export function startMaintenance(pool: Pool, log: FastifyBaseLogger): () => void {
  const timer = setInterval(() => {
    pool
      .query(`DELETE FROM stats.processed_events WHERE processed_at < now() - interval '30 days'`)
      .then((r) => r.rowCount && log.info({ deleted: r.rowCount }, 'pruned processed_events'))
      .catch((err) => log.warn({ err: (err as Error).message }, 'processed_events prune failed'));
  }, 3_600_000);
  timer.unref();
  return () => clearInterval(timer);
}
