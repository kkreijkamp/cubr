import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { unauthorized } from './errors.js';

export interface AuthUser {
  id: string;
  username: string;
  jti: string;
  /** expiry, unix seconds */
  exp: number;
  /** issued at, unix seconds */
  iat?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

const ISSUER = 'cubr';
export const TOKEN_TTL_SEC = 30 * 24 * 3600;

const keyCache = new Map<string, Uint8Array>();
function key(secret: string): Uint8Array {
  let k = keyCache.get(secret);
  if (!k) {
    k = new TextEncoder().encode(secret);
    keyCache.set(secret, k);
  }
  return k;
}

/**
 * `issuedAt` (unix seconds, default now) lets a token outlive a per-user revocation stored in the
 * same second: a password reset revokes every older token and signs in with iat = revokedAt + 1.
 */
export async function signToken(
  secret: string,
  user: { id: string; username: string },
  ttlSec = TOKEN_TTL_SEC,
  issuedAt?: number,
): Promise<{ token: string; jti: string; exp: number }> {
  const jti = randomUUID();
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const token = await new SignJWT({ username: user.username })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setJti(jti)
    .setIssuedAt(issuedAt)
    .setExpirationTime(exp)
    .sign(key(secret));
  return { token, jti, exp };
}

export async function verifyToken(secret: string, token: string): Promise<AuthUser> {
  const { payload } = await jwtVerify(token, key(secret), { issuer: ISSUER, algorithms: ['HS256'] });
  if (!payload.sub || typeof payload.username !== 'string' || !payload.jti || !payload.exp) {
    throw new Error('malformed token');
  }
  return { id: payload.sub, username: payload.username, jti: payload.jti, exp: payload.exp, iat: payload.iat };
}

export function revokedKey(jti: string): string {
  return `auth:revoked:${jti}`;
}

/**
 * Every token of this user issued at or before the stored time (unix seconds) is revoked: set when
 * the account is deleted, for TOKEN_TTL_SEC (the longest a token lives).
 */
export function revokedUserKey(userId: string): string {
  return `auth:revoked-user:${userId}`;
}

/** Whether a token is revoked, given what Redis holds for its jti and for its user. */
export function tokenRevoked(user: Pick<AuthUser, 'iat'>, jtiHit: string | null, userRevokedAt: string | null): boolean {
  if (jtiHit !== null) return true;
  if (userRevokedAt === null) return false;
  // a token without iat predates this check: treat it as issued before the revocation
  return (user.iat ?? 0) <= Number(userRevokedAt);
}

async function isRevoked(redis: Redis | undefined, user: AuthUser): Promise<boolean> {
  if (!redis) return false;
  try {
    const hits = await Promise.race([
      redis.mget(revokedKey(user.jti), revokedUserKey(user.id)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
    ]);
    return hits ? tokenRevoked(user, hits[0] ?? null, hits[1] ?? null) : false;
  } catch {
    return false; // fail open: Redis outage must not log everyone out
  }
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

/**
 * Returns Fastify preHandlers: `requireAuth` (401 without a valid token) and `optionalAuth`
 * (sets req.user when a valid token is present, otherwise continues anonymously).
 */
export function makeAuth(secret: string, redis?: Redis) {
  async function resolve(req: FastifyRequest): Promise<AuthUser | null> {
    const token = bearer(req);
    if (!token) return null;
    try {
      const user = await verifyToken(secret, token);
      if (await isRevoked(redis, user)) return null;
      return user;
    } catch {
      return null;
    }
  }
  return {
    requireAuth: async (req: FastifyRequest, _reply: FastifyReply) => {
      const user = await resolve(req);
      if (!user) throw unauthorized();
      req.user = user;
    },
    optionalAuth: async (req: FastifyRequest, _reply: FastifyReply) => {
      const user = await resolve(req);
      if (user) req.user = user;
    },
    resolve,
  };
}
