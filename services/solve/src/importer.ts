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
