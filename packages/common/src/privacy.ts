import type { Redis } from './redis.js';

// ---------------------------------------------------------------------------------------------
// Private profiles. The auth service owns the flag (auth.users.profile_private) and mirrors it into
// one Redis set, the same way it publishes token revocations; every service with a public per-user
// endpoint (stats, leaderboard ranks) asks the set before answering a stranger.
// ---------------------------------------------------------------------------------------------

/** SET of user ids whose profile is private (written by auth, read everywhere). */
export const PRIVATE_USERS_KEY = 'auth:private-users';

/**
 * Whether `userId`'s profile is private. Fails closed: when Redis can't answer within `timeoutMs`,
 * the profile counts as private, so an outage hides profiles instead of exposing private ones.
 */
export async function isPrivateProfile(redis: Redis, userId: string, timeoutMs = 500): Promise<boolean> {
  try {
    const hit = await Promise.race([
      redis.sismember(PRIVATE_USERS_KEY, userId.toLowerCase()),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return hit === null ? true : hit === 1;
  } catch {
    return true;
  }
}

/** May `viewerId` (null = signed out) see `userId`'s profile data? The owner always may. */
export async function canViewProfile(redis: Redis, viewerId: string | null | undefined, userId: string): Promise<boolean> {
  if (viewerId && viewerId.toLowerCase() === userId.toLowerCase()) return true;
  return !(await isPrivateProfile(redis, userId));
}
