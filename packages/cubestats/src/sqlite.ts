/**
 * Minimal read-only SQLite reader: every row of every table in a database file, enough to
 * import a DCTimer backup in the browser. Follows the documented file format
 * (https://www.sqlite.org/fileformat.html): table b-trees, varints, record serial types and
 * overflow pages. Indexes, WAL files and writes are out of scope.
 */
export type SqlValue = number | string | Uint8Array | null;

export class SqliteFormatError extends Error {}

const MAGIC = 'SQLite format 3\0';

export function isSqliteFile(bytes: Uint8Array): boolean {
  if (bytes.length < 100) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}

/** Rows of every table (by name). A NULL first column is replaced by the rowid: that is how an INTEGER PRIMARY KEY is stored. */
export function readSqliteTables(bytes: Uint8Array): Map<string, SqlValue[][]> {
  if (!isSqliteFile(bytes)) throw new SqliteFormatError('not an SQLite database');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rawPageSize = view.getUint16(16);
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
  const usable = pageSize - bytes[20];
  const encoding = view.getUint32(56);
  const decoder = new TextDecoder(encoding === 2 ? 'utf-16le' : encoding === 3 ? 'utf-16be' : 'utf-8');
  if (pageSize < 512 || usable < 480) throw new SqliteFormatError('invalid page size');

  const pageStart = (page: number): number => {
    const start = (page - 1) * pageSize;
    if (page < 1 || start + pageSize > bytes.length) throw new SqliteFormatError(`page ${page} is outside the file`);
    return start;
  };

  // varint: 1-9 bytes, big-endian 7-bit groups; the 9th byte contributes all 8 bits
  const varint = (pos: number): [value: number, next: number] => {
    let value = 0;
    for (let i = 0; i < 8; i++) {
      const b = bytes[pos + i];
      value = value * 128 + (b & 0x7f);
      if (b < 0x80) return [value, pos + i + 1];
    }
    return [value * 256 + bytes[pos + 8], pos + 9];
  };

  /** The whole payload of a table leaf cell, following its overflow chain. */
  const payload = (pos: number, size: number): Uint8Array => {
    const maxLocal = usable - 35;
    if (size <= maxLocal) return bytes.subarray(pos, pos + size);
    const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
    const k = minLocal + ((size - minLocal) % (usable - 4));
    const local = k <= maxLocal ? k : minLocal;
    const out = new Uint8Array(size);
    out.set(bytes.subarray(pos, pos + local));
    let filled = local;
    let next = view.getUint32(pos + local);
    const seen = new Set<number>();
    while (filled < size) {
      if (next === 0 || seen.has(next)) throw new SqliteFormatError('broken overflow chain');
      seen.add(next);
      const start = pageStart(next);
      const n = Math.min(usable - 4, size - filled);
      out.set(bytes.subarray(start + 4, start + 4 + n), filled);
      filled += n;
      next = view.getUint32(start);
    }
    return out;
  };

  const record = (data: Uint8Array): SqlValue[] => {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const local = (pos: number): [number, number] => {
      let value = 0;
      for (let i = 0; i < 8; i++) {
        const b = data[pos + i];
        value = value * 128 + (b & 0x7f);
        if (b < 0x80) return [value, pos + i + 1];
      }
      return [value * 256 + data[pos + 8], pos + 9];
    };
    const [headerSize, first] = local(0);
    const types: number[] = [];
    for (let p = first; p < headerSize; ) {
      const [t, next] = local(p);
      types.push(t);
      p = next;
    }
    const values: SqlValue[] = [];
    let p = headerSize;
    const int = (len: number): number => {
      if (len === 8) return Number(dv.getBigInt64(p));
      let v = 0;
      for (let i = 0; i < len; i++) v = v * 256 + data[p + i];
      const signBit = 2 ** (8 * len - 1);
      return v >= signBit ? v - 2 * signBit : v;
    };
    for (const t of types) {
      if (t === 0) values.push(null);
      else if (t >= 1 && t <= 6) {
        const len = [0, 1, 2, 3, 4, 6, 8][t];
        values.push(int(len));
        p += len;
      } else if (t === 7) {
        values.push(dv.getFloat64(p));
        p += 8;
      } else if (t === 8 || t === 9) values.push(t - 8);
      else if (t >= 12 && t % 2 === 0) {
        const n = (t - 12) / 2;
        values.push(data.slice(p, p + n));
        p += n;
      } else if (t >= 13) {
        const n = (t - 13) / 2;
        values.push(decoder.decode(data.subarray(p, p + n)));
        p += n;
      } else throw new SqliteFormatError(`unknown serial type ${t}`);
    }
    return values;
  };

  /** Every row of the table b-tree rooted at `page`, in rowid order. */
  const tableRows = (page: number, visited = new Set<number>()): SqlValue[][] => {
    if (visited.has(page)) throw new SqliteFormatError('b-tree cycle');
    visited.add(page);
    const start = pageStart(page);
    const header = page === 1 ? 100 : start; // page 1 starts with the 100-byte file header
    const type = bytes[header];
    const cells = view.getUint16(header + 3);
    const rows: SqlValue[][] = [];
    if (type === 0x0d) {
      for (let i = 0; i < cells; i++) {
        const [size, afterSize] = varint(start + view.getUint16(header + 8 + i * 2));
        const [rowid, afterRowid] = varint(afterSize);
        const row = record(payload(afterRowid, size));
        if (row.length > 0 && row[0] === null) row[0] = rowid;
        rows.push(row);
      }
    } else if (type === 0x05) {
      for (let i = 0; i < cells; i++) {
        const left = view.getUint32(start + view.getUint16(header + 12 + i * 2));
        rows.push(...tableRows(left, visited));
      }
      rows.push(...tableRows(view.getUint32(header + 8), visited));
    } else {
      throw new SqliteFormatError(`page ${page} is not a table b-tree page`);
    }
    return rows;
  };

  // sqlite_master: type, name, tbl_name, rootpage, sql
  const tables = new Map<string, SqlValue[][]>();
  for (const [type, name, , rootpage] of tableRows(1)) {
    if (type === 'table' && typeof name === 'string' && typeof rootpage === 'number' && rootpage > 0) {
      tables.set(name, tableRows(rootpage));
    }
  }
  return tables;
}
