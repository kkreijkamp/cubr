import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Pure domain helpers for the auth service: request schemas, row → API mapping, small parsers.
// Everything here is side-effect free so it can be unit-tested without Postgres/Redis.
// ---------------------------------------------------------------------------------------------

export const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
export const COUNTRY_RE = /^[A-Z]{2}$/;
export const WCA_ID_RE = /^\d{4}[A-Z]{4}\d{2}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Max serialized size of PUT /api/auth/me/settings `settings` (bytes of JSON). */
export const SETTINGS_MAX_BYTES = 16 * 1024;
/** Max ids accepted by GET /api/users?ids=… */
export const MAX_IDS = 100;

export const registerSchema = z.object({
  username: z.string().trim().regex(USERNAME_RE, 'must be 3–20 characters: letters, digits or _'),
  email: z.string().trim().max(254).email(),
  password: z.string().min(8).max(128),
});

export const loginSchema = z.object({
  login: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(128),
});

/** '' (or whitespace) means "clear" just like null, which is friendlier for HTML forms. */
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

export const patchMeSchema = z.object({
  displayName: z.preprocess(blankToNull, z.string().trim().max(40).nullable()).optional(),
  bio: z.preprocess(blankToNull, z.string().trim().max(280).nullable()).optional(),
  country: z
    .preprocess(blankToNull, z.string().trim().toUpperCase().regex(COUNTRY_RE, 'must be an ISO 3166-1 alpha-2 code').nullable())
    .optional(),
  wcaId: z
    .preprocess(blankToNull, z.string().trim().toUpperCase().regex(WCA_ID_RE, 'must look like 2015ABCD01').nullable())
    .optional(),
});
export type PatchMe = z.infer<typeof patchMeSchema>;

export const settingsSchema = z.object({
  settings: z.record(z.unknown()),
});

/** Size in bytes of the JSON encoding of `value` (what Postgres will store). */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

// ---- row mapping ------------------------------------------------------------------------------

export interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash?: string;
  display_name: string | null;
  bio: string | null;
  country: string | null;
  wca_id: string | null;
  created_at: Date | string;
  last_login_at?: Date | string | null;
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  country: string | null;
  wcaId: string | null;
  createdAt: string;
}
export interface PrivateUser extends PublicUser {
  email: string;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name ?? null,
    bio: row.bio ?? null,
    // char(2) is blank-padded by Postgres; trim defensively
    country: row.country ? row.country.trim() || null : null,
    wcaId: row.wca_id ?? null,
    createdAt: iso(row.created_at),
  };
}

export function toPrivateUser(row: UserRow): PrivateUser {
  return { ...toPublicUser(row), email: row.email };
}

/** Columns selected everywhere a user is returned (never includes password_hash). */
export const USER_COLUMNS = 'id, username, email, display_name, bio, country, wca_id, created_at, last_login_at';

/** Maps validated PATCH /me fields to SQL columns. Only fixed identifiers, values stay parameterised. */
export function buildUserUpdate(patch: PatchMe): { sets: string[]; values: unknown[] } {
  const columns: Record<keyof PatchMe, string> = {
    displayName: 'display_name',
    bio: 'bio',
    country: 'country',
    wcaId: 'wca_id',
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of Object.keys(columns) as (keyof PatchMe)[]) {
    if (patch[key] === undefined) continue;
    values.push(patch[key]);
    sets.push(`${columns[key]} = $${values.length}`);
  }
  return { sets, values };
}

/**
 * Parses `?ids=a,b,c`: trims, drops invalid uuids and duplicates (keeping first-seen order).
 * Returns null when more than MAX_IDS ids were supplied.
 */
export function parseIdList(raw: string | undefined): string[] | null {
  if (!raw) return [];
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length > MAX_IDS) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const id = p.toLowerCase();
    if (!UUID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Maps a Postgres unique-violation constraint name to the user-facing conflict message. */
export function conflictMessage(constraint: string | undefined): string {
  if (constraint === 'users_username_lower') return 'Username is already taken';
  if (constraint === 'users_email_lower') return 'Email is already registered';
  return 'Username or email already in use';
}

/** Payload of user.registered / user.updated events (SPEC §8, besides eventId/occurredAt). */
export function userEventData(user: PublicUser) {
  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    country: user.country,
    wcaId: user.wcaId,
    createdAt: user.createdAt,
  };
}
