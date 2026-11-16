import { timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------------------------
// Ko-fi supporters (pure, unit-tested). Ko-fi POSTs application/x-www-form-urlencoded with one
// `data` field holding the payment as JSON, retrying the same message_id until it gets a 200.
// cubr keeps only what the about page shows: the name when the supporter made their support
// public, the kind of support and when. Email, amount, message and payment ids are dropped.
// ---------------------------------------------------------------------------------------------

/** Longest name shown on the about page. */
export const SUPPORTER_NAME_MAX = 40;
/** Names listed at most. */
export const SUPPORTERS_LIST_MAX = 200;

export interface SupporterRecord {
  messageId: string;
  kind: string;
  /** null unless the supporter made it public (and gave a name) */
  name: string | null;
  isPublic: boolean;
  isSubscription: boolean;
  tier: string | null;
  receivedAt: string;
}

export interface KofiPayload {
  token: string;
  record: SupporterRecord;
}

/** Control, zero-width and bidi-override characters: dropped from names (no hidden or flipped text). */
function invisible(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x206f) || cp === 0xfeff;
}
function blank(cp: number): boolean {
  return cp === 0x20 || cp === 0xa0 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x3000;
}

/** Drops invisible characters, collapses whitespace, caps the length; '' -> null. */
export function cleanSupporterName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let out = '';
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    if (invisible(cp) && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) continue;
    out += blank(cp) || cp === 0x09 || cp === 0x0a || cp === 0x0d ? ' ' : ch;
  }
  const s = out.split(' ').filter(Boolean).join(' ');
  if (!s) return null;
  return [...s].slice(0, SUPPORTER_NAME_MAX).join('').trim();
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * Parses the `data` form field. Returns null when it isn't Ko-fi JSON with a verification token
 * and a message id; everything else is optional, and anything not marked public is anonymous.
 */
export function parseKofiData(data: unknown, now = new Date()): KofiPayload | null {
  if (typeof data !== 'string' || data.length > 64 * 1024) return null;
  let j: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    j = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const token = text(j.verification_token, 200);
  const messageId = text(j.message_id, 100);
  if (!token || !messageId) return null;
  const isPublic = j.is_public === true;
  const at = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : NaN;
  return {
    token,
    record: {
      messageId,
      kind: text(j.type, 40) ?? 'Tip',
      name: isPublic ? cleanSupporterName(j.from_name) : null,
      isPublic,
      isSubscription: j.is_subscription_payment === true || text(j.type, 40) === 'Subscription',
      tier: text(j.tier_name, 80),
      receivedAt: new Date(Number.isNaN(at) ? now.getTime() : at).toISOString(),
    },
  };
}

/** Constant-time comparison of the configured and the presented verification token. */
export function kofiTokenMatches(expected: string, presented: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}
