import { z } from 'zod';

export const MAX_COUNT = 25;

/** GET /api/scrambles/:event?count=1..25&fresh=0|1 */
export const scrambleQuerySchema = z.object({
  count: z.coerce.number().int().min(1).max(MAX_COUNT).default(1),
  fresh: z
    .enum(['0', '1', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});
