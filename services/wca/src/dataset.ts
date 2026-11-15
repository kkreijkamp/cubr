import type { Pool } from '@cubr/common';
import { PG_PING_TIMEOUT_MS, queryWithTimeout, unavailable } from '@cubr/common';

/**
 * Which WCA export is currently loaded. The importer (jobs/wca-import) owns the `wca` schema
 * and swaps in a new copy atomically; until it has run once, `wca.meta` does not exist and
 * every data route answers 503 "WCA data not loaded yet".
 */
export interface DatasetMeta {
  exportDate: string;
  exportVersion: string | null;
  importedAt: string;
  rowCounts: Record<string, number>;
  sizeBytes: number;
  /** Cache namespace: changes with every import, so a fresh import never serves stale cache. */
  cacheVersion: string;
}

const UNDEFINED_TABLE = '42P01';
const UNDEFINED_SCHEMA = '3F000';
const META_TTL_MS = 10_000;

interface MetaRow {
  export_date: Date;
  export_version: string | null;
  imported_at: Date;
  row_counts: Record<string, number>;
  size_bytes: number;
}

export function createDataset(pool: Pool) {
  let cached: { value: DatasetMeta | null; at: number } | null = null;

  /** Reads wca.meta (memoised for 10 s so routes don't pay an extra round trip). `timeoutMs` bounds the query. */
  async function meta(timeoutMs?: number): Promise<DatasetMeta | null> {
    if (cached && Date.now() - cached.at < META_TTL_MS) return cached.value;
    let value: DatasetMeta | null = null;
    try {
      const sql = 'SELECT export_date, export_version, imported_at, row_counts, size_bytes FROM wca.meta LIMIT 1';
      const { rows } = await (timeoutMs ? queryWithTimeout<MetaRow>(pool, sql, [], timeoutMs) : pool.query<MetaRow>(sql));
      const r = rows[0];
      if (r) {
        const exportDate = r.export_date.toISOString();
        value = {
          exportDate,
          exportVersion: r.export_version,
          importedAt: r.imported_at.toISOString(),
          rowCounts: r.row_counts,
          sizeBytes: Number(r.size_bytes),
          cacheVersion: `${exportDate.slice(0, 10)}.${Math.floor(r.imported_at.getTime() / 1000)}`,
        };
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== UNDEFINED_TABLE && code !== UNDEFINED_SCHEMA) throw err; // e.g. Postgres down
    }
    cached = { value, at: Date.now() };
    return value;
  }

  /** Meta of the loaded dataset, or 503 UNAVAILABLE when the importer has not run yet. */
  async function requireLoaded(): Promise<DatasetMeta> {
    const m = await meta();
    if (!m) throw unavailable('WCA data not loaded yet');
    return m;
  }

  /** Extra fields for GET /api/wca/_info. */
  async function info(): Promise<Record<string, unknown>> {
    try {
      // short timeout: a dead connection is dropped instead of held for 30 s by every status poll
      const m = await meta(PG_PING_TIMEOUT_MS);
      if (!m) return { dataLoaded: false };
      return {
        dataLoaded: true,
        wca: { exportDate: m.exportDate, exportVersion: m.exportVersion, importedAt: m.importedAt, counts: m.rowCounts },
      };
    } catch {
      return { dataLoaded: false };
    }
  }

  return { meta, requireLoaded, info };
}

export type Dataset = ReturnType<typeof createDataset>;
