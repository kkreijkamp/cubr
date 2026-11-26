import { z } from 'zod';
import { badRequest } from '@cubr/common';

export const MAX_COUNT = 25;

/** GET /api/scrambles/:event?count=1..25&fresh=0|1&type=<scramble type> (the event's default when omitted) */
export const scrambleQuerySchema = z.object({
  count: z.coerce.number().int().min(1).max(MAX_COUNT).default(1),
  type: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,32}$/, 'type: a scramble type id')
    .optional(),
  fresh: z
    .enum(['0', '1', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});

/** GET /api/scrambles/:event/image?scramble=...&type=<scramble type> */
export const imageQuerySchema = z.object({
  scramble: z.string().trim().min(1, 'scramble: required').max(2000),
  type: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,32}$/, 'type: a scramble type id')
    .optional(),
});

/** GET /api/scrambles/daily?date=YYYY-MM-DD */
export const dailyQuerySchema = z.object({ date: z.string().optional() });

/** Days in the past (besides today) whose daily challenge can still be requested. */
export const DAILY_HISTORY_DAYS = 30;
const DAY_MS = 86_400_000;

export const todayUtc = (now: Date = new Date()) => now.toISOString().slice(0, 10);

/**
 * Validates the `date` query parameter: defaults to today (UTC); must be a real calendar date
 * between DAILY_HISTORY_DAYS days ago and today. Throws 400 BAD_REQUEST otherwise.
 */
export function resolveDailyDate(input: string | undefined, now: Date = new Date()): string {
  const today = todayUtc(now);
  if (input === undefined || input === '') return today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) throw badRequest('date: expected format YYYY-MM-DD');
  const ms = Date.parse(`${input}T00:00:00Z`);
  // Date.parse accepts e.g. 2026-02-30 on some engines -> round-trip to reject impossible dates
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== input) {
    throw badRequest('date: not a valid calendar date');
  }
  const daysAgo = Math.round((Date.parse(`${today}T00:00:00Z`) - ms) / DAY_MS);
  if (daysAgo < 0) throw badRequest('date: cannot be in the future');
  if (daysAgo > DAILY_HISTORY_DAYS) throw badRequest(`date: must be within the last ${DAILY_HISTORY_DAYS} days`);
  return input;
}
