import { z } from 'zod';

/** WCA ids look like 2009ZEMD01: year of first competition, 4 letters, 2 digits. */
export const WCA_ID_RE = /^\d{4}[A-Z]{4}\d{2}$/;

const event = z.string().trim().min(1, 'event is required').max(20);
const kind = z.enum(['single', 'average']).default('single');

export const rankQuery = z.object({
  event,
  kind,
  // unit-specific limits (integer ms vs. moves) are checked once the event is known
  value: z.coerce.number({ invalid_type_error: 'value must be a number' }).finite(),
  // ISO 3166-1 alpha-2 ("AU") or a WCA country id ("Australia", "USA")
  country: z.string().trim().min(2).max(60).optional(),
});
export type RankQuery = z.infer<typeof rankQuery>;

export const distributionQuery = z.object({
  event,
  kind,
  buckets: z.coerce.number().int().min(1).max(600).default(50),
});
export type DistributionQuery = z.infer<typeof distributionQuery>;

export const personSearchQuery = z.object({
  q: z.string().trim().min(1, 'q is required').max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type PersonSearchQuery = z.infer<typeof personSearchQuery>;

export const personParams = z.object({
  wcaId: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(WCA_ID_RE, 'wcaId must look like 2009ZEMD01')),
});

/** Escapes LIKE wildcards so user input is matched literally (default escape char is \). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
