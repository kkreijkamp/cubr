import { describe, expect, it } from 'vitest';
import { chunk, IMPORT_CHUNK_SIZE, leaveOutExisting, planImport, toColumns } from '../src/importer.js';
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
        practice: false,
        solves: [
          { timeMs: 9000, penalty: 'OK', scramble: 'R', createdAt: '2020-01-01T00:00:00.000Z' },
          { timeMs: 9500, penalty: 'DNF', scramble: 'U', comment: 'oops', createdAt: '2020-01-01T00:01:00.000Z' },
        ],
      },
      { name: 'empty', event: '444', practice: false, solves: [] },
      { name: 'two', event: '222', practice: true, solves: [{ timeMs: 3000, penalty: '+2', scramble: '', createdAt: '2020-01-02T00:00:00.000Z' }] },
    ],
  };

  it('assigns ids, links solves to their new session, collects events with solves', () => {
    let n = 0;
    const plan = planImport(body, () => `id-${n++}`);
    expect(plan.sessions.map((s) => [s.id, s.name, s.event, s.practice])).toEqual([
      ['id-0', 'main', '333', false],
      ['id-3', 'empty', '444', false],
      ['id-4', 'two', '222', true],
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
          practice: false,
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

describe('leaveOutExisting', () => {
  let n = 0;
  const ids = () => `id-${++n}`;
  const body: ImportBody = {
    sessions: [
      {
        name: 'main',
        event: '333',
        practice: false,
        solves: [1, 2, 3, 4].map((i) => ({ timeMs: i * 1000, penalty: 'OK' as const, scramble: '', createdAt: `2026-01-0${i}T00:00:00Z` })),
      },
      { name: 'oh', event: '333oh', practice: false, solves: [{ timeMs: 20_000, penalty: 'OK' as const, scramble: '', createdAt: '2026-01-05T00:00:00Z' }] },
    ],
  };

  it('changes nothing when the account has none of the solves', () => {
    const plan = planImport(body, ids);
    expect(leaveOutExisting(plan, new Map())).toEqual({ ...plan, skipped: 0, continued: 0 });
  });

  it("continues the session that already holds some of a session's solves, with only the rest", () => {
    const plan = planImport(body, ids);
    // the account has main's first two solves, in its session "old"
    const out = leaveOutExisting(
      plan,
      new Map([
        [0, 'old'],
        [1, 'old'],
      ]),
    );
    expect(out.skipped).toBe(2);
    expect(out.continued).toBe(1);
    expect(out.sessions.map((x) => x.name)).toEqual(['oh']); // main isn't created again
    expect(out.rows.map((r) => [r.timeMs, r.sessionId === 'old'])).toEqual([
      [3000, true],
      [4000, true],
      [20_000, false],
    ]);
    expect(out.events.sort()).toEqual(['333', '333oh']);
  });

  it('adds nothing for a file imported before, and goes with the session holding most of the solves', () => {
    const plan = planImport(body, ids);
    const all = leaveOutExisting(plan, new Map(plan.rows.map((_, i) => [i, i === 0 ? 'b' : 'a'])));
    expect(all).toMatchObject({ sessions: [], rows: [], events: [], skipped: 5, continued: 0 });
    const split = leaveOutExisting(
      plan,
      new Map([
        [0, 'b'],
        [1, 'a'],
        [2, 'a'],
      ]),
    );
    expect(split.rows).toEqual([expect.objectContaining({ timeMs: 4000, sessionId: 'a' }), expect.objectContaining({ timeMs: 20_000 })]);
  });
});
