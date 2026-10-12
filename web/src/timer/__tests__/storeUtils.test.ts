import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeLocalDb, encodeLocalDb, insertChrono, sortChrono, uuid } from '../storeUtils';
import type { Solve } from '../../lib/types';

const isEvent = (id: string) => ['333', '222', 'pyram'].includes(id);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function solve(id: string, at: number, extra: Partial<Solve> = {}): Solve {
  return { id, sessionId: 's1', event: '333', timeMs: 10_000 + at, penalty: 'OK', scramble: 'R U', comment: null, source: 'timer', createdAt: new Date(at).toISOString(), ...extra };
}

afterEach(() => vi.unstubAllGlobals());

describe('uuid', () => {
  it('produces v4 uuids', () => {
    const ids = new Set(Array.from({ length: 200 }, uuid));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(UUID_RE);
  });
  it('falls back to getRandomValues on insecure origins', () => {
    vi.stubGlobal('crypto', { getRandomValues: (b: Uint8Array) => b.fill(0xab) });
    expect(uuid()).toMatch(UUID_RE);
  });
});

describe('chronological helpers', () => {
  it('sortChrono keeps already sorted arrays and sorts stable otherwise', () => {
    const sorted = [solve('a', 1), solve('b', 2)];
    expect(sortChrono(sorted)).toBe(sorted);
    const out = sortChrono([solve('c', 3), solve('a', 1), solve('b', 1)]);
    expect(out.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
  it('insertChrono appends or inserts in place', () => {
    const list = [solve('a', 1), solve('c', 3)];
    expect(insertChrono(list, solve('d', 4)).map((s) => s.id)).toEqual(['a', 'c', 'd']);
    expect(insertChrono(list, solve('b', 2)).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(list).toHaveLength(2);
  });
});

describe('local db codec', () => {
  it('treats missing data as empty and garbage as corrupt', () => {
    expect(decodeLocalDb(null, isEvent)).toMatchObject({ corrupt: false, dropped: 0 });
    expect(decodeLocalDb('nope', isEvent).corrupt).toBe(true);
    expect(decodeLocalDb({ v: 2, sessions: [] }, isEvent).corrupt).toBe(true);
    expect(decodeLocalDb({ v: 1 }, isEvent).corrupt).toBe(true);
  });

  it('round-trips and drops invalid entries', () => {
    const raw = {
      v: 1,
      sessions: [
        { id: 's1', name: ' main ', event: '333', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: 'garbage' },
        { id: 's1', name: 'dup', event: '333' },
        { name: 'no id' },
        { id: 's2', name: '', event: 'nope' },
      ],
      solves: {
        s1: [
          ['b', 12000, 1, 'R', 'nice', 2000, 'manual'],
          ['a', 11000, 0, 'U', null, 1000],
          ['a', 11000, 0, 'U', null, 1000],
          ['x', -5, 0, '', null, 0],
          'junk',
        ],
      },
      current: 's2',
      lastByEvent: { '333': 's1', '222': 'missing' },
    };
    const { db, dropped, corrupt } = decodeLocalDb(raw, isEvent);
    expect(corrupt).toBe(false);
    expect(dropped).toBe(5); // dup session, id-less session, dup solve, bad time, junk
    expect(db.sessions.map((s) => [s.id, s.name, s.event, s.solveCount])).toEqual([
      ['s1', 'main', '333', 2],
      ['s2', 'session', '333', 0],
    ]);
    const list = db.solves.get('s1')!;
    expect(list.map((s) => s.id)).toEqual(['a', 'b']);
    expect(list[1]).toMatchObject({ penalty: '+2', comment: 'nice', source: 'manual', event: '333', sessionId: 's1' });
    expect(db.current).toBe('s2');
    expect(db.lastByEvent).toEqual({ '333': 's1' });

    const again = decodeLocalDb(JSON.parse(encodeLocalDb(db)), isEvent);
    expect(again.dropped).toBe(0);
    expect(again.db.solves.get('s1')).toEqual(list);
    expect(again.db.sessions).toEqual(db.sessions);
  });
});
