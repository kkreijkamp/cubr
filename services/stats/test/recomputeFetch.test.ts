import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchSolveList, readSolvePage, type RecomputeDeps } from '../src/recompute.js';
import type { ListSolve } from '../src/domain/pbs.js';
import { FakeSolveService, newCuber } from './harness.js';

const log = { warn: () => undefined, info: () => undefined } as unknown as RecomputeDeps['log'];

describe("reading solve-service's solve list", () => {
  const fake = new FakeSolveService();
  beforeAll(() => fake.start());
  afterAll(() => fake.close());

  it('follows the pages to the end, the same list as in one go', async () => {
    const user = newCuber();
    const a = fake.session(user);
    const b = fake.session(user);
    for (let i = 0; i < 7; i++) fake.solve(user, i % 2 ? a : b, 9000 + i, `2026-01-0${1 + i}T10:00:00.000Z`);
    const deps = { solveUrl: fake.url, internalToken: 't', log, pageSize: 3 };
    const paged = await fetchSolveList(deps, user.id, '333');
    expect(paged).toEqual(fake.list(user.id, '333'));
    expect(fake.recomputes(user.id).map((path) => new URL(path, 'http://x').searchParams.get('after'))).toEqual([null, '3', '6']);
  });

  it('refuses a malformed answer rather than store it', () => {
    const ok = {
      id: '10000000-0000-4000-8000-000000000001',
      sessionId: '20000000-0000-4000-8000-000000000001',
      timeMs: 9000,
      penalty: 'OK',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const read = (body: unknown) => readSolvePage(body, [] as ListSolve[], new Map());
    expect(read({ solves: [ok], next: null })).toBeNull();
    expect(read({ solves: [ok] })).toBeNull(); // a solve-service that answers in one go
    expect(read({ solves: [ok], next: 'cursor' })).toBe('cursor');
    for (const bad of [
      { ...ok, id: 'x' },
      { ...ok, timeMs: 0 },
      { ...ok, timeMs: 1.5 },
      { ...ok, penalty: '+3' },
      { ...ok, createdAt: 'never' },
      { ...ok, practice: 'yes' },
      null,
    ])
      expect(() => read({ solves: [bad] }), JSON.stringify(bad)).toThrow('malformed solve');
    expect(() => read({ nope: [] })).toThrow('no solves array');
    expect(() => read({ solves: [], next: 3 })).toThrow('malformed cursor');
  });

  it("keeps one copy of each session's id, however many solves name it", () => {
    const sessions = new Map<string, string>();
    const out: ListSolve[] = [];
    const sid = '20000000-0000-4000-8000-000000000001';
    const page = {
      solves: [1, 2, 3].map((i) => ({
        id: `10000000-0000-4000-8000-00000000000${i}`,
        sessionId: `${sid}`.slice(0),
        timeMs: 9000,
        penalty: 'OK',
        createdAt: '2026-01-01T00:00:00.000Z',
      })),
    };
    readSolvePage(page, out, sessions);
    expect(sessions.size).toBe(1);
    expect(out.map((s) => s.sessionId)).toEqual([sid, sid, sid]);
  });
});
