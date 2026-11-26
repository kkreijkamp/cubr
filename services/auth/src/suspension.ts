import type { Pool, PoolClient } from 'pg';

// ---------------------------------------------------------------------------------------------
// A moderator can suspend an account (routes/moderation.ts, decided 2026-11-26): every session ends,
// the profile turns private, and nothing signs in while it lasts (a password, a reset link, Google,
// Apple or GitHub); the account's times stay. Lifting it lets the account sign in again.
// ---------------------------------------------------------------------------------------------

/** What a suspended account is told when it tries to sign in. */
export const SUSPENDED_MESSAGE = 'This account is suspended. Questions: hello@cubr.dev';

export async function isSuspended(db: Pool | PoolClient, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ suspended: boolean }>('select suspended_at is not null as suspended from auth.users where id = $1', [userId]);
  return rows[0]?.suspended === true;
}
