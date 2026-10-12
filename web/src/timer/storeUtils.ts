// Pure helpers behind lib/solves.ts (kept free of browser globals so they can be unit-tested):
// compact localStorage codec.
import type { Penalty } from '@cubetype/cubestats';
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
