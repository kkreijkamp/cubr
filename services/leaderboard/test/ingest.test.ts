import { describe, expect, it } from 'vitest';
import { planPbUpdated, planSolveCreated, planUserInfo } from '../src/ingest.js';
import { parseUserInfo, splitWithScores } from '../src/board.js';

const U = '00000000-0000-4000-8000-000000000001';
const NOW = Date.parse('2026-10-14T12:00:00Z');

describe('planPbUpdated', () => {
  const base = { userId: U, username: 'a', event: '333', kind: 'single', occurredAt: '2026-10-14T11:00:00.000Z' };
  it('sets an exact value with achievedAt', () => {
    expect(planPbUpdated({ ...base, valueMs: 9876, achievedAt: '2026-10-13T10:00:00Z' }, NOW)).toEqual({
      board: 'lb:333:single:all',
      event: '333',
      kind: 'single',
      valueMs: 9876,
      achievedAt: '2026-10-13T10:00:00.000Z',
      occurredAtMs: Date.parse('2026-10-14T11:00:00Z'),
    });
  });
  it('removes on null / -1', () => {
    expect(planPbUpdated({ ...base, valueMs: null }, NOW)?.valueMs).toBeNull();
    expect(planPbUpdated({ ...base, valueMs: -1 }, NOW)?.valueMs).toBeNull();
  });
  it('ignores kinds/events without boards and garbage values', () => {
    expect(planPbUpdated({ ...base, kind: 'mo3', valueMs: 1 }, NOW)).toBeNull();
    expect(planPbUpdated({ ...base, kind: 'ao100', valueMs: 1 }, NOW)).toBeNull();
    expect(planPbUpdated({ ...base, event: '333fm', valueMs: 30 }, NOW)).toBeNull();
    expect(planPbUpdated({ ...base, event: 'nope', valueMs: 30 }, NOW)).toBeNull();
    expect(planPbUpdated({ ...base, valueMs: 0 }, NOW)).toBeNull();
    expect(planPbUpdated({ ...base, valueMs: 'x' }, NOW)).toBeNull();
  });
});

describe('planSolveCreated', () => {
  const base = { userId: U, username: 'a', event: '333', createdAt: '2026-10-14T10:00:00.000Z' };
  it('writes daily + weekly boards for single and rolling ao5 (UTC buckets)', () => {
    const w = planSolveCreated({ ...base, effectiveMs: 10500, rolling: { ao5: 11200, ao12: null } }, NOW);
    expect(w.map((x) => [x.board, x.valueMs, x.ttlSec])).toEqual([
      ['lb:333:single:d:2026-10-14', 10500, 3 * 86400],
      ['lb:333:single:w:2026-W42', 10500, 15 * 86400],
      ['lb:333:ao5:d:2026-10-14', 11200, 3 * 86400],
      ['lb:333:ao5:w:2026-W42', 11200, 15 * 86400],
    ]);
    expect(w[0].achievedAt).toBe('2026-10-14T10:00:00.000Z');
  });
  it('skips DNF singles and n/a / DNF averages', () => {
    expect(planSolveCreated({ ...base, effectiveMs: null, rolling: { ao5: -1 } }, NOW)).toEqual([]);
    expect(planSolveCreated({ ...base, effectiveMs: null, rolling: { ao5: null } }, NOW)).toEqual([]);
    expect(planSolveCreated({ ...base, effectiveMs: 9000 }, NOW)).toHaveLength(2);
  });
  it('skips solves older than the board lifetime', () => {
    const fiveDaysAgo = new Date(NOW - 5 * 86400_000).toISOString();
    const w = planSolveCreated({ ...base, createdAt: fiveDaysAgo, effectiveMs: 9000 }, NOW);
    expect(w.map((x) => x.board)).toEqual(['lb:333:single:w:2026-W41']);
    const old = new Date(NOW - 20 * 86400_000).toISOString();
    expect(planSolveCreated({ ...base, createdAt: old, effectiveMs: 9000 }, NOW)).toEqual([]);
  });
  it('skips 333fm', () => {
    expect(planSolveCreated({ ...base, event: '333fm', effectiveMs: 60000 }, NOW)).toEqual([]);
  });
});

describe('planUserInfo', () => {
  it('takes country only from user.* events', () => {
    expect(planUserInfo('user.updated', { userId: U, username: 'a', country: 'AU' })).toEqual({ userId: U, username: 'a', country: 'AU' });
    expect(planUserInfo('user.updated', { userId: U, username: 'a', country: null })).toEqual({ userId: U, username: 'a', country: null });
    expect(planUserInfo('solve.created', { userId: U, username: 'a', country: 'AU' })).toEqual({ userId: U, username: 'a' });
    expect(planUserInfo('solve.created', { userId: U })).toBeNull();
  });
});

describe('read helpers', () => {
  it('parseUserInfo tolerates missing / bad JSON', () => {
    expect(parseUserInfo('{"username":"x","country":"AU"}')).toEqual({ username: 'x', country: 'AU' });
    expect(parseUserInfo('{"username":"x"}')).toEqual({ username: 'x', country: null });
    expect(parseUserInfo(null)).toEqual({ username: 'unknown', country: null });
    expect(parseUserInfo('{bad')).toEqual({ username: 'unknown', country: null });
  });
  it('splitWithScores pairs members and scores', () => {
    expect(splitWithScores(['a', '100', 'b', '200'])).toEqual({ ids: ['a', 'b'], scores: [100, 200] });
  });
});
