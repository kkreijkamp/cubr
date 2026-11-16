import { describe, expect, it } from 'vitest';
import type { PoolClient } from '@cubr/common';
import { assertImportFits, exportChunks, MAX_SOLVES_PER_ACCOUNT } from '../src/routes/importExport.js';
import { toSession, toSolve, type SessionRow, type SolveRow } from '../src/mapping.js';

const U = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-16T06:00:00.000Z');

const session = (id: string, name: string, minute: number): SessionRow => ({
  id,
  name,
  event: '333',
  practice: false,
  created_at: new Date(Date.UTC(2026, 10, 1, 0, minute)),
  updated_at: new Date(Date.UTC(2026, 10, 2)),
  solve_count: 0,
});

const solve = (id: string, sessionId: string, at: string): SolveRow => ({
  id,
  user_id: U,
  session_id: sessionId,
  event: '333',
  time_ms: 9000 + Number(id.slice(-2)),
  penalty: 'OK',
  scramble: "R U R' U'",
  comment: null,
  source: 'timer',
  daily_date: null,
  daily_index: null,
  created_at: new Date(at),
});

/** In-memory stand-in for the two queries exportChunks makes (sessions, then keyset pages of solves). */
function fakeDb(sessions: SessionRow[], solves: SolveRow[]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const key = (s: SolveRow) => s.created_at.toISOString();
  const db = {
    async query(sql: string, params: unknown[]) {
      queries.push({ sql, params });
      if (!sql.includes('created_key')) return { rows: sessions }; // listSessions
      const [, sessionId, afterKey, afterId] = params as [string, string, string?, string?];
      const limit = Number(/LIMIT (\d+)/.exec(sql)![1]);
      const rows = solves
        .filter((s) => s.session_id === sessionId)
        .sort((a, b) => key(a).localeCompare(key(b)) || a.id.localeCompare(b.id))
        .filter((s) => afterKey === undefined || key(s) > afterKey || (key(s) === afterKey && s.id > afterId!))
        .slice(0, limit)
        .map((s) => ({ ...s, created_key: key(s) }));
      return { rows };
    },
  };
  return { db: db as unknown as PoolClient, queries };
}

/** What the old all-in-memory export returned. */
function expected(sessions: SessionRow[], solves: SolveRow[]) {
  const sorted = [...solves].sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id));
  return {
    exportedAt: NOW.toISOString(),
    sessions: sessions.map((s) => ({ ...toSession(s), solves: sorted.filter((v) => v.session_id === s.id).map(toSolve) })),
  };
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = '';
  for await (const chunk of gen) out += chunk;
  return out;
}

describe('exportChunks', () => {
  const s1 = session('aaaaaaaa-0000-4000-8000-000000000001', 'main', 0);
  const s2 = session('aaaaaaaa-0000-4000-8000-000000000002', 'empty', 1);
  const s3 = session('aaaaaaaa-0000-4000-8000-000000000003', 'oh "quotes"', 2);
  const solves = [
    solve('bbbbbbbb-0000-4000-8000-000000000011', s1.id, '2026-11-05T10:00:00.000Z'),
    solve('bbbbbbbb-0000-4000-8000-000000000012', s1.id, '2026-11-05T10:00:01.000Z'),
    solve('bbbbbbbb-0000-4000-8000-000000000013', s1.id, '2026-11-05T10:00:02.000Z'),
    // two solves in the same instant: ordered by id, neither skipped nor repeated across pages
    solve('bbbbbbbb-0000-4000-8000-000000000032', s3.id, '2026-11-06T09:00:00.000Z'),
    solve('bbbbbbbb-0000-4000-8000-000000000031', s3.id, '2026-11-06T09:00:00.000Z'),
    solve('bbbbbbbb-0000-4000-8000-000000000033', s3.id, '2026-11-06T09:00:05.000Z'),
    solve('bbbbbbbb-0000-4000-8000-000000000034', s3.id, '2026-11-06T09:00:06.000Z'),
  ];

  it('produces the same document as the old export, page by page', async () => {
    for (const batch of [1, 2, 3, 4, 100]) {
      const { db } = fakeDb([s1, s2, s3], solves);
      const text = await collect(exportChunks(db, U, batch, NOW));
      expect(JSON.parse(text), `batch ${batch}`).toEqual(expected([s1, s2, s3], solves));
    }
  });

  it('pages with a (created_at, id) cursor and stops on a short page', async () => {
    const { db, queries } = fakeDb([s1], solves);
    await collect(exportChunks(db, U, 2, NOW));
    const pages = queries.filter((q) => q.sql.includes('created_key'));
    expect(pages.map((q) => q.params.length)).toEqual([2, 4]); // first page, then one after the cursor
    expect(pages[1].params.slice(2)).toEqual(['2026-11-05T10:00:01.000Z', 'bbbbbbbb-0000-4000-8000-000000000012']);
  });

  it('handles an account without sessions', async () => {
    const { db } = fakeDb([], []);
    expect(JSON.parse(await collect(exportChunks(db, U, 10, NOW)))).toEqual({ exportedAt: NOW.toISOString(), sessions: [] });
  });
});

describe('assertImportFits', () => {
  it('allows filling the account up to the cap', () => {
    expect(() => assertImportFits(MAX_SOLVES_PER_ACCOUNT - 100_000, 100_000)).not.toThrow();
  });
  it('refuses an import that would pass it, with the numbers', () => {
    try {
      assertImportFits(200_000, 60_000);
      throw new Error('expected a 400');
    } catch (err) {
      expect((err as { statusCode: number }).statusCode).toBe(400);
      expect((err as Error).message).toMatch(/250,000 solves: this one has 200,000, and the import adds 60,000/);
    }
  });
});
