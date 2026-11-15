import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backoffDelay,
  coalesce,
  decodeLocalDb,
  decodeQueue,
  encodeLocalDb,
  insertChrono,
  overlaySessions,
  overlaySolves,
  planImportChunks,
  sortChrono,
  uuid,
  type QueuedOp,
  type SyncOp,
} from '../storeUtils';
import type { Session, Solve } from '../../lib/types';

const isEvent = (id: string) => ['333', '222', 'pyram'].includes(id);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function solve(id: string, at: number, extra: Partial<Solve> = {}): Solve {
  return { id, sessionId: 's1', event: '333', timeMs: 10_000 + at, penalty: 'OK', scramble: 'R U', comment: null, source: 'timer', createdAt: new Date(at).toISOString(), ...extra };
}
const op = (o: SyncOp, opId = Math.random().toString(36).slice(2)): QueuedOp => ({ opId, userId: 'u1', op: o, attempts: 0, createdAt: 0 });

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

  it('keeps a practice session one (stored only when it is)', () => {
    const raw = {
      v: 1,
      sessions: [
        { id: 's1', name: 'warm up', event: '333', practice: true },
        { id: 's2', name: 'main', event: '333', practice: 'yes' },
      ],
      solves: {},
      current: null,
      lastByEvent: {},
    };
    const { db } = decodeLocalDb(raw, isEvent);
    expect(db.sessions.map((s) => s.practice ?? false)).toEqual([true, false]);
    const file = JSON.parse(encodeLocalDb(db));
    expect(file.sessions.map((s: { practice?: boolean }) => s.practice)).toEqual([true, undefined]);
    expect(decodeLocalDb(file, isEvent).db.sessions).toEqual(db.sessions);
  });

  it('decodeQueue filters malformed entries', () => {
    expect(decodeQueue('x')).toEqual([]);
    const good = op({ kind: 'deleteSolve', id: 'a', sessionId: 's' });
    expect(decodeQueue([good, { opId: 1 }, null, { ...good, op: { kind: 'evil' } }])).toEqual([good]);
  });
});

describe('queue coalescing', () => {
  const create = op(
    { kind: 'createSolve', solve: { id: 'a', sessionId: 's1', event: '333', timeMs: 1000, penalty: 'OK', scramble: 'R', createdAt: 'x' } },
    'c1',
  );

  it('folds edits into an unsent create', () => {
    const q = coalesce([create], op({ kind: 'updateSolve', id: 'a', sessionId: 's1', patch: { penalty: 'DNF' } }), null);
    expect(q).toHaveLength(1);
    expect((q[0].op as Extract<SyncOp, { kind: 'createSolve' }>).solve.penalty).toBe('DNF');
  });

  it('does not touch the op that is in flight', () => {
    const q = coalesce([create], op({ kind: 'updateSolve', id: 'a', sessionId: 's1', patch: { penalty: '+2' } }), 'c1');
    expect(q).toHaveLength(2);
    expect((q[0].op as Extract<SyncOp, { kind: 'createSolve' }>).solve.penalty).toBe('OK');
  });

  it('drops everything about a solve deleted before it was sent', () => {
    let q = coalesce([create], op({ kind: 'updateSolve', id: 'a', sessionId: 's1', patch: { comment: 'x' } }), null);
    q = coalesce(q, op({ kind: 'deleteSolve', id: 'a', sessionId: 's1' }), null);
    expect(q).toEqual([]);
  });

  it('merges consecutive updates and keeps deletes of synced solves', () => {
    let q = coalesce([], op({ kind: 'updateSolve', id: 'z', sessionId: 's1', patch: { penalty: '+2' } }), null);
    q = coalesce(q, op({ kind: 'updateSolve', id: 'z', sessionId: 's1', patch: { comment: 'hi' } }), null);
    expect(q).toHaveLength(1);
    expect(q[0].op).toMatchObject({ patch: { penalty: '+2', comment: 'hi' } });
    q = coalesce(q, op({ kind: 'deleteSolve', id: 'z', sessionId: 's1' }), null);
    expect(q.map((x) => x.op.kind)).toEqual(['deleteSolve']);
  });

  it('handles sessions the same way', () => {
    const cs = op({ kind: 'createSession', session: { id: 's9', name: 'a', event: '333', createdAt: 'x' } });
    let q = coalesce([cs], op({ kind: 'renameSession', id: 's9', name: 'b' }), null);
    expect(q[0].op).toMatchObject({ session: { name: 'b' } });
    q = coalesce(q, op({ kind: 'createSolve', solve: { id: 'q', sessionId: 's9', event: '333', timeMs: 1, penalty: 'OK', scramble: '', createdAt: 'x' } }), null);
    q = coalesce(q, op({ kind: 'deleteSession', id: 's9' }), null);
    expect(q).toEqual([]);
  });

  it('folds marking a session as practice into its create, and keeps only the latest of a synced one', () => {
    const cs = op({ kind: 'createSession', session: { id: 's9', name: 'a', event: '333', createdAt: 'x' } });
    const q = coalesce([cs], op({ kind: 'setPractice', id: 's9', practice: true }), null);
    expect(q).toHaveLength(1);
    expect(q[0].op).toMatchObject({ session: { practice: true } });
    let synced = coalesce([], op({ kind: 'setPractice', id: 's1', practice: true }), null);
    synced = coalesce(synced, op({ kind: 'setPractice', id: 's1', practice: false }), null);
    expect(synced.map((x) => x.op)).toEqual([{ kind: 'setPractice', id: 's1', practice: false }]);
    expect(decodeQueue(synced)).toEqual(synced);
    // deleted before it was sent: nothing left to say about it
    expect(coalesce(synced, op({ kind: 'deleteSession', id: 's1' }), null).map((x) => x.op.kind)).toEqual(['deleteSession']);
  });
});

describe('backoff', () => {
  it('grows exponentially with jitter and caps at a minute', () => {
    expect(backoffDelay(0, () => 0.5)).toBe(1000);
    expect(backoffDelay(3, () => 0.5)).toBe(8000);
    expect(backoffDelay(30, () => 0.5)).toBe(60_000);
    expect(backoffDelay(0, () => 0)).toBe(750);
    expect(backoffDelay(0, () => 0.9999)).toBeLessThanOrEqual(1250);
  });
});

describe('optimistic overlays', () => {
  const session: Session = { id: 's1', name: 'main', event: '333', createdAt: 'x', updatedAt: 'x', solveCount: 2 };
  it('applies session ops', () => {
    const out = overlaySessions(
      [session],
      [
        { kind: 'createSession', session: { id: 's2', name: 'new', event: '222', createdAt: 'y' } },
        { kind: 'renameSession', id: 's1', name: 'renamed' },
        { kind: 'createSession', session: { id: 's1', name: 'dup', event: '333', createdAt: 'y' } },
      ],
    );
    expect(out.map((s) => [s.id, s.name])).toEqual([
      ['s1', 'renamed'],
      ['s2', 'new'],
    ]);
    expect(overlaySessions(out, [{ kind: 'deleteSession', id: 's2' }]).map((s) => s.id)).toEqual(['s1']);
    expect(overlaySessions(out, [{ kind: 'setPractice', id: 's2', practice: true }]).map((s) => s.practice ?? false)).toEqual([false, true]);
  });

  it('applies solve ops idempotently', () => {
    const server = [solve('a', 1), solve('b', 3)];
    const ops: SyncOp[] = [
      { kind: 'createSolve', solve: { id: 'c', sessionId: 's1', event: '333', timeMs: 5, penalty: 'OK', scramble: '', createdAt: new Date(2).toISOString() } },
      { kind: 'createSolve', solve: { id: 'a', sessionId: 's1', event: '333', timeMs: 5, penalty: 'OK', scramble: '', createdAt: new Date(9).toISOString() } },
      { kind: 'createSolve', solve: { id: 'other', sessionId: 's2', event: '333', timeMs: 5, penalty: 'OK', scramble: '', createdAt: new Date(9).toISOString() } },
      { kind: 'updateSolve', id: 'b', sessionId: 's1', patch: { penalty: 'DNF' } },
      { kind: 'deleteSolve', id: 'a', sessionId: 's1' },
    ];
    const out = overlaySolves('s1', server, ops);
    expect(out.map((s) => [s.id, s.penalty])).toEqual([
      ['c', 'OK'],
      ['b', 'DNF'],
    ]);
    expect(overlaySolves('s1', out, ops)).toEqual(out);
  });
});

describe('import chunking', () => {
  const sess = (name: string, n: number) => ({
    name,
    event: '333',
    solves: Array.from({ length: n }, (_, i) => ({ timeMs: 1000 + i, penalty: 'OK' as const, scramble: '', createdAt: 'x' })),
  });

  it('packs whole sessions into requests of at most max solves', () => {
    const chunks = planImportChunks([sess('a', 8), sess('b', 5), sess('c', 0), sess('d', 3), sess('e', 9)], 10);
    expect(chunks.map((c) => c.sessions.map((s) => s.name))).toEqual([['a'], ['b', 'd'], ['e']]);
    for (const c of chunks) expect(c.sessions.reduce((a, s) => a + s.solves.length, 0)).toBeLessThanOrEqual(10);
  });

  it('never splits a session unless it exceeds the hard limit', () => {
    const big = planImportChunks([sess('big', 25)], 10, 100);
    expect(big).toHaveLength(1);
    expect(big[0].sessions[0].solves).toHaveLength(25);
    const huge = planImportChunks([sess('huge session name that is quite long!!', 25)], 10, 10);
    expect(huge.map((c) => c.sessions[0].name)).toEqual(['huge session name that is quite long!!', 'huge session name that is quite long (2)', 'huge session name that is quite long (3)']);
    expect(huge.flatMap((c) => c.sessions[0].solves)).toHaveLength(25);
    for (const c of huge) expect(c.sessions[0].name.length).toBeLessThanOrEqual(40);
  });
});
