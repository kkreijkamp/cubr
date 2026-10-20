import type { Penalty } from '@cubetype/cubestats';

// The one place where database rows (snake_case, Date objects) become the API shapes of
// docs/SPEC.md section 9 (camelCase, ISO-8601 strings).

export interface SessionRow {
  id: string;
  name: string;
  event: string;
  created_at: Date;
  updated_at: Date;
  /** count(*) - the common pg type parser turns int8 into a JS number */
  solve_count?: number | null;
}

export interface SolveRow {
  id: string;
  user_id?: string;
  session_id: string;
  event: string;
  time_ms: number;
  penalty: Penalty;
  scramble: string;
  comment: string | null;
  source: string;
  /** 'YYYY-MM-DD' (common keeps `date` columns as strings) */
  daily_date: string | null;
  daily_index: number | null;
  created_at: Date;
}

export interface Session {
  id: string;
  name: string;
  event: string;
  createdAt: string;
  updatedAt: string;
  solveCount: number;
}

export interface Solve {
  id: string;
  sessionId: string;
  event: string;
  timeMs: number;
  penalty: Penalty;
  scramble: string;
  comment: string | null;
  source: string;
  createdAt: string;
  dailyDate: string | null;
  dailyIndex: number | null;
}

/** Columns to SELECT for a full Solve (keep in sync with SolveRow). */
export const SOLVE_COLUMNS =
  'id, user_id, session_id, event, time_ms, penalty, scramble, comment, source, daily_date, daily_index, created_at';

/** pg returns timestamptz as Date; tolerate strings too (e.g. rows built in tests). */
export function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

export function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    name: row.name,
    event: row.event,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    solveCount: Number(row.solve_count ?? 0),
  };
}

export function toSolve(row: SolveRow): Solve {
  return {
    id: row.id,
    sessionId: row.session_id,
    event: row.event,
    timeMs: row.time_ms,
    penalty: row.penalty,
    scramble: row.scramble,
    comment: row.comment,
    source: row.source,
    createdAt: iso(row.created_at),
    dailyDate: row.daily_date ?? null,
    dailyIndex: row.daily_index ?? null,
  };
}
