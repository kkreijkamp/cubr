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
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

const ISSUER = 'cubetype';
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

export async function signToken(
  secret: string,
  user: { id: string; username: string },
  ttlSec = TOKEN_TTL_SEC,
): Promise<{ token: string; jti: string; exp: number }> {
  const jti = randomUUID();
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const token = await new SignJWT({ username: user.username })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key(secret));
  return { token, jti, exp };
}

export async function verifyToken(secret: string, token: string): Promise<AuthUser> {
  const { payload } = await jwtVerify(token, key(secret), { issuer: ISSUER, algorithms: ['HS256'] });
  if (!payload.sub || typeof payload.username !== 'string' || !payload.jti || !payload.exp) {
    throw new Error('malformed token');
  }
  return { id: payload.sub, username: payload.username, jti: payload.jti, exp: payload.exp };
}

export function revokedKey(jti: string): string {
  return `auth:revoked:${jti}`;
}

async function isRevoked(redis: Redis | undefined, jti: string): Promise<boolean> {
  if (!redis) return false;
  try {
    const hit = await Promise.race([
      redis.exists(revokedKey(jti)),
      new Promise<number>((resolve) => setTimeout(() => resolve(0), 300)),
    ]);
    return hit === 1;
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
      if (await isRevoked(redis, user.jti)) return null;
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
