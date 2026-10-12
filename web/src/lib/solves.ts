// Solve store — the single source of truth for sessions & solves in the browser.
//
// CONTRACT (other pages rely on these exports):
//  - Guest mode ("local"): everything persists in localStorage; works with no backend at all.
//  - Logged-in mode ("cloud"): data lives in solve-service. Writes are optimistic (UI updates
//    immediately) and queued; failed requests (network / 5xx) are retried with backoff — solve
//    and session ids are generated client-side, so retries are idempotent. 4xx → revert + toast.
//  - Switches automatically on login/logout (onAuthChange from ./auth).
//
// Implementation notes
//  - Local data: `cubetype.local.v1` (compact tuples, see timer/storeUtils.ts), written debounced
//    and flushed on pagehide.
//  - Cloud writes go through a persistent FIFO queue (`cubetype.queue.v1`) processed one op at a
//    time; unsent edits are coalesced into their create. Network/5xx/429 → exponential backoff
//    (1 s … 60 s, retried immediately on `online`). Server reads are overlaid with queued ops so
//    optimistic changes survive reloads.
import { getEvent, isEventId, type Penalty } from '@cubetype/cubestats';
import { api, ApiError, getToken } from './api';
import { getCurrentUser, onAuthChange } from './auth';
import { settingsStore, updateSettings } from './settings';
import { createStore, loadJson, saveJson, useStore } from './store';
import { toast } from './toast';
import type { PrivateUser, Session, Solve } from './types';
import {
  backoffDelay,
  coalesce,
  decodeLocalDb,
  decodeQueue,
  emptyLocalDb,
  encodeLocalDb,
  insertChrono,
  LOCAL_KEY,
  overlaySessions,
  overlaySolves,
  QUEUE_KEY,
  sortChrono,
  uuid,
  type LocalDb,
  type QueuedOp,
  type SyncOp,
} from '../timer/storeUtils';

export interface SolveState {
  /** initial load finished */
  ready: boolean;
  mode: 'local' | 'cloud';
  sessions: Session[];
  currentSessionId: string | null;
  /** solves of the current session, chronological (oldest first) */
  solves: Solve[];
  /** number of writes waiting to be synced to the server */
  pending: number;
  /** last sync error message, if the server is unreachable */
  syncError: string | null;
  /** the current session's solves are being fetched (cloud mode, first visit of a session) */
  loading: boolean;
}

export interface AddSolveInput {
  timeMs: number;
  penalty: Penalty;
  scramble: string;
  comment?: string | null;
}

const EMPTY: Solve[] = [];

export const solveStore = createStore<SolveState>({
  ready: false,
  mode: 'local',
  sessions: [],
  currentSessionId: null,
  solves: EMPTY,
  pending: 0,
  syncError: null,
  loading: false,
});

export function useSolveState(): SolveState {
  return useStore(solveStore);
}

export function getCurrentSession(): Session | null {
  const s = solveStore.get();
  return s.sessions.find((x) => x.id === s.currentSessionId) ?? null;
}

// ================================================================ module state

const browser = typeof window !== 'undefined' && typeof document !== 'undefined';

type Scope = { mode: 'local' } | { mode: 'cloud'; userId: string };
let scope: Scope | null = null;
/** bumps on every scope change so late async results from a previous scope are ignored */
let gen = 0;

/** the guest database (always the persisted local data, also while logged in) */
let localDb: LocalDb = emptyLocalDb();
let localDirty = false;
let localTimer: ReturnType<typeof setTimeout> | null = null;

/** what the UI shows: === localDb in local mode, a cache of the server in cloud mode */
let model: LocalDb = localDb;

let loadError: string | null = null;
let queueError: string | null = null;

function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.isUnavailable ? 'solve service unreachable' : e.message;
  return (e as Error)?.message || 'something went wrong';
}

function userId(): string | null {
  return scope?.mode === 'cloud' ? scope.userId : null;
}

function publish(extra: Partial<SolveState> = {}): void {
  solveStore.set((prev) => ({
    ...prev,
    mode: scope?.mode ?? 'local',
    sessions: model.sessions,
    currentSessionId: model.current,
    solves: (model.current && model.solves.get(model.current)) || EMPTY,
    pending: pendingCount(),
    syncError: queueError ?? loadError,
    ...extra,
  }));
}

/** Resolves once the initial load of the active scope has finished. */
function whenReady(timeoutMs = 15_000): Promise<void> {
  if (solveStore.get().ready) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, timeoutMs);
    const unsub = solveStore.subscribe(() => {
      if (solveStore.get().ready) done();
    });
    function done() {
      clearTimeout(t);
      unsub();
      resolve();
    }
  });
}

// ================================================================ local persistence

function readLocal(): LocalDb {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LOCAL_KEY);
  } catch {
    return emptyLocalDb();
  }
  if (!raw) return emptyLocalDb();
  let parsed: unknown = '__corrupt__';
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* handled below */
  }
  return decodeLocalDb(parsed, isEventId).db;
}

function saveLocalSoon(): void {
  localDirty = true;
  if (localTimer) return;
  localTimer = setTimeout(flushLocal, 250);
}

/** Writes the guest db now. */
function flushLocal(): void {
  if (localTimer) clearTimeout(localTimer);
  localTimer = null;
  if (!localDirty) return;
  try {
    if (localDb.sessions.length === 0) localStorage.removeItem(LOCAL_KEY);
    else localStorage.setItem(LOCAL_KEY, encodeLocalDb(localDb));
    localDirty = false;
  } catch {
    /* storage full or disabled: the data stays in memory */
  }
}

// ================================================================ retry queue

let queue: QueuedOp[] = browser ? decodeQueue(loadJson<unknown>(QUEUE_KEY, [])) : [];
let inflight: string | null = null;
let pumping = false;
let backoffN = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function saveQueue(): void {
  saveJson(QUEUE_KEY, queue);
}

function pendingCount(): number {
  const uid = userId();
  if (!uid) return 0;
  let n = 0;
  for (const q of queue) if (q.userId === uid) n++;
  return n;
}

/** queued ops of the current user, oldest first */
function overlayOps(): SyncOp[] {
  const uid = userId();
  return queue.filter((q) => q.userId === uid).map((q) => q.op);
}

function enqueue(op: SyncOp): string {
  const uid = userId();
  if (!uid) throw new Error('not logged in');
  const item: QueuedOp = { opId: uuid(), userId: uid, op, attempts: 0, createdAt: Date.now() };
  queue = coalesce(queue, item, inflight);
  saveQueue();
  if (!retryTimer) void pump();
  return item.opId;
}

function isRetryable(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true; // TypeError / abort: treat as network
  return e.isUnavailable || e.status >= 500 || e.status === 429 || e.status === 408;
}

async function send(op: SyncOp): Promise<void> {
  const ignore404 = (e: unknown) => {
    if (e instanceof ApiError && e.status === 404) return;
    throw e;
  };
  switch (op.kind) {
    case 'createSession':
      await api.sessions.create({ id: op.session.id, name: op.session.name, event: op.session.event });
      return;
    case 'renameSession':
      await api.sessions.rename(op.id, op.name).catch(ignore404);
      return;
    case 'deleteSession':
      await api.sessions.remove(op.id).catch(ignore404);
      return;
    case 'createSolve': {
      const { event: _event, ...body } = op.solve;
      await api.solves.create(body);
      return;
    }
    case 'updateSolve':
      await api.solves.update(op.id, op.patch).catch(ignore404);
      return;
    case 'deleteSolve':
      await api.solves.remove(op.id).catch(ignore404);
      return;
  }
}

function scheduleRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void pump();
  }, backoffDelay(backoffN++));
}

async function pump(): Promise<void> {
  if (pumping || !browser) return;
  const uid = userId();
  if (!uid || !getToken()) return;
  pumping = true;
  const g = gen;
  try {
    for (;;) {
      if (g !== gen) break;
      const head = queue.find((q) => q.userId === uid);
      if (!head) {
        if (queueError) {
          queueError = null;
          publish();
        }
        break;
      }
      inflight = head.opId;
      try {
        await send(head.op);
        inflight = null;
        queue = queue.filter((q) => q.opId !== head.opId);
        saveQueue();
        backoffN = 0;
        const hadError = queueError || loadError;
        queueError = null;
        publish();
        if (hadError && loadError) void refreshCloud();
      } catch (e) {
        inflight = null;
        if (g !== gen) break;
        if (e instanceof ApiError && e.status === 401) {
          // token expired/revoked: the auth layer logs out; ops stay queued for the next login
          break;
        }
        if (isRetryable(e)) {
          head.attempts++;
          saveQueue();
          queueError = errorMessage(e);
          publish();
          scheduleRetry();
          break;
        }
        // permanent rejection (validation, conflict …): drop it and re-sync to revert
        queue = queue.filter((q) => q.opId !== head.opId);
        saveQueue();
        toast.error(`Couldn't save your change: ${errorMessage(e)}`);
        publish();
        void refreshCloud();
      }
    }
  } finally {
    inflight = null;
    pumping = false;
  }
}

// ================================================================ loading

function sessionById(id: string | null | undefined): Session | undefined {
  return id ? model.sessions.find((s) => s.id === id) : undefined;
}

function pickCurrent(): string | null {
  const ss = model.sessions;
  if (model.current && ss.some((s) => s.id === model.current)) return model.current;
  const ev = settingsStore.get().lastEvent;
  const byEv = model.lastByEvent[ev];
  if (byEv && ss.some((s) => s.id === byEv)) return byEv;
  return ss.find((s) => s.event === ev)?.id ?? ss[0]?.id ?? null;
}

function defaultEvent(): string {
  const ev = settingsStore.get().lastEvent;
  return isEventId(ev) ? ev : '333';
}

/** Default name for a new session of `event`: "3x3", then "3x3 2", "3x3 3" … */
export function suggestSessionName(event: string): string {
  const base = getEvent(event)?.short ?? event;
  const taken = new Set(solveStore.get().sessions.map((s) => s.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

async function loadLocalScope(): Promise<void> {
  localDb = readLocal();
  model = localDb;
  if (!pickCurrent()) createSessionInternal(suggestSessionNameFor(defaultEvent()), defaultEvent());
  model.current = pickCurrent();
  publish({ ready: true, loading: false });
}

function suggestSessionNameFor(event: string): string {
  const base = getEvent(event)?.short ?? event;
  const taken = new Set(model.sessions.map((s) => s.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

let solveReq = 0;

async function loadCloudScope(uid: string, g: number, keepCurrent = false): Promise<void> {
  let sessions: Session[] | null = null;
  try {
    sessions = (await api.sessions.list()).sessions;
    loadError = null;
  } catch (e) {
    if (g !== gen) return;
    if (e instanceof ApiError && e.status === 401) return; // auth layer switches to local
    loadError = errorMessage(e);
  }
  if (g !== gen) return;
  const prevCurrent = model.current;
  const prevSolves = model.solves;
  const base = sessions ?? model.sessions;
  model = {
    sessions: overlaySessions(base, overlayOps()),
    solves: keepCurrent ? prevSolves : new Map(),
    current: keepCurrent ? prevCurrent : null,
    lastByEvent: keepCurrent ? model.lastByEvent : {},
  };
  let cur = pickCurrent();
  if (!cur) cur = createSessionInternal(suggestSessionNameFor(defaultEvent()), defaultEvent()).id;
  model.current = cur;
  publish();
  await loadSessionSolves(cur, g);
  if (g !== gen) return;
  publish({ ready: true, loading: false });
  void pump();
}

async function loadSessionSolves(sid: string, g: number): Promise<void> {
  const uid = userId();
  if (!uid) return;
  const unsynced = queue.some((q) => q.userId === uid && q.op.kind === 'createSession' && q.op.session.id === sid);
  if (unsynced) {
    model.solves.set(sid, overlaySolves(sid, model.solves.get(sid) ?? [], overlayOps()));
    publish({ loading: false });
    return;
  }
  const req = ++solveReq;
  if (!model.solves.has(sid)) publish({ loading: true });
  try {
    const { solves } = await api.sessions.solves(sid);
    if (g !== gen) return;
    const list = overlaySolves(sid, sortChrono(solves), overlayOps());
    model.solves.set(sid, list);
    model.sessions = model.sessions.map((s) => (s.id === sid && s.solveCount !== list.length ? { ...s, solveCount: list.length } : s));
    if (req === solveReq) publish({ loading: false });
    else publish();
  } catch (e) {
    if (g !== gen) return;
    if (e instanceof ApiError && e.status === 404) {
      // deleted on another device
      model.sessions = model.sessions.filter((s) => s.id !== sid);
      model.solves.delete(sid);
      if (model.current === sid) {
        model.current = null;
        let cur = pickCurrent();
        if (!cur) cur = createSessionInternal(suggestSessionNameFor(defaultEvent()), defaultEvent()).id;
        model.current = cur;
        publish();
        await loadSessionSolves(cur, g);
      }
      return;
    }
    if (!(e instanceof ApiError && e.status === 401)) loadError = errorMessage(e);
    if (!model.solves.has(sid)) model.solves.set(sid, overlaySolves(sid, [], overlayOps()));
    if (req === solveReq) publish({ loading: false });
  }
}

/** Re-reads sessions + current solves from the server, keeping the current session. */
async function refreshCloud(): Promise<void> {
  const uid = userId();
  if (!uid) return;
  await loadCloudScope(uid, gen, true);
}

// ================================================================ auth / scope switching

function handleAuth(user: PrivateUser | null): void {
  const next: Scope = user ? { mode: 'cloud', userId: user.id } : { mode: 'local' };
  if (scope && scope.mode === next.mode && (next.mode === 'local' || (scope.mode === 'cloud' && scope.userId === next.userId))) return;
  flushLocal();
  gen++;
  scope = next;
  loadError = null;
  queueError = null;
  backoffN = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (next.mode === 'local') {
    void loadLocalScope();
    return;
  }
  model = emptyLocalDb();
  solveStore.set({ ready: false, mode: 'cloud', sessions: [], currentSessionId: null, solves: EMPTY, pending: pendingCount(), syncError: null, loading: true });
  void loadCloudScope(next.userId, gen);
}

if (browser) {
  onAuthChange(handleAuth);
  const u = getCurrentUser();
  if (u) handleAuth(u);
  else if (!getToken()) handleAuth(null);
  // else: a token exists and the auth check is in flight — AuthProvider will call us

  window.addEventListener('pagehide', () => flushLocal());
  window.addEventListener('online', () => {
    if (!userId()) return;
    backoffN = 0;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    void pump();
    if (loadError) void refreshCloud();
  });
}

// ================================================================ mutations

function commit(): void {
  if (scope?.mode !== 'cloud') saveLocalSoon();
  publish();
}

function locate(id: string): { sid: string; index: number; list: Solve[] } | null {
  const order = model.current ? [model.current, ...Array.from(model.solves.keys()).filter((k) => k !== model.current)] : Array.from(model.solves.keys());
  for (const sid of order) {
    const list = model.solves.get(sid);
    if (!list) continue;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].id === id) return { sid, index: i, list };
  }
  return null;
}

function patchSession(id: string, patch: Partial<Session>): void {
  model.sessions = model.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

function validName(name: string): string {
  const n = name.trim();
  if (n.length < 1 || n.length > 40) throw new Error('Session names must be 1–40 characters');
  return n;
}

function createSessionInternal(name: string, event: string): Session {
  const now = new Date().toISOString();
  const session: Session = { id: uuid(), name, event, createdAt: now, updatedAt: now, solveCount: 0 };
  model.sessions = [...model.sessions, session];
  model.solves.set(session.id, []);
  if (scope?.mode === 'cloud') enqueue({ kind: 'createSession', session: { id: session.id, name, event, createdAt: now } });
  else saveLocalSoon();
  return session;
}

/** Load (or reload) sessions + current session's solves for the active mode. */
export async function reloadSolves(): Promise<void> {
  if (!scope) return whenReady();
  if (scope.mode === 'local') return loadLocalScope();
  return refreshCloud();
}

/** Append a solve to the current session. Resolves with the stored solve. */
export async function addSolve(input: AddSolveInput): Promise<Solve> {
  if (!solveStore.get().ready) await whenReady();
  const timeMs = Math.round(input.timeMs);
  if (!Number.isFinite(timeMs) || timeMs < 1 || timeMs > 86_400_000) throw new Error('Time must be between 0.001 s and 24 h');
  const session = sessionById(model.current);
  if (!session) throw new Error('Unknown session');
  const solve: Solve = {
    id: uuid(),
    sessionId: session.id,
    event: session.event,
    timeMs,
    penalty: input.penalty,
    scramble: (input.scramble ?? '').slice(0, 2000),
    comment: input.comment ? input.comment.slice(0, 500) : null,
    source: 'timer',
    createdAt: new Date().toISOString(),
  };
  const list = model.solves.get(session.id);
  if (list) model.solves.set(session.id, insertChrono(list, solve));
  patchSession(session.id, { solveCount: (list?.length ?? session.solveCount) + 1, updatedAt: solve.createdAt });
  if (scope?.mode !== 'cloud') {
    commit();
    return solve;
  }
  enqueue({
    kind: 'createSolve',
    solve: {
      id: solve.id,
      sessionId: solve.sessionId,
      event: solve.event,
      timeMs,
      penalty: solve.penalty,
      scramble: solve.scramble,
      comment: solve.comment,
      source: solve.source,
      createdAt: solve.createdAt,
    },
  });
  commit();
  return solve;
}

function updateSolveLocal(solveId: string, patch: { penalty?: Penalty; comment?: string | null }): boolean {
  const hit = locate(solveId);
  if (!hit) return false;
  const next = hit.list.slice();
  next[hit.index] = { ...next[hit.index], ...patch };
  model.solves.set(hit.sid, next);
  if (scope?.mode === 'cloud') enqueue({ kind: 'updateSolve', id: solveId, sessionId: hit.sid, patch });
  commit();
  return true;
}

export async function setPenalty(solveId: string, penalty: Penalty): Promise<void> {
  const hit = locate(solveId);
  if (!hit || hit.list[hit.index].penalty === penalty) return;
  updateSolveLocal(solveId, { penalty });
}

export async function setComment(solveId: string, comment: string | null): Promise<void> {
  const c = comment && comment.trim() ? comment.trim().slice(0, 500) : null;
  const hit = locate(solveId);
  if (!hit || (hit.list[hit.index].comment ?? null) === c) return;
  updateSolveLocal(solveId, { comment: c });
}

export async function deleteSolve(solveId: string): Promise<void> {
  const hit = locate(solveId);
  if (!hit) return;
  const next = hit.list.slice();
  next.splice(hit.index, 1);
  model.solves.set(hit.sid, next);
  patchSession(hit.sid, { solveCount: next.length });
  if (scope?.mode === 'cloud') enqueue({ kind: 'deleteSolve', id: solveId, sessionId: hit.sid });
  commit();
}

export async function createSession(name: string, event: string): Promise<Session> {
  if (!solveStore.get().ready) await whenReady();
  if (!isEventId(event)) throw new Error(`Unknown event ${event}`);
  const s = createSessionInternal(validName(name), event);
  commit();
  return s;
}

export async function renameSession(sessionId: string, name: string): Promise<void> {
  const n = validName(name);
  const s = sessionById(sessionId);
  if (!s || s.name === n) return;
  patchSession(sessionId, { name: n, updatedAt: new Date().toISOString() });
  if (scope?.mode === 'cloud') enqueue({ kind: 'renameSession', id: sessionId, name: n });
  commit();
}

export async function deleteSession(sessionId: string): Promise<void> {
  const s = sessionById(sessionId);
  if (!s) return;
  model.sessions = model.sessions.filter((x) => x.id !== sessionId);
  model.solves.delete(sessionId);
  for (const [ev, id] of Object.entries(model.lastByEvent)) if (id === sessionId) delete model.lastByEvent[ev];
  if (scope?.mode === 'cloud') enqueue({ kind: 'deleteSession', id: sessionId });
  if (model.current === sessionId) {
    const sibling = [...model.sessions].reverse().find((x) => x.event === s.event);
    const next = sibling ?? createSessionInternal(suggestSessionNameFor(s.event), s.event);
    commit();
    await switchSession(next.id);
    return;
  }
  commit();
}

export async function switchSession(sessionId: string): Promise<void> {
  const s = sessionById(sessionId);
  if (!s) throw new Error('Unknown session');
  model.current = sessionId;
  model.lastByEvent = { ...model.lastByEvent, [s.event]: sessionId };
  if (settingsStore.get().lastEvent !== s.event) updateSettings({ lastEvent: s.event });
  if (scope?.mode === 'cloud') {
    publish();
    await loadSessionSolves(sessionId, gen);
  } else commit();
}

function findSessionFor(event: string): Session | undefined {
  const last = sessionById(model.lastByEvent[event]);
  if (last && last.event === event) return last;
  return model.sessions.find((s) => s.event === event);
}

/** Switch to the first session of `event`, creating one if none exists. */
export async function switchEvent(event: string): Promise<void> {
  if (!solveStore.get().ready) await whenReady();
  if (!isEventId(event)) throw new Error(`Unknown event ${event}`);
  const s = findSessionFor(event) ?? createSessionInternal(suggestSessionNameFor(event), event);
  await switchSession(s.id);
}
