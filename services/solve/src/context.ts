import type { FastifyRequest } from 'fastify';
import { unauthorized, type AuthUser, type BaseConfig, type Pool, makeAuth } from '@cubetype/common';

export interface RouteContext {
  config: BaseConfig;
  pool: Pool;
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

/** Postgres error helpers (SQLSTATE codes). */
export function pgCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}
export const FK_VIOLATION = '23503';
