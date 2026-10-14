import { z } from 'zod';
import { badRequest } from '@cubetype/common';
import { isEventId, DAILY_EVENTS } from '@cubetype/cubestats';

// Request validation (docs/SPEC.md §5 limits, §9.3 bodies). Route handlers call
// `parse(schema, req.body ?? {})` from common, which turns failures into 400 BAD_REQUEST.

export const MAX_TIME_MS = 86_400_000;
export const MAX_IMPORT_SOLVES = 100_000;
export const MAX_IMPORT_SESSIONS = 1_000;
/** Client clocks drift; timestamps further in the future than this are clamped to the server time. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export const uuid = z.string().uuid();
export const penalty = z.enum(['OK', '+2', 'DNF']);
export const eventId = z.string().refine(isEventId, { message: 'unknown event' });
const sessionName = z.string().trim().min(1).max(40);
const timeMs = z.number().int().min(1).max(MAX_TIME_MS);
const scramble = z.string().max(2000);
const comment = z.string().max(500);
const isoDateTime = z.string().datetime({ offset: true });
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').refine(isRealDate, 'invalid date');

/** Sources a client may set; `source` is only a label (statistics treat every solve the same). */
export const SOLVE_SOURCES = ['timer', 'manual', 'race', 'daily', 'import', 'seed'] as const;

export const idParams = z.object({ id: uuid });

export const createSessionBody = z.object({
  id: uuid.optional(),
  name: sessionName,
  event: eventId,
});

export const patchSessionBody = z.object({ name: sessionName });

/** POST /api/sessions/:id/merge — the sessions whose solves move into :id (then deleted). */
export const mergeSessionsBody = z.object({
  sourceIds: z
    .array(uuid.transform((s) => s.toLowerCase()))
    .min(1, 'pick at least one session to merge')
    .max(50)
    .refine((a) => new Set(a).size === a.length, 'sourceIds must be unique'),
});

export const createSolveBody = z
  .object({
    // SPEC lists `id` as required; we accept a missing id and generate one (not idempotent then).
    id: uuid.optional(),
    sessionId: uuid,
    timeMs,
    penalty: penalty.default('OK'),
    scramble: scramble.default(''),
    comment: comment.nullish(),
    source: z.enum(SOLVE_SOURCES).optional(),
    createdAt: isoDateTime.optional(),
    daily: z.object({ date: ymd, index: z.number().int().min(0).max(4) }).optional(),
  })
  .refine((b) => b.source !== 'daily' || b.daily !== undefined, {
    message: 'daily solves need daily: {date, index}',
    path: ['daily'],
  });
export type CreateSolveBody = z.infer<typeof createSolveBody>;

export const patchSolveBody = z
  .object({ penalty: penalty.optional(), comment: comment.nullable().optional() })
  .refine((b) => b.penalty !== undefined || b.comment !== undefined, { message: 'nothing to update (penalty or comment)' });

export const importSolve = z.object({
  timeMs,
  penalty: penalty.default('OK'),
  scramble: scramble.default(''),
  comment: comment.nullish(),
  createdAt: isoDateTime,
});
export type ImportSolve = z.infer<typeof importSolve>;

export const importBody = z
  .object({
    sessions: z
      .array(z.object({ name: sessionName, event: eventId, solves: z.array(importSolve).max(MAX_IMPORT_SOLVES) }))
      .min(1)
      .max(MAX_IMPORT_SESSIONS),
  })
  .refine((b) => b.sessions.reduce((n, s) => n + s.solves.length, 0) <= MAX_IMPORT_SOLVES, {
    message: `at most ${MAX_IMPORT_SOLVES} solves per import`,
    path: ['sessions'],
  });
export type ImportBody = z.infer<typeof importBody>;

export const dailyQuery = z.object({ date: ymd.optional() });

export const internalParams = z.object({ userId: uuid });
export const internalQuery = z.object({ event: eventId.optional() });

function isRealDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** UTC calendar day 'YYYY-MM-DD', shifted by `offsetDays`. */
export function utcDay(now: number, offsetDays = 0): string {
  return new Date(now + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Resolves the solve timestamp: default now. A device whose clock runs fast must not lose its
 * solves (the web client drops a solve the server answered with 400), so anything more than
 * MAX_FUTURE_SKEW_MS ahead is clamped to the server time instead of being rejected.
 */
export function resolveCreatedAt(createdAt: string | undefined, now = Date.now()): Date {
  if (createdAt === undefined) return new Date(now);
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) throw badRequest('createdAt: not a valid timestamp');
  return new Date(t > now + MAX_FUTURE_SKEW_MS ? now : t);
}

/**
 * Daily-challenge attempts are only accepted for a day that is currently "today" somewhere on
 * Earth (UTC-12 … UTC+14): UTC yesterday, today or tomorrow. Older/future days are rejected so
 * the challenge board stays honest.
 */
export function assertDailyAllowed(date: string, event: string, now = Date.now()): void {
  const allowed = [utcDay(now, -1), utcDay(now, 0), utcDay(now, 1)];
  if (!allowed.includes(date)) throw badRequest('daily.date: daily challenge is only open for the current day');
  if (!DAILY_EVENTS.includes(event)) throw badRequest(`daily: event ${event} has no daily challenge`);
}
