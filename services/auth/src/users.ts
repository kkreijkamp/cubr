import { z } from 'zod';
import { isReleasedEmail } from './unconfirmed.js';

// ---------------------------------------------------------------------------------------------
// Pure domain helpers for the auth service: request schemas, row -> API mapping, small parsers.
// Everything here is side-effect free so it can be unit-tested without Postgres/Redis.
// ---------------------------------------------------------------------------------------------

export const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
export const COUNTRY_RE = /^[A-Z]{2}$/;
export const WCA_ID_RE = /^\d{4}[A-Z]{4}\d{2}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Max serialized size of PUT /api/auth/me/settings `settings` (bytes of JSON). */
export const SETTINGS_MAX_BYTES = 16 * 1024;
/** Max ids accepted by GET /api/users?ids=... */
export const MAX_IDS = 100;

export const registerSchema = z.object({
  username: z.string().trim().regex(USERNAME_RE, 'must be 3-20 characters: letters, digits or _'),
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
  /** private profile: strangers see only the username and picture */
  private: z.boolean().optional(),
});
export type PatchMe = z.infer<typeof patchMeSchema>;

/** DELETE /api/auth/me: the password again, so a stolen token alone cannot delete the account. */
export const deleteMeSchema = z
  .object({
    password: z.string().min(1).max(128).optional(),
    /** an account without a password (made with Google, Apple or GitHub) types its username instead */
    confirm: z.string().trim().min(1).max(40).optional(),
  })
  .refine((b) => b.password !== undefined || b.confirm !== undefined, { message: 'password: required' });

export const settingsSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
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
  /** short content hash of the current profile picture (null = none); part of the avatar URL */
  avatar_version?: string | null;
  profile_private?: boolean | null;
  /** false for an account made with Google, Apple or GitHub that hasn't set a password */
  has_password?: boolean;
  /** the email was confirmed by a link sent to it (or vouched for by Google, Apple or GitHub) */
  email_verified?: boolean;
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  country: string | null;
  wcaId: string | null;
  /** null when the profile is private and the viewer isn't its owner */
  createdAt: string | null;
  /** same-origin, immutable (versioned) URL of the profile picture, or null */
  avatarUrl: string | null;
  /** a private profile: strangers get only id, username and picture (everything else null) */
  private: boolean;
}
export interface PrivateUser extends PublicUser {
  email: string;
  /** the account can sign in with a password (false: only with Google, Apple or GitHub) */
  hasPassword: boolean;
  /** the email is confirmed (a link sent to it was opened, or a provider vouched for it) */
  emailVerified: boolean;
  /** the account never confirmed its address in time and another account took it: it has none (unconfirmed.ts) */
  emailReleased?: true;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

/**
 * The user as `viewerId` may see them (no viewer = a stranger, also what user.* events carry): a
 * private profile shows anyone but its owner only the username and picture.
 */
export function toPublicUser(row: UserRow, viewerId?: string | null): PublicUser {
  const isPrivate = row.profile_private === true;
  if (isPrivate && viewerId?.toLowerCase() !== row.id.toLowerCase()) {
    return {
      id: row.id,
      username: row.username,
      displayName: null,
      bio: null,
      country: null,
      wcaId: null,
      createdAt: null,
      avatarUrl: avatarUrl(row.id, row.avatar_version),
      private: true,
    };
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name ?? null,
    bio: row.bio ?? null,
    // char(2) is blank-padded by Postgres; trim defensively
    country: row.country ? row.country.trim() || null : null,
    wcaId: row.wca_id ?? null,
    createdAt: iso(row.created_at),
    avatarUrl: avatarUrl(row.id, row.avatar_version),
    private: isPrivate,
  };
}

/** Versioned avatar URL: a new picture gets a new URL, so the old one can be cached forever. */
export function avatarUrl(userId: string, version: string | null | undefined): string | null {
  return version ? `/api/users/${userId}/avatar?v=${version}` : null;
}

/** The owner's own view: everything, plus the email, whether it's confirmed and whether there's a password. */
export function toPrivateUser(row: UserRow): PrivateUser {
  return {
    ...toPublicUser(row, row.id),
    email: row.email,
    hasPassword: row.has_password !== false,
    emailVerified: row.email_verified === true,
    // its address was never confirmed and another account took it (unconfirmed.ts): it has none
    ...(isReleasedEmail(row.email) && { emailReleased: true }),
  };
}

/** Columns selected everywhere a user is returned (never includes password_hash). */
export const USER_COLUMNS =
  'id, username, email, display_name, bio, country, wca_id, created_at, last_login_at, avatar_version, profile_private, password_hash is not null as has_password, email_verified_at is not null as email_verified';

/** Maps validated PATCH /me fields to SQL columns. Only fixed identifiers, values stay parameterised. */
export function buildUserUpdate(patch: PatchMe): { sets: string[]; values: unknown[] } {
  const columns: Record<keyof PatchMe, string> = {
    displayName: 'display_name',
    bio: 'bio',
    country: 'country',
    wcaId: 'wca_id',
    private: 'profile_private',
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

/**
 * Payload of user.registered / user.updated events (SPEC section 8, besides eventId/occurredAt).
 * Pass the stranger's view (toPublicUser(row) without a viewer): a private profile then publishes
 * no country or WCA id, so read models such as the leaderboards' display info drop them too.
 */
export function userEventData(user: PublicUser) {
  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    country: user.country,
    wcaId: user.wcaId,
    createdAt: user.createdAt,
    avatarUrl: user.avatarUrl,
  };
}

// ---- profile pictures --------------------------------------------------------------------------
// The browser crops and resizes to a small square image before uploading; the server never decodes
// images (no native image libraries) - it only checks the declared type against the file's magic
// bytes and enforces a size cap, then serves the bytes back with a fixed, safe Content-Type.

export const AVATAR_MAX_BYTES = 300 * 1024;
export const AVATAR_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const;
export type AvatarType = (typeof AVATAR_TYPES)[number];

/** Detects PNG / JPEG / WebP from the first bytes of a file (null = anything else). */
export function sniffImageType(buf: Buffer): AvatarType | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** 'image/webp; charset=x' -> 'image/webp' */
export function baseContentType(header: string | undefined): string {
  return (header ?? '').split(';')[0].trim().toLowerCase();
}
