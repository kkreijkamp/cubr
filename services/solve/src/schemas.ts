import { z } from 'zod';
import { badRequest } from '@cubetype/common';
import { isEventId } from '@cubetype/cubestats';

// Request validation (docs/SPEC.md §5 limits, §9.3 bodies). Route handlers call
// `parse(schema, req.body ?? {})` from common, which turns failures into 400 BAD_REQUEST.

export const MAX_TIME_MS = 86_400_000;
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

/** Sources a client may set; `source` is only a label (statistics treat every solve the same). */
export const SOLVE_SOURCES = ['timer', 'manual', 'race', 'import', 'seed'] as const;

export const idParams = z.object({ id: uuid });

export const createSessionBody = z.object({
  id: uuid.optional(),
  name: sessionName,
  event: eventId,
});

export const patchSessionBody = z.object({ name: sessionName });

export const createSolveBody = z.object({
  // SPEC lists `id` as required; we accept a missing id and generate one (not idempotent then).
  id: uuid.optional(),
  sessionId: uuid,
  timeMs,
  penalty: penalty.default('OK'),
  scramble: scramble.default(''),
  comment: comment.nullish(),
  source: z.enum(SOLVE_SOURCES).optional(),
  createdAt: isoDateTime.optional(),
});
export type CreateSolveBody = z.infer<typeof createSolveBody>;

export const patchSolveBody = z
  .object({ penalty: penalty.optional(), comment: comment.nullable().optional() })
  .refine((b) => b.penalty !== undefined || b.comment !== undefined, { message: 'nothing to update (penalty or comment)' });

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
