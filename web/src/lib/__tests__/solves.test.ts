import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isEventId, parseTimerFile, type ImportedSession, type Penalty } from '@cubr/cubestats';
import { decodeLocalDb, encodeLocalDb, LOCAL_KEY, QUEUE_KEY, type QueuedOp } from '../../timer/storeUtils';
import type { Session, Solve } from '../types';
import { MemoryStorage } from './memoryStorage';

// lib/solves.ts is tested through its exports, with browser globals stubbed per test, fake timers, a
// fresh module instance per test (it keeps module state) and a small in-memory solve service behind
// the mocked api module.

type ApiModule = typeof import('../api');
type ApiErrorClass = ApiModule['ApiError'];
type TestUser = { id: string; username: string };

const h = vi.hoisted(() => ({
  token: null as string | null,
  user: null as { id: string; username: string } | null,
  authListeners: new Set<(user: unknown) => void>(),
  api: {
    sessions: { list: vi.fn(), create: vi.fn(), rename: vi.fn(), setPractice: vi.fn(), remove: vi.fn(), solves: vi.fn(), import: vi.fn(), merge: vi.fn() },
    solves: { create: vi.fn(), update: vi.fn(), remove: vi.fn(), export: vi.fn() },
  },
}));

vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<ApiModule>()), api: h.api, getToken: () => h.token }));
vi.mock('../auth', () => ({
  onAuthChange: (fn: (user: unknown) => void) => {
    h.authListeners.add(fn);
    return () => h.authListeners.delete(fn);
  },
  getCurrentUser: () => h.user,
}));

const U1: TestUser = { id: 'u1', username: 'one' };
const U2: TestUser = { id: 'u2', username: 'two' };
const NOW = '2026-11-16T10:00:00.000Z';
const CACHE_KEY = 'cubr.cloudcache.v1';
const LAST_SESSION_KEY = 'cubr.lastSession.v1';
/** an ISO date `n` minutes into 2026 */
const T = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();

// ---------------------------------------------------------------- the fake solve service

type ServerSession = Session & { userId: string };
interface SeedOptions {
  userId: string;
  name: string;
  event?: string;
  practice?: boolean;
  solves?: { timeMs: number; at: string; penalty?: Penalty }[];
}
interface FakeServer {
  sessions: ServerSession[];
  solves: Map<string, Solve[]>;
  /** every request fails like a network error */
  down: boolean;
  seq: number;
  seed(o: SeedOptions): ServerSession;
  solvesOf(sessionId: string): Solve[];
  /** a user's session names in list order */
  namesOf(userId: string): string[];
}

function newServer(): FakeServer {
  const server: FakeServer = {
    sessions: [],
    solves: new Map(),
    down: false,
    seq: 0,
    seed(o) {
      const createdAt = new Date(Date.UTC(2025, 0, 1) + ++server.seq * 1000).toISOString();
      const id = `${o.name.replace(/\W/g, '')}-${crypto.randomUUID().slice(0, 8)}`;
      const s: ServerSession = {
        id,
        userId: o.userId,
        name: o.name,
        event: o.event ?? '333',
        practice: o.practice ?? false,
        createdAt,
        updatedAt: createdAt,
        solveCount: 0,
      };
      server.sessions.push(s);
      const list = (o.solves ?? []).map((x, i) => solveRow(s, `${id}-s${i}`, x.timeMs, x.at, x.penalty));
      server.solves.set(
        id,
        list.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      );
      return s;
    },
    solvesOf: (sid) => server.solves.get(sid) ?? [],
    namesOf: (uid) => listOf(server, uid).map((s) => s.name),
  };
  return server;
}

function solveRow(s: Session, id: string, timeMs: number, createdAt: string, penalty: Penalty = 'OK'): Solve {
  return {
    id,
    sessionId: s.id,
    event: s.event,
    timeMs,
    penalty,
    scramble: 'R U',
    comment: null,
    source: 'timer',
    createdAt,
    dailyDate: null,
    dailyIndex: null,
  };
}

const listOf = (server: FakeServer, uid: string) => server.sessions.filter((s) => s.userId === uid).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** Points the api mocks at `server` (the SPEC section 9.3 behaviour the store relies on). */
function installServer(ApiError: ApiErrorClass, server: FakeServer): void {
  const caller = () => {
    if (server.down) throw new ApiError(0, 'NETWORK', 'Network error - is the server reachable?');
    if (!h.user) throw new ApiError(401, 'UNAUTHORIZED', 'not signed in');
    return h.user.id;
  };
  const view = ({ userId: _owner, ...s }: ServerSession): Session => ({ ...s, solveCount: server.solvesOf(s.id).length });
  const mine = (id: string) => {
    const uid = caller();
    const s = server.sessions.find((x) => x.id === id && x.userId === uid);
    if (!s) throw new ApiError(404, 'NOT_FOUND', 'session not found');
    return s;
  };
  const solveOf = (id: string) => {
    const uid = caller();
    for (const s of server.sessions.filter((x) => x.userId === uid)) {
      const list = server.solvesOf(s.id);
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) return { list, i };
    }
    throw new ApiError(404, 'NOT_FOUND', 'solve not found');
  };
  const sortList = (list: Solve[]) => list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const { sessions, solves } = h.api;
  sessions.list.mockImplementation(async () => ({ sessions: listOf(server, caller()).map(view) }));
  sessions.create.mockImplementation(async (body: { id: string; name: string; event: string; practice?: boolean; scramble?: string; createdAt?: string }) => {
    const uid = caller();
    const existing = server.sessions.find((s) => s.id === body.id);
    if (existing) {
      if (existing.userId !== uid) throw new ApiError(409, 'CONFLICT', 'id taken');
      return { session: view(existing) };
    }
    const now = new Date().toISOString();
    const s: ServerSession = {
      id: body.id,
      userId: uid,
      name: body.name,
      event: body.event,
      practice: (body.practice ?? false) || !!body.scramble,
      ...(body.scramble ? { scramble: body.scramble } : {}),
      createdAt: body.createdAt ?? now,
      updatedAt: now,
      solveCount: 0,
    };
    server.sessions.push(s);
    server.solves.set(s.id, []);
    return { session: view(s) };
  });
  sessions.rename.mockImplementation(async (id: string, name: string) => {
    const s = mine(id);
    s.name = name;
    return { session: view(s) };
  });
  sessions.setPractice.mockImplementation(async (id: string, practice: boolean) => {
    const s = mine(id);
    s.practice = practice;
    return { session: view(s) };
  });
  sessions.remove.mockImplementation(async (id: string) => {
    mine(id);
    server.sessions = server.sessions.filter((s) => s.id !== id);
    server.solves.delete(id);
  });
  sessions.solves.mockImplementation(async (id: string) => ({ solves: server.solvesOf(mine(id).id).map((x) => ({ ...x })) }));
  sessions.import.mockImplementation(
    async (payload: { sessions: { name: string; event: string; practice?: boolean; solves: Omit<Solve, 'id' | 'sessionId' | 'event' | 'source'>[] }[] }) => {
      const uid = caller();
      let count = 0;
      for (const p of payload.sessions) {
        const now = new Date().toISOString();
        const s: ServerSession = {
          id: crypto.randomUUID(),
          userId: uid,
          name: p.name,
          event: p.event,
          practice: p.practice ?? false,
          createdAt: now,
          updatedAt: now,
          solveCount: 0,
        };
        server.sessions.push(s);
        server.solves.set(
          s.id,
          sortList(
            p.solves.map((x) => ({
              ...solveRow(s, crypto.randomUUID(), x.timeMs, x.createdAt, x.penalty),
              scramble: x.scramble,
              comment: x.comment ?? null,
              source: 'import',
            })),
          ),
        );
        count += p.solves.length;
      }
      return { imported: { sessions: payload.sessions.length, solves: count } };
    },
  );
  sessions.merge.mockImplementation(async (targetId: string, sourceIds: string[]) => {
    const target = mine(targetId);
    const sources = sourceIds.map(mine);
    if (sources.some((s) => s.event !== target.event)) throw new ApiError(409, 'CONFLICT', 'different events');
    let moved = 0;
    for (const s of sources) {
      const list = server.solvesOf(s.id).map((x) => ({ ...x, sessionId: target.id }));
      moved += list.length;
      server.solves.set(target.id, sortList([...server.solvesOf(target.id), ...list]));
      server.sessions = server.sessions.filter((x) => x.id !== s.id);
      server.solves.delete(s.id);
    }
    return { session: view(target), merged: { sessions: sources.length, solves: moved } };
  });
  solves.create.mockImplementation(
    async (body: {
      id: string;
      sessionId: string;
      timeMs: number;
      penalty: Penalty;
      scramble: string;
      comment?: string | null;
      source?: string;
      createdAt?: string;
      daily?: { date: string; index: number };
    }) => {
      const s = mine(body.sessionId);
      const list = server.solvesOf(s.id);
      const same = list.find((x) => x.id === body.id); // idempotent on id
      if (same) return { solve: same, rolling: { ao5: null, ao12: null } };
      const solve: Solve = {
        ...solveRow(s, body.id, body.timeMs, body.createdAt ?? new Date().toISOString(), body.penalty),
        scramble: body.scramble,
        comment: body.comment ?? null,
        source: body.source ?? 'timer',
        dailyDate: body.daily?.date ?? null,
        dailyIndex: body.daily?.index ?? null,
      };
      server.solves.set(s.id, sortList([...list, solve]));
      return { solve, rolling: { ao5: null, ao12: null } };
    },
  );
  solves.update.mockImplementation(async (id: string, patch: { penalty?: Penalty; comment?: string | null }) => {
    const { list, i } = solveOf(id);
    list[i] = { ...list[i], ...patch };
    return { solve: list[i] };
  });
  solves.remove.mockImplementation(async (id: string) => {
    const { list, i } = solveOf(id);
    list.splice(i, 1);
  });
  solves.export.mockImplementation(async () => {
    const uid = caller();
    return {
      exportedAt: new Date().toISOString(),
      sessions: listOf(server, uid).map((s) => ({ ...view(s), solves: server.solvesOf(s.id).map((x) => ({ ...x })) })),
    };
  });
}

// ---------------------------------------------------------------- page harness

let local: MemoryStorage;
let session: MemoryStorage;
let win: EventTarget;
let doc: EventTarget & { visibilityState: string };

function stubPage(): void {
  win = new EventTarget();
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
}

/** settles every promise chain that is not waiting for a (fake) timer */
// Node's setImmediate, which the fake timers leave alone; typed here because the web app has no Node
// types (the Docker image and CI type-check web/ on its own)
const setImmediateReal = (globalThis as unknown as { setImmediate(cb: () => void): void }).setImmediate;
const flush = () => new Promise<void>((resolve) => setImmediateReal(resolve));
const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.spyOn(Math, 'random').mockReturnValue(0.5); // retry backoff without jitter: 1 s, 2 s, 4 s ...
  local = new MemoryStorage();
  session = new MemoryStorage();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  stubPage();
  h.token = null;
  h.user = null;
  h.authListeners.clear();
  for (const group of Object.values(h.api)) for (const fn of Object.values(group)) fn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface StartOptions {
  /** keep the solve service of an earlier page */
  server?: FakeServer;
  seed?: (server: FakeServer) => void;
  /** runs before the store module loads (e.g. to make a request fail during the first load) */
  before?: (ctx: { ApiError: ApiErrorClass; server: FakeServer }) => void;
}

/** Loads the store as a page would: signed in as `user`, or as a guest. */
async function start(user: TestUser | null = null, opts: StartOptions = {}) {
  const { ApiError } = await import('../api');
  const server = opts.server ?? newServer();
  installServer(ApiError, server);
  opts.seed?.(server);
  opts.before?.({ ApiError, server });
  h.user = user;
  h.token = user ? `token-${user.id}` : null;
  const store = await import('../solves');
  const { toastStore } = await import('../toast');
  const { settingsStore } = await import('../settings');
  await flush();
  return {
    ...store,
    ApiError,
    server,
    toastStore,
    settingsStore,
    state: () => store.solveStore.get(),
    /** the solve service works normally again */
    reinstall: () => installServer(ApiError, server),
    toasts: () => toastStore.get().map((t) => [t.type, t.message]),
  };
}

/** A reload: same browser storage and solve service, a fresh page and module instance. */
async function newPage(): Promise<void> {
  vi.clearAllTimers();
  vi.resetModules();
  h.authListeners.clear();
  stubPage();
}

async function login(user: TestUser): Promise<void> {
  h.user = user;
  h.token = `token-${user.id}`;
  for (const l of [...h.authListeners]) l(user);
  await flush();
}

async function logout(): Promise<void> {
  h.user = null;
  h.token = null;
  for (const l of [...h.authListeners]) l(null);
  await flush();
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** the guest data as saved in localStorage */
function storedGuest() {
  const raw = local.getItem(LOCAL_KEY);
  if (!raw) throw new Error('no guest data saved');
  return decodeLocalDb(JSON.parse(raw), isEventId).db;
}

/** the fields a solve keeps everywhere (memory, localStorage, server) */
const core = ({ id, sessionId, event, timeMs, penalty, scramble, comment, source, createdAt }: Solve) => ({
  id,
  sessionId,
  event,
  timeMs,
  penalty,
  scramble,
  comment,
  source,
  createdAt,
});
const queued = () => local.json<QueuedOp[]>(QUEUE_KEY) ?? [];
const imp = (timeMs: number, createdAt: string, penalty: Penalty = 'OK', comment: string | null = null) => ({
  timeMs,
  penalty,
  scramble: 'x',
  comment,
  createdAt,
});

// ================================================================ guest mode

describe('guest mode (localStorage)', () => {
  it('starts a new guest with a 3x3 session and a 3x3 practice session, the first one current', async () => {
    const s = await start();
    const st = s.state();
    expect(st).toMatchObject({ ready: true, mode: 'local', solves: [], pending: 0, syncError: null, loading: false });
    expect(st.sessions.map((x) => [x.name, x.event, x.practice ?? false, x.solveCount])).toEqual([
      ['3x3', '333', false, 0],
      ['3x3 practice', '333', true, 0],
    ]);
    expect(st.currentSessionId).toBe(st.sessions[0].id);
    expect(s.getCurrentSession()?.name).toBe('3x3');
    expect(h.api.sessions.list).not.toHaveBeenCalled();
  });

  it("starts with the settings' last event", async () => {
    local.setItem('cubr.settings', JSON.stringify({ lastEvent: 'pyram' }));
    const s = await start();
    expect(s.state().sessions.map((x) => x.name)).toEqual(['Pyra', 'Pyra practice']);
  });

  it('saves a solve to localStorage shortly after it is added, and has it on the next visit', async () => {
    const s = await start();
    const solve = await s.addSolve({ timeMs: 9876.4, penalty: 'OK', scramble: "R U R'" });
    expect(solve).toMatchObject({
      timeMs: 9876,
      penalty: 'OK',
      scramble: "R U R'",
      comment: null,
      source: 'timer',
      event: '333',
      sessionId: s.state().currentSessionId,
      createdAt: NOW,
    });
    expect(s.state().solves).toEqual([solve]);
    expect(s.getCurrentSession()?.solveCount).toBe(1);
    expect(local.getItem(LOCAL_KEY)).toBeNull(); // debounced, not written on every solve
    await advance(250);
    expect(storedGuest().solves.get(solve.sessionId)!.map(core)).toEqual([core(solve)]);

    await newPage();
    const again = await start();
    expect(again.state().currentSessionId).toBe(solve.sessionId);
    expect(again.state().solves.map(core)).toEqual([core(solve)]);
  });

  it.each([0, 0.4, -5, 86_400_001, NaN, Infinity])('refuses a time of %s ms', async (timeMs) => {
    const s = await start();
    await expect(s.addSolve({ timeMs, penalty: 'OK', scramble: '' })).rejects.toThrow('Time must be between 0.001 s and 24 h');
    expect(s.state().solves).toEqual([]);
  });

  it('cuts a scramble at 2000 and a comment at 500 characters, and keeps the source and penalty', async () => {
    const s = await start();
    const solve = await s.addSolve({ timeMs: 5000, penalty: '+2', scramble: 'x'.repeat(2100), comment: 'c'.repeat(600), source: 'manual' });
    expect(solve).toMatchObject({ penalty: '+2', source: 'manual' });
    expect(solve.scramble).toHaveLength(2000);
    expect(solve.comment).toHaveLength(500);
    expect((await s.addSolve({ timeMs: 5000, penalty: 'OK', scramble: '', comment: '' })).comment).toBeNull();
  });

  it('changes the penalty and comment of a solve (trimmed; blank = none) and saves them', async () => {
    const s = await start();
    const a = await s.addSolve({ timeMs: 5000, penalty: 'OK', scramble: 'R' });
    await s.setPenalty(a.id, 'DNF');
    await s.setComment(a.id, '  close one  ');
    expect(s.state().solves[0]).toMatchObject({ penalty: 'DNF', comment: 'close one' });
    await s.setComment(a.id, '   ');
    expect(s.state().solves[0].comment).toBeNull();
    await s.setComment(a.id, 'x'.repeat(600));
    await s.setPenalty('no-such-solve', '+2');
    await advance(250);
    expect(storedGuest().solves.get(a.sessionId)![0]).toMatchObject({ id: a.id, penalty: 'DNF', comment: 'x'.repeat(500) });
  });

  it('deletes a solve and updates the session count', async () => {
    const s = await start();
    const a = await s.addSolve({ timeMs: 5000, penalty: 'OK', scramble: '' });
    const b = await s.addSolve({ timeMs: 6000, penalty: 'OK', scramble: '' });
    await s.deleteSolve(a.id);
    expect(s.state().solves.map((x) => x.id)).toEqual([b.id]);
    expect(s.getCurrentSession()?.solveCount).toBe(1);
    await advance(250);
    expect(
      storedGuest()
        .solves.get(b.sessionId)!
        .map((x) => x.id),
    ).toEqual([b.id]);
  });

  it('adds a solve to another session when asked, and refuses an unknown one', async () => {
    const s = await start();
    const practice = s.state().sessions[1];
    const x = await s.addSolve({ timeMs: 5000, penalty: 'OK', scramble: '', sessionId: practice.id });
    expect(x).toMatchObject({ sessionId: practice.id, event: '333' });
    expect(s.state().solves).toEqual([]); // the current session is unchanged
    expect(s.getLoadedSolves(practice.id)).toEqual([x]);
    expect(s.state().sessions[1].solveCount).toBe(1);
    await expect(s.addSolve({ timeMs: 5000, penalty: 'OK', scramble: '', sessionId: 'nope' })).rejects.toThrow('Unknown session');
  });

  it('creates sessions with a trimmed 1-40 character name for a known event, without switching to them', async () => {
    const s = await start();
    const oh = await s.createSession('  OH  ', '333oh');
    expect(oh).toMatchObject({ name: 'OH', event: '333oh', solveCount: 0 });
    expect('practice' in oh).toBe(false);
    expect((await s.createSession('slow', '333', { practice: true })).practice).toBe(true);
    expect(s.state().sessions.map((x) => x.name)).toEqual(['3x3', '3x3 practice', 'OH', 'slow']);
    expect(s.getCurrentSession()?.name).toBe('3x3');
    await expect(s.createSession('   ', '333')).rejects.toThrow('Session names must be 1-40 characters');
    await expect(s.createSession('x'.repeat(41), '333')).rejects.toThrow('Session names must be 1-40 characters');
    await expect(s.createSession('ok', '333mbf')).rejects.toThrow('Unknown event 333mbf');
    expect(s.state().sessions).toHaveLength(4);
    expect(s.suggestSessionName('333')).toBe('3x3 2');
    expect(s.suggestSessionName('333oh')).toBe('3x3 OH');
  });

  it('renames a session (trimmed) and keeps the old name when the new one is invalid', async () => {
    const s = await start();
    const [main] = s.state().sessions;
    await s.renameSession(main.id, '  Main  ');
    expect(s.getCurrentSession()?.name).toBe('Main');
    await expect(s.renameSession(main.id, '')).rejects.toThrow('Session names must be 1-40 characters');
    await expect(s.renameSession(main.id, 'n'.repeat(41))).rejects.toThrow('Session names must be 1-40 characters');
    expect(s.getCurrentSession()?.name).toBe('Main');
    await advance(250);
    expect(storedGuest().sessions[0].name).toBe('Main');
  });

  it('marks a session as practice and back', async () => {
    const s = await start();
    const [main] = s.state().sessions;
    await s.setSessionPractice(main.id, true);
    expect(s.state().sessions[0].practice).toBe(true);
    await advance(250);
    expect(storedGuest().sessions[0].practice).toBe(true);
    await s.setSessionPractice(main.id, false);
    expect(s.state().sessions[0].practice).toBe(false);
    await advance(250);
    expect(storedGuest().sessions[0].practice).toBeUndefined();
  });

  it("switches events to the event's last used session, creating its sessions the first time, and remembers it", async () => {
    const s = await start();
    await s.switchEvent('222');
    expect(s.state().sessions.map((x) => x.name)).toEqual(['3x3', '3x3 practice', '2x2', '2x2 practice']);
    expect(s.getCurrentSession()?.name).toBe('2x2');
    expect(s.settingsStore.get().lastEvent).toBe('222');
    await s.switchSession(s.state().sessions[3].id);
    await s.switchEvent('333');
    expect(s.getCurrentSession()?.name).toBe('3x3');
    await s.switchEvent('222');
    expect(s.getCurrentSession()?.name).toBe('2x2 practice');
    await expect(s.switchEvent('333mbf')).rejects.toThrow('Unknown event 333mbf');
    await expect(s.switchSession('nope')).rejects.toThrow('Unknown session');
    await advance(250);

    await newPage();
    const again = await start();
    expect(again.getCurrentSession()?.name).toBe('2x2 practice');
    expect(again.settingsStore.get().lastEvent).toBe('222');
  });

  it('switches to a practice scramble: its own practice session, made once, remembered, and back to the default', async () => {
    const s = await start();
    await s.switchScramble('333', 'pll');
    const pll = s.getCurrentSession()!;
    expect(pll).toMatchObject({ name: '3x3 pll', event: '333', scramble: 'pll', practice: true });
    await s.switchScramble('333', null);
    expect(s.getCurrentSession()?.name).toBe('3x3');
    await s.switchScramble('333', 'pll');
    expect(s.getCurrentSession()?.id).toBe(pll.id); // the same session, not a second one
    expect(s.state().sessions.filter((x) => x.scramble === 'pll')).toHaveLength(1);
    // switching events and back returns to where you were, the practice scramble included
    await s.switchEvent('222');
    await s.switchEvent('333');
    expect(s.getCurrentSession()?.id).toBe(pll.id);
    // a practice scramble's session stays a practice session
    await s.setSessionPractice(pll.id, false);
    expect(s.getCurrentSession()?.practice).toBe(true);
    // the daily challenge and races never use it
    expect((await s.ensureSession('333', { counts: true })).scramble).toBeUndefined();
    // unknown types fall back to the default
    await s.switchScramble('333', 'nope');
    expect(s.getCurrentSession()?.name).toBe('3x3');
    await advance(250);
    expect(storedGuest().sessions.find((x) => x.id === pll.id)).toMatchObject({ scramble: 'pll', practice: true });
    await newPage();
    const again = await start();
    expect(again.state().sessions.find((x) => x.id === pll.id)).toMatchObject({ scramble: 'pll', practice: true });
  });

  it('merges only sessions of the same scramble type, and replaces a deleted one with its own kind', async () => {
    const s = await start();
    const main = s.state().sessions[0];
    await s.switchScramble('333', 'pll');
    const pll = s.getCurrentSession()!;
    await expect(s.mergeSessions(main.id, [pll.id])).rejects.toThrow('only sessions of the same scramble type can be merged');
    await s.deleteSession(pll.id);
    expect(s.getCurrentSession()).toMatchObject({ name: '3x3 pll', scramble: 'pll' });
    expect(s.getCurrentSession()?.id).not.toBe(pll.id);
  });

  it('ensureSession finds a counting session for the daily challenge and races, without switching', async () => {
    const s = await start();
    const [main, practice] = s.state().sessions;
    await s.switchSession(practice.id);
    expect((await s.ensureSession('333')).id).toBe(practice.id);
    expect((await s.ensureSession('333', { counts: true })).id).toBe(main.id);
    const pyra = await s.ensureSession('pyram', { counts: true });
    expect(pyra).toMatchObject({ name: 'Pyra', event: 'pyram' });
    expect(pyra.practice).toBeUndefined();
    expect(s.state().sessions.map((x) => x.name)).toContain('Pyra practice');
    expect(s.state().currentSessionId).toBe(practice.id);
    // an event with only a practice session gets a counting one
    await s.deleteSession(main.id);
    const fresh = await s.ensureSession('333', { counts: true });
    expect(fresh).toMatchObject({ name: '3x3', event: '333' });
    expect(fresh.practice).toBeUndefined();
  });

  it('deleting the current session opens another of its event, or a new one when there is none', async () => {
    const s = await start();
    const [main, practice] = s.state().sessions;
    await s.deleteSession(main.id);
    expect(s.state().sessions.map((x) => x.id)).toEqual([practice.id]);
    expect(s.state().currentSessionId).toBe(practice.id);
    await s.deleteSession(practice.id);
    const [only] = s.state().sessions;
    expect(only).toMatchObject({ name: '3x3', event: '333' });
    expect(only.practice).toBeUndefined(); // a replacement is just the default session
    expect(s.state().currentSessionId).toBe(only.id);
  });

  it('deleting another session leaves the current one, and the event forgets it as its last session', async () => {
    const s = await start();
    await s.switchEvent('222');
    const twoPractice = s.state().sessions[3];
    await s.switchSession(twoPractice.id);
    await s.switchEvent('333');
    const current = s.state().currentSessionId;
    await s.deleteSession(twoPractice.id);
    expect(s.state().currentSessionId).toBe(current);
    await s.switchEvent('222');
    expect(s.getCurrentSession()?.name).toBe('2x2');
  });

  it('clearing a session deletes its solves but keeps its id, name and place', async () => {
    const s = await start();
    const ids = s.state().sessions.map((x) => x.id);
    const before = s.getCurrentSession()!;
    await s.addSolve({ timeMs: 1000, penalty: 'OK', scramble: '' });
    await s.addSolve({ timeMs: 2000, penalty: 'OK', scramble: '' });
    vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
    await s.clearSession(before.id);
    expect(s.getCurrentSession()).toMatchObject({ id: before.id, name: before.name, createdAt: before.createdAt, solveCount: 0 });
    expect(s.state().solves).toEqual([]);
    expect(s.state().sessions.map((x) => x.id)).toEqual(ids);
    await advance(250);
    expect(storedGuest().solves.get(before.id)).toEqual([]);
    // an empty session is left alone
    const updatedAt = s.getCurrentSession()!.updatedAt;
    vi.setSystemTime(new Date(Date.parse(NOW) + 120_000));
    await s.clearSession(before.id);
    expect(s.getCurrentSession()!.updatedAt).toBe(updatedAt);
  });

  it('merges sessions into one, solves in time order and re-tagged, and saves it at once', async () => {
    const s = await start();
    const [main] = s.state().sessions;
    const other = await s.createSession('other', '333');
    const at = (min: number) => vi.setSystemTime(new Date(Date.parse(NOW) + min * 60_000));
    at(1);
    const a1 = await s.addSolve({ timeMs: 1000, penalty: 'OK', scramble: '', sessionId: main.id });
    at(2);
    const b1 = await s.addSolve({ timeMs: 2000, penalty: '+2', scramble: '', sessionId: other.id });
    at(3);
    const a2 = await s.addSolve({ timeMs: 3000, penalty: 'OK', scramble: '', sessionId: main.id });
    at(4);
    const b2 = await s.addSolve({ timeMs: 4000, penalty: 'DNF', scramble: '', sessionId: other.id });
    expect(await s.mergeSessions(main.id, [other.id, other.id])).toEqual({ sessions: 1, solves: 2 });
    const order = [a1.id, b1.id, a2.id, b2.id];
    expect(s.state().sessions.map((x) => x.name)).toEqual(['3x3', '3x3 practice']);
    expect(s.state().solves.map((x) => x.id)).toEqual(order);
    expect(s.state().solves.map((x) => x.penalty)).toEqual(['OK', '+2', 'OK', 'DNF']);
    expect(s.state().solves.every((x) => x.sessionId === main.id)).toBe(true);
    expect(s.getCurrentSession()?.solveCount).toBe(4);
    const saved = storedGuest(); // no waiting for the debounce
    expect(saved.solves.get(main.id)!.map((x) => x.id)).toEqual(order);
    expect(saved.sessions.map((x) => x.id)).not.toContain(other.id);
  });

  it('makes the target current when the current session is merged away', async () => {
    const s = await start();
    const [main] = s.state().sessions;
    const other = await s.createSession('other', '333');
    await s.switchSession(other.id);
    await s.mergeSessions(main.id, [other.id]);
    expect(s.state().currentSessionId).toBe(main.id);
  });

  it('refuses merges into itself, of nothing, of unknown sessions and across events', async () => {
    const s = await start();
    const [main, practice] = s.state().sessions;
    const pyra = await s.createSession('pyra', 'pyram');
    await expect(s.mergeSessions(main.id, [main.id])).rejects.toThrow("a session can't be merged into itself");
    await expect(s.mergeSessions(main.id, [])).rejects.toThrow('pick at least one session to merge');
    await expect(s.mergeSessions('nope', [practice.id])).rejects.toThrow("that session doesn't exist anymore");
    await expect(s.mergeSessions(main.id, ['nope'])).rejects.toThrow("one of these sessions doesn't exist anymore");
    await expect(s.mergeSessions(main.id, [pyra.id])).rejects.toThrow('only sessions of the same event can be merged');
    expect(s.state().sessions).toHaveLength(3);
  });

  it('puts everything back when the browser cannot store the merge', async () => {
    const s = await start();
    const [main, practice] = s.state().sessions;
    await s.addSolve({ timeMs: 1000, penalty: 'OK', scramble: '' });
    await s.addSolve({ timeMs: 2000, penalty: 'OK', scramble: '', sessionId: practice.id });
    await advance(250);
    const before = s.state();
    local.full = true;
    await expect(s.mergeSessions(main.id, [practice.id])).rejects.toThrow('not enough browser storage to save the merge');
    expect(s.state().sessions).toEqual(before.sessions);
    expect(s.state().solves).toEqual(before.solves);
    expect(s.getLoadedSolves(practice.id)).toHaveLength(1);
    expect(storedGuest().sessions.map((x) => x.id)).toEqual([main.id, practice.id]);
  });

  it('imports sessions from a file: solves in time order marked as imported, unusable sessions left out', async () => {
    const s = await start();
    const r = await s.importSessions([
      { name: '  From csTimer  ', event: '444', sourceType: '444wca', solves: [imp(3000, T(2)), imp(2000, T(1), '+2', 'note')] },
      { name: 'unknown event', event: '333mbf', sourceType: 'r3ni', solves: [imp(1000, T(1))] },
      { name: 'no solves', event: '333', sourceType: '333', solves: [] },
      { name: '   ', event: '222', sourceType: '222so', practice: true, solves: [imp(1500, T(3))] },
      { name: 'n'.repeat(45), event: '333', sourceType: '333', solves: [imp(1600, T(4))] },
    ] satisfies ImportedSession[]);
    expect(r).toEqual({ sessions: 3, solves: 4 });
    const added = s.state().sessions.slice(2);
    expect(added.map((x) => [x.name, x.event, x.practice ?? false, x.solveCount])).toEqual([
      ['From csTimer', '444', false, 2],
      ['import', '222', true, 1],
      ['n'.repeat(40), '333', false, 1],
    ]);
    expect(s.getLoadedSolves(added[0].id)!.map((x) => [x.timeMs, x.penalty, x.comment, x.source, x.createdAt, x.sessionId, x.event])).toEqual([
      [2000, '+2', 'note', 'import', T(1), added[0].id, '444'],
      [3000, 'OK', null, 'import', T(2), added[0].id, '444'],
    ]);
    expect(s.getCurrentSession()?.name).toBe('3x3');
    expect(storedGuest().sessions).toHaveLength(5); // saved at once
  });

  it('undoes an import that does not fit in browser storage', async () => {
    const s = await start();
    await advance(250);
    local.full = true;
    await expect(s.importSessions([{ name: 'big', event: '333', sourceType: '333', solves: [imp(1000, T(1))] }])).rejects.toThrow(
      'Not enough browser storage for this import. Sign in to import it into your cloud account instead.',
    );
    expect(s.state().sessions.map((x) => x.name)).toEqual(['3x3', '3x3 practice']);
    local.full = false;
    expect(storedGuest().sessions.map((x) => x.name)).toEqual(['3x3', '3x3 practice']);
  });

  it('exports every session with its solves, as a file the importer reads back the same', async () => {
    const s = await start();
    const [, practice] = s.state().sessions;
    // a second apart, as real solves are (the importer spreads solves of the same millisecond apart)
    await s.addSolve({ timeMs: 9000, penalty: 'OK', scramble: "R U R'", comment: 'first' });
    vi.setSystemTime(new Date(Date.parse(NOW) + 1000));
    await s.addSolve({ timeMs: 9500, penalty: 'DNF', scramble: 'F2' });
    vi.setSystemTime(new Date(Date.parse(NOW) + 2000));
    await s.addSolve({ timeMs: 7000, penalty: '+2', scramble: 'U', sessionId: practice.id });
    vi.setSystemTime(new Date(NOW));
    const data = await s.exportAll();
    expect(data.exportedAt).toBe(NOW);
    expect(data.sessions.map((x) => [x.name, x.solves.length])).toEqual([
      ['3x3', 2],
      ['3x3 practice', 1],
    ]);
    const back = parseTimerFile(JSON.stringify(data, null, 2));
    expect(back.format).toBe('cubr');
    expect(back.sessions.map((x) => [x.name, x.event, x.practice ?? false])).toEqual([
      ['3x3', '333', false],
      ['3x3 practice', '333', true],
    ]);
    back.sessions.forEach((x, i) => {
      expect(x.solves).toEqual(
        data.sessions[i].solves.map(({ timeMs, penalty, scramble, comment, createdAt }) => ({ timeMs, penalty, scramble, comment, createdAt })),
      );
    });
  });

  it.each([
    ['broken JSON', '{"v":1,"sessions":'],
    ['an unknown version', '{"v":2,"sessions":[]}'],
  ])('keeps unreadable guest data (%s) as a backup and starts fresh', async (_label, raw) => {
    local.setItem(LOCAL_KEY, raw);
    const s = await start();
    expect(local.getItem(`${LOCAL_KEY}.corrupt`)).toBe(raw);
    expect(s.state().sessions.map((x) => x.name)).toEqual(['3x3', '3x3 practice']);
    expect(s.toasts()).toEqual([['notice', expect.stringContaining('A backup copy was kept in this browser')]]);
  });

  it('saves at once when the page is hidden or closed', async () => {
    const s = await start();
    const a = await s.addSolve({ timeMs: 1000, penalty: 'OK', scramble: '' });
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(
      storedGuest()
        .solves.get(a.sessionId)!
        .map((x) => x.id),
    ).toEqual([a.id]);
    const b = await s.addSolve({ timeMs: 2000, penalty: 'OK', scramble: '' });
    win.dispatchEvent(new Event('pagehide'));
    expect(
      storedGuest()
        .solves.get(a.sessionId)!
        .map((x) => x.id),
    ).toEqual([a.id, b.id]);
  });

  it('picks up guest solves saved by another tab', async () => {
    const s = await start();
    await advance(250);
    const sid = s.state().currentSessionId!;
    const db = storedGuest();
    db.solves.set(sid, [
      { id: 'from-another-tab', sessionId: sid, event: '333', timeMs: 4321, penalty: 'OK', scramble: 'U', comment: null, source: 'timer', createdAt: NOW },
    ]);
    local.setItem(LOCAL_KEY, encodeLocalDb(db));
    win.dispatchEvent(Object.assign(new Event('storage'), { key: 'cubr.settings' }));
    expect(s.state().solves).toEqual([]);
    win.dispatchEvent(Object.assign(new Event('storage'), { key: LOCAL_KEY }));
    expect(s.state().solves.map((x) => x.id)).toEqual(['from-another-tab']);
    expect(s.state().currentSessionId).toBe(sid);
  });

  it('warns once when browser storage is full, keeps the solves in memory, and saves them when there is room', async () => {
    const s = await start();
    await advance(250);
    local.full = true;
    await s.addSolve({ timeMs: 1000, penalty: 'OK', scramble: '' });
    await advance(250);
    expect(s.state().syncError).toBe('browser storage is full - export your solves or sign in to sync them');
    await s.addSolve({ timeMs: 2000, penalty: 'OK', scramble: '' });
    await advance(250);
    expect(s.toasts().filter(([type]) => type === 'error')).toHaveLength(1);
    expect(s.state().solves).toHaveLength(2);
    local.full = false;
    await s.addSolve({ timeMs: 3000, penalty: 'OK', scramble: '' });
    await advance(250);
    expect(s.state().syncError).toBeNull();
    expect(storedGuest().solves.get(s.state().currentSessionId!)).toHaveLength(3);
  });

  it('clearLocalData removes the guest data and starts over', async () => {
    const s = await start();
    await s.addSolve({ timeMs: 1000, penalty: 'OK', scramble: '' });
    await advance(250);
    local.setItem(`${LOCAL_KEY}.corrupt`, 'old backup');
    s.clearLocalData();
    expect(local.getItem(`${LOCAL_KEY}.corrupt`)).toBeNull();
    expect(s.state().sessions.map((x) => [x.name, x.solveCount])).toEqual([
      ['3x3', 0],
      ['3x3 practice', 0],
    ]);
    expect(s.state().solves).toEqual([]);
    expect(s.localDataSummary()).toEqual({ sessions: 0, solves: 0 });
  });

  it('localDataSummary counts the sessions that have solves', async () => {
    const s = await start();
    const [, practice] = s.state().sessions;
    expect(s.localDataSummary()).toEqual({ sessions: 0, solves: 0 });
    await s.addSolve({ timeMs: 1000, penalty: 'OK', scramble: '' });
    await s.addSolve({ timeMs: 2000, penalty: 'OK', scramble: '' });
    const p = await s.addSolve({ timeMs: 3000, penalty: 'OK', scramble: '', sessionId: practice.id });
    expect(s.localDataSummary()).toEqual({ sessions: 2, solves: 3 });
    await s.deleteSolve(p.id);
    expect(s.localDataSummary()).toEqual({ sessions: 1, solves: 2 });
  });

  it('setPenaltyIn is for signed-in users only', async () => {
    const s = await start();
    await expect(s.setPenaltyIn('x', 'DNF')).rejects.toThrow('not signed in');
  });
});

// ================================================================ signed in

describe('signed in (cloud)', () => {
  let main: ServerSession;
  let big: ServerSession;
  const seedU1 = (server: FakeServer) => {
    main = server.seed({
      userId: 'u1',
      name: '3x3',
      solves: [
        { timeMs: 9000, at: T(2) },
        { timeMs: 8000, at: T(1) },
      ],
    });
    big = server.seed({ userId: 'u1', name: '4x4', event: '444', solves: [{ timeMs: 60_000, at: T(3) }] });
    server.seed({ userId: 'u2', name: 'not yours', solves: [{ timeMs: 1, at: T(1) }] });
  };
  const offline = (s: { ApiError: ApiErrorClass }) => new s.ApiError(0, 'NETWORK', 'Network error - is the server reachable?');
  const add = (s: Awaited<ReturnType<typeof start>>, timeMs: number, extra: Partial<Parameters<typeof s.addSolve>[0]> = {}) =>
    s.addSolve({ timeMs, penalty: 'OK', scramble: 'R', ...extra });

  it("loads the account's sessions and only the current session's solves", async () => {
    const s = await start(U1, { seed: seedU1 });
    expect(s.state()).toMatchObject({ ready: true, mode: 'cloud', currentSessionId: main.id, pending: 0, syncError: null, loading: false });
    expect(s.state().sessions.map((x) => [x.name, x.solveCount])).toEqual([
      ['3x3', 2],
      ['4x4', 1],
    ]);
    expect(s.state().solves.map((x) => x.timeMs)).toEqual([8000, 9000]); // oldest first
    expect(h.api.sessions.solves.mock.calls).toEqual([[main.id]]);
  });

  it('shows a new solve before the server answers, and sends it with its own id', async () => {
    const s = await start(U1, { seed: seedU1 });
    const gate = deferred();
    const real = h.api.solves.create.getMockImplementation()!;
    h.api.solves.create.mockImplementationOnce(async (body: unknown) => {
      await gate.promise;
      return real(body);
    });
    const solve = await add(s, 7777, { scramble: 'R2' });
    await flush();
    expect(s.state().solves.map((x) => x.id)).toEqual([`${main.id}-s1`, `${main.id}-s0`, solve.id]);
    expect(s.state().pending).toBe(1);
    expect(s.getCurrentSession()?.solveCount).toBe(3);
    expect(h.api.solves.create).toHaveBeenCalledWith({
      id: solve.id,
      sessionId: main.id,
      timeMs: 7777,
      penalty: 'OK',
      scramble: 'R2',
      comment: null,
      source: 'timer',
      createdAt: NOW,
    });
    gate.resolve();
    await flush();
    expect(s.state().pending).toBe(0);
    expect(s.server.solvesOf(main.id).map((x) => x.id)).toContain(solve.id);
    expect(queued()).toEqual([]);
  });

  it('keeps a change that could not be sent in the queue (cubr.queue.v1) and retries it, same id, backing off', async () => {
    const s = await start(U1, { seed: seedU1 });
    h.api.solves.create.mockRejectedValueOnce(offline(s)).mockRejectedValueOnce(offline(s));
    const solve = await add(s, 7777);
    await flush();
    expect(s.state()).toMatchObject({ pending: 1, syncError: 'solve service unreachable' });
    expect(s.state().solves.map((x) => x.id)).toContain(solve.id);
    expect(queued()).toEqual([
      expect.objectContaining({
        userId: 'u1',
        attempts: 1,
        op: expect.objectContaining({ kind: 'createSolve', solve: expect.objectContaining({ id: solve.id }) }),
      }),
    ]);
    await advance(999);
    expect(h.api.solves.create).toHaveBeenCalledTimes(1);
    await advance(1); // 1 s after the first failure
    expect(h.api.solves.create).toHaveBeenCalledTimes(2);
    await advance(1999);
    expect(h.api.solves.create).toHaveBeenCalledTimes(2);
    await advance(1); // then 2 s
    expect(h.api.solves.create).toHaveBeenCalledTimes(3);
    expect(s.state()).toMatchObject({ pending: 0, syncError: null });
    const [first, ...retries] = h.api.solves.create.mock.calls.map((c) => c[0]);
    for (const body of retries) expect(body).toEqual(first);
    expect(s.server.solvesOf(main.id).filter((x) => x.id === solve.id)).toHaveLength(1);
    expect(queued()).toEqual([]);
  });

  it('does not duplicate a solve the server saved when its answer was lost', async () => {
    const s = await start(U1, { seed: seedU1 });
    const real = h.api.solves.create.getMockImplementation()!;
    h.api.solves.create.mockImplementationOnce(async (body: unknown) => {
      await real(body);
      throw new s.ApiError(504, 'HTTP_504', 'Gateway timeout');
    });
    const solve = await add(s, 7777);
    await flush();
    expect(s.state().pending).toBe(1);
    await advance(1000);
    expect(h.api.solves.create).toHaveBeenCalledTimes(2);
    expect(s.state().pending).toBe(0);
    expect(s.server.solvesOf(main.id).filter((x) => x.id === solve.id)).toHaveLength(1);
    expect(s.state().solves.filter((x) => x.id === solve.id)).toHaveLength(1);
  });

  it.each([500, 502, 503, 504, 429, 408])('retries after a %i answer', async (status) => {
    const s = await start(U1, { seed: seedU1 });
    h.api.solves.create.mockRejectedValueOnce(new s.ApiError(status, `HTTP_${status}`, 'busy'));
    const solve = await add(s, 7777);
    await flush();
    expect(s.state().pending).toBe(1);
    expect(s.toasts()).toEqual([]);
    await advance(1000);
    expect(s.state().pending).toBe(0);
    expect(s.server.solvesOf(main.id).map((x) => x.id)).toContain(solve.id);
  });

  it.each([400, 403, 404, 409, 422])('drops a change the server refuses (%i), shows the server data again and says why', async (status) => {
    const s = await start(U1, { seed: seedU1 });
    h.api.solves.create.mockRejectedValueOnce(new s.ApiError(status, 'NOPE', 'time out of range'));
    const solve = await add(s, 7777);
    await flush();
    expect(s.state().solves.map((x) => x.id)).not.toContain(solve.id);
    expect(s.state()).toMatchObject({ pending: 0, syncError: null });
    expect(s.getCurrentSession()?.solveCount).toBe(2);
    expect(s.toasts()).toEqual([['error', "Couldn't save your change: time out of range"]]);
    await advance(120_000);
    expect(h.api.solves.create).toHaveBeenCalledTimes(1); // never retried
    expect(queued()).toEqual([]);
  });

  it('moves queued solves whose session was merged away on another device into a new session, with one notice', async () => {
    const s = await start(U1, { seed: seedU1 });
    h.api.solves.create.mockRejectedValueOnce(offline(s));
    const a = await add(s, 1111);
    vi.setSystemTime(new Date(Date.parse(NOW) + 1000));
    const b = await add(s, 2222);
    await flush();
    expect(queued().map((q) => q.op.kind)).toEqual(['createSolve', 'createSolve']);
    // meanwhile 3x3 was merged into another session on another device: it's gone from the account
    s.server.sessions = s.server.sessions.filter((x) => x.id !== main.id);
    await advance(2000);
    await flush();
    const rec = s.server.sessions.find((x) => x.name === '3x3 (recovered)');
    expect(rec).toMatchObject({ userId: 'u1', event: '333', practice: false }); // this device still knew 3x3: a normal session
    expect(s.server.solvesOf(rec!.id).map((x) => x.id)).toEqual([a.id, b.id]);
    expect(queued()).toEqual([]);
    expect(s.toasts()).toEqual([['notice', '2 solves from a session merged or deleted on another device are in a new session, "3x3 (recovered)"']]);
    expect(s.state().sessions.map((x) => x.name)).toContain('3x3 (recovered)');
  });

  it('drops, with an error, a solve that cannot go into the session it was moved to either', async () => {
    const s = await start(U1, { seed: seedU1 });
    h.api.solves.create.mockRejectedValueOnce(offline(s));
    await add(s, 1111);
    await flush();
    s.server.sessions = s.server.sessions.filter((x) => x.id !== main.id);
    const real = h.api.sessions.create.getMockImplementation()!;
    // the new session is made, then removed again before the solve arrives
    h.api.sessions.create.mockImplementationOnce(async (body: { id: string }) => {
      const res = await real(body);
      s.server.sessions = s.server.sessions.filter((x) => x.id !== body.id);
      return res;
    });
    await advance(2000);
    await flush();
    expect(queued()).toEqual([]);
    expect(s.toasts().map(([type]) => type)).toEqual(['notice', 'error']); // moved once, then given up: no loop
  });

  it('retries at once when the browser comes back online', async () => {
    const s = await start(U1, { seed: seedU1 });
    h.api.solves.create.mockRejectedValueOnce(offline(s)).mockRejectedValueOnce(offline(s));
    await add(s, 7777);
    await flush();
    await advance(1000); // fails again: next try in 2 s
    expect(h.api.solves.create).toHaveBeenCalledTimes(2);
    win.dispatchEvent(new Event('online'));
    await flush();
    expect(h.api.solves.create).toHaveBeenCalledTimes(3);
    expect(s.state()).toMatchObject({ pending: 0, syncError: null });
  });

  it('keeps a change when the sign-in has expired (401) and sends it after signing in again', async () => {
    const s = await start(U1, { seed: seedU1 });
    h.api.solves.create.mockRejectedValueOnce(new s.ApiError(401, 'UNAUTHORIZED', 'token expired'));
    const solve = await add(s, 7777);
    await flush();
    expect(s.state().pending).toBe(1);
    await advance(120_000);
    expect(h.api.solves.create).toHaveBeenCalledTimes(1); // no retries without a valid sign-in
    await logout();
    await login(U1);
    expect(h.api.solves.create).toHaveBeenCalledTimes(2);
    expect(s.server.solvesOf(main.id).map((x) => x.id)).toContain(solve.id);
    expect(s.state().pending).toBe(0);
  });

  it('keeps unsent changes across a reload, shows them on top of the server data, and sends them in order', async () => {
    const s = await start(U1, { seed: seedU1 });
    h.api.solves.create.mockRejectedValue(new s.ApiError(503, 'HTTP_503', 'Service temporarily unavailable'));
    const a = await add(s, 1111);
    vi.setSystemTime(new Date(Date.parse(NOW) + 1000));
    const b = await add(s, 2222);
    await flush();
    expect(queued().map((q) => q.op.kind)).toEqual(['createSolve', 'createSolve']);

    await newPage();
    const again = await start(U1, { server: s.server, before: ({ ApiError }) => h.api.solves.create.mockRejectedValue(new ApiError(503, 'HTTP_503', 'down')) });
    expect(again.state().pending).toBe(2);
    expect(again.state().solves.map((x) => x.id)).toEqual([`${main.id}-s1`, `${main.id}-s0`, a.id, b.id]);
    expect(again.getCurrentSession()?.solveCount).toBe(4);
    expect(s.server.solvesOf(main.id)).toHaveLength(2);
    again.reinstall();
    await advance(1000);
    expect(again.state().pending).toBe(0);
    expect(h.api.solves.create.mock.calls.slice(-2).map((c) => c[0].id)).toEqual([a.id, b.id]);
    expect(s.server.solvesOf(main.id).map((x) => x.id)).toEqual([`${main.id}-s1`, `${main.id}-s0`, a.id, b.id]);
  });

  it('folds edits of an unsent solve into its creation, and sends nothing for one deleted before it was sent', async () => {
    const s = await start(U1, { seed: seedU1 });
    h.api.solves.create.mockRejectedValueOnce(offline(s));
    const a = await add(s, 5000);
    await flush(); // failed: waits for a retry
    await s.setPenalty(a.id, 'DNF');
    await s.setComment(a.id, 'bad');
    const b = await add(s, 6000);
    await s.deleteSolve(b.id);
    expect(queued()).toEqual([
      expect.objectContaining({
        op: expect.objectContaining({ kind: 'createSolve', solve: expect.objectContaining({ id: a.id, penalty: 'DNF', comment: 'bad' }) }),
      }),
    ]);
    await advance(1000);
    expect(h.api.solves.create).toHaveBeenCalledTimes(2);
    expect(h.api.solves.create).toHaveBeenLastCalledWith(expect.objectContaining({ id: a.id, penalty: 'DNF', comment: 'bad' }));
    expect(h.api.solves.update).not.toHaveBeenCalled();
    expect(h.api.solves.remove).not.toHaveBeenCalled();
    expect(s.server.solvesOf(main.id).map((x) => x.id)).toEqual([`${main.id}-s1`, `${main.id}-s0`, a.id]);
  });

  it('sends penalty, comment and delete requests for a solve the server has', async () => {
    const s = await start(U1, { seed: seedU1 });
    const a = await add(s, 5000);
    await flush();
    await s.setPenalty(a.id, '+2');
    await flush();
    expect(h.api.solves.update).toHaveBeenLastCalledWith(a.id, { penalty: '+2' });
    await s.setComment(a.id, ' nice ');
    await flush();
    expect(h.api.solves.update).toHaveBeenLastCalledWith(a.id, { comment: 'nice' });
    expect(s.server.solvesOf(main.id).find((x) => x.id === a.id)).toMatchObject({ penalty: '+2', comment: 'nice' });
    await s.deleteSolve(a.id);
    await flush();
    expect(h.api.solves.remove).toHaveBeenCalledWith(a.id);
    expect(s.server.solvesOf(main.id).map((x) => x.id)).not.toContain(a.id);
    expect(s.state().pending).toBe(0);
  });

  it('sends session changes: create (with its own id), rename, practice and delete', async () => {
    const s = await start(U1, { seed: seedU1 });
    const oh = await s.createSession('OH', '333oh');
    await flush();
    expect(h.api.sessions.create).toHaveBeenLastCalledWith({ id: oh.id, name: 'OH', event: '333oh' });
    await s.renameSession(oh.id, 'One-handed');
    await flush();
    expect(h.api.sessions.rename).toHaveBeenLastCalledWith(oh.id, 'One-handed');
    await s.setSessionPractice(oh.id, true);
    await flush();
    expect(h.api.sessions.setPractice).toHaveBeenLastCalledWith(oh.id, true);
    expect(s.server.sessions.find((x) => x.id === oh.id)).toMatchObject({ name: 'One-handed', practice: true });
    await s.deleteSession(oh.id);
    await flush();
    expect(h.api.sessions.remove).toHaveBeenLastCalledWith(oh.id);
    expect(s.server.sessions.some((x) => x.id === oh.id)).toBe(false);
    const warmUp = await s.createSession('warm up', '333', { practice: true });
    await flush();
    expect(h.api.sessions.create).toHaveBeenLastCalledWith({ id: warmUp.id, name: 'warm up', event: '333', practice: true });
    expect(s.state().pending).toBe(0);
  });

  it("sends a practice scramble's session with its type, as a practice session", async () => {
    const s = await start(U1, { seed: seedU1 });
    await s.switchScramble('333', 'oll');
    const oll = s.getCurrentSession()!;
    await flush();
    expect(h.api.sessions.create).toHaveBeenLastCalledWith({ id: oll.id, name: '3x3 oll', event: '333', practice: true, scramble: 'oll' });
    expect(s.server.sessions.find((x) => x.id === oll.id)).toMatchObject({ scramble: 'oll', practice: true });
  });

  it('treats changes to a session deleted on another device (404) as done, and skips edits to a session being deleted', async () => {
    const s = await start(U1, { seed: seedU1 });
    s.server.sessions = s.server.sessions.filter((x) => x.id !== big.id); // gone elsewhere
    await s.renameSession(big.id, 'renamed');
    await s.setSessionPractice(big.id, true);
    await s.deleteSession(big.id);
    await flush();
    expect(h.api.sessions.rename).toHaveBeenCalledWith(big.id, 'renamed');
    expect(h.api.sessions.setPractice).not.toHaveBeenCalled(); // dropped: the session is deleted next
    expect(h.api.sessions.remove).toHaveBeenCalledWith(big.id);
    expect(s.toasts()).toEqual([]);
    expect(s.state()).toMatchObject({ pending: 0, syncError: null });
  });

  it('clears a session with two requests: an empty copy with the same name and creation time, and a delete', async () => {
    const s = await start(U1, {
      seed: (server) => {
        main = server.seed({ userId: 'u1', name: '3x3', solves: [1, 2, 3].map((i) => ({ timeMs: i * 1000, at: T(i) })) });
        big = server.seed({ userId: 'u1', name: '3x3 practice', practice: true });
      },
    });
    await s.clearSession(main.id);
    await flush();
    const fresh = s.getCurrentSession()!;
    expect(fresh.id).not.toBe(main.id);
    expect(fresh).toMatchObject({ name: '3x3', event: '333', createdAt: main.createdAt, solveCount: 0 });
    expect(s.state().solves).toEqual([]);
    expect(s.state().sessions.map((x) => x.id)).toEqual([fresh.id, big.id]);
    expect(h.api.sessions.create).toHaveBeenCalledWith({ id: fresh.id, name: '3x3', event: '333', createdAt: main.createdAt });
    expect(h.api.sessions.remove).toHaveBeenCalledWith(main.id);
    expect(h.api.solves.remove).not.toHaveBeenCalled();
    expect(s.server.namesOf('u1')).toEqual(['3x3', '3x3 practice']); // the copy keeps the old place
    expect(s.server.solvesOf(fresh.id)).toEqual([]);
    expect(s.server.sessions.some((x) => x.id === main.id)).toBe(false);
  });

  it('opens a session with its solves and remembers it as current for this account on the next visit', async () => {
    const s = await start(U1, { seed: seedU1 });
    await s.switchSession(big.id);
    await flush();
    expect(s.state().solves.map((x) => x.timeMs)).toEqual([60_000]);
    expect(local.json<Record<string, { current: string }>>(LAST_SESSION_KEY)).toMatchObject({ u1: { current: big.id } });
    await newPage();
    const again = await start(U1, { server: s.server });
    expect(again.state().currentSessionId).toBe(big.id);
  });

  it('drops a session deleted on another device when opening it, and opens another', async () => {
    const s = await start(U1, { seed: seedU1 });
    s.server.sessions = s.server.sessions.filter((x) => x.id !== big.id);
    await s.switchSession(big.id);
    await flush();
    expect(s.state().sessions.map((x) => x.id)).toEqual([main.id]);
    expect(s.state().currentSessionId).toBe(main.id);
    expect(s.state().solves).toHaveLength(2);
  });

  it('shows a just-saved solve even if the server list lags behind, for a minute', async () => {
    const s = await start(U1, { seed: seedU1 });
    const a = await add(s, 5000);
    await flush();
    const real = h.api.sessions.solves.getMockImplementation()!;
    h.api.sessions.solves.mockImplementation(async (id: string) => {
      const r = (await real(id)) as { solves: Solve[] };
      return { solves: r.solves.filter((x) => x.id !== a.id) }; // a replica that hasn't caught up
    });
    await s.reloadSolves();
    await flush();
    expect(s.state().solves.map((x) => x.id)).toContain(a.id);
    vi.setSystemTime(new Date(Date.parse(NOW) + 61_000));
    await s.reloadSolves();
    await flush();
    expect(s.state().solves.map((x) => x.id)).not.toContain(a.id);
  });

  it('keeps timing from the offline copy (cubr.cloudcache.v1) while the solve service is down', async () => {
    const s = await start(U1, { seed: seedU1 });
    expect(local.getItem(CACHE_KEY)).toBeNull();
    await advance(1500);
    const cache = local.json<{ userId: string; sessionId: string; sessions: Session[]; solves: unknown[] }>(CACHE_KEY)!;
    expect(cache).toMatchObject({ userId: 'u1', sessionId: main.id });
    expect(cache.sessions.map((x) => x.name)).toEqual(['3x3', '4x4']);
    expect(cache.solves).toHaveLength(2);
    const before = s.state().solves.map(core);

    await newPage();
    s.server.down = true;
    const off = await start(U1, { server: s.server });
    expect(off.state()).toMatchObject({ ready: true, mode: 'cloud', currentSessionId: main.id, syncError: 'solve service unreachable' });
    expect(off.state().sessions.map((x) => x.name)).toEqual(['3x3', '4x4']);
    expect(off.state().solves.map(core)).toEqual(before);
    const added = await add(off, 4444);
    await flush();
    expect(off.state().pending).toBe(1);
    s.server.down = false;
    await advance(2000);
    expect(off.state()).toMatchObject({ pending: 0, syncError: null });
    expect(s.server.solvesOf(main.id).map((x) => x.id)).toContain(added.id);
  });

  it("never shows another account's offline copy", async () => {
    local.setItem(
      CACHE_KEY,
      JSON.stringify({
        userId: 'u2',
        sessions: [{ id: 'u2s', name: "two's session", event: '333', createdAt: T(0), updatedAt: T(0), solveCount: 1 }],
        sessionId: 'u2s',
        solves: [['x', 1000, 0, '', null, 0]],
      }),
    );
    const s = await start(U1, { before: ({ server }) => (server.down = true) });
    expect(s.state().sessions.map((x) => x.name)).toEqual(['3x3', '3x3 practice']); // made here, sent once the service is back
    expect(s.state().solves).toEqual([]);
    expect(s.state().pending).toBe(2);
  });

  it("leaves another account's queued changes alone", async () => {
    const foreign: QueuedOp = { opId: 'op-u2', userId: 'u2', op: { kind: 'deleteSession', id: 'u2-session' }, attempts: 0, createdAt: 0 };
    local.setItem(QUEUE_KEY, JSON.stringify([foreign]));
    const s = await start(U1, { seed: seedU1 });
    await add(s, 5000);
    await flush();
    expect(h.api.sessions.remove).not.toHaveBeenCalled();
    expect(s.state().pending).toBe(0);
    expect(queued()).toEqual([foreign]);
  });

  it('waits for the account to load before adding a solve made right away', async () => {
    const gate = deferred();
    const s = await start(U1, {
      seed: seedU1,
      before: () => {
        const real = h.api.sessions.list.getMockImplementation()!;
        h.api.sessions.list.mockImplementationOnce(async () => {
          await gate.promise;
          return real();
        });
      },
    });
    expect(s.state()).toMatchObject({ ready: false, mode: 'cloud' });
    const pending = add(s, 5555);
    gate.resolve();
    await flush();
    const solve = await pending;
    expect(solve.sessionId).toBe(main.id);
    expect(s.state().solves.map((x) => x.id)).toContain(solve.id);
  });

  it('daily-challenge attempts wait for the server, which can refuse them', async () => {
    const s = await start(U1, { seed: seedU1 });
    const date = '2026-11-16';
    const ok = await add(s, 9000, { source: 'daily', daily: { date, index: 0 } });
    expect(ok).toMatchObject({ source: 'daily', dailyDate: date, dailyIndex: 0 });
    expect(h.api.solves.create).toHaveBeenLastCalledWith(expect.objectContaining({ id: ok.id, source: 'daily', daily: { date, index: 0 } }));
    expect(s.server.solvesOf(main.id).find((x) => x.id === ok.id)).toMatchObject({ dailyDate: date, dailyIndex: 0 });

    h.api.solves.create.mockRejectedValueOnce(new s.ApiError(409, 'CONFLICT', 'already submitted'));
    await expect(add(s, 9500, { source: 'daily', daily: { date, index: 1 } })).rejects.toMatchObject({ status: 409, message: 'already submitted' });
    await flush();
    expect(s.state().solves.map((x) => x.timeMs)).not.toContain(9500);

    // offline it is kept and sent later
    h.api.solves.create.mockRejectedValueOnce(offline(s));
    await expect(add(s, 9600, { source: 'daily', daily: { date, index: 2 } })).resolves.toMatchObject({ timeMs: 9600 });
    expect(s.state().pending).toBe(1);
  });

  it('sets the penalty of a solve that is not loaded here (a daily attempt), after its creation if that is still queued', async () => {
    const s = await start(U1, { seed: seedU1 });
    const elsewhere = s.server.solvesOf(big.id)[0]; // big's solves are not loaded
    await s.setPenaltyIn(elsewhere.id, '+2', big.id);
    expect(h.api.solves.update).toHaveBeenCalledWith(elsewhere.id, { penalty: '+2' });
    expect(s.server.solvesOf(big.id)[0].penalty).toBe('+2');
    await expect(s.setPenaltyIn('unknown', 'DNF')).rejects.toThrow('unknown solve');

    h.api.solves.create.mockRejectedValueOnce(offline(s));
    const queuedSolve = await add(s, 7000, { sessionId: big.id });
    await flush();
    await s.setPenaltyIn(queuedSolve.id, 'DNF'); // folded into the queued creation
    await advance(1000);
    expect(h.api.solves.create).toHaveBeenLastCalledWith(expect.objectContaining({ id: queuedSolve.id, penalty: 'DNF' }));
    expect(h.api.solves.update).toHaveBeenCalledTimes(1);

    h.api.solves.update.mockRejectedValueOnce(new s.ApiError(403, 'FORBIDDEN', 'the day is over'));
    await expect(s.setPenaltyIn(elsewhere.id, 'OK', big.id)).rejects.toThrow('the day is over');
  });

  it('exports after sending what is queued', async () => {
    const s = await start(U1, { seed: seedU1 });
    h.api.solves.create.mockRejectedValueOnce(offline(s));
    const a = await add(s, 5000);
    await flush();
    const exporting = s.exportAll();
    await advance(300);
    const data = await exporting;
    expect(h.api.solves.create).toHaveBeenCalledTimes(2);
    expect(h.api.solves.create.mock.invocationCallOrder[1]).toBeLessThan(h.api.solves.export.mock.invocationCallOrder[0]);
    expect(data.sessions.find((x) => x.id === main.id)!.solves.map((x) => x.id)).toContain(a.id);
    expect(data.sessions.map((x) => x.name)).toEqual(['3x3', '4x4']);
  });

  it('imports sessions in one request and shows them', async () => {
    const s = await start(U1, { seed: seedU1 });
    const r = await s.importSessions([
      { name: ' Imported ', event: '444', sourceType: '444wca', solves: [imp(3000, T(5)), imp(2000, T(4), '+2', 'n')] },
      { name: 'skip me', event: 'nope', sourceType: 'x', solves: [imp(1000, T(1))] },
      { name: '', event: '222', sourceType: '222so', practice: true, solves: [imp(1500, T(2))] },
    ]);
    expect(r).toEqual({ sessions: 2, solves: 3 });
    expect(h.api.sessions.import).toHaveBeenCalledTimes(1);
    expect(h.api.sessions.import.mock.calls[0][0]).toEqual({
      sessions: [
        { name: 'Imported', event: '444', solves: [imp(3000, T(5)), imp(2000, T(4), '+2', 'n')] },
        { name: 'import', event: '222', practice: true, solves: [imp(1500, T(2))] },
      ],
    });
    expect(s.state().sessions.map((x) => [x.name, x.solveCount])).toEqual([
      ['3x3', 2],
      ['4x4', 1],
      ['Imported', 2],
      ['import', 1],
    ]);
  });

  describe('merging', () => {
    let other: ServerSession;
    const seedMerge = (server: FakeServer) => {
      main = server.seed({
        userId: 'u1',
        name: '3x3',
        solves: [
          { timeMs: 1000, at: T(1) },
          { timeMs: 3000, at: T(3) },
        ],
      });
      other = server.seed({
        userId: 'u1',
        name: '3x3 B',
        solves: [
          { timeMs: 2000, at: T(2) },
          { timeMs: 4000, at: T(4) },
        ],
      });
    };

    it('sends queued changes first, then merges on the server and shows the result', async () => {
      const s = await start(U1, { seed: seedMerge });
      h.api.solves.create.mockRejectedValueOnce(offline(s));
      const a = await add(s, 5000);
      await flush();
      const merging = s.mergeSessions(main.id, [other.id]);
      await advance(300);
      await expect(merging).resolves.toEqual({ sessions: 1, solves: 2 });
      expect(h.api.solves.create.mock.invocationCallOrder[1]).toBeLessThan(h.api.sessions.merge.mock.invocationCallOrder[0]);
      expect(h.api.sessions.merge).toHaveBeenCalledWith(main.id, [other.id]);
      expect(s.state().sessions.map((x) => x.id)).toEqual([main.id]);
      expect(s.state().solves.map((x) => x.timeMs)).toEqual([1000, 2000, 3000, 4000, 5000]);
      expect(s.server.solvesOf(main.id).map((x) => x.id)).toContain(a.id);
      expect(s.server.sessions.some((x) => x.id === other.id)).toBe(false);
    });

    it("refuses to merge while changes to those sessions can't be sent", async () => {
      const s = await start(U1, { seed: seedMerge });
      h.api.solves.create.mockRejectedValue(offline(s));
      await add(s, 5000);
      await flush();
      const merging = s.mergeSessions(main.id, [other.id]).then(
        () => null,
        (e: Error) => e,
      );
      await advance(300);
      expect((await merging)?.message).toBe("you have unsynced solves - try again when you're back online");
      expect(h.api.sessions.merge).not.toHaveBeenCalled();
      expect(s.state().sessions).toHaveLength(2);
    });

    it.each([
      [409, 'only sessions of the same event can be merged'],
      [404, 'one of these sessions no longer exists (changed on another device?) - your sessions were refreshed, please try again'],
      [401, 'you were signed out - sign in again to merge sessions'],
      [429, 'too many requests - try again in a moment'],
      [503, "couldn't reach the solve service - try again in a moment"],
      [400, 'the server said no'],
    ])('explains a merge the server refuses with %i', async (status, message) => {
      const s = await start(U1, { seed: seedMerge });
      h.api.sessions.merge.mockRejectedValueOnce(new s.ApiError(status, 'X', 'the server said no'));
      await expect(s.mergeSessions(main.id, [other.id])).rejects.toThrow(message);
      await flush();
      expect(s.state().sessions.map((x) => x.id)).toEqual([main.id, other.id]); // refreshed from the server
    });

    it('merges more than 50 sessions in chunks and says how far it got when a chunk fails', async () => {
      const sources: ServerSession[] = [];
      const s = await start(U1, {
        seed: (server) => {
          main = server.seed({ userId: 'u1', name: 'target' });
          for (let i = 0; i < 60; i++) sources.push(server.seed({ userId: 'u1', name: `s${i}`, solves: [{ timeMs: 1000 + i, at: T(i) }] }));
        },
      });
      const real = h.api.sessions.merge.getMockImplementation()!;
      h.api.sessions.merge.mockImplementationOnce(real).mockRejectedValueOnce(new s.ApiError(503, 'HTTP_503', 'down'));
      await expect(
        s.mergeSessions(
          main.id,
          sources.map((x) => x.id),
        ),
      ).rejects.toThrow("merged 50 of 60 sessions, then: couldn't reach the solve service - try again in a moment");
      await flush();
      expect(h.api.sessions.merge.mock.calls.map((c) => c[1].length)).toEqual([50, 10]);
      expect(s.state().sessions).toHaveLength(11);
      expect(s.server.solvesOf(main.id)).toHaveLength(50);
    });
  });

  it("forgetUser drops an account's queued changes, offline copy and last session, and nothing of others", async () => {
    const foreign: QueuedOp = { opId: 'op-u2', userId: 'u2', op: { kind: 'deleteSession', id: 'u2-session' }, attempts: 0, createdAt: 0 };
    local.setItem(QUEUE_KEY, JSON.stringify([foreign]));
    local.setItem(LAST_SESSION_KEY, JSON.stringify({ u2: { current: 'u2-session', lastByEvent: {} } }));
    const s = await start(U1, { seed: seedU1 });
    await s.switchSession(big.id);
    await advance(1500);
    h.api.solves.create.mockRejectedValue(offline(s));
    await add(s, 5000);
    await flush();
    expect(s.state().pending).toBe(1);
    expect(local.getItem(CACHE_KEY)).not.toBeNull();
    s.forgetUser('u1');
    expect(queued()).toEqual([foreign]);
    expect(local.getItem(CACHE_KEY)).toBeNull();
    expect(local.json(LAST_SESSION_KEY)).toEqual({ u2: { current: 'u2-session', lastByEvent: {} } });
    expect(s.state().pending).toBe(0);
  });
});

// ================================================================ signing in and out

describe("two tabs (the October review's #11)", () => {
  let main: ServerSession;
  const seed = (server: FakeServer) => {
    main = server.seed({ userId: 'u1', name: '3x3', solves: [{ timeMs: 9000, at: T(1) }] });
  };
  const offline = (s: { ApiError: ApiErrorClass }) => new s.ApiError(0, 'NETWORK', 'Network error - is the server reachable?');
  type Tab = Awaited<ReturnType<typeof start>>;
  const add = (s: Tab, timeMs: number) => s.addSolve({ timeMs, penalty: 'OK', scramble: 'R' });
  /** a browser delivers each write to localStorage to the other tabs as a 'storage' event */
  const tell = (w: EventTarget, key: string) => w.dispatchEvent(Object.assign(new Event('storage'), { key }));
  const timesQueued = () => queued().flatMap((q) => (q.op.kind === 'createSolve' ? [q.op.solve.timeMs] : []));

  /** A second tab: the same browser storage and solve service, its own page and module instance. */
  async function secondTab(server: FakeServer, opts: { offline?: boolean } = {}): Promise<{ tab: Tab; first: EventTarget; second: EventTarget }> {
    const first = win;
    vi.resetModules();
    stubPage();
    const tab = await start(U1, { server, before: opts.offline ? (ctx) => void h.api.solves.create.mockRejectedValue(offline(ctx)) : undefined });
    return { tab, first, second: win };
  }

  /** navigator.locks for the tabs: one holder per name, ifAvailable answers null while it's held */
  function stubLocks(): void {
    const held = new Set<string>();
    vi.stubGlobal('navigator', {
      locks: {
        request: async (name: string, _opts: unknown, fn: (lock: { name: string } | null) => Promise<void>) => {
          if (held.has(name)) return fn(null);
          held.add(name);
          try {
            return await fn({ name });
          } finally {
            held.delete(name);
          }
        },
      },
    });
  }

  it("keeps every tab's unsent changes, and sends them all once back online", async () => {
    const a = await start(U1, { seed });
    h.api.solves.create.mockRejectedValue(offline(a));
    const one = await add(a, 1111);
    await flush();
    const { tab: b, first, second } = await secondTab(a.server, { offline: true });
    const two = await add(b, 2222);
    tell(first, QUEUE_KEY);
    const three = await add(a, 3333); // tab A writes again: tab B's solve stays (it used to be overwritten)
    tell(second, QUEUE_KEY);
    expect(timesQueued()).toEqual([1111, 2222, 3333]);
    b.reinstall(); // back online
    first.dispatchEvent(new Event('online'));
    second.dispatchEvent(new Event('online'));
    await advance(5000);
    expect(a.server.solvesOf(main.id).map((x) => x.id)).toEqual(expect.arrayContaining([one.id, two.id, three.id]));
    expect(queued()).toEqual([]);
  });

  it('sends from one tab at a time', async () => {
    stubLocks();
    const a = await start(U1, { seed });
    h.api.solves.create.mockRejectedValue(offline(a));
    await add(a, 1111);
    await add(a, 2222);
    await flush();
    const { tab: b, first, second } = await secondTab(a.server, { offline: true });
    await add(b, 3333);
    tell(first, QUEUE_KEY);
    b.reinstall();
    const real = h.api.solves.create.getMockImplementation()!;
    let sending = 0;
    let most = 0;
    let calls = 0;
    h.api.solves.create.mockImplementation(async (body: unknown) => {
      calls++;
      most = Math.max(most, ++sending);
      await new Promise((r) => setTimeout(r, 100));
      sending--;
      return real(body);
    });
    first.dispatchEvent(new Event('online'));
    second.dispatchEvent(new Event('online'));
    await advance(5000);
    expect(most).toBe(1);
    expect(calls).toBe(3); // each once, back online
    expect(queued()).toEqual([]);
  });

  it("never folds an edit into the solve another tab is sending, so the edit isn't lost", async () => {
    stubLocks();
    const a = await start(U1, { seed });
    const gate = deferred();
    const real = h.api.solves.create.getMockImplementation()!;
    h.api.solves.create.mockImplementationOnce(async (body: unknown) => {
      await gate.promise;
      return real(body);
    });
    const solve = await add(a, 1111);
    await flush(); // tab A is sending it
    const { tab: b, first, second } = await secondTab(a.server);
    const marking = b.setPenaltyIn(solve.id, 'DNF', main.id); // tab B marks it DNF meanwhile (it waits until that's sent)
    await flush();
    tell(first, QUEUE_KEY);
    expect(queued().map((q) => q.op.kind)).toEqual(['createSolve', 'updateSolve']); // a separate edit, not folded in
    gate.resolve();
    await advance(5000); // tab A sends both
    tell(second, QUEUE_KEY);
    await marking; // tab B hears its edit went out
    expect(a.server.solvesOf(main.id).find((x) => x.id === solve.id)?.penalty).toBe('DNF');
    expect(queued()).toEqual([]);
  });
});

describe('signing in and out', () => {
  it('switches to the account on login and back to the guest solves on logout, losing nothing', async () => {
    const s = await start();
    const g = await s.addSolve({ timeMs: 3333, penalty: 'OK', scramble: '' });
    const account = s.server.seed({ userId: 'u1', name: '3x3', solves: [{ timeMs: 9000, at: T(1) }] });
    await login(U1);
    expect(s.state()).toMatchObject({ mode: 'cloud', ready: true, currentSessionId: account.id });
    expect(s.state().solves.map((x) => x.timeMs)).toEqual([9000]);
    expect(s.localDataSummary()).toEqual({ sessions: 1, solves: 1 }); // still in this browser
    await logout();
    expect(s.state()).toMatchObject({ mode: 'local', ready: true, pending: 0 });
    expect(s.state().solves.map((x) => x.id)).toEqual([g.id]);
  });

  it('offers to upload guest solves after login, and uploads them into the account', async () => {
    const s = await start();
    const a = await s.addSolve({ timeMs: 1000, penalty: 'OK', scramble: 'R', comment: 'hi' });
    const b = await s.addSolve({ timeMs: 2000, penalty: 'DNF', scramble: 'U' });
    s.server.seed({ userId: 'u1', name: '3x3' });
    await login(U1);
    expect(s.uploadOfferStore.get()).toEqual({ userId: 'u1', sessions: 1, solves: 2 });
    expect(await s.uploadLocalSolves()).toEqual({ sessions: 1, solves: 2 });
    expect(h.api.sessions.import.mock.calls[0][0]).toEqual({
      sessions: [
        {
          name: '3x3',
          event: '333',
          solves: [a, b].map(({ timeMs, penalty, scramble, comment, createdAt }) => ({ timeMs, penalty, scramble, comment, createdAt })),
        },
      ],
    });
    expect(s.uploadOfferStore.get()).toBeNull();
    expect(s.localDataSummary()).toEqual({ sessions: 0, solves: 0 });
    expect(local.getItem(LOCAL_KEY)).toBeNull();
    expect(s.state().sessions.map((x) => [x.name, x.solveCount])).toEqual([
      ['3x3', 0],
      ['3x3', 2],
    ]);
  });

  it('keeps only the guest sessions not uploaded yet when an upload fails half way, so a retry adds no duplicates', async () => {
    const tuples = Array.from({ length: 20_000 }, (_, i) => [`b${i}`, 5000 + (i % 1000), 0, '', null, Date.UTC(2026, 0, 1) + i * 1000]);
    local.setItem(
      LOCAL_KEY,
      JSON.stringify({
        v: 1,
        sessions: [
          { id: 'g-big', name: 'big', event: '333', createdAt: T(0), updatedAt: T(0) },
          { id: 'g-small', name: 'small', event: '222', createdAt: T(0), updatedAt: T(0) },
        ],
        solves: { 'g-big': tuples, 'g-small': [['s0', 4000, 0, '', null, Date.UTC(2026, 0, 2)]] },
        current: 'g-big',
        lastByEvent: {},
      }),
    );
    const s = await start(U1, { seed: (server) => server.seed({ userId: 'u1', name: '3x3' }) });
    expect(s.uploadOfferStore.get()).toEqual({ userId: 'u1', sessions: 2, solves: 20_001 });
    const real = h.api.sessions.import.getMockImplementation()!;
    h.api.sessions.import.mockImplementationOnce(real).mockRejectedValueOnce(new s.ApiError(503, 'HTTP_503', 'Service temporarily unavailable'));
    await expect(s.uploadLocalSolves()).rejects.toMatchObject({ status: 503 });
    expect(h.api.sessions.import.mock.calls.map((c) => c[0].sessions.map((x: { name: string }) => x.name))).toEqual([['big'], ['small']]);
    expect(s.localDataSummary()).toEqual({ sessions: 1, solves: 1 });
    await s.uploadLocalSolves();
    expect(h.api.sessions.import.mock.calls[2][0].sessions.map((x: { name: string }) => x.name)).toEqual(['small']);
    expect(s.server.namesOf('u1')).toEqual(['3x3', 'big', 'small']);
    expect(s.localDataSummary()).toEqual({ sessions: 0, solves: 0 });
  });

  it('does not offer the upload again once dismissed for that account', async () => {
    const s = await start();
    await s.addSolve({ timeMs: 1000, penalty: 'OK', scramble: '' });
    await login(U1);
    expect(s.uploadOfferStore.get()).toMatchObject({ userId: 'u1' });
    s.dismissUploadOffer();
    expect(s.uploadOfferStore.get()).toBeNull();
    expect(session.getItem('cubr.uploadOffer.dismissed')).toBe('u1');
    await logout();
    await login(U1);
    expect(s.uploadOfferStore.get()).toBeNull();
    await logout();
    await login(U2);
    expect(s.uploadOfferStore.get()).toEqual({ userId: 'u2', sessions: 1, solves: 1 });
  });

  it('uploadLocalSolves needs a signed-in user', async () => {
    const s = await start();
    await expect(s.uploadLocalSolves()).rejects.toThrow('Sign in first');
  });

  it('ignores a late answer meant for the previous account', async () => {
    const s = await start();
    const guestIds = s.state().sessions.map((x) => x.id);
    s.server.seed({ userId: 'u1', name: 'u1 session' });
    const gate = deferred();
    const real = h.api.sessions.list.getMockImplementation()!;
    h.api.sessions.list.mockImplementationOnce(async () => {
      const r = await real();
      await gate.promise;
      return r;
    });
    await login(U1);
    expect(s.state()).toMatchObject({ mode: 'cloud', ready: false });
    await logout();
    gate.resolve();
    await flush();
    expect(s.state()).toMatchObject({ mode: 'local', ready: true });
    expect(s.state().sessions.map((x) => x.id)).toEqual(guestIds);
    expect(h.api.sessions.solves).not.toHaveBeenCalled();
  });

  // recently completed ops are re-applied on reads for a minute (read-after-write), but only the account's own
  it('does not show sessions the previous account just created to the next account', async () => {
    const s = await start(U1, {
      seed: (server) => {
        server.seed({ userId: 'u1', name: '3x3' });
        server.seed({ userId: 'u2', name: '3x3' });
      },
    });
    await s.createSession('u1 private', '333');
    await flush();
    expect(s.server.namesOf('u1')).toContain('u1 private');
    await logout();
    await login(U2);
    expect(s.state().sessions.map((x) => x.name)).toEqual(['3x3']);
  });
});
