import { timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import { forbidden } from './errors.js';

/** Header that carries INTERNAL_API_TOKEN on service-to-service calls. */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/** Constant-time check of a presented token against the expected one (never matches an empty token). */
export function internalTokenMatches(expected: string, presented: string | string[] | undefined): boolean {
  if (!expected || typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

let warnedOpen = false;

/**
 * preHandler for /internal/* routes: the caller must send `X-Internal-Token: <token>`, otherwise
 * 403 FORBIDDEN. With an empty token (local development) every call is allowed and a single
 * warning is logged at startup.
 */
export function requireInternal(token: string, log?: FastifyBaseLogger) {
  if (!token && log && !warnedOpen) {
    warnedOpen = true;
    log.warn('INTERNAL_API_TOKEN is not set: /internal routes accept calls without a token');
  }
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!token) return;
    if (!internalTokenMatches(token, req.headers[INTERNAL_TOKEN_HEADER])) throw forbidden();
  };
}

/** Headers for a call to another service's /internal routes (none when no token is configured). */
export function internalHeaders(token: string): Record<string, string> {
  return token ? { [INTERNAL_TOKEN_HEADER]: token } : {};
}
