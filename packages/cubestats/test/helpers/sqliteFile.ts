import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Builds a real SQLite database file with node:sqlite and returns its bytes. `pragmas` run before
 * anything is created (page_size, encoding and auto_vacuum only take effect on an empty file).
 * Note: node:sqlite binds a JS number as REAL unless the column has INTEGER/NUMERIC affinity; use
 * a BigInt or an SQL literal for an integer in an untyped column.
 */
export function sqliteBytes(build: (db: DatabaseSync) => void, pragmas: string[] = []): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'cubr-sqlite-test-'));
  try {
    const file = join(dir, 'test.db');
    const db = new DatabaseSync(file);
    try {
      for (const p of pragmas) db.exec(`PRAGMA ${p}`);
      build(db);
    } finally {
      db.close();
    }
    return new Uint8Array(readFileSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Big-endian u32 at `offset` (SQLite stores page numbers this way). */
export const u32 = (bytes: Uint8Array, offset: number): number => new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset);

/** A copy of `bytes` with a big-endian u32 written at `offset`. */
export function withU32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(offset, value);
  return copy;
}

/** DCTimer's tables (as in its SQLite backups): sessions, and results in the current and the old layouts. */
export const DCTIMER_SCHEMA = {
  sessiontb: 'CREATE TABLE sessiontb (id INTEGER PRIMARY KEY, name TEXT)',
  resultstb: 'CREATE TABLE resultstb (id INTEGER PRIMARY KEY, sid INTEGER, rtime INTEGER, p1 INTEGER, p2 INTEGER, scr TEXT, time TEXT, note TEXT)',
  /** old layout: one table per session (resulttb = session 1, result<N> = session N) */
  oldResults: (table: string) => `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, rtime INTEGER, p1 INTEGER, p2 INTEGER, scr TEXT, time TEXT, note TEXT)`,
};
