import type { Migration } from '@cubetype/common';

/** auth schema (docs/SPEC.md §7.1). Applied by migrate() at startup; statements are idempotent. */
export const migrations: Migration[] = [
  {
    id: '001_init',
    sql: `
      CREATE TABLE IF NOT EXISTS auth.users (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        username      text NOT NULL,
        email         text NOT NULL,
        password_hash text NOT NULL,
        display_name  text,
        bio           text,
        country       char(2),
        wca_id        text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        last_login_at timestamptz
      );
      CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON auth.users (lower(username));
      CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON auth.users (lower(email));
      CREATE TABLE IF NOT EXISTS auth.user_settings (
        user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
        settings   jsonb NOT NULL DEFAULT '{}',
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
];
