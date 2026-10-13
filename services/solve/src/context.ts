import type { FastifyRequest } from 'fastify';
import { isValidTimeZone, unauthorized, type AuthUser, type BaseConfig, type Pool, type Redis, makeAuth } from '@cubetype/common';

export interface RouteContext {
  config: BaseConfig;
  pool: Pool;
  redis: Redis;
  auth: ReturnType<typeof makeAuth>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The authenticated user (routes register `requireAuth` as an onRequest hook). The token's
 * `sub` must be a UUID because it is bound to uuid columns; ids are compared lower-case.
 */
export function currentUser(req: FastifyRequest): AuthUser {
  const user = req.user;
  if (!user || !UUID_RE.test(user.id)) throw unauthorized();
  return { ...user, id: user.id.toLowerCase() };
}

/** IANA timezone from the `X-Timezone` header (SPEC §5), copied into events as `tz`. */
export function tzFrom(req: FastifyRequest): string {
  const raw = req.headers['x-timezone'];
  const tz = Array.isArray(raw) ? raw[0] : raw;
  return tz && tz.length <= 64 && isValidTimeZone(tz) ? tz : 'UTC';
}

/** Postgres error helpers (SQLSTATE codes). */
export function pgCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}
export function pgConstraint(err: unknown): string | undefined {
  return (err as { constraint?: string } | null)?.constraint;
}
export const UNIQUE_VIOLATION = '23505';
export const FK_VIOLATION = '23503';
