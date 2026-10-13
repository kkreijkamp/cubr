import { z } from 'zod';

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
