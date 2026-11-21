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

/**
 * ISO date, or the epoch for a missing or invalid date (sorts before everything else). A date past
 * the year 9999 is invalid too (e.g. a csTimer timestamp written in ms instead of s): one such
 * date would otherwise make the server refuse the whole import.
 */
function isoDate(at: number | null | undefined): string {
  if (typeof at === 'number' && Number.isFinite(at) && at > 0 && at < MAX_DATE_MS) return new Date(at).toISOString();
  return new Date(0).toISOString();
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
    for (const s of session.solves) {
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
        createdAt: isoDate(s.at),
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
