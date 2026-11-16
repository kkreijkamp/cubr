import { describe, expect, it } from 'vitest';
import { isSqliteFile, readSqliteTables, SqliteFormatError, type SqlValue } from '../src/sqlite.js';
import { sqliteBytes, u32, withU32 } from './helpers/sqliteFile.js';

/** A table with `n` rows (id INTEGER PRIMARY KEY, label, n), enough for interior pages at page_size 512. */
function manyRows(n: number, pragmas: string[] = ['page_size = 512']): Uint8Array {
  return sqliteBytes((db) => {
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT, n INTEGER)');
    const ins = db.prepare('INSERT INTO t (label, n) VALUES (?, ?)');
    db.exec('BEGIN');
    for (let i = 1; i <= n; i++) ins.run(`row ${i}`, BigInt(i * 7));
    db.exec('COMMIT');
  }, pragmas);
}

const expectedRows = (n: number): SqlValue[][] => Array.from({ length: n }, (_, k) => [k + 1, `row ${k + 1}`, (k + 1) * 7]);

describe('isSqliteFile', () => {
  it('recognises a database by its 16-byte magic and a full 100-byte header', () => {
    const db = manyRows(1);
    expect(isSqliteFile(db)).toBe(true);
    expect(isSqliteFile(db.subarray(0, 99))).toBe(false);
    expect(isSqliteFile(new Uint8Array(100))).toBe(false);
    const text = new TextEncoder().encode('SQLite format 2\0'.padEnd(200, ' '));
    expect(isSqliteFile(text)).toBe(false);
  });

  it('readSqliteTables refuses anything else', () => {
    expect(() => readSqliteTables(new TextEncoder().encode('{"session1":[]}'.padEnd(200)))).toThrow(SqliteFormatError);
    expect(() => readSqliteTables(new Uint8Array(0))).toThrow('not an SQLite database');
  });
});

describe('readSqliteTables', () => {
  it('reads every record serial type: NULL, 1-8 byte integers (signed), floats, 0/1 constants, text and blobs', () => {
    const literals: [string, SqlValue][] = [
      ['NULL', null],
      ['0', 0],
      ['1', 1],
      ['127', 127],
      ['-128', -128],
      ['32767', 32767],
      ['-32768', -32768],
      ['8388607', 8388607],
      ['-8388608', -8388608],
      ['2147483647', 2147483647],
      ['-2147483648', -2147483648],
      ['1099511627776', 2 ** 40],
      ['-1099511627776', -(2 ** 40)],
      ['9007199254740991', Number.MAX_SAFE_INTEGER],
      ['-9007199254740991', Number.MIN_SAFE_INTEGER],
      ['1.5', 1.5],
      ['-0.25', -0.25],
      ['1e300', 1e300],
      ["''", ''],
      ["'café 三阶 \u{1f9ca}'", 'café 三阶 \u{1f9ca}'],
      ["'it''s'", "it's"],
      ["X''", new Uint8Array(0)],
      ["X'00FF7F80'", new Uint8Array([0x00, 0xff, 0x7f, 0x80])],
    ];
    const bytes = sqliteBytes((db) => {
      db.exec('CREATE TABLE v (k INTEGER PRIMARY KEY, x)');
      for (const [i, [sql]] of literals.entries()) db.exec(`INSERT INTO v (k, x) VALUES (${i + 1}, ${sql})`);
    });
    const rows = readSqliteTables(bytes).get('v');
    expect(rows).toEqual(literals.map(([, value], i) => [i + 1, value]));
  });

  it('puts the rowid in an INTEGER PRIMARY KEY column (stored as NULL), including key 0', () => {
    const bytes = sqliteBytes((db) => {
      db.exec('CREATE TABLE s (id INTEGER PRIMARY KEY, name TEXT)');
      db.exec("INSERT INTO s VALUES (42, 'answer'), (0, 'zero'), (2147483648, 'big')");
    });
    // rowid order
    expect(readSqliteTables(bytes).get('s')).toEqual([
      [0, 'zero'],
      [42, 'answer'],
      [2147483648, 'big'],
    ]);
  });

  // a negative rowid is a 9-byte varint, a 64-bit two's complement integer
  it('reads a negative rowid as the negative number it is', () => {
    const bytes = sqliteBytes((db) => {
      db.exec('CREATE TABLE s (id INTEGER PRIMARY KEY, name TEXT)');
      db.exec("INSERT INTO s VALUES (-5, 'minus five'), (1, 'one')");
    });
    expect(readSqliteTables(bytes).get('s')).toEqual([
      [-5, 'minus five'],
      [1, 'one'],
    ]);
  });

  it('walks interior pages and returns every row in rowid order', () => {
    const rows = readSqliteTables(manyRows(3000)).get('t');
    expect(rows).toHaveLength(3000);
    expect(rows).toEqual(expectedRows(3000));
  });

  it.each([
    ['512-byte pages', ['page_size = 512']],
    ['1 KiB pages', ['page_size = 1024']],
    ['4 KiB pages', ['page_size = 4096']],
    ['64 KiB pages (stored as 1 in the header)', ['page_size = 65536']],
    ['UTF-16le text', ['page_size = 512', "encoding = 'UTF-16le'"]],
    ['UTF-16be text', ['page_size = 512', "encoding = 'UTF-16be'"]],
    ['auto-vacuum (pointer-map pages)', ['page_size = 512', 'auto_vacuum = FULL']],
  ])('reads a database with %s', (_label, pragmas) => {
    const name = 'café 三阶';
    const bytes = sqliteBytes((db) => {
      db.exec('CREATE TABLE "täble" (id INTEGER PRIMARY KEY, name TEXT, note TEXT)');
      const ins = db.prepare('INSERT INTO "täble" (name, note) VALUES (?, ?)');
      for (let i = 0; i < 400; i++) ins.run(`${name} ${i}`, i % 50 === 0 ? 'n'.repeat(3000) : null);
    }, pragmas);
    const rows = readSqliteTables(bytes).get('täble');
    expect(rows).toHaveLength(400);
    expect(rows![0]).toEqual([1, `${name} 0`, 'n'.repeat(3000)]);
    expect(rows![399]).toEqual([400, `${name} 399`, null]);
    expect(rows!.filter((r) => r[2] !== null)).toHaveLength(8);
  });

  it('follows overflow chains for long text and blobs', () => {
    const text = Array.from({ length: 20_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    const blob = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 31) & 0xff);
    for (const pageSize of [512, 4096]) {
      const bytes = sqliteBytes((db) => {
        db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, t TEXT, b BLOB, tail TEXT)');
        db.prepare('INSERT INTO big (t, b, tail) VALUES (?, ?, ?)').run(text, blob, 'end');
        db.prepare('INSERT INTO big (t, b, tail) VALUES (?, ?, ?)').run('short', new Uint8Array([9]), 'end 2');
      }, [`page_size = ${pageSize}`]);
      const rows = readSqliteTables(bytes).get('big')!;
      expect(rows[0][1]).toBe(text);
      expect(rows[0][2]).toEqual(blob);
      expect(rows[0][3]).toBe('end'); // a column after the overflowing ones
      expect(rows[1]).toEqual([2, 'short', new Uint8Array([9]), 'end 2']);
    }
  });

  it('returns only live rows: deleted rows and dropped tables do not come back', () => {
    const bytes = sqliteBytes((db) => {
      db.exec('CREATE TABLE keep (id INTEGER PRIMARY KEY, v TEXT)');
      db.exec('CREATE TABLE gone (id INTEGER PRIMARY KEY, v TEXT)');
      const ins = db.prepare('INSERT INTO keep (v) VALUES (?)');
      for (let i = 1; i <= 300; i++) ins.run(`v${i}`);
      db.exec("INSERT INTO gone (v) VALUES ('secret')");
      db.exec('DELETE FROM keep WHERE id % 3 = 0');
      db.exec('DROP TABLE gone');
    }, ['page_size = 512']);
    const tables = readSqliteTables(bytes);
    expect([...tables.keys()]).toEqual(['keep']);
    const rows = tables.get('keep')!;
    expect(rows).toHaveLength(200);
    expect(rows.every((r) => (r[0] as number) % 3 !== 0)).toBe(true);
  });

  it('lists tables only (not indexes, views or triggers), each by its own name', () => {
    const bytes = sqliteBytes((db) => {
      db.exec('CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT)');
      db.exec('CREATE TABLE b (x, y)');
      db.exec('CREATE INDEX a_v ON a (v)');
      db.exec('CREATE VIEW av AS SELECT v FROM a');
      db.exec('CREATE TRIGGER a_t AFTER INSERT ON a BEGIN SELECT 1; END');
      db.exec("INSERT INTO a (v) VALUES ('one')");
      db.exec('INSERT INTO b VALUES (1, 2)');
    });
    const tables = readSqliteTables(bytes);
    expect([...tables.keys()].sort()).toEqual(['a', 'b']);
    expect(tables.get('a')).toEqual([[1, 'one']]);
    expect(tables.get('b')).toEqual([[1, 2]]);
  });

  it('returns an empty list for an empty table and no tables for an empty database', () => {
    expect(readSqliteTables(sqliteBytes((db) => db.exec('CREATE TABLE e (id INTEGER PRIMARY KEY)'))).get('e')).toEqual([]);
    const empty = sqliteBytes((db) => db.exec('CREATE TABLE tmp (x); DROP TABLE tmp'));
    expect(readSqliteTables(empty).size).toBe(0);
  });
});

describe('readSqliteTables on damaged files', () => {
  it('rejects an invalid page size or too many reserved bytes', () => {
    const good = manyRows(10);
    const tiny = good.slice();
    tiny.set([0x00, 0x80], 16); // 128-byte pages
    expect(() => readSqliteTables(tiny)).toThrow('invalid page size');
    const reserved = good.slice();
    reserved[20] = 100; // 512 - 100 usable bytes
    expect(() => readSqliteTables(reserved)).toThrow('invalid page size');
  });

  it('reports a truncated file instead of reading past its end', () => {
    const bytes = manyRows(500);
    expect(() => readSqliteTables(bytes.subarray(0, 512))).toThrow(/page \d+ is outside the file/);
    expect(() => readSqliteTables(bytes.subarray(0, bytes.length - 512))).toThrow(SqliteFormatError);
  });

  it('stops at a b-tree page that points back at itself', () => {
    let root = 0;
    const bytes = sqliteBytes((db) => {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)');
      const ins = db.prepare('INSERT INTO t (label) VALUES (?)');
      for (let i = 0; i < 500; i++) ins.run(`row ${i}`);
      root = Number((db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 't'").get() as { rootpage: number }).rootpage);
    }, ['page_size = 512']);
    const start = (root - 1) * 512;
    expect(bytes[start]).toBe(0x05); // precondition: the root is an interior page
    expect(() => readSqliteTables(withU32(bytes, start + 8, root))).toThrow('b-tree cycle');
  });

  it('stops at an overflow chain that loops or ends early', () => {
    const bytes = sqliteBytes((db) => {
      db.exec('CREATE TABLE big (t TEXT)');
      db.prepare('INSERT INTO big VALUES (?)').run('x'.repeat(5000));
    }, ['page_size = 512']);
    // page 2 is the table, its overflow pages follow from page 3 (each starts with the next page number)
    const first = 3 * 512 - 512;
    expect(u32(bytes, first)).toBe(4); // precondition
    expect(readSqliteTables(bytes).get('big')![0][0]).toHaveLength(5000);
    expect(() => readSqliteTables(withU32(bytes, first, 3))).toThrow('broken overflow chain');
    expect(() => readSqliteTables(withU32(bytes, first, 0))).toThrow('broken overflow chain');
    expect(() => readSqliteTables(withU32(bytes, first, 9999))).toThrow('page 9999 is outside the file');
  });

  it('refuses a page that is not a table b-tree page', () => {
    const bytes = manyRows(10);
    const broken = bytes.slice();
    broken[512] = 0x0a; // page 2 (the table) marked as an index leaf
    expect(() => readSqliteTables(broken)).toThrow('page 2 is not a table b-tree page');
  });
});
