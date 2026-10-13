// Pure helpers behind lib/solves.ts (kept free of browser globals so they can be unit-tested):
// compact localStorage codec, retry-queue coalescing, optimistic overlays, backoff.
import type { Penalty } from '@cubetype/cubestats';
import type { NewSolve } from '../lib/api';
import type { Session, Solve } from '../lib/types';

// ---------------------------------------------------------------- ids

/** RFC 4122 v4 UUID. Falls back to getRandomValues on insecure origins (plain-http deployments). */
export function uuid(): string {
  const c: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      /* insecure context */
    }
  }
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------- ordering

const ts = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/** Chronological order (stable). Returns the same array when it is already sorted. */
export function sortChrono(solves: Solve[]): Solve[] {
  for (let i = 1; i < solves.length; i++) {
    if (ts(solves[i].createdAt) < ts(solves[i - 1].createdAt)) {
      return solves
        .map((s, idx) => ({ s, idx, t: ts(s.createdAt) }))
        .sort((a, b) => a.t - b.t || a.idx - b.idx)
        .map((x) => x.s);
    }
  }
  return solves;
}

/** Insert keeping chronological order (fast path: append). Returns a new array. */
export function insertChrono(list: Solve[], solve: Solve): Solve[] {
  const t = ts(solve.createdAt);
  if (list.length === 0 || ts(list[list.length - 1].createdAt) <= t) return [...list, solve];
  let i = list.length;
  while (i > 0 && ts(list[i - 1].createdAt) > t) i--;
  return [...list.slice(0, i), solve, ...list.slice(i)];
}

// ---------------------------------------------------------------- local storage codec

export const LOCAL_KEY = 'cubetype.local.v1';

/** [id, timeMs, penalty (0 OK, 1 +2, 2 DNF), scramble, comment, createdAt epoch ms, source (omitted = timer)] */
export type SolveTuple = [string, number, 0 | 1 | 2, string, string | null, number, string?];

interface LocalSessionRow {
  id: string;
  name: string;
  event: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalDbFile {
  v: 1;
  sessions: LocalSessionRow[];
  solves: Record<string, SolveTuple[]>;
  current: string | null;
  lastByEvent: Record<string, string>;
}

export interface LocalDb {
  sessions: Session[];
  solves: Map<string, Solve[]>;
  current: string | null;
  lastByEvent: Record<string, string>;
}

export function emptyLocalDb(): LocalDb {
  return { sessions: [], solves: new Map(), current: null, lastByEvent: {} };
}

const PEN_CODES: Penalty[] = ['OK', '+2', 'DNF'];
const penCode = (p: Penalty): 0 | 1 | 2 => (p === 'DNF' ? 2 : p === '+2' ? 1 : 0);
const isStr = (x: unknown): x is string => typeof x === 'string';
const validIso = (x: unknown, fallback: string) => (isStr(x) && !Number.isNaN(Date.parse(x)) ? x : fallback);

function decodeTuple(t: unknown, session: { id: string; event: string }): Solve | null {
  if (!Array.isArray(t)) return null;
  const [id, timeMs, pen, scramble, comment, created, source] = t as unknown[];
  if (!isStr(id) || !id) return null;
  if (typeof timeMs !== 'number' || !Number.isFinite(timeMs) || timeMs < 1 || timeMs > 86_400_000) return null;
  const p = PEN_CODES[typeof pen === 'number' ? pen : 0] ?? 'OK';
  const ms = typeof created === 'number' && Number.isFinite(created) ? created : 0;
  return {
    id,
    sessionId: session.id,
    event: session.event,
    timeMs: Math.round(timeMs),
    penalty: p,
    scramble: isStr(scramble) ? scramble : '',
    comment: isStr(comment) && comment ? comment : null,
    source: isStr(source) && source ? source : 'timer',
    createdAt: new Date(ms).toISOString(),
  };
}

export function encodeSolve(s: Solve): SolveTuple {
  const t: SolveTuple = [s.id, s.timeMs, penCode(s.penalty), s.scramble, s.comment ?? null, ts(s.createdAt)];
  if (s.source && s.source !== 'timer') t.push(s.source);
  return t;
}

/**
 * Parses whatever is stored under LOCAL_KEY. Never throws: unknown shapes yield an empty db with
 * `corrupt: true`; individually broken sessions/solves are dropped and counted.
 */
export function decodeLocalDb(raw: unknown, isEvent: (id: string) => boolean): { db: LocalDb; dropped: number; corrupt: boolean } {
  const db = emptyLocalDb();
  if (raw === null || raw === undefined) return { db, dropped: 0, corrupt: false };
  if (typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1 || !Array.isArray((raw as LocalDbFile).sessions)) {
    return { db, dropped: 0, corrupt: true };
  }
  const file = raw as Partial<LocalDbFile>;
  const solvesObj = file.solves && typeof file.solves === 'object' ? file.solves : {};
  let dropped = 0;
  const seen = new Set<string>();
  const now = new Date(0).toISOString();
  for (const row of file.sessions ?? []) {
    if (!row || typeof row !== 'object' || !isStr(row.id) || !row.id || seen.has(row.id)) {
      dropped++;
      continue;
    }
    seen.add(row.id);
    const event = isStr(row.event) && isEvent(row.event) ? row.event : '333';
    const name = isStr(row.name) && row.name.trim() ? row.name.trim().slice(0, 40) : 'session';
    const createdAt = validIso(row.createdAt, now);
    const list: Solve[] = [];
    const rawSolves = (solvesObj as Record<string, unknown>)[row.id];
    const ids = new Set<string>();
    if (Array.isArray(rawSolves)) {
      for (const t of rawSolves) {
        const s = decodeTuple(t, { id: row.id, event });
        if (!s || ids.has(s.id)) {
          dropped++;
          continue;
        }
        ids.add(s.id);
        list.push(s);
      }
    }
    const sorted = sortChrono(list);
    db.sessions.push({ id: row.id, name, event, createdAt, updatedAt: validIso(row.updatedAt, createdAt), solveCount: sorted.length });
    db.solves.set(row.id, sorted);
  }
  db.current = isStr(file.current) && seen.has(file.current) ? file.current : null;
  if (file.lastByEvent && typeof file.lastByEvent === 'object') {
    for (const [ev, id] of Object.entries(file.lastByEvent)) if (isStr(id) && seen.has(id)) db.lastByEvent[ev] = id;
  }
  return { db, dropped, corrupt: false };
}

export function encodeLocalDb(db: LocalDb): string {
  const file: LocalDbFile = {
    v: 1,
    sessions: db.sessions.map(({ id, name, event, createdAt, updatedAt }) => ({ id, name, event, createdAt, updatedAt })),
    solves: {},
    current: db.current,
    lastByEvent: db.lastByEvent,
  };
  for (const s of db.sessions) file.solves[s.id] = (db.solves.get(s.id) ?? []).map(encodeSolve);
  return JSON.stringify(file);
}

// ---------------------------------------------------------------- retry queue

export const QUEUE_KEY = 'cubetype.queue.v1';

export type SyncOp =
  | { kind: 'createSession'; session: { id: string; name: string; event: string; createdAt: string } }
  | { kind: 'renameSession'; id: string; name: string }
  | { kind: 'deleteSession'; id: string }
  | { kind: 'createSolve'; solve: NewSolve & { event: string; createdAt: string } }
  | { kind: 'updateSolve'; id: string; sessionId: string; patch: { penalty?: Penalty; comment?: string | null } }
  | { kind: 'deleteSolve'; id: string; sessionId: string };

export interface QueuedOp {
  opId: string;
  userId: string;
  op: SyncOp;
  attempts: number;
  createdAt: number;
}

const OP_KINDS = new Set(['createSession', 'renameSession', 'deleteSession', 'createSolve', 'updateSolve', 'deleteSolve']);

export function decodeQueue(raw: unknown): QueuedOp[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (q): q is QueuedOp =>
      !!q && typeof q === 'object' && isStr(q.opId) && isStr(q.userId) && !!q.op && typeof q.op === 'object' && OP_KINDS.has(q.op.kind),
  );
}

const solveIdOf = (op: SyncOp): string | null =>
  op.kind === 'createSolve' ? op.solve.id : op.kind === 'updateSolve' || op.kind === 'deleteSolve' ? op.id : null;
const sessionIdOf = (op: SyncOp): string | null =>
  op.kind === 'createSession'
    ? op.session.id
    : op.kind === 'renameSession' || op.kind === 'deleteSession'
      ? op.id
      : op.kind === 'createSolve'
        ? op.solve.sessionId
        : op.sessionId;

/**
 * Adds `next` to the queue, merging it into ops that have not been sent yet:
 *  - edits of a not-yet-created solve/session are folded into the create;
 *  - deleting a not-yet-created solve/session drops every op about it (nothing to send at all).
 * `inflightOpId` (the op currently being sent) is never modified.
 */
export function coalesce(queue: QueuedOp[], next: QueuedOp, inflightOpId: string | null): QueuedOp[] {
  const editable = (q: QueuedOp) => q.userId === next.userId && q.opId !== inflightOpId;
  const op = next.op;
  if (op.kind === 'updateSolve') {
    const i = queue.findIndex((q) => editable(q) && q.op.kind === 'createSolve' && q.op.solve.id === op.id);
    if (i >= 0) {
      const create = queue[i].op as Extract<SyncOp, { kind: 'createSolve' }>;
      const merged: QueuedOp = { ...queue[i], op: { ...create, solve: { ...create.solve, ...op.patch } } };
      return queue.map((q, k) => (k === i ? merged : q));
    }
    const j = queue.findIndex((q) => editable(q) && q.op.kind === 'updateSolve' && q.op.id === op.id);
    if (j >= 0) {
      const prev = queue[j].op as Extract<SyncOp, { kind: 'updateSolve' }>;
      const merged: QueuedOp = { ...queue[j], op: { ...prev, patch: { ...prev.patch, ...op.patch } } };
      return queue.map((q, k) => (k === j ? merged : q));
    }
  }
  if (op.kind === 'deleteSolve') {
    const created = queue.some((q) => editable(q) && q.op.kind === 'createSolve' && q.op.solve.id === op.id);
    const rest = queue.filter((q) => !(editable(q) && solveIdOf(q.op) === op.id));
    return created ? rest : [...rest, next];
  }
  if (op.kind === 'renameSession') {
    const i = queue.findIndex((q) => editable(q) && q.op.kind === 'createSession' && q.op.session.id === op.id);
    if (i >= 0) {
      const create = queue[i].op as Extract<SyncOp, { kind: 'createSession' }>;
      const merged: QueuedOp = { ...queue[i], op: { ...create, session: { ...create.session, name: op.name } } };
      return queue.map((q, k) => (k === i ? merged : q));
    }
    const rest = queue.filter((q) => !(editable(q) && q.op.kind === 'renameSession' && q.op.id === op.id));
    return [...rest, next];
  }
  if (op.kind === 'deleteSession') {
    const created = queue.some((q) => editable(q) && q.op.kind === 'createSession' && q.op.session.id === op.id);
    const rest = queue.filter((q) => !(editable(q) && sessionIdOf(q.op) === op.id));
    return created ? rest : [...rest, next];
  }
  return [...queue, next];
}

/** Exponential backoff with ±25 % jitter: 1 s, 2 s, 4 s … capped at 60 s. */
export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, Math.min(attempt, 16)));
  return Math.round(base * (0.75 + rand() * 0.5));
}

// ---------------------------------------------------------------- optimistic overlays (cloud)

/** Applies queued (unsynced) session ops on top of the server's session list. */
export function overlaySessions(server: Session[], ops: SyncOp[]): Session[] {
  let out = server.slice();
  for (const op of ops) {
    if (op.kind === 'createSession') {
      if (!out.some((s) => s.id === op.session.id)) {
        out.push({ ...op.session, updatedAt: op.session.createdAt, solveCount: 0 });
      }
    } else if (op.kind === 'renameSession') {
      out = out.map((s) => (s.id === op.id ? { ...s, name: op.name } : s));
    } else if (op.kind === 'deleteSession') {
      out = out.filter((s) => s.id !== op.id);
    }
  }
  return out;
}

/** Applies queued solve ops for one session on top of the server's (chronological) solve list. */
export function overlaySolves(sessionId: string, server: Solve[], ops: SyncOp[]): Solve[] {
  let out = server;
  let ids: Set<string> | null = null;
  for (const op of ops) {
    if (op.kind === 'createSolve' && op.solve.sessionId === sessionId) {
      ids ??= new Set(out.map((s) => s.id));
      if (ids.has(op.solve.id)) continue;
      ids.add(op.solve.id);
      const s = op.solve;
      out = insertChrono(out, {
        id: s.id,
        sessionId: s.sessionId,
        event: s.event,
        timeMs: s.timeMs,
        penalty: s.penalty,
        scramble: s.scramble,
        comment: s.comment ?? null,
        source: s.source ?? 'timer',
        createdAt: s.createdAt,
        dailyDate: s.daily?.date ?? null,
        dailyIndex: s.daily?.index ?? null,
      });
    } else if (op.kind === 'updateSolve' && op.sessionId === sessionId) {
      out = out.map((s) => (s.id === op.id ? { ...s, ...op.patch } : s));
    } else if (op.kind === 'deleteSolve' && op.sessionId === sessionId) {
      out = out.filter((s) => s.id !== op.id);
    }
  }
  return out;
}
