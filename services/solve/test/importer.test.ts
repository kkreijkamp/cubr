import { describe, expect, it } from 'vitest';
import { chunk, IMPORT_CHUNK_SIZE, planImport, toColumns } from '../src/importer.js';
import type { ImportBody } from '../src/schemas.js';

describe('chunk', () => {
  it('splits into fixed-size chunks with a short tail', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
  });

  it('covers 100 000 rows in 50 chunks of 2000 without losing any', () => {
    const rows = Array.from({ length: 100_000 }, (_, i) => i);
    const parts = chunk(rows, IMPORT_CHUNK_SIZE);
    expect(parts).toHaveLength(50);
    expect(parts.every((p) => p.length === 2000)).toBe(true);
    expect(parts.flat()).toEqual(rows);
  });

  it('rejects a non-positive size', () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe('planImport', () => {
  const body: ImportBody = {
    sessions: [
      {
        name: 'main',
        event: '333',
        solves: [
          { timeMs: 9000, penalty: 'OK', scramble: 'R', createdAt: '2020-01-01T00:00:00.000Z' },
          { timeMs: 9500, penalty: 'DNF', scramble: 'U', comment: 'oops', createdAt: '2020-01-01T00:01:00.000Z' },
        ],
      },
      { name: 'empty', event: '444', solves: [] },
      { name: 'two', event: '222', solves: [{ timeMs: 3000, penalty: '+2', scramble: '', createdAt: '2020-01-02T00:00:00.000Z' }] },
    ],
  };

  it('assigns ids, links solves to their new session, collects events with solves', () => {
    let n = 0;
    const plan = planImport(body, () => `id-${n++}`);
    expect(plan.sessions.map((s) => [s.id, s.name, s.event])).toEqual([
      ['id-0', 'main', '333'],
      ['id-3', 'empty', '444'],
      ['id-4', 'two', '222'],
    ]);
    expect(plan.rows.map((r) => [r.id, r.sessionId, r.event])).toEqual([
      ['id-1', 'id-0', '333'],
      ['id-2', 'id-0', '333'],
      ['id-5', 'id-4', '222'],
    ]);
    expect(plan.rows[0].comment).toBeNull();
    expect(plan.rows[1].comment).toBe('oops');
    expect(plan.events).toEqual(['333', '222']); // '444' had no solves
  });

  it('uses random UUIDs by default', () => {
    const plan = planImport(body);
    expect(new Set([...plan.sessions.map((s) => s.id), ...plan.rows.map((r) => r.id)]).size).toBe(6);
    expect(plan.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('toColumns', () => {
  it('produces one array per column in row order (for unnest)', () => {
    const plan = planImport({
      sessions: [
        {
          name: 's',
          event: '333',
          solves: [
            { timeMs: 1, penalty: 'OK', scramble: 'a"b\\c', createdAt: 'T1' },
            { timeMs: 2, penalty: '+2', scramble: '', comment: 'x', createdAt: 'T2' },
          ],
        },
      ],
    });
    const c = toColumns(plan.rows);
    expect(c.timeMs).toEqual([1, 2]);
    expect(c.penalty).toEqual(['OK', '+2']);
    expect(c.scramble).toEqual(['a"b\\c', '']);
    expect(c.comment).toEqual([null, 'x']);
    expect(c.createdAt).toEqual(['T1', 'T2']);
    expect(c.id).toEqual(plan.rows.map((r) => r.id));
    expect(new Set(c.sessionId).size).toBe(1);
  });
});
