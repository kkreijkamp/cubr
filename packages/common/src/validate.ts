import type { ZodType, ZodTypeDef } from 'zod';
import { badRequest } from './errors.js';

/** Parses `data` with a zod schema, throwing a 400 BAD_REQUEST HttpError on failure. */
export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
    throw badRequest(`${where}${issue.message}`);
  }
  return result.data;
}
