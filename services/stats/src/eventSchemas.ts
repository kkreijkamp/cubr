import { z } from 'zod';

/** Event payload schemas (SPEC §8). Lenient: unknown extra fields are ignored. */
const uuid = z.string().uuid();
const penalty = z.enum(['OK', '+2', 'DNF']);
const event = z.string().min(1).max(20);
const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp');
const optUsername = z.string().min(1).max(64).nullish();
const optTz = z.string().max(64).nullish();

export const CONSUMED_TYPES = [
  'user.registered',
  'user.updated',
  'solve.created',
] as const;

export const userEventSchema = z.object({
  eventId: z.string().min(1),
  userId: uuid,
  username: z.string().min(1).max(64),
  createdAt: isoDate.nullish(),
});

export const solveCreatedSchema = z.object({
  eventId: z.string().min(1),
  userId: uuid,
  username: optUsername,
  event,
  sessionId: uuid,
  solveId: uuid,
  timeMs: z.number().int().positive(),
  penalty,
  createdAt: isoDate,
  tz: optTz,
  rolling: z
    .object({ ao5: z.number().nullish(), ao12: z.number().nullish() })
    .partial()
    .nullish(),
});

export type UserEvent = z.infer<typeof userEventSchema>;
export type SolveCreated = z.infer<typeof solveCreatedSchema>;
