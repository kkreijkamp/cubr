// Solve store - the single source of truth for sessions & solves in the browser.
//
// CONTRACT (other pages rely on these exports):
//  - Guest mode ("local"): everything persists in localStorage; works with no backend at all.
//  - Logged-in mode ("cloud"): data lives in solve-service. Writes are optimistic (UI updates
//    immediately) and queued; failed requests (network / 5xx) are retried with backoff - solve
//    and session ids are generated client-side, so retries are idempotent. 4xx -> revert + toast.
//  - Switches automatically on login/logout (onAuthChange from ./auth).
//
// Implementation notes
//  - Local data: `cubr.local.v1` (compact tuples, see timer/storeUtils.ts), written debounced
//    and flushed on pagehide. Corrupt data is backed up to `cubr.local.v1.corrupt`, never lost.
//  - Cloud writes go through a persistent FIFO queue (`cubr.queue.v1`) processed one op at a
//    time; unsent edits are coalesced into their create. Network/5xx/429 -> exponential backoff
//    (1 s ... 60 s, retried immediately on `online`). Server reads are overlaid with queued ops so
//    optimistic changes survive reloads. The current session is cached (`cubr.cloudcache.v1`)
//    so a logged-in user can keep timing while solve-service is down.
import { defaultSessionName, isEventId, isPracticeScramble, scrambleSessionName, type ImportedSession, type Penalty } from '@cubr/cubestats';
import { api, ApiError, getToken, type ImportPayload } from './api';
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
  encodeSolve,
  insertChrono,
  LOCAL_KEY,
  overlaySessions,
  overlaySolves,
  defaultSessionsPlan,
  freeSessionName,
  planImportChunks,
  QUEUE_KEY,
  sortChrono,
  uuid,
  type LocalDb,
  type QueuedOp,
  type SolveTuple,
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
  source?: 'timer' | 'manual' | 'race' | 'daily';
  /** daily-challenge attempt (cloud mode only) */
  daily?: { date: string; index: number };
  /** override target session (defaults to the current session) */
  sessionId?: string;
  /** client-side id (generated when absent); lets a caller change the solve before it is synced */
  id?: string;
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
const CLOUD_CACHE_KEY = 'cubr.cloudcache.v1';
const LAST_SESSION_KEY = 'cubr.lastSession.v1';
const OFFER_DISMISSED_KEY = 'cubr.uploadOffer.dismissed';

type Scope = { mode: 'local' } | { mode: 'cloud'; userId: string };
let scope: Scope | null = null;
/** bumps on every scope change so late async results from a previous scope are ignored */
let gen = 0;

/** the guest database (always the persisted local data, also while logged in) */
let localDb: LocalDb = emptyLocalDb();
let localDirty = false;
let localTimer: ReturnType<typeof setTimeout> | null = null;
let storageError: string | null = null;
let quotaWarned = false;

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
    syncError: queueError ?? loadError ?? storageError,
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

function readLocal(quiet = false): LocalDb {
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
  const { db, corrupt } = decodeLocalDb(parsed, isEventId);
  if (corrupt && !quiet) {
    try {
      localStorage.setItem(`${LOCAL_KEY}.corrupt`, raw);
    } catch {
      /* no space for a backup */
    }
    toast.notice('Your saved guest solves could not be read, so the timer started fresh. A backup copy was kept in this browser.', {
      durationMs: 8000,
    });
  }
  return db;
}

function saveLocalSoon(): void {
  localDirty = true;
  if (localTimer) return;
  localTimer = setTimeout(flushLocal, 250);
}

/** Writes the guest db now. Returns false when the browser refused (quota). */
function flushLocal(): boolean {
  if (localTimer) clearTimeout(localTimer);
  localTimer = null;
  if (!localDirty) return true;
  try {
    if (localDb.sessions.length === 0) localStorage.removeItem(LOCAL_KEY);
    else localStorage.setItem(LOCAL_KEY, encodeLocalDb(localDb));
    localDirty = false;
    if (storageError) {
      storageError = null;
      publish();
    }
    return true;
  } catch {
    storageError = 'browser storage is full - export your solves or sign in to sync them';
    if (!quotaWarned) toast.error('Browser storage is full: new solves may not be saved. Export your data or sign in to sync to the cloud.');
    quotaWarned = true;
    publish();
    return false;
  }
}

// ================================================================ cloud cache & last session

interface CloudCache {
  userId: string;
  sessions: Session[];
  sessionId: string | null;
  solves: SolveTuple[];
}
let cacheTimer: ReturnType<typeof setTimeout> | null = null;

function readCloudCache(uid: string): { sessions: Session[]; sessionId: string | null; solves: Solve[] } | null {
  const c = loadJson<CloudCache | null>(CLOUD_CACHE_KEY, null);
  if (!c || c.userId !== uid || !Array.isArray(c.sessions)) return null;
  const sessions = c.sessions.filter((s) => s && typeof s.id === 'string' && isEventId(s.event));
  const session = sessions.find((s) => s.id === c.sessionId);
  let solves: Solve[] = [];
  if (session && Array.isArray(c.solves)) {
    // reuse the local codec for the cached solves
    const { db } = decodeLocalDb(
      { v: 1, sessions: [{ id: session.id, name: session.name, event: session.event, createdAt: session.createdAt, updatedAt: session.updatedAt }], solves: { [session.id]: c.solves } },
      isEventId,
    );
    solves = db.solves.get(session.id) ?? [];
  }
  return { sessions, sessionId: session?.id ?? null, solves };
}

function flushCloudCache(): void {
  if (cacheTimer) clearTimeout(cacheTimer);
  cacheTimer = null;
  const uid = userId();
  if (!uid || !solveStore.get().ready) return;
  const cur = model.current;
  const list = (cur && model.solves.get(cur)) || [];
  const cache: CloudCache = {
    userId: uid,
    sessions: model.sessions,
    sessionId: list.length <= 20_000 ? cur : null,
    solves: list.length <= 20_000 ? list.map(encodeSolve) : [],
  };
  saveJson(CLOUD_CACHE_KEY, cache);
}

function cloudCacheSoon(): void {
  if (cacheTimer) return;
  cacheTimer = setTimeout(flushCloudCache, 1500);
}

function readLastSession(uid: string): { current: string | null; lastByEvent: Record<string, string> } {
  const all = loadJson<Record<string, { current?: string; lastByEvent?: Record<string, string> }>>(LAST_SESSION_KEY, {});
  const mine = all && typeof all === 'object' ? all[uid] : undefined;
  return {
    current: typeof mine?.current === 'string' ? mine.current : null,
    lastByEvent: mine?.lastByEvent && typeof mine.lastByEvent === 'object' ? { ...mine.lastByEvent } : {},
  };
}

function writeLastSession(): void {
  const uid = userId();
  if (!uid) return;
  const all = loadJson<Record<string, unknown>>(LAST_SESSION_KEY, {});
  saveJson(LAST_SESSION_KEY, { ...(all && typeof all === 'object' ? all : {}), [uid]: { current: model.current, lastByEvent: model.lastByEvent } });
}

// ================================================================ retry queue

// Tabs share the queue (the October review's #11): the stored copy is the truth, re-read before every
// change since another tab may have written it, and followed through 'storage' events. One tab sends at a
// time (a Web Lock), and the op it is sending is shared too, so no tab folds an edit into it.
let queue: QueuedOp[] = browser ? readQueue() : [];
const INFLIGHT_KEY = 'cubr.queue.inflight';
/** a tab that crashed mid-send leaves its marker: after this long it no longer counts */
const INFLIGHT_STALE_MS = 60_000;
const QUEUE_LOCK = 'cubr.queue';

function readQueue(): QueuedOp[] {
  return decodeQueue(loadJson<unknown>(QUEUE_KEY, []));
}

/** The op another tab is sending right now, if any. */
function sharedInflight(): string | null {
  const m = loadJson<{ opId?: unknown; at?: unknown } | null>(INFLIGHT_KEY, null);
  return m && typeof m.opId === 'string' && typeof m.at === 'number' && Date.now() - m.at < INFLIGHT_STALE_MS ? m.opId : null;
}

function shareInflight(opId: string | null): void {
  try {
    if (opId) localStorage.setItem(INFLIGHT_KEY, JSON.stringify({ opId, at: Date.now() }));
    else localStorage.removeItem(INFLIGHT_KEY);
  } catch {
    /* storage unavailable: this tab is the only one that can write anyway */
  }
}
/** ops completed in the last minute - re-applied on reads to cover read-after-write races (each
 *  with its account: after switching accounts, the other account's ops must not show) */
let recent: { op: SyncOp; at: number; userId: string }[] = [];
let inflight: string | null = null;
let pumping = false;
let backoffN = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const waiters = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();

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

/** queued + recently completed ops of the current user, oldest first */
function overlayOps(): SyncOp[] {
  const uid = userId();
  const cutoff = Date.now() - 60_000;
  recent = recent.filter((r) => r.at > cutoff);
  return [...recent.filter((r) => r.userId === uid).map((r) => r.op), ...queue.filter((q) => q.userId === uid).map((q) => q.op)];
}

function settle(opId: string, err?: Error): void {
  const w = waiters.get(opId);
  if (!w) return;
  waiters.delete(opId);
  if (err) w.reject(err);
  else w.resolve();
}

function enqueue(op: SyncOp): string {
  const uid = userId();
  if (!uid) throw new Error('not logged in');
  const item: QueuedOp = { opId: uuid(), userId: uid, op, attempts: 0, createdAt: Date.now() };
  queue = coalesce(readQueue(), item, inflight ?? sharedInflight());
  saveQueue();
  // waiters of ops that were folded away (e.g. a solve deleted before it was sent) are done
  for (const id of Array.from(waiters.keys())) if (id !== inflight && !queue.some((q) => q.opId === id)) settle(id);
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
      await api.sessions.create({
        id: op.session.id,
        name: op.session.name,
        event: op.session.event,
        ...(op.session.practice ? { practice: true } : {}),
        ...(op.session.scramble ? { scramble: op.session.scramble } : {}),
        ...(op.keepCreatedAt ? { createdAt: op.session.createdAt } : {}),
      });
      return;
    case 'renameSession':
      await api.sessions.rename(op.id, op.name).catch(ignore404);
      return;
    case 'setPractice':
      await api.sessions.setPractice(op.id, op.practice).catch(ignore404);
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
  let elsewhere = false;
  try {
    const locks = (globalThis.navigator as (Navigator & { locks?: LockManager }) | undefined)?.locks;
    if (locks?.request) {
      await locks.request(QUEUE_LOCK, { ifAvailable: true }, async (lock) => {
        elsewhere = lock ? await pumpLoop(uid) : true;
      });
    } else elsewhere = await pumpLoop(uid);
  } finally {
    inflight = null;
    pumping = false;
  }
  // another tab is sending: look again in a moment, in case it stops before reaching what's left
  if (elsewhere && !retryTimer && pendingCount() > 0) {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void pump();
    }, 1000);
  }
}

/**
 * Sends this account's queued ops in order, until the queue is empty or a send fails. True when it stopped
 * at an op another tab is sending (without Web Locks two tabs can pump at once).
 */
async function pumpLoop(uid: string): Promise<boolean> {
  const g = gen;
  try {
    for (;;) {
      if (g !== gen) break;
      queue = readQueue();
      const head = queue.find((q) => q.userId === uid);
      if (!head) {
        if (queueError) {
          queueError = null;
          publish();
        }
        break;
      }
      if (head.opId === sharedInflight()) return true;
      inflight = head.opId;
      shareInflight(head.opId);
      try {
        await send(head.op);
        inflight = null;
        shareInflight(null);
        queue = afterSent(readQueue(), head);
        saveQueue();
        recent.push({ op: head.op, at: Date.now(), userId: head.userId });
        if (recent.length > 200) recent = recent.slice(-200);
        backoffN = 0;
        const hadError = queueError || loadError;
        queueError = null;
        settle(head.opId);
        publish();
        if (hadError && loadError) void refreshCloud();
      } catch (e) {
        inflight = null;
        shareInflight(null);
        if (g !== gen) break;
        if (e instanceof ApiError && e.status === 401) {
          // token expired/revoked: the auth layer logs out; ops stay queued for the next login
          settle(head.opId);
          break;
        }
        if (isRetryable(e)) {
          queue = readQueue().map((q) => (q.opId === head.opId ? { ...q, attempts: q.attempts + 1 } : q));
          saveQueue();
          queueError = errorMessage(e);
          settle(head.opId); // accepted locally, will sync later
          publish();
          scheduleRetry();
          break;
        }
        // a solve whose session is gone (merged away or deleted on another device): its solves move to a new session
        if (head.op.kind === 'createSolve' && isSessionGone(e) && !rehomed.has(head.op.solve.sessionId)) {
          rehomeSolves(head.op.solve.sessionId, head.userId, head.op.solve.event);
          continue;
        }
        // permanent rejection (validation, conflict ...): drop it and re-sync to revert
        queue = readQueue().filter((q) => q.opId !== head.opId);
        saveQueue();
        settle(head.opId, e as Error);
        toast.error(`Couldn't save your change: ${errorMessage(e)}`);
        publish();
        void refreshCloud();
      }
    }
  } finally {
    if (inflight) shareInflight(null);
    inflight = null;
  }
  return false;
}

/**
 * The queue once `sent` went through. Normally that drops it; but if another tab changed it meanwhile (it
 * read the in-flight marker too late), what changed still has to reach the server: a solve's create can't
 * carry it any more (the server keeps the first create), so it goes as an edit; other ops are sent again.
 */
function afterSent(stored: QueuedOp[], sent: QueuedOp): QueuedOp[] {
  const now = stored.find((q) => q.opId === sent.opId);
  if (!now || JSON.stringify(now.op) === JSON.stringify(sent.op)) return stored.filter((q) => q.opId !== sent.opId);
  if (now.op.kind === 'createSolve') {
    const { id, sessionId, penalty, comment } = now.op.solve;
    return stored.map((q) => (q.opId === sent.opId ? { ...q, op: { kind: 'updateSolve', id, sessionId, patch: { penalty, comment: comment ?? null } } } : q));
  }
  return stored;
}

/** The solve service's answer to a solve for a session that isn't there (services/solve/src/routes/solves.ts). */
const isSessionGone = (e: unknown) => e instanceof ApiError && e.status === 404 && e.message === 'session not found';

/** sessions made by rehomeSolves: a solve that can't go into one of these is dropped, not moved again */
const rehomed = new Set<string>();
const RECOVERED = ' (recovered)';

/**
 * The queued solves of a session that's gone from the account (merged into another, or deleted, on another
 * device: their creates get 404) move to a new session, "<name> (recovered)", sent before them, with one
 * notice, instead of being dropped with an error each (the October review's #11). It keeps the old session's
 * practice and scramble type when this device still knows them; else it's a practice session, so solves of
 * a scramble type that doesn't count can't reach the boards (turning practice off counts them).
 */
function rehomeSolves(lost: string, uid: string, event: string): void {
  const old = sessionById(lost);
  const base = old?.name ?? 'session';
  const name = `${base.slice(0, 40 - RECOVERED.length).trimEnd()}${RECOVERED}`;
  const practice = old ? old.practice === true : true;
  const session = { id: uuid(), name, event, ...(practice ? { practice: true } : {}), ...(old?.scramble ? { scramble: old.scramble } : {}), createdAt: new Date().toISOString() };
  rehomed.add(session.id);
  let moved = 0;
  queue = readQueue().map((q) => {
    if (q.userId !== uid) return q;
    if (q.op.kind === 'createSolve' && q.op.solve.sessionId === lost) {
      moved++;
      return { ...q, op: { ...q.op, solve: { ...q.op.solve, sessionId: session.id } } };
    }
    if ((q.op.kind === 'updateSolve' || q.op.kind === 'deleteSolve') && q.op.sessionId === lost) return { ...q, op: { ...q.op, sessionId: session.id } };
    return q;
  });
  const item: QueuedOp = { opId: uuid(), userId: uid, op: { kind: 'createSession', session }, attempts: 0, createdAt: Date.now() };
  const first = queue.findIndex((q) => q.userId === uid && q.op.kind === 'createSolve' && q.op.solve.sessionId === session.id);
  queue = first < 0 ? [...queue, item] : [...queue.slice(0, first), item, ...queue.slice(first)];
  saveQueue();
  toast.notice(`${moved} ${moved === 1 ? 'solve' : 'solves'} from a session merged or deleted on another device ${moved === 1 ? 'is' : 'are'} in a new session, "${name}"`);
  void refreshCloud();
}

/**
 * Tries to sync everything that is queued right now. Resolves when the queue is empty, when the
 * server is unreachable (the queue keeps retrying in the background) or after `timeoutMs`.
 */
export async function flushQueue(timeoutMs = 8000): Promise<void> {
  if (!userId()) return;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  backoffN = 0;
  void pump();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && pendingCount() > 0 && (pumping || !retryTimer)) {
    await new Promise((r) => setTimeout(r, 150));
    if (!pumping && !retryTimer && pendingCount() > 0) void pump();
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

/** Default name for a new session of `event`: "3x3", then "3x3 2", "3x3 3" ... */
export function suggestSessionName(event: string): string {
  return freeSessionName(defaultSessionName(event), solveStore.get().sessions);
}

async function loadLocalScope(): Promise<void> {
  localDb = readLocal();
  model = localDb;
  if (!pickCurrent()) createDefaultSessions(defaultEvent());
  model.current = pickCurrent();
  publish({ ready: true, loading: false });
}

/** A single new session's name for `event` (its short name, numbered if taken). */
function suggestSessionNameFor(event: string): string {
  return freeSessionName(defaultSessionName(event), model.sessions);
}

/**
 * Creates the sessions an event starts with: its default session ("3x3") and, if the event has
 * no practice session yet, "3x3 practice" a millisecond later so the default one stays first.
 * Used when a new account, a new guest or a newly opened event needs a session; replacing a
 * deleted session creates only the default one. Returns the default session.
 */
function createDefaultSessions(event: string): Session {
  const t = Date.now();
  const created = defaultSessionsPlan(event, model.sessions).map((p, i) =>
    createSessionInternal(p.name, event, p.practice, new Date(t + i).toISOString()),
  );
  return created[0];
}

let loadAttempts = 0;
let loadRetryTimer: ReturnType<typeof setTimeout> | null = null;
let solveReq = 0;

async function loadCloudScope(uid: string, g: number, keepCurrent = false): Promise<void> {
  let sessions: Session[] | null = null;
  try {
    sessions = (await api.sessions.list()).sessions;
    loadError = null;
    loadAttempts = 0;
  } catch (e) {
    if (g !== gen) return;
    if (e instanceof ApiError && e.status === 401) return; // auth layer switches to local
    loadError = errorMessage(e);
    if (loadRetryTimer) clearTimeout(loadRetryTimer);
    loadRetryTimer = setTimeout(() => {
      loadRetryTimer = null;
      if (g === gen && loadError) void refreshCloud();
    }, backoffDelay(loadAttempts++ + 1));
  }
  if (g !== gen) return;
  const last = readLastSession(uid);
  const prevCurrent = model.current;
  const prevSolves = model.solves;
  const cache = sessions ? null : readCloudCache(uid);
  const base = sessions ?? cache?.sessions ?? model.sessions;
  model = {
    sessions: overlaySessions(base, overlayOps()),
    solves: keepCurrent ? prevSolves : new Map(),
    current: keepCurrent ? prevCurrent : last.current,
    lastByEvent: keepCurrent ? model.lastByEvent : last.lastByEvent,
  };
  if (cache?.sessionId && !model.solves.has(cache.sessionId)) {
    model.solves.set(cache.sessionId, overlaySolves(cache.sessionId, cache.solves, overlayOps()));
  }
  let cur = pickCurrent();
  if (!cur) cur = createDefaultSessions(defaultEvent()).id;
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
    cloudCacheSoon();
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

export interface UploadOffer {
  userId: string;
  sessions: number;
  solves: number;
}
/** Set after login when this browser still has guest solves that could be uploaded. */
export const uploadOfferStore = createStore<UploadOffer | null>(null);
export function useUploadOffer(): UploadOffer | null {
  return useStore(uploadOfferStore);
}

function countLocal(db: LocalDb): { sessions: number; solves: number } {
  let sessions = 0;
  let solves = 0;
  for (const s of db.sessions) {
    const n = db.solves.get(s.id)?.length ?? 0;
    if (n > 0) {
      sessions++;
      solves += n;
    }
  }
  return { sessions, solves };
}

function maybeOfferUpload(uid: string): void {
  if (userId() !== uid) return;
  let dismissed: string | null = null;
  try {
    dismissed = sessionStorage.getItem(OFFER_DISMISSED_KEY);
  } catch {
    /* ignore */
  }
  if (dismissed === uid) return;
  const c = countLocal(readLocal(true));
  if (c.solves > 0) uploadOfferStore.set({ userId: uid, ...c });
}

function handleAuth(user: PrivateUser | null): void {
  const next: Scope = user ? { mode: 'cloud', userId: user.id } : { mode: 'local' };
  if (scope && scope.mode === next.mode && (next.mode === 'local' || (scope.mode === 'cloud' && scope.userId === next.userId))) return;
  flushLocal();
  flushCloudCache();
  gen++;
  scope = next;
  loadError = null;
  queueError = null;
  backoffN = 0;
  loadAttempts = 0;
  if (retryTimer) clearTimeout(retryTimer);
  if (loadRetryTimer) clearTimeout(loadRetryTimer);
  retryTimer = null;
  loadRetryTimer = null;
  uploadOfferStore.set(null);
  if (next.mode === 'local') {
    void loadLocalScope();
    return;
  }
  model = emptyLocalDb();
  solveStore.set({ ready: false, mode: 'cloud', sessions: [], currentSessionId: null, solves: EMPTY, pending: pendingCount(), syncError: null, loading: true });
  const g = gen;
  void loadCloudScope(next.userId, g).then(() => {
    if (g === gen) maybeOfferUpload(next.userId);
  });
}

if (browser) {
  onAuthChange(handleAuth);
  const u = getCurrentUser();
  if (u) handleAuth(u);
  else if (!getToken()) handleAuth(null);
  // else: a token exists and the auth check is in flight - AuthProvider will call us

  window.addEventListener('pagehide', () => {
    flushLocal();
    flushCloudCache();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushLocal();
      flushCloudCache();
    } else if (userId() && pendingCount() > 0 && !retryTimer) void pump();
  });
  window.addEventListener('online', () => {
    if (!userId()) return;
    backoffN = 0;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    void pump();
    if (loadError) void refreshCloud();
  });
  // another tab changed the guest data, or the queue
  window.addEventListener('storage', (e) => {
    if (e.key === QUEUE_KEY || e.key === null) queueChangedElsewhere();
    if (e.key !== LOCAL_KEY || scope?.mode !== 'local' || localDirty) return;
    const current = model.current;
    localDb = readLocal(true);
    model = localDb;
    model.current = current && sessionById(current) ? current : pickCurrent();
    if (!model.current) {
      createSessionInternal(suggestSessionNameFor(defaultEvent()), defaultEvent());
      model.current = pickCurrent();
    }
    publish();
  });
}

/** Another tab wrote the queue: follow it; what this tab waited for may have gone through over there. */
function queueChangedElsewhere(): void {
  queue = readQueue();
  for (const id of Array.from(waiters.keys())) if (id !== inflight && !queue.some((q) => q.opId === id)) settle(id);
  publish();
  if (userId() && pendingCount() > 0 && !retryTimer) void pump();
}

// ================================================================ mutations

function commit(): void {
  if (scope?.mode === 'cloud') cloudCacheSoon();
  else saveLocalSoon();
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
  if (n.length < 1 || n.length > 40) throw new Error('Session names must be 1-40 characters');
  return n;
}

function createSessionInternal(name: string, event: string, practice = false, createdAt = new Date().toISOString(), scramble?: string): Session {
  const now = createdAt;
  // a practice scramble's session is always a practice session: only the default scramble counts
  const extra = { ...(practice || scramble ? { practice: true } : {}), ...(scramble ? { scramble } : {}) };
  const session: Session = { id: uuid(), name, event, ...extra, createdAt: now, updatedAt: now, solveCount: 0 };
  model.sessions = [...model.sessions, session];
  model.solves.set(session.id, []);
  if (scope?.mode === 'cloud') enqueue({ kind: 'createSession', session: { id: session.id, name, event, ...extra, createdAt: now } });
  else saveLocalSoon();
  return session;
}

/** Load (or reload) sessions + current session's solves for the active mode. */
export async function reloadSolves(): Promise<void> {
  if (!scope) return whenReady();
  if (scope.mode === 'local') return loadLocalScope();
  return refreshCloud();
}

/** Append a solve to the current (or given) session. Resolves with the stored solve. */
export async function addSolve(input: AddSolveInput): Promise<Solve> {
  if (!solveStore.get().ready) await whenReady();
  const timeMs = Math.round(input.timeMs);
  if (!Number.isFinite(timeMs) || timeMs < 1 || timeMs > 86_400_000) throw new Error('Time must be between 0.001 s and 24 h');
  let session = sessionById(input.sessionId ?? model.current);
  if (!session) {
    if (input.sessionId) throw new Error('Unknown session');
    session = await ensureSession(defaultEvent());
  }
  const solve: Solve = {
    id: input.id ?? uuid(),
    sessionId: session.id,
    event: session.event,
    timeMs,
    penalty: input.penalty,
    scramble: (input.scramble ?? '').slice(0, 2000),
    comment: input.comment ? input.comment.slice(0, 500) : null,
    source: input.source ?? 'timer',
    createdAt: new Date().toISOString(),
    dailyDate: input.daily?.date ?? null,
    dailyIndex: input.daily?.index ?? null,
  };
  const list = model.solves.get(session.id);
  if (list) model.solves.set(session.id, insertChrono(list, solve));
  patchSession(session.id, { solveCount: (list?.length ?? session.solveCount) + 1, updatedAt: solve.createdAt });
  if (scope?.mode !== 'cloud') {
    commit();
    return solve;
  }
  const opId = enqueue({
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
      ...(input.daily ? { daily: input.daily } : {}),
    },
  });
  commit();
  if (input.daily) {
    // daily attempts report server rejections (e.g. 409 already submitted) to the caller
    await new Promise<void>((resolve, reject) => {
      if (!queue.some((q) => q.opId === opId)) return resolve();
      waiters.set(opId, { resolve, reject });
    });
  }
  return solve;
}

/** Changes a loaded solve; returns the id of the queued op (cloud mode), else null. */
function updateSolveLocal(solveId: string, patch: { penalty?: Penalty; comment?: string | null }): string | null {
  const hit = locate(solveId);
  if (!hit) return null;
  const next = hit.list.slice();
  next[hit.index] = { ...next[hit.index], ...patch };
  model.solves.set(hit.sid, next);
  const opId = scope?.mode === 'cloud' ? enqueue({ kind: 'updateSolve', id: solveId, sessionId: hit.sid, patch }) : null;
  commit();
  return opId;
}

/**
 * Resolves once a queued op has reached the server, was folded into another queued op, or is
 * waiting to retry after a network error; rejects if the server refused it.
 */
function whenSent(opId: string | null): Promise<void> {
  if (!opId) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (!queue.some((q) => q.opId === opId)) return resolve();
    waiters.set(opId, { resolve, reject });
  });
}

export async function setPenalty(solveId: string, penalty: Penalty): Promise<void> {
  const hit = locate(solveId);
  if (!hit || hit.list[hit.index].penalty === penalty) return;
  updateSolveLocal(solveId, { penalty });
}

/**
 * Sets the penalty of an account's solve that may not be loaded here (cloud mode only fetches the
 * sessions you open), e.g. a daily-challenge attempt. Queued like any other change, so it reaches
 * the server after the solve itself. `sessionId` is needed only when neither the solve nor its
 * queued creation is known here. See whenSent for when the promise settles.
 */
export async function setPenaltyIn(solveId: string, penalty: Penalty, sessionId?: string): Promise<void> {
  if (!solveStore.get().ready) await whenReady();
  if (scope?.mode !== 'cloud') throw new Error('not signed in');
  const hit = locate(solveId);
  if (hit) {
    if (hit.list[hit.index].penalty === penalty) return;
    return whenSent(updateSolveLocal(solveId, { penalty }));
  }
  const creating = queue.find((q) => q.op.kind === 'createSolve' && q.op.solve.id === solveId)?.op;
  const sid = creating?.kind === 'createSolve' ? creating.solve.sessionId : sessionId;
  if (!sid) throw new Error('unknown solve');
  return whenSent(enqueue({ kind: 'updateSolve', id: solveId, sessionId: sid, patch: { penalty } }));
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

export async function createSession(name: string, event: string, opts: { practice?: boolean; scramble?: string } = {}): Promise<Session> {
  if (!solveStore.get().ready) await whenReady();
  if (!isEventId(event)) throw new Error(`Unknown event ${event}`);
  const scramble = opts.scramble && isPracticeScramble(event, opts.scramble) ? opts.scramble : undefined;
  const s = createSessionInternal(validName(name), event, opts.practice === true, undefined, scramble);
  commit();
  return s;
}

/** A practice session's solves count for no personal best and no leaderboard (the session's own stats stay). */
export async function setSessionPractice(sessionId: string, practice: boolean): Promise<void> {
  const s = sessionById(sessionId);
  if (!s || (s.practice === true) === practice) return;
  if (!practice && s.scramble) return; // only the default scramble counts: its sessions stay practice
  patchSession(sessionId, { practice, updatedAt: new Date().toISOString() });
  if (scope?.mode === 'cloud') enqueue({ kind: 'setPractice', id: sessionId, practice });
  commit();
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
    const sibling = [...model.sessions].reverse().find((x) => x.event === s.event && x.scramble === s.scramble);
    const next =
      sibling ??
      (s.scramble
        ? createSessionInternal(freeSessionName(scrambleSessionName(s.event, s.scramble), model.sessions), s.event, true, undefined, s.scramble)
        : createSessionInternal(suggestSessionNameFor(s.event), s.event));
    commit();
    await switchSession(next.id);
    return;
  }
  commit();
}

/**
 * Deletes every solve in a session but keeps the session: its name and its place in the list
 * (csTimer's alt+d). Signed in, an empty session with the same name and creation time takes its
 * place - one request to create it and one to delete the old one, however many solves there were.
 */
export async function clearSession(sessionId: string): Promise<void> {
  const old = sessionById(sessionId);
  if (!old || old.solveCount === 0) return;
  const now = new Date().toISOString();
  if (scope?.mode !== 'cloud') {
    model.solves.set(sessionId, []);
    patchSession(sessionId, { solveCount: 0, updatedAt: now });
    commit();
    return;
  }
  const fresh: Session = {
    id: uuid(),
    name: old.name,
    event: old.event,
    ...(old.practice ? { practice: true } : {}),
    ...(old.scramble ? { scramble: old.scramble } : {}),
    createdAt: old.createdAt,
    updatedAt: now,
    solveCount: 0,
  };
  model.sessions = model.sessions.map((s) => (s.id === sessionId ? fresh : s));
  model.solves.delete(sessionId);
  model.solves.set(fresh.id, []);
  for (const [ev, id] of Object.entries(model.lastByEvent)) if (id === sessionId) model.lastByEvent[ev] = fresh.id;
  enqueue({
    kind: 'createSession',
    session: { id: fresh.id, name: fresh.name, event: fresh.event, ...(fresh.practice ? { practice: true } : {}), ...(fresh.scramble ? { scramble: fresh.scramble } : {}), createdAt: fresh.createdAt },
    keepCreatedAt: true,
  });
  enqueue({ kind: 'deleteSession', id: sessionId });
  if (model.current === sessionId) {
    commit();
    await switchSession(fresh.id);
    return;
  }
  commit();
}

export async function switchSession(sessionId: string): Promise<void> {
  const s = sessionById(sessionId);
  if (!s) throw new Error('Unknown session');
  model.current = sessionId;
  model.lastByEvent = { ...model.lastByEvent, [s.event]: sessionId, [scrambleScope(s.event, s.scramble)]: sessionId };
  if (settingsStore.get().lastEvent !== s.event) updateSettings({ lastEvent: s.event });
  if (scope?.mode === 'cloud') {
    writeLastSession();
    publish();
    await loadSessionSolves(sessionId, gen);
  } else commit();
}

/** The session of `event` used last (or the first); `counts`: one that isn't a practice session. */
function findSessionFor(event: string, counts = false): Session | undefined {
  const ok = (s: Session | undefined) => !!s && s.event === event && !(counts && s.practice);
  const last = sessionById(model.lastByEvent[event]);
  if (ok(last)) return last;
  return model.sessions.find(ok);
}

/** lastByEvent's key for the last session of one scramble type ("333#" = the default, "333#pll") */
const scrambleScope = (event: string, scramble: string | undefined) => `${event}#${scramble ?? ''}`;

/**
 * Switch `event` to a scramble type (null = its default): to the session of that type used last,
 * else its first, else a new one. A practice type's new session is "3x3 pll", a practice session
 * (only the default scramble counts for PBs and leaderboards); the default's are made as usual.
 */
export async function switchScramble(event: string, scramble: string | null): Promise<void> {
  if (!solveStore.get().ready) await whenReady();
  if (!isEventId(event)) throw new Error(`Unknown event ${event}`);
  const type = scramble && isPracticeScramble(event, scramble) ? scramble : undefined;
  const ok = (s: Session | undefined): s is Session => !!s && s.event === event && s.scramble === type;
  const last = sessionById(model.lastByEvent[scrambleScope(event, type)]);
  let target = ok(last) ? last : model.sessions.find(ok);
  if (!target) {
    target = type
      ? createSessionInternal(freeSessionName(scrambleSessionName(event, type), model.sessions), event, true, undefined, type)
      : createDefaultSessions(event);
  }
  await switchSession(target.id);
}

/** Switch to the first session of `event`, creating one if none exists. */
export async function switchEvent(event: string): Promise<void> {
  if (!solveStore.get().ready) await whenReady();
  if (!isEventId(event)) throw new Error(`Unknown event ${event}`);
  const s = findSessionFor(event) ?? createDefaultSessions(event);
  await switchSession(s.id);
}

/**
 * Returns a session for `event` without switching to it (creates one if needed). `counts`: one
 * whose solves count for PBs and leaderboards (the daily challenge and races never go into a
 * practice session).
 */
export async function ensureSession(event: string, opts: { counts?: boolean } = {}): Promise<Session> {
  if (!solveStore.get().ready) await whenReady();
  if (!isEventId(event)) throw new Error(`Unknown event ${event}`);
  const found = findSessionFor(event, opts.counts === true);
  if (found) return found;
  const s = createDefaultSessions(event);
  commit();
  return s;
}

// ================================================================ merging sessions

const MERGE_CHUNK = 50; // the API merges at most 50 sources per request
const SAME_EVENT_MSG = 'only sessions of the same event can be merged';
const SAME_SCRAMBLE_MSG = 'only sessions of the same scramble type can be merged';

/** The session a queued op touches (same rule as storeUtils' coalescing). */
function opSessionId(op: SyncOp): string {
  switch (op.kind) {
    case 'createSession':
      return op.session.id;
    case 'renameSession':
    case 'setPractice':
    case 'deleteSession':
      return op.id;
    case 'createSolve':
      return op.solve.sessionId;
    default:
      return op.sessionId;
  }
}

/**
 * The solves of a session that are already in memory (chronological), or null if they haven't
 * been fetched yet (cloud mode only fetches the sessions you open). Do not mutate the result.
 */
export function getLoadedSolves(sessionId: string): Solve[] | null {
  return model.solves.get(sessionId) ?? null;
}

/** target + sources combined chronologically (re-tagged to the target); null if any isn't loaded. */
function combinedSolves(targetId: string, sourceIds: string[]): { list: Solve[]; before: number } | null {
  const before = model.solves.get(targetId);
  if (!before) return null;
  const seen = new Set(before.map((s) => s.id));
  const all = before.slice();
  for (const id of sourceIds) {
    const list = model.solves.get(id);
    if (!list) return null;
    for (const s of list) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      all.push({ ...s, sessionId: targetId });
    }
  }
  return { list: sortChrono(all), before: before.length };
}

/** Drops merged-away sessions from the model and points everything that referenced them at the target. */
function dropMergedSessions(targetId: string, drop: Set<string>, targetPatch: Partial<Session>): void {
  model.sessions = model.sessions.filter((s) => !drop.has(s.id)).map((s) => (s.id === targetId ? { ...s, ...targetPatch } : s));
  drop.forEach((id) => model.solves.delete(id));
  const lastByEvent = { ...model.lastByEvent };
  for (const [ev, id] of Object.entries(lastByEvent)) if (drop.has(id)) lastByEvent[ev] = targetId;
  model.lastByEvent = lastByEvent;
  if (model.current && drop.has(model.current)) model.current = targetId;
}

function mergeErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return 'one of these sessions no longer exists (changed on another device?) - your sessions were refreshed, please try again';
    if (e.status === 409) return SAME_EVENT_MSG;
    if (e.status === 401) return 'you were signed out - sign in again to merge sessions';
    if (e.status === 429) return 'too many requests - try again in a moment';
    if (e.isUnavailable || e.status >= 500) return "couldn't reach the solve service - try again in a moment";
    return e.message || 'the merge was rejected';
  }
  return (e as Error)?.message || 'the merge failed';
}

/**
 * Moves every solve of `sourceIds` into `targetId` (kept chronological) and deletes the source
 * sessions. All sessions must belong to the same event. If the current session is merged away,
 * the target becomes current. Guest mode: localStorage. Cloud mode: not optimistic - waits for
 * the retry queue, then POST /api/sessions/:id/merge and reloads.
 */
export async function mergeSessions(targetId: string, sourceIds: string[]): Promise<{ sessions: number; solves: number }> {
  if (!solveStore.get().ready) await whenReady();
  const target = sessionById(targetId);
  if (!target) throw new Error("that session doesn't exist anymore");
  const ids = Array.from(new Set(sourceIds));
  if (ids.includes(targetId)) throw new Error("a session can't be merged into itself");
  if (ids.length === 0) throw new Error('pick at least one session to merge');
  const sources = ids.map((id) => sessionById(id));
  if (sources.some((s) => !s)) throw new Error("one of these sessions doesn't exist anymore");
  if (sources.some((s) => s!.event !== target.event)) throw new Error(SAME_EVENT_MSG);
  if (sources.some((s) => s!.scramble !== target.scramble)) throw new Error(SAME_SCRAMBLE_MSG);
  return scope?.mode === 'cloud' ? mergeCloud(target, ids) : mergeLocal(target, ids);
}

function mergeLocal(target: Session, ids: string[]): { sessions: number; solves: number } {
  const snapshot = { sessions: model.sessions, solves: new Map(model.solves), current: model.current, lastByEvent: model.lastByEvent };
  const merged = combinedSolves(target.id, ids) ?? { list: [], before: 0 }; // local mode has every list in memory
  model.solves.set(target.id, merged.list);
  dropMergedSessions(target.id, new Set(ids), { solveCount: merged.list.length, updatedAt: new Date().toISOString() });
  localDirty = true;
  if (!flushLocal()) {
    // the browser refused the write: put everything back so memory matches what is stored
    Object.assign(model, snapshot);
    publish();
    throw new Error('not enough browser storage to save the merge - export your solves or sign in to sync them');
  }
  publish();
  return { sessions: ids.length, solves: merged.list.length - merged.before };
}

async function mergeCloud(target: Session, ids: string[]): Promise<{ sessions: number; solves: number }> {
  const uid = userId();
  if (!uid) throw new Error('not logged in');
  const involved = new Set([target.id, ...ids]);
  const unsynced = () => queue.some((q) => q.userId === uid && involved.has(opSessionId(q.op)));
  // a merge must never overtake queued writes (a solve sent later would land in a deleted session)
  if (pendingCount() > 0) await flushQueue(10_000);
  if (unsynced()) throw new Error("you have unsynced solves - try again when you're back online");

  const g = gen;
  const total = { sessions: 0, solves: 0 };
  try {
    for (let i = 0; i < ids.length; i += MERGE_CHUNK) {
      const chunk = ids.slice(i, i + MERGE_CHUNK);
      const r = await api.sessions.merge(target.id, chunk);
      total.sessions += r.merged.sessions;
      total.solves += r.merged.solves;
      if (g !== gen) return total;
      const drop = new Set(chunk);
      // completed ops of merged-away sessions must not resurrect them in the read overlay
      recent = recent.filter((x) => !drop.has(opSessionId(x.op)));
      // show the result right away when everything is in memory; otherwise re-fetch the target
      const merged = combinedSolves(target.id, chunk);
      if (merged) model.solves.set(target.id, merged.list);
      else model.solves.delete(target.id);
      dropMergedSessions(target.id, drop, { solveCount: r.session.solveCount, updatedAt: r.session.updatedAt });
      writeLastSession();
      publish();
    }
  } catch (e) {
    if (g === gen) void refreshCloud();
    const msg = mergeErrorMessage(e);
    throw new Error(total.sessions > 0 ? `merged ${total.sessions} of ${ids.length} sessions, then: ${msg}` : msg);
  }
  if (g === gen) await refreshCloud();
  return total;
}

/** Import sessions read by parseTimerFile (cloud: POST /api/sessions/import; local: localStorage). */
export async function importSessions(sessions: ImportedSession[]): Promise<{ sessions: number; solves: number }> {
  if (!solveStore.get().ready) await whenReady();
  const valid = sessions.filter((s) => isEventId(s.event) && s.solves.length > 0);
  if (scope?.mode === 'cloud') {
    const payload: ImportPayload['sessions'] = valid.map((s) => ({
      name: (s.name.trim() || 'import').slice(0, 40),
      event: s.event,
      ...(s.practice || s.scramble ? { practice: true } : {}),
      ...(s.scramble ? { scramble: s.scramble } : {}),
      solves: s.solves.map((x) => ({ timeMs: x.timeMs, penalty: x.penalty, scramble: x.scramble, comment: x.comment, createdAt: x.createdAt })),
    }));
    const total = { sessions: 0, solves: 0 };
    for (const chunk of planImportChunks(payload)) {
      const r = await api.sessions.import(chunk);
      total.sessions += r.imported.sessions;
      total.solves += r.imported.solves;
    }
    await refreshCloud();
    return total;
  }
  const added: Session[] = [];
  let solves = 0;
  for (const s of valid) {
    const now = new Date().toISOString();
    const session: Session = {
      id: uuid(),
      name: (s.name.trim() || 'import').slice(0, 40),
      event: s.event,
      ...(s.practice || s.scramble ? { practice: true } : {}),
      ...(s.scramble ? { scramble: s.scramble } : {}),
      createdAt: now,
      updatedAt: now,
      solveCount: s.solves.length,
    };
    const list = sortChrono(
      s.solves.map((x) => ({
        id: uuid(),
        sessionId: session.id,
        event: s.event,
        timeMs: x.timeMs,
        penalty: x.penalty,
        scramble: x.scramble,
        comment: x.comment,
        source: 'import',
        createdAt: x.createdAt,
      })),
    );
    added.push(session);
    localDb.sessions = [...localDb.sessions, session];
    localDb.solves.set(session.id, list);
    solves += list.length;
  }
  localDirty = true;
  if (!flushLocal()) {
    const ids = new Set(added.map((s) => s.id));
    localDb.sessions = localDb.sessions.filter((s) => !ids.has(s.id));
    ids.forEach((id) => localDb.solves.delete(id));
    localDirty = true;
    flushLocal();
    throw new Error('Not enough browser storage for this import. Sign in to import it into your cloud account instead.');
  }
  if (scope?.mode === 'local') publish();
  return { sessions: added.length, solves };
}

/** All sessions with all solves (for JSON export). */
export async function exportAll(): Promise<{ exportedAt: string; sessions: (Session & { solves: Solve[] })[] }> {
  if (!solveStore.get().ready) await whenReady();
  if (scope?.mode === 'cloud') {
    await flushQueue();
    return api.solves.export();
  }
  flushLocal();
  return {
    exportedAt: new Date().toISOString(),
    sessions: localDb.sessions.map((s) => ({ ...s, solves: localDb.solves.get(s.id) ?? [] })),
  };
}

// ================================================================ guest data helpers (extra exports)

/** Uploads this browser's guest solves to the logged-in account, then removes the local copy. */
export async function uploadLocalSolves(): Promise<{ sessions: number; solves: number }> {
  const uid = userId();
  if (!uid) throw new Error('Sign in first');
  flushLocal();
  const db = readLocal(true);
  const entries = db.sessions
    .map((s) => ({ s, list: db.solves.get(s.id) ?? [] }))
    .filter((x) => x.list.length > 0)
    .map(({ s, list }) => ({
      localId: s.id,
      payload: {
        name: s.name,
        event: s.event,
        ...(s.practice ? { practice: true } : {}),
        solves: list.map((x) => ({ timeMs: x.timeMs, penalty: x.penalty, scramble: x.scramble, comment: x.comment, createdAt: x.createdAt })),
      },
    }));
  const owner = new Map<ImportPayload['sessions'][number], string>(entries.map((e) => [e.payload, e.localId]));
  const total = { sessions: 0, solves: 0 };
  const done = new Set<string>();
  try {
    for (const chunk of planImportChunks(entries.map((e) => e.payload))) {
      const r = await api.sessions.import(chunk);
      total.sessions += r.imported.sessions;
      total.solves += r.imported.solves;
      chunk.sessions.forEach((p) => {
        const id = owner.get(p);
        if (id) done.add(id);
      });
    }
  } catch (e) {
    // keep only what was not uploaded yet, so a retry never duplicates solves
    if (done.size) removeLocalSessions(done);
    throw e;
  }
  removeLocalSessions(new Set(db.sessions.map((s) => s.id)));
  uploadOfferStore.set(null);
  if (userId() === uid) await refreshCloud();
  return total;
}

function removeLocalSessions(ids: Set<string>): void {
  localDb = readLocal(true);
  localDb.sessions = localDb.sessions.filter((s) => !ids.has(s.id));
  ids.forEach((id) => localDb.solves.delete(id));
  localDirty = true;
  flushLocal();
}

export function dismissUploadOffer(): void {
  const offer = uploadOfferStore.get();
  if (offer) {
    try {
      sessionStorage.setItem(OFFER_DISMISSED_KEY, offer.userId);
    } catch {
      /* ignore */
    }
  }
  uploadOfferStore.set(null);
}

/** Counts of the guest data stored in this browser. */
export function localDataSummary(): { sessions: number; solves: number } {
  if (scope?.mode === 'local') return countLocal(localDb);
  return countLocal(readLocal(true));
}

/** Forgets what this browser keeps for an account (after deleting it): its offline copy and unsent changes. */
export function forgetUser(uid: string): void {
  queue = readQueue().filter((q) => q.userId !== uid);
  saveQueue();
  if (loadJson<{ userId?: unknown } | null>(CLOUD_CACHE_KEY, null)?.userId === uid) {
    try {
      localStorage.removeItem(CLOUD_CACHE_KEY);
    } catch {
      /* ignore */
    }
  }
  const last = loadJson<Record<string, unknown>>(LAST_SESSION_KEY, {});
  if (last && typeof last === 'object' && uid in last) {
    const { [uid]: _gone, ...rest } = last;
    saveJson(LAST_SESSION_KEY, rest);
  }
  publish();
}

/** Deletes every guest session/solve stored in this browser (does not touch cloud data). */
export function clearLocalData(): void {
  try {
    localStorage.removeItem(LOCAL_KEY);
    localStorage.removeItem(`${LOCAL_KEY}.corrupt`);
  } catch {
    /* ignore */
  }
  if (localTimer) clearTimeout(localTimer);
  localTimer = null;
  localDirty = false;
  localDb = emptyLocalDb();
  storageError = null;
  if (scope?.mode === 'local') {
    model = localDb;
    createDefaultSessions(defaultEvent());
    model.current = pickCurrent();
    publish();
  }
}
