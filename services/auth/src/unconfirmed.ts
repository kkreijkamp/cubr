import type { PoolClient } from 'pg';
import { EMAIL_CONFIRM_TTL_DAYS } from './emailChange.js';

// ---------------------------------------------------------------------------------------------
// An address someone signed up with but never confirmed stops blocking its real owner once its
// confirmation link's 7 days are over (decided 2026-11-26): a sign-up, a sign-in with Google, Apple or
// GitHub, or a change of email can then take it. Until then it stayed taken for good, and only
// hello@cubr.dev could free it by hand. The account that had it keeps working (sign-in by username)
// with a placeholder address on the reserved .invalid domain, which no email ever goes to, until it
// adds another; the account page asks it to. Password-reset links never went to it anyway: they only
// go to a confirmed address.
// ---------------------------------------------------------------------------------------------

/** How long an unconfirmed address stays its account's: as long as the link that confirms it works. */
export const HOLD_DAYS = EMAIL_CONFIRM_TTL_DAYS;

/**
 * SQL, on `auth.users u`: the account's address still counts, so nobody else may take it. Confirmed,
 * from before confirmation existed, set in the last 7 days (the sign-up's link, even if its email
 * failed), or with a link that confirms it still open (a new one asked for since).
 */
export const HOLDS_EMAIL = `(u.email_verified_at is not null or u.predates_email_confirmation
    or u.created_at > now() - make_interval(days => ${HOLD_DAYS})
    or exists (select 1 from auth.email_changes c where c.user_id = u.id and lower(c.new_email) = lower(u.email) and c.expires_at > now()))`;

/** The address a freed account gets instead: one per account, on a domain that never receives mail (RFC 6761). */
export function releasedEmail(userId: string): string {
  return `released-${userId.toLowerCase()}@cubr.invalid`;
}

export function isReleasedEmail(email: string): boolean {
  return /^released-[0-9a-f-]{36}@cubr\.invalid$/i.test(email);
}

/**
 * Frees `email` from the account that has it (other than `exceptUserId`), if that account never
 * confirmed it in time. Returns the freed account's id; null when no account has the address, or the
 * one that has it still holds it. Runs inside the caller's transaction and locks that account's row,
 * so two sign-ups racing for the address can't both take it.
 */
export async function releaseUnconfirmed(c: PoolClient, email: string, exceptUserId?: string): Promise<string | null> {
  const { rows } = await c.query<{ id: string; holds: boolean }>(
    `select u.id, ${HOLDS_EMAIL} as holds from auth.users u where lower(u.email) = lower($1) and ($2::uuid is null or u.id <> $2::uuid) for update of u`,
    [email, exceptUserId ?? null],
  );
  const holder = rows[0];
  if (!holder || holder.holds) return null;
  await c.query('update auth.users set email = $2 where id = $1', [holder.id, releasedEmail(holder.id)]);
  return holder.id;
}
