import { z } from 'zod';

/** Event payload schemas (SPEC section 8). Lenient: unknown extra fields are ignored. */
const uuid = z.guid(); // any 8-4-4-4-12 hex id, as zod 3's .uuid() took
const penalty = z.enum(['OK', '+2', 'DNF']);
const event = z.string().min(1).max(20);
const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp');
const optUsername = z.string().min(1).max(64).nullish();
const optTz = z.string().max(64).nullish();

export const CONSUMED_TYPES = [
  'user.registered',
  'user.updated',
  'solve.created',
  'solve.updated',
  'solve.deleted',
  'session.deleted',
  'session.renamed',
  'session.updated',
  'sessions.merged',
  'solves.imported',
  'user.deleted',
] as const;

export const userEventSchema = z.object({
  eventId: z.string().min(1),
  userId: uuid,
  username: z.string().min(1).max(64),
  createdAt: isoDate.nullish(),
});

export const userDeletedSchema = z.object({
  eventId: z.string().min(1),
  userId: uuid,
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
  rolling: z.object({ ao5: z.number().nullish(), ao12: z.number().nullish() }).partial().nullish(),
  sessionName: z.string().max(200).nullish(),
  /** a practice session's solve: counted, but never a PB */
  practice: z.boolean().nullish(),
});

/** solve.updated / solve.deleted: only the routing fields are needed (they trigger a recompute). */
export const solveChangedSchema = z.object({
  eventId: z.string().min(1),
  userId: uuid,
  username: optUsername,
  event,
  sessionId: uuid.nullish(),
  solveId: uuid,
  timeMs: z.number().int().nullish(),
  penalty: penalty.nullish(),
  createdAt: isoDate.nullish(),
  tz: optTz,
});

export const sessionDeletedSchema = z.object({
  eventId: z.string().min(1),
  userId: uuid,
  username: optUsername,
  sessionId: uuid,
  event,
  tz: optTz,
});

export const sessionRenamedSchema = z.object({
  eventId: z.string().min(1),
  userId: uuid,
  username: optUsername,
  sessionId: uuid,
  event,
  name: z.string().min(1).max(200),
});

/** session.updated: the session was marked as practice, or no longer is (its event is recomputed). */
export const sessionUpdatedSchema = z.object({
  eventId: z.string().min(1),
  userId: uuid,
  username: optUsername,
  sessionId: uuid,
  event,
  name: z.string().min(1).max(200),
  practice: z.boolean(),
  tz: optTz,
});

/** sessions.merged: solves of sourceIds moved into targetId, sources deleted. */
export const sessionsMergedSchema = z.object({
  eventId: z.string().min(1),
  userId: uuid,
  username: optUsername,
  event,
  targetId: uuid,
  sourceIds: z.array(uuid).min(1),
  tz: optTz,
});

/** Response of solve-service GET /internal/users/:id/sessions */
export const sessionListSchema = z.object({
  sessions: z.array(z.object({ id: uuid, name: z.string(), event, practice: z.boolean().optional() })),
});

export const solvesImportedSchema = z.object({
  eventId: z.string().min(1),
  userId: uuid,
  username: optUsername,
  events: z.array(event).nullish(),
  count: z.number().nullish(),
  tz: optTz,
});

export type UserEvent = z.infer<typeof userEventSchema>;
export type SolveCreated = z.infer<typeof solveCreatedSchema>;
export type SolveChanged = z.infer<typeof solveChangedSchema>;
export type SessionDeleted = z.infer<typeof sessionDeletedSchema>;
export type SessionRenamed = z.infer<typeof sessionRenamedSchema>;
export type SolvesImported = z.infer<typeof solvesImportedSchema>;

/** Response of solve-service GET /internal/users/:id/solves?event= */
export const solveListSchema = z.object({
  solves: z.array(
    z.object({
      id: uuid,
      sessionId: uuid,
      timeMs: z.number().int().positive(),
      penalty,
      createdAt: isoDate,
      practice: z.boolean().optional(),
    }),
  ),
});
