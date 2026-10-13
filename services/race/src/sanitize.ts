import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Random string over [a-z0-9] from crypto bytes (rejection sampling avoids modulo bias). */
export function randomId(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b >= 252) continue; // 252 = 7 * 36: keep only bytes that map uniformly
      out += ALPHABET[b % 36];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Short, url-safe room id, e.g. "k3x9q2ab". */
export const newRoomId = (): string => randomId(8);

export const ROOM_ID_RE = /^[a-z0-9]{4,32}$/;
export const GUEST_ID_RE = /^guest-[a-z0-9]{6,24}$/;

export const generateGuestId = (): string => `guest-${randomId(10)}`;

/** Returns the guest id if it is well-formed, otherwise null (callers then generate a new one). */
export function sanitizeGuestId(raw: unknown): string | null {
  return typeof raw === 'string' && GUEST_ID_RE.test(raw) ? raw : null;
}

/**
 * Normalises free text typed by users: drops control and invisible formatting characters
 * (zero-width spaces, bidi overrides), collapses whitespace runs to one space, trims, and caps
 * the length in code points (so emoji are never cut in half).
 */
export function sanitizeText(raw: string, maxChars: number): string {
  const cleaned = raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return Array.from(cleaned).slice(0, maxChars).join('').trim();
}

/** Guest nickname: 1–20 visible characters, otherwise `fallback`. */
export function sanitizeName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const name = sanitizeText(raw, 20);
  return name.length > 0 ? name : fallback;
}

/** Default display name for a guest: "guest-" + the last 4 characters of the guest id. */
export function defaultGuestName(guestId: string): string {
  return `guest-${guestId.slice(-4)}`;
}
