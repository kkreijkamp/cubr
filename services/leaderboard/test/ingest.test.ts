import { describe, expect, it } from 'vitest';
import { FALLBACK_FLOORS, FloorProvider, floorFor, isBelowFloor, parseRecords } from '../src/floors.js';
import { planDailyResult, planPbUpdated, planPeriodRefresh, planSolveCreated, planUserInfo } from '../src/ingest.js';
import { parsePeriodBests } from '../src/periods.js';
import { toBoardWrite } from '../src/rebuild.js';
import { parseUserInfo, splitWithScores } from '../src/board.js';

const U = '00000000-0000-4000-8000-000000000001';
const NOW = Date.parse('2026-10-14T12:00:00Z');
const silentLog = { info() {}, warn() {}, error() {}, debug() {} } as never;

describe('anti-cheat floors', () => {
  it('uses WCA records when present (average for ao5/ao12)', () => {
    const recs = { '333': { single: 3050, average: 3900 } };
    expect(floorFor('333', 'single', recs)).toBe(3050);
    expect(floorFor('333', 'ao5', recs)).toBe(3900);
    expect(floorFor('333', 'ao12', recs)).toBe(3900);
  });
  it('falls back to the hard-coded table', () => {
    expect(floorFor('333', 'single', null)).toBe(1800);
    expect(floorFor('333', 'ao5', null)).toBe(2600);
    expect(floorFor('pyram', 'single', { pyram: { single: null, average: 1500 } })).toBe(520);
    expect(floorFor('333fm', 'single', null)).toBeNull();
    expect(Object.keys(FALLBACK_FLOORS)).toHaveLength(15);
  });
  it('keeps the fallback table below the WCA records', () => {
    // records (ms) in the WCA export of 2026-10-15
    const records: Record<string, [number, number]> = {
      '222': [390, 860], '333': [2510, 3510], '444': [15180, 18560], '555': [29490, 33190], '666': [57690, 61760],
    };
    for (const [event, [single, average]] of Object.entries(records)) {
      expect(FALLBACK_FLOORS[event].single).toBeLessThan(single);
      expect(FALLBACK_FLOORS[event].average).toBeLessThan(average);
    }
  });
  it('is strict: equal to the floor passes', () => {
    expect(isBelowFloor(2999, 3000)).toBe(true);
    expect(isBelowFloor(3000, 3000)).toBe(false);
    expect(isBelowFloor(1, null)).toBe(false);
  });
  it('parses /internal/records defensively', () => {
    expect(parseRecords({ records: { '333': { single: 3050, average: null }, x: 5 } })).toEqual({
      '333': { single: 3050, average: null },
    });
    expect(parseRecords({})).toBeNull();
    expect(parseRecords(null)).toBeNull();
  });
  it('FloorProvider caches records and falls back when wca is down', async () => {
    let calls = 0;
    const up = new FloorProvider('http://wca', '', silentLog, 3_600_000, 60_000, async () => {
      calls++;
      return { records: { '333': { single: 3050, average: 3900 } } };
    });
    expect(await up.floor('333', 'single')).toBe(3050);
    expect(await up.floor('333', 'ao5')).toBe(3900);
    expect(calls).toBe(1);
    expect(up.source).toBe('wca');

    const down = new FloorProvider('http://wca', '', silentLog, 3_600_000, 60_000, async () => {
      calls++;
      throw new Error('ECONNREFUSED');
    });
    expect(await down.floor('333', 'single')).toBe(1800);
    expect(await down.floor('222', 'ao5')).toBe(640);
    expect(calls).toBe(2); // second call within the retry window doesn't refetch
    expect(down.source).toBe('fallback');
  });
  it('FloorProvider sends the internal token to wca', async () => {
    let headers: Record<string, string> | undefined;
    const p = new FloorProvider('http://wca', 'secret', silentLog, 3_600_000, 60_000, async (_url, opts) => {
      headers = opts?.headers;
      return { records: {} };
    });
    await p.floor('333', 'single');
    expect(headers).toEqual({ 'x-internal-token': 'secret' });
  });
});

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
  it('skips a practice session\'s solves', () => {
    const solve = { ...base, effectiveMs: 6000, rolling: { ao5: 7000, ao12: null } };
    expect(planSolveCreated({ ...solve, practice: true }, NOW)).toEqual([]);
    expect(planSolveCreated({ ...solve, practice: false }, NOW)).toHaveLength(4);
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

describe('planDailyResult', () => {
  const d = { userId: U, username: 'a', date: '2026-10-14', event: '222', ao5: 3456, occurredAt: '2026-10-14T09:00:00Z' };
  it('writes the exact ao5 to the challenge board', () => {
    expect(planDailyResult(d, NOW)).toEqual({
      board: 'lb:dc:2026-10-14:222',
      event: '222',
      kind: 'ao5',
      valueMs: 3456,
      achievedAt: '2026-10-14T09:00:00.000Z',
      occurredAtMs: Date.parse('2026-10-14T09:00:00Z'),
    });
  });
  it('removes the entry for a DNF ao5 (a penalty marked after the solve can cause one)', () => {
    expect(planDailyResult({ ...d, ao5: -1 }, NOW)).toMatchObject({ board: 'lb:dc:2026-10-14:222', valueMs: null });
    expect(planDailyResult({ ...d, ao5: null }, NOW)).toMatchObject({ valueMs: null });
  });
  it('ignores bad payloads instead of deleting', () => {
    expect(planDailyResult({ ...d, date: '14/10/2026' }, NOW)).toBeNull();
    expect(planDailyResult({ ...d, event: '333fm' }, NOW)).toBeNull();
    expect(planDailyResult({ ...d, ao5: 'fast' }, NOW)).toBeNull();
    expect(planDailyResult({ ...d, ao5: 0 }, NOW)).toBeNull();
  });
  it('falls back to now without occurredAt', () => {
    const { occurredAt: _o, ...rest } = d;
    expect(planDailyResult(rest, NOW)).toMatchObject({ occurredAtMs: NOW, achievedAt: new Date(NOW).toISOString() });
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

describe('rebuild / read helpers', () => {
  it('toBoardWrite validates stats PB rows', () => {
    const pb = { userId: U, username: 'a', event: '333', kind: 'ao5', valueMs: 12000, achievedAt: '2026-10-01T00:00:00Z' };
    expect(toBoardWrite(pb, 'ao5')).toEqual({ board: 'lb:333:ao5:all', valueMs: 12000, achievedAt: '2026-10-01T00:00:00.000Z' });
    expect(toBoardWrite({ ...pb, kind: 'single' }, 'ao5')).toBeNull();
    expect(toBoardWrite({ ...pb, valueMs: -1 }, 'ao5')).toBeNull();
    expect(toBoardWrite({ ...pb, event: '333fm' }, 'ao5')).toBeNull();
  });
  it('parseUserInfo tolerates missing / bad JSON', () => {
    expect(parseUserInfo('{"username":"x","country":"AU"}')).toEqual({ username: 'x', country: 'AU', avatarUrl: null });
    expect(parseUserInfo('{"username":"x"}')).toEqual({ username: 'x', country: null, avatarUrl: null });
    expect(parseUserInfo(null)).toEqual({ username: 'unknown', country: null, avatarUrl: null });
    expect(parseUserInfo('{bad')).toEqual({ username: 'unknown', country: null, avatarUrl: null });
  });
  it('parseUserInfo only passes through same-origin avatar paths', () => {
    expect(parseUserInfo(`{"username":"x","avatarUrl":"/api/users/${U}/avatar?v=abc123"}`).avatarUrl).toBe(`/api/users/${U}/avatar?v=abc123`);
    expect(parseUserInfo('{"username":"x","avatarUrl":"https://evil.example/x.png"}').avatarUrl).toBeNull();
  });
  it('planUserInfo carries avatarUrl from user.* events and rejects foreign URLs', () => {
    const ok = planUserInfo('user.updated', { userId: U, username: 'x', avatarUrl: `/api/users/${U}/avatar?v=abc123def456` });
    expect(ok?.avatarUrl).toBe(`/api/users/${U}/avatar?v=abc123def456`);
    expect(planUserInfo('user.updated', { userId: U, username: 'x', avatarUrl: 'javascript:alert(1)' })?.avatarUrl).toBeNull();
    expect(planUserInfo('user.updated', { userId: U, username: 'x', avatarUrl: null })?.avatarUrl).toBeNull();
    expect(planUserInfo('solve.created', { userId: U, username: 'x', avatarUrl: 'x' })).not.toHaveProperty('avatarUrl');
  });
  it('splitWithScores pairs members and scores', () => {
    expect(splitWithScores(['a', '100', 'b', '200'])).toEqual({ ids: ['a', 'b'], scores: [100, 200] });
  });
});

describe('planPeriodRefresh (periods.changed)', () => {
  const live = { days: ['2026-11-17', '2026-11-16'], weeks: ['2026-W47'] };
  const at = '2026-11-16T14:00:00.000Z';

  it("writes stats' best for every live day and week, and an empty entry where stats has none", () => {
    const writes = planPeriodRefresh('333', { days: { '2026-11-16': { single: { valueMs: 17_711, achievedAt: at } } }, weeks: { '2026-W47': { single: { valueMs: 17_711, achievedAt: at }, ao5: { valueMs: 20_122, achievedAt: at } } } }, live);
    expect(writes).toEqual([
      { board: 'lb:333:single:d:2026-11-17', kind: 'single', valueMs: null, achievedAt: '', ttlSec: 3 * 86_400 },
      { board: 'lb:333:ao5:d:2026-11-17', kind: 'ao5', valueMs: null, achievedAt: '', ttlSec: 3 * 86_400 },
      { board: 'lb:333:single:d:2026-11-16', kind: 'single', valueMs: 17_711, achievedAt: at, ttlSec: 3 * 86_400 },
      { board: 'lb:333:ao5:d:2026-11-16', kind: 'ao5', valueMs: null, achievedAt: '', ttlSec: 3 * 86_400 },
      { board: 'lb:333:single:w:2026-W47', kind: 'single', valueMs: 17_711, achievedAt: at, ttlSec: 15 * 86_400 },
      { board: 'lb:333:ao5:w:2026-W47', kind: 'ao5', valueMs: 20_122, achievedAt: at, ttlSec: 15 * 86_400 },
    ]);
  });

  it('ignores days and weeks that are no longer live, and events without boards', () => {
    const writes = planPeriodRefresh('333', { days: { '2026-11-01': { single: { valueMs: 5_000, achievedAt: at } } }, weeks: {} }, live);
    expect(writes.every((w) => w.valueMs === null)).toBe(true);
    expect(planPeriodRefresh('333fm', { days: {}, weeks: {} }, live)).toEqual([]);
    expect(planPeriodRefresh('bogus', { days: {}, weeks: {} }, live)).toEqual([]);
  });
});

describe('parsePeriodBests (stats\' answer)', () => {
  it('keeps well-formed entries', () => {
    const body = { days: { '2026-11-16': { single: { valueMs: 17_711, achievedAt: '2026-11-16T02:56:18.483Z' } } }, weeks: { '2026-W47': {} } };
    expect(parsePeriodBests(body)).toEqual(body);
  });

  it('throws on anything malformed, so the event is retried instead of wiping entries', () => {
    for (const bad of [
      null,
      {},
      { days: {}, weeks: [] },
      { days: { yesterday: {} }, weeks: {} },
      { days: { '2026-11-16': { single: { valueMs: -5, achievedAt: '2026-11-16T00:00:00Z' } } }, weeks: {} },
      { days: { '2026-11-16': { single: { valueMs: 1.5, achievedAt: '2026-11-16T00:00:00Z' } } }, weeks: {} },
      { days: {}, weeks: { '2026-W47': { ao5: { valueMs: 20_000, achievedAt: 'soon' } } } },
    ]) {
      expect(() => parsePeriodBests(bad), JSON.stringify(bad)).toThrow();
    }
  });
});
