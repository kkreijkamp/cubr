import pg from 'pg';
import type { QueryConfig, QueryResult, QueryResultRow } from 'pg';
import type { FastifyBaseLogger } from 'fastify';

// int8 (bigint / bigserial / count(*)) -> JS number. Our bigints (total ms, ids) stay < 2^53.
pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10));
// numeric -> number (used by avg()/percentile results)
pg.types.setTypeParser(1700, (v: string) => Number.parseFloat(v));
// date -> keep the 'YYYY-MM-DD' string (the default parser builds a local-midnight Date -> tz bugs)
pg.types.setTypeParser(1082, (v: string) => v);

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(
  databaseUrl: string,
  opts: { max?: number; log?: FastifyBaseLogger; queryTimeoutMs?: number } = {},
): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Without these, a database that vanishes without a TCP reset (e.g. a CloudNativePG
    // failover or a dead node) leaves queries hanging forever and exhausts the pool.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    query_timeout: opts.queryTimeoutMs ?? 30_000,
    statement_timeout: opts.queryTimeoutMs ?? 30_000,
    application_name: process.env.SERVICE_NAME ?? 'cubetype',
  });
  // An idle client erroring (e.g. Postgres failover) must not crash the process.
  pool.on('error', (err) => opts.log?.warn({ err }, 'postgres idle client error'));
  return pool;
}

/**
 * Query with a client-side timeout ("Query read timeout").
 *
 * Without it, a connection whose server vanished without a TCP reset (DB pod/VM gone behind a
 * port forwarder or a dead pod IP during failover) waits for the pool's 30 s query_timeout. Via
 * `pool.query` a timed-out client is released with the error, so the pool drops it instead of
 * keeping it checked out; callers holding a PoolClient must do `client.release(err)` themselves.
 */
export function queryWithTimeout<R extends QueryResultRow = QueryResultRow>(
  db: Pool | PoolClient,
  text: string,
  values: unknown[] = [],
  timeoutMs = 10_000,
): Promise<QueryResult<R>> {
  // `query_timeout` is honoured per query by pg but only typed on the connection config.
  return db.query<R>({ text, values, query_timeout: timeoutMs } as QueryConfig);
}

/** Below the 2 s deadline of readiness checks and _info (server.ts), so a timed-out query has already freed its client. */
export const PG_PING_TIMEOUT_MS = 1500;

/**
 * Postgres dependency check for /readyz and _info. A plain `pool.query('select 1')` against a
 * dead-but-open connection would keep its client for 30 s, so probes every few seconds plus
 * status-page polls could exhaust the pool and keep the service unready long after a failover.
 */
export function pingPostgres(pool: Pool): Promise<unknown> {
  return queryWithTimeout(pool, 'select 1', [], PG_PING_TIMEOUT_MS);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until Postgres accepts connections (useful at startup while the DB pod boots). */
export async function waitForPostgres(pool: pg.Pool, log?: FastifyBaseLogger, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 500;
  for (;;) {
    try {
      await pool.query('select 1');
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      log?.warn({ err: (err as Error).message }, `postgres not ready, retrying in ${delay}ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
    }
  }
}

export interface Migration {
  id: string;
  sql: string;
}

/**
 * Applies pending migrations for one schema. A Postgres advisory lock serialises concurrent
 * replicas starting at the same time; applied ids are tracked in <schema>.schema_migrations.
 */
export async function migrate(pool: pg.Pool, schema: string, migrations: Migration[], log?: FastifyBaseLogger): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', [`cubetype:migrate:${schema}`]);
    await client.query(`create schema if not exists ${schema}`);
    await client.query(
      `create table if not exists ${schema}.schema_migrations (id text primary key, applied_at timestamptz not null default now())`,
    );
    const { rows } = await client.query<{ id: string }>(`select id from ${schema}.schema_migrations`);
    const applied = new Set(rows.map((r) => r.id));
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      log?.info({ schema, migration: m.id }, 'applying migration');
      await client.query('begin');
      try {
        await client.query(m.sql);
        await client.query(`insert into ${schema}.schema_migrations (id) values ($1)`, [m.id]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(hashtext($1))', [`cubetype:migrate:${schema}`]).catch(() => {});
    client.release();
  }
}

/** Runs `fn` inside a transaction (commit on success, rollback on throw). */
export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch((e: Error) => {
      broken = e; // connection is unusable -> destroy it instead of returning it to the pool
    });
    throw err;
  } finally {
    client.release(broken);
  }
}
