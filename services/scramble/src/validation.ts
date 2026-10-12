import { z } from 'zod';

export const MAX_COUNT = 25;

/** GET /api/scrambles/:event?count=1..25 */
export const scrambleQuerySchema = z.object({
  count: z.coerce.number().int().min(1).max(MAX_COUNT).default(1),
});
