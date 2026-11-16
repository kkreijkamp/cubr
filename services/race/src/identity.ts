import { isTokenRevoked, verifyToken, type Redis } from '@cubr/common';
import { defaultGuestName, generateGuestId, sanitizeGuestId, sanitizeName } from './sanitize.js';
import type { Identity } from './types.js';

/**
 * Socket handshake `auth: {token?, name?, guestId?}` -> who is playing.
 * - valid JWT that wasn't revoked (by logout, or for the whole account by a password reset or the
 *   account's deletion: the same check as every HTTP route): playerId = userId, name = username
 * - otherwise a guest: playerId = the client's stored guestId if well-formed (so a refresh or a
 *   reconnect to a different pod keeps the same identity), else a fresh `guest-<random>`;
 *   name = sanitised nickname or "guest-xxxx".
 */
export async function resolveIdentity(auth: unknown, jwtSecret: string, redis: Redis): Promise<Identity> {
  const a = (auth && typeof auth === 'object' ? auth : {}) as Record<string, unknown>;
  if (typeof a.token === 'string' && a.token.length > 0 && a.token.length < 4096) {
    try {
      const user = await verifyToken(jwtSecret, a.token);
      if (!(await isTokenRevoked(redis, user))) {
        return { playerId: user.id, name: user.username, userId: user.id, guest: false };
      }
    } catch {
      // invalid/expired token -> continue as guest
    }
  }
  const guestId = sanitizeGuestId(a.guestId) ?? generateGuestId();
  return { playerId: guestId, name: sanitizeName(a.name, defaultGuestName(guestId)), userId: null, guest: true };
}
