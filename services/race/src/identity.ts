import { createHmac } from 'node:crypto';
import { isTokenRevoked, verifyToken, type Redis } from '@cubr/common';
import { defaultGuestName, randomId, sanitizeGuestId, sanitizeName } from './sanitize.js';
import type { Identity } from './types.js';

/** A guest's secret key: kept by its browser only (web/src/lib/race.ts), sent in the handshake. */
export const GUEST_KEY_RE = /^[a-z0-9]{24,64}$/;

/**
 * A guest's public id, from the secret key only its browser holds: an HMAC, so seeing the id (every
 * member of a room does: players, results, chat) doesn't let anyone else play as that guest (the October
 * review's #12). The "gst-" prefix can't be claimed through the old handshake field below.
 */
export function guestIdFor(key: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(`race-guest:${key}`).digest();
  return `gst-${BigInt(`0x${mac.subarray(0, 8).toString('hex')}`).toString(36).padStart(12, '0').slice(-12)}`;
}

/**
 * Socket handshake `auth: {token?, name?, guestKey?}` -> who is playing.
 * - valid JWT that wasn't revoked (by logout, or for the whole account by a password reset or the
 *   account's deletion: the same check as every HTTP route): playerId = userId, name = username
 * - otherwise a guest: playerId = guestIdFor(guestKey), the same on every refresh or reconnect (to any
 *   pod) of that browser; name = sanitised nickname or "guest-xxxx".
 * - The previous release's tabs send `guestId`, the id itself: still accepted in its old "guest-" form,
 *   until the release after this one (remove it then). Anyone else gets a fresh id nobody can claim.
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
  const key = typeof a.guestKey === 'string' && GUEST_KEY_RE.test(a.guestKey) ? a.guestKey : null;
  const guestId = key ? guestIdFor(key, jwtSecret) : (sanitizeGuestId(a.guestId) ?? guestIdFor(randomId(32), jwtSecret));
  return { playerId: guestId, name: sanitizeName(a.name, defaultGuestName(guestId)), userId: null, guest: true };
}
