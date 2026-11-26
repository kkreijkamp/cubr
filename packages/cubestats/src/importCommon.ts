import type { Penalty } from './averages.js';
import { isEventId } from './events.js';
import { isPracticeScramble } from './scrambleTypes.js';

/** One solve ready for POST /api/sessions/import (or the guest store). */
export interface ImportedSolve {
  timeMs: number;
  penalty: Penalty;
  scramble: string;
  comment: string | null;
  createdAt: string;
}

export interface ImportedSession {
  name: string;
  event: string;
  /** The source timer's own puzzle / scramble type, e.g. "444wca" or "pyra". */
  sourceType: string;
  /** a cubr practice session (its solves count for no PB or leaderboard) */
  practice?: boolean;
  /** a practice scramble type (scrambleTypes.ts), e.g. csTimer's "pll": always a practice session */
  scramble?: string;
  solves: ImportedSolve[];
}

/** Solves an import leaves out instead of failing the whole file. */
export interface ImportSkipped {
  /** Multi-blind attempts: cubr has no multi-blind event. */
  multiBlind: number;
  /** No usable time (missing, zero, or above the server's 24 h limit). */
  invalid: number;
}

/** A session as a format reader sees it, before the limits are applied. `event: null` = multi-blind. */
export interface RawSession {
  name: unknown;
  event: string | null;
  sourceType: string;
  /** Sort key where the source has one (csTimer rank, CubeDesk order). */
  rank?: number;
  practice?: boolean;
  /** the session's practice scramble type, where the source says (csTimer's PLL, OLL ...) */
  scramble?: string;
  solves: RawSolve[];
}

export interface RawSolve {
  timeMs: number;
  penalty: Penalty;
  scramble?: unknown;
  comment?: unknown;
  /** Epoch milliseconds, or null when the source has no date. */
  at?: number | null;
}

// The server's limits (services/solve/src/schemas.ts): a solve outside them would make the whole
// import request fail, so they are applied here per solve.
const MAX_TIME_MS = 86_400_000;
const MAX_SCRAMBLE = 2000;
const MAX_COMMENT = 500;
const MAX_NAME = 40;

const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** The first moment of the year 10000: from then on toISOString() writes "+010000-...", which the server's date check refuses. */
const MAX_DATE_MS = Date.UTC(10000, 0, 1);

/** A usable date: a number of ms after the epoch and before the year 10000 (later ones, e.g. a csTimer
 *  timestamp written in ms instead of s, would make the server refuse the whole import). */
const validAt = (at: number | null | undefined): at is number => typeof at === 'number' && Number.isFinite(at) && at > 0 && at < MAX_DATE_MS;

/**
 * Each solve's date, keeping the session's own order (the October review's #9). The server reads a
 * session by date and breaks ties by random ids, which shuffled a quick session's solves (csTimer
 * counts whole seconds), and with them its averages and PBs. So:
 * - a timestamp in order with the one before (or equal to it) comes at least a millisecond after the
 *   solve before; one that goes backwards (a clock change) is kept as it is;
 * - a missing or invalid date comes a millisecond after the solve before (at the start: just before the
 *   first dated solve), so it lands where it was solved rather than in 1970. A session with no date at
 *   all stays at the epoch, a millisecond apart, which keeps undated old solves off the daily and weekly
 *   boards.
 */
export function sessionDates(ats: (number | null | undefined)[]): string[] {
  const ms: number[] = [];
  let prevRaw: number | null = null; // the last valid timestamp, as given
  for (const at of ats) {
    const prev = ms.length ? ms[ms.length - 1] : NaN;
    if (validAt(at)) {
      ms.push(prevRaw !== null && at >= prevRaw ? Math.max(at, prev + 1) : at);
      prevRaw = at;
    } else {
      ms.push(prevRaw !== null ? prev + 1 : NaN); // NaN: before the first dated solve, filled in below
    }
  }
  const first = ms.findIndex((v) => !Number.isNaN(v));
  for (let i = 0; i < (first === -1 ? ms.length : first); i++) ms[i] = first === -1 ? i : Math.max(0, ms[first] - (first - i));
  return ms.map((v) => new Date(Math.min(v, MAX_DATE_MS - 1)).toISOString());
}

/** Applies the server's limits, drops empty sessions and sorts by rank (stable). */
export function finishImport(raw: RawSession[]): { sessions: ImportedSession[]; skipped: ImportSkipped } {
  const skipped: ImportSkipped = { multiBlind: 0, invalid: 0 };
  const sessions: ImportedSession[] = [];
  const ordered = raw
    .map((session, index) => ({ session, index }))
    .sort((a, b) => (a.session.rank ?? Infinity) - (b.session.rank ?? Infinity) || a.index - b.index);
  for (const { session, index } of ordered) {
    if (session.event === null) {
      skipped.multiBlind += session.solves.length;
      continue;
    }
    const solves: ImportedSolve[] = [];
    const dates = sessionDates(session.solves.map((s) => s.at));
    for (const [i, s] of session.solves.entries()) {
      const timeMs = Math.round(s.timeMs);
      if (!Number.isFinite(timeMs) || timeMs < 1 || timeMs > MAX_TIME_MS) {
        skipped.invalid++;
        continue;
      }
      const comment = text(s.comment).trim();
      solves.push({
        timeMs,
        penalty: s.penalty,
        scramble: text(s.scramble).slice(0, MAX_SCRAMBLE),
        comment: comment ? comment.slice(0, MAX_COMMENT) : null,
        createdAt: dates[i],
      });
    }
    if (!solves.length) continue;
    const name = text(session.name).trim().slice(0, MAX_NAME) || `import ${index + 1}`;
    const event = isEventId(session.event) ? session.event : '333';
    const scramble = session.scramble && isPracticeScramble(event, session.scramble) ? session.scramble : undefined;
    sessions.push({
      name,
      event,
      sourceType: session.sourceType,
      ...(session.practice || scramble ? { practice: true } : {}),
      ...(scramble ? { scramble } : {}),
      solves,
    });
  }
  return { sessions, skipped };
}

export function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
