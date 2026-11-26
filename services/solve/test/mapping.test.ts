import { describe, expect, it } from 'vitest';
import { toSession, toSolve, type SolveRow } from '../src/mapping.js';

const baseRow: SolveRow = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  session_id: '33333333-3333-4333-8333-333333333333',
  event: '333',
  time_ms: 9876,
  penalty: '+2',
  scramble: "R U R' U'",
  comment: null,
  source: 'timer',
  daily_date: null,
  daily_index: null,
  created_at: new Date('2026-10-14T01:02:03.456Z'),
};

describe('toSolve', () => {
  it('maps a row to the API Solve shape (camelCase, ISO dates, no user_id)', () => {
    expect(toSolve(baseRow)).toEqual({
      id: baseRow.id,
      sessionId: baseRow.session_id,
      event: '333',
      timeMs: 9876,
      penalty: '+2',
      scramble: "R U R' U'",
      comment: null,
      source: 'timer',
      createdAt: '2026-10-14T01:02:03.456Z',
      dailyDate: null,
      dailyIndex: null,
    });
  });

  it('keeps daily fields and comments', () => {
    const s = toSolve({ ...baseRow, source: 'daily', daily_date: '2026-10-14', daily_index: 4, comment: 'pb!' });
    expect(s.dailyDate).toBe('2026-10-14');
    expect(s.dailyIndex).toBe(4);
    expect(s.comment).toBe('pb!');
    expect(s).not.toHaveProperty('userId');
  });

  it('accepts string timestamps', () => {
    expect(toSolve({ ...baseRow, created_at: '2026-01-01T00:00:00+10:00' as unknown as Date }).createdAt).toBe('2025-12-31T14:00:00.000Z');
  });
});

describe('toSession', () => {
  it('maps a row and coerces solve_count', () => {
    expect(
      toSession({
        id: 'a',
        name: '3x3',
        event: '333',
        practice: true,
        created_at: new Date('2026-10-14T00:00:00Z'),
        updated_at: new Date('2026-10-14T00:00:01Z'),
        solve_count: 42,
      }),
    ).toEqual({
      id: 'a',
      name: '3x3',
      event: '333',
      practice: true,
      createdAt: '2026-10-14T00:00:00.000Z',
      updatedAt: '2026-10-14T00:00:01.000Z',
      solveCount: 42,
    });
  });

  it('defaults a missing count to 0', () => {
    const s = toSession({ id: 'a', name: 'x', event: '222', practice: false, created_at: new Date(0), updated_at: new Date(0) });
    expect(s.solveCount).toBe(0);
    expect(s.practice).toBe(false);
  });
});
