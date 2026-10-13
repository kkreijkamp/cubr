import type { FastifyBaseLogger } from 'fastify';
import { publishEvent, type Pool, type PoolClient, type Redis } from '@cubetype/common';

/**
 * Transactional outbox (docs/SPEC.md §7.2, §9.3).
 *
 * Route handlers call `enqueue(client, type, payload)` inside the SAME transaction that writes
 * the solve, so an event exists if and only if the write committed. A background relay in every
 * replica then moves unpublished rows to the Redis stream. If Redis is down, solves still
 * succeed; events pile up in the table and are delivered once Redis is back (at-least-once —
 * consumers dedupe on `eventId` = `solve-<outboxId>`).
 */

export type OutboxType = 'solve.created' | 'solve.updated' | 'solve.deleted' | 'session.deleted';

export async function enqueue(client: PoolClient, type: OutboxType, payload: Record<string, unknown>): Promise<void> {
  // occurredAt = when the change happened, not when the relay got round to publishing it.
  const data = { ...payload, occurredAt: new Date().toISOString() };
  await client.query('INSERT INTO solve.outbox (type, payload) VALUES ($1, $2::jsonb)', [type, JSON.stringify(data)]);
}

export interface RelayOptions {
  pool: Pool;
  redis: Redis;
  log: FastifyBaseLogger;
  intervalMs?: number;
  batchSize?: number;
  maxBackoffMs?: number;
  /** Published rows older than this are deleted by the cleanup loop. */
  retentionMs?: number;
  cleanupEveryMs?: number;
}

export interface RelayInfo {
  backlog: number | null;
  published: number;
  lastPublishedAt: string | null;
  lastError: string | null;
  healthy: boolean;
}

export interface Relay {
  stop(): Promise<void>;
  info(): Promise<RelayInfo>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Rejects if `p` takes longer than `ms` (a paused/partitioned Redis makes commands hang). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function startOutboxRelay(opts: RelayOptions): Relay {
  const { pool, redis, log } = opts;
  const intervalMs = opts.intervalMs ?? 250;
  const batchSize = opts.batchSize ?? 500;
  const maxBackoffMs = opts.maxBackoffMs ?? 5000;
  const retentionMs = opts.retentionMs ?? 24 * 3600 * 1000;
  const cleanupEveryMs = opts.cleanupEveryMs ?? 10 * 60 * 1000;

  let running = true;
  let published = 0;
  let lastPublishedAt: string | null = null;
  let lastError: string | null = null;
  let healthy = true;
  let lastWarn = 0;
  let wake: (() => void) | null = null;

  /** Interruptible sleep so stop() does not wait for a 5 s backoff. */
  const nap = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(t);
        wake = null;
        resolve();
      };
    });

  /** One relay pass: claim up to `batchSize` rows, XADD them in order, mark them published. */
  async function relayOnce(): Promise<number> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // SKIP LOCKED: several replicas relay concurrently without blocking or double-claiming.
      const { rows } = await client.query<{ id: number; type: string; payload: Record<string, unknown> }>(
        `SELECT id, type, payload FROM solve.outbox
          WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );
      if (rows.length > 0) {
        // Probe first: if Redis is unreachable we don't queue XADDs that would replay later.
        await withTimeout(redis.ping(), 1000, 'redis ping');
        for (const row of rows) {
          await withTimeout(publishEvent(redis, row.type, { ...row.payload, eventId: `solve-${row.id}` }), 5000, 'redis xadd');
        }
        await client.query('UPDATE solve.outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
      }
      await client.query('COMMIT');
      client.release();
      if (rows.length > 0) {
        published += rows.length;
        lastPublishedAt = new Date().toISOString();
      }
      return rows.length;
    } catch (err) {
      // Roll back so the claimed rows stay unpublished and are retried on the next pass. If even
      // the rollback fails the connection is unusable: release(err) makes the pool drop it.
      let connOk = true;
      await client.query('ROLLBACK').catch(() => {
        connOk = false;
      });
      client.release(connOk ? undefined : (err as Error));
      throw err;
    }
  }

  const relayLoop = (async () => {
    let backoff = intervalMs;
    while (running) {
      try {
        const n = await relayOnce();
        if (!healthy) log.info('outbox relay recovered, publishing backlog');
        healthy = true;
        lastError = null;
        backoff = intervalMs;
        if (n === batchSize) continue; // backlog: drain without waiting
        await nap(intervalMs);
      } catch (err) {
        if (!running) break;
        healthy = false;
        lastError = (err as Error).message;
        const now = Date.now();
        if (now - lastWarn > 10_000) {
          lastWarn = now;
          const backlog = await countBacklog();
          log.warn({ err: lastError, backlog }, 'outbox relay failed; solves are still accepted, will retry');
        }
        backoff = Math.min(Math.max(backoff * 2, 500), maxBackoffMs);
        await nap(backoff);
      }
    }
  })();

  async function cleanup() {
    const res = await pool.query(
      `DELETE FROM solve.outbox WHERE published_at IS NOT NULL AND published_at < now() - make_interval(secs => $1)`,
      [retentionMs / 1000],
    );
    if (res.rowCount) log.info({ deleted: res.rowCount }, 'outbox cleanup');
  }
  const cleanupTimer = setInterval(() => {
    cleanup().catch((err) => log.warn({ err: (err as Error).message }, 'outbox cleanup failed'));
  }, cleanupEveryMs);
  cleanupTimer.unref();

  /** Unpublished rows, or null if Postgres doesn't answer within 1.5 s (keeps _info snappy). */
  async function countBacklog(): Promise<number | null> {
    const query = pool.query<{ n: number }>('SELECT count(*) AS n FROM solve.outbox WHERE published_at IS NULL');
    return withTimeout(query, 1500, 'backlog count').then((r) => r.rows[0].n, () => null);
  }

  return {
    async stop() {
      running = false;
      clearInterval(cleanupTimer);
      wake?.();
      // Let an in-flight pass finish (bounded by the Redis/Postgres timeouts above).
      await Promise.race([relayLoop, sleep(6000)]);
    },
    async info() {
      return {
        backlog: await countBacklog(),
        published,
        lastPublishedAt,
        lastError,
        healthy,
      };
    },
  };
}
