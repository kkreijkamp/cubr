import { randomUUID } from 'node:crypto';
import type { PoolClient } from '@cubr/common';
import type { ImportBody } from './schemas.js';

/** Rows per INSERT statement. ~2000 keeps each statement's parameter arrays at a few hundred KB. */
export const IMPORT_CHUNK_SIZE = 2000;

export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error('chunk size must be >= 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A solve ready for insertion, with server-generated ids. */
export interface ImportRow {
  id: string;
  sessionId: string;
  event: string;
  timeMs: number;
  penalty: string;
  scramble: string;
  comment: string | null;
  createdAt: string;
}

export interface ImportPlan {
  sessions: { id: string; name: string; event: string; practice: boolean; scramble: string | null }[];
  rows: ImportRow[];
  /** Distinct events that received at least one solve. */
  events: string[];
}

/** A plan with what the account already has taken out (see `leaveOutExisting`). */
export interface ImportResult extends ImportPlan {
  /** solves the account already had (same event, time, penalty and moment), left out */
  skipped: number;
  /** existing sessions that the import adds solves to */
  continued: number;
}

/** Assigns ids to every imported session and solve (pure - no I/O). */
export function planImport(body: ImportBody, newId: () => string = randomUUID): ImportPlan {
  const sessions: ImportPlan['sessions'] = [];
  const rows: ImportRow[] = [];
  const events = new Set<string>();
  for (const s of body.sessions) {
    const sessionId = newId();
    // a practice scramble's session is always a practice session
    const scramble = s.scramble ?? null;
    sessions.push({ id: sessionId, name: s.name, event: s.event, practice: s.practice || scramble !== null, scramble });
    if (s.solves.length) events.add(s.event);
    for (const v of s.solves) {
      rows.push({
        id: newId(),
        sessionId,
        event: s.event,
        timeMs: v.timeMs,
        penalty: v.penalty,
        scramble: v.scramble,
        comment: v.comment ?? null,
        createdAt: v.createdAt,
      });
    }
  }
  return { sessions, rows, events: [...events] };
}

/**
 * The account's sessions that already hold each planned solve: row index -> session id, for every row
 * whose event, time, penalty and moment (to the millisecond) match a solve the user has. One query,
 * on the (user_id, event, created_at) index.
 */
export async function findExisting(client: PoolClient, userId: string, rows: ImportRow[]): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  const size = IMPORT_CHUNK_SIZE * 5;
  for (let offset = 0; offset < rows.length; offset += size) {
    const part = rows.slice(offset, offset + size);
    const { rows: hits } = await client.query<{ i: number; session_id: string }>(
      `SELECT (t.i - 1)::int AS i, min(s.session_id::text) AS session_id
         FROM unnest($2::text[], $3::int[], $4::text[], $5::timestamptz[]) WITH ORDINALITY AS t(event, time_ms, penalty, created_at, i)
         JOIN solve.solves s ON s.user_id = $1 AND s.event = t.event AND s.created_at = t.created_at AND s.time_ms = t.time_ms AND s.penalty = t.penalty
        GROUP BY t.i`,
      [userId, part.map((r) => r.event), part.map((r) => r.timeMs), part.map((r) => r.penalty), part.map((r) => r.createdAt)],
    );
    for (const h of hits) found.set(offset + h.i, h.session_id);
  }
  return found;
}

/**
 * Leaves out the solves the account already has (`existing`, from findExisting), so importing a file
 * again, or retrying one that failed half-way, adds only what's missing (pure - no I/O). A session whose
 * solves are already in one of the account's sessions continues that one (the one holding most of them)
 * with the rest; a session with none of them becomes a new session, as before.
 */
export function leaveOutExisting(plan: ImportPlan, existing: Map<number, string>): ImportResult {
  if (existing.size === 0) return { ...plan, skipped: 0, continued: 0 };
  // per planned session: how many of its solves each existing session holds
  const holders = new Map<string, Map<string, number>>();
  plan.rows.forEach((r, i) => {
    const at = existing.get(i);
    if (at === undefined) return;
    const counts = holders.get(r.sessionId) ?? new Map<string, number>();
    counts.set(at, (counts.get(at) ?? 0) + 1);
    holders.set(r.sessionId, counts);
  });
  const target = new Map<string, string>();
  for (const [planned, counts] of holders) target.set(planned, [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]);
  const rows = plan.rows.filter((_, i) => !existing.has(i)).map((r) => ({ ...r, sessionId: target.get(r.sessionId) ?? r.sessionId }));
  const sessions = plan.sessions.filter((s) => !target.has(s.id));
  const created = new Set(sessions.map((s) => s.id));
  const events = [...new Set(rows.map((r) => r.event))];
  const continued = new Set(rows.map((r) => r.sessionId).filter((id) => !created.has(id))).size;
  return { sessions, rows, events, skipped: plan.rows.length - rows.length, continued };
}

/** Column-oriented arrays for `unnest()` - one array per column, same order as the SQL below. */
export function toColumns(rows: ImportRow[]) {
  const n = rows.length;
  const cols = {
    id: new Array<string>(n),
    sessionId: new Array<string>(n),
    event: new Array<string>(n),
    timeMs: new Array<number>(n),
    penalty: new Array<string>(n),
    scramble: new Array<string>(n),
    comment: new Array<string | null>(n),
    createdAt: new Array<string>(n),
  };
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    cols.id[i] = r.id;
    cols.sessionId[i] = r.sessionId;
    cols.event[i] = r.event;
    cols.timeMs[i] = r.timeMs;
    cols.penalty[i] = r.penalty;
    cols.scramble[i] = r.scramble;
    cols.comment[i] = r.comment;
    cols.createdAt[i] = r.createdAt;
  }
  return cols;
}

// One statement inserts a whole chunk: each column travels as a single array parameter and
// unnest() zips them back into rows. Much faster than multi-row VALUES with 16k placeholders.
const INSERT_CHUNK_SQL = `
INSERT INTO solve.solves (id, user_id, session_id, event, time_ms, penalty, scramble, comment, source, created_at)
SELECT t.id, $1::uuid, t.session_id, t.event, t.time_ms, t.penalty, t.scramble, t.comment, 'import', t.created_at
  FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::int[], $6::text[], $7::text[], $8::text[], $9::timestamptz[])
       AS t(id, session_id, event, time_ms, penalty, scramble, comment, created_at)`;

/** Writes the plan inside the caller's transaction. Returns the number of solves inserted. */
export async function writeImport(client: PoolClient, userId: string, plan: ImportPlan, chunkSize = IMPORT_CHUNK_SIZE): Promise<number> {
  if (plan.sessions.length) {
    // created_at offset by 1 us per session keeps the file's session order in GET /api/sessions.
    await client.query(
      `INSERT INTO solve.sessions (id, user_id, name, event, practice, scramble, created_at, updated_at)
       SELECT t.id, $1::uuid, t.name, t.event, t.practice, t.scramble, now() + (t.ord - 1) * interval '1 microsecond', now()
         FROM unnest($2::uuid[], $3::text[], $4::text[], $5::boolean[], $6::text[]) WITH ORDINALITY AS t(id, name, event, practice, scramble, ord)`,
      [
        userId,
        plan.sessions.map((s) => s.id),
        plan.sessions.map((s) => s.name),
        plan.sessions.map((s) => s.event),
        plan.sessions.map((s) => s.practice),
        plan.sessions.map((s) => s.scramble),
      ],
    );
  }
  let inserted = 0;
  for (const part of chunk(plan.rows, chunkSize)) {
    const c = toColumns(part);
    const res = await client.query(INSERT_CHUNK_SQL, [userId, c.id, c.sessionId, c.event, c.timeMs, c.penalty, c.scramble, c.comment, c.createdAt]);
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}
