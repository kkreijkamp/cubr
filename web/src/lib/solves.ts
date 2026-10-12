// Solve store — the single source of truth for sessions & solves in the browser.
//
// CONTRACT (other pages rely on these exports):
//  - Guest mode ("local"): everything persists in localStorage; works with no backend at all.
//
// Implementation notes
//  - Local data: `cubetype.local.v1` (compact tuples, see timer/storeUtils.ts), written debounced
//    and flushed on pagehide.
import { getEvent, isEventId, type Penalty } from '@cubetype/cubestats';
import { createStore, useStore } from './store';
import type { Session, Solve } from './types';
import { decodeLocalDb, emptyLocalDb, encodeLocalDb, insertChrono, LOCAL_KEY, uuid, type LocalDb } from '../timer/storeUtils';

export interface SolveState {
  /** initial load finished */
  ready: boolean;
  sessions: Session[];
  currentSessionId: string | null;
  /** solves of the current session, chronological (oldest first) */
  solves: Solve[];
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
  sessions: [],
  currentSessionId: null,
  solves: EMPTY,
});

export function useSolveState(): SolveState {
  return useStore(solveStore);
}

// ================================================================ module state

const browser = typeof window !== 'undefined' && typeof document !== 'undefined';
/** event of the first session in a fresh browser */
const DEFAULT_EVENT = '333';

/** the guest database: what the UI shows, persisted in localStorage */
let model: LocalDb = emptyLocalDb();
let localDirty = false;
let localTimer: ReturnType<typeof setTimeout> | null = null;

function publish(extra: Partial<SolveState> = {}): void {
  solveStore.set((prev) => ({
    ...prev,
    sessions: model.sessions,
    currentSessionId: model.current,
    solves: (model.current && model.solves.get(model.current)) || EMPTY,
    ...extra,
  }));
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
    if (model.sessions.length === 0) localStorage.removeItem(LOCAL_KEY);
    else localStorage.setItem(LOCAL_KEY, encodeLocalDb(model));
    localDirty = false;
  } catch {
    /* storage full or disabled: the data stays in memory */
  }
}

// ================================================================ loading

function sessionById(id: string | null | undefined): Session | undefined {
  return id ? model.sessions.find((s) => s.id === id) : undefined;
}

function pickCurrent(): string | null {
  const ss = model.sessions;
  if (model.current && ss.some((s) => s.id === model.current)) return model.current;
  return ss[0]?.id ?? null;
}

function loadLocalScope(): void {
  model = readLocal();
  if (!pickCurrent()) createSessionInternal(suggestSessionNameFor(DEFAULT_EVENT), DEFAULT_EVENT);
  model.current = pickCurrent();
  publish({ ready: true });
}

function suggestSessionNameFor(event: string): string {
  const base = getEvent(event)?.short ?? event;
  const taken = new Set(model.sessions.map((s) => s.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

if (browser) {
  loadLocalScope();
  window.addEventListener('pagehide', () => flushLocal());
}

// ================================================================ mutations

function commit(): void {
  saveLocalSoon();
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

function createSessionInternal(name: string, event: string): Session {
  const now = new Date().toISOString();
  const session: Session = { id: uuid(), name, event, createdAt: now, updatedAt: now, solveCount: 0 };
  model.sessions = [...model.sessions, session];
  model.solves.set(session.id, []);
  saveLocalSoon();
  return session;
}

/** Append a solve to the current session. Resolves with the stored solve. */
export async function addSolve(input: AddSolveInput): Promise<Solve> {
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
  commit();
  return solve;
}

function updateSolveLocal(solveId: string, patch: { penalty?: Penalty; comment?: string | null }): boolean {
  const hit = locate(solveId);
  if (!hit) return false;
  const next = hit.list.slice();
  next[hit.index] = { ...next[hit.index], ...patch };
  model.solves.set(hit.sid, next);
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
  commit();
}

export async function switchSession(sessionId: string): Promise<void> {
  const s = sessionById(sessionId);
  if (!s) throw new Error('Unknown session');
  model.current = sessionId;
  model.lastByEvent = { ...model.lastByEvent, [s.event]: sessionId };
  commit();
}

function findSessionFor(event: string): Session | undefined {
  const last = sessionById(model.lastByEvent[event]);
  if (last && last.event === event) return last;
  return model.sessions.find((s) => s.event === event);
}

/** Switch to the first session of `event`, creating one if none exists. */
export async function switchEvent(event: string): Promise<void> {
  if (!isEventId(event)) throw new Error(`Unknown event ${event}`);
  const s = findSessionFor(event) ?? createSessionInternal(suggestSessionNameFor(event), event);
  await switchSession(s.id);
}
