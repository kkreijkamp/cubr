import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Pure domain helpers for the auth service: request schemas and row → API mapping.
// Everything here is side-effect free so it can be unit-tested without Postgres.
// ---------------------------------------------------------------------------------------------

export const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const registerSchema = z.object({
  username: z.string().trim().regex(USERNAME_RE, 'must be 3–20 characters: letters, digits or _'),
  email: z.string().trim().max(254).email(),
  password: z.string().min(8).max(128),
});

export const loginSchema = z.object({
  login: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(128),
});

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

/** Maps a Postgres unique-violation constraint name to the user-facing conflict message. */
export function conflictMessage(constraint: string | undefined): string {
  if (constraint === 'users_username_lower') return 'Username is already taken';
  if (constraint === 'users_email_lower') return 'Email is already registered';
  return 'Username or email already in use';
}
