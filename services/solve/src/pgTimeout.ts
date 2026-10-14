import type { QueryConfig, QueryResult, QueryResultRow } from 'pg';
import type { Pool, PoolClient } from '@cubetype/common';

/**
 * Query with a client-side timeout ("Query read timeout").
 *
 * Without it, a connection whose server vanished without a TCP reset (DB pod/VM gone behind a
 * port forwarder or a dead pod IP during failover) waits forever. Via `pool.query` a timed-out
 * client is released with the error, so the pool drops it instead of leaking it; callers holding
 * a PoolClient must do `client.release(err)` themselves.
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
