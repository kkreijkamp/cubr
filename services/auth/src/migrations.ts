import type { Migration } from '@cubr/common';

/** auth schema (docs/SPEC.md section 7.1). Applied by migrate() at startup; statements are idempotent. */
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
  {
    id: '002_avatars',
    sql: `
      -- profile pictures: small pre-resized images (~20-40 KB) stored next to the account;
      -- users.avatar_version (a content hash) makes every picture URL unique -> cacheable forever
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS avatar_version text;
      CREATE TABLE IF NOT EXISTS auth.avatars (
        user_id      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
        content_type text NOT NULL CHECK (content_type IN ('image/webp', 'image/jpeg', 'image/png')),
        bytes        bytea NOT NULL,
        version      text NOT NULL,
        updated_at   timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: '003_password_resets',
    sql: `
      -- password-reset links: only the SHA-256 of the token is stored (a leaked table resets
      -- nothing); a row is deleted when used, and every row of the user goes with it
      CREATE TABLE IF NOT EXISTS auth.password_resets (
        token_hash bytea PRIMARY KEY,
        user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS password_resets_user ON auth.password_resets (user_id);
    `,
  },
  {
    id: '004_private_profiles',
    sql: `
      -- a private profile shows strangers only the username and picture; mirrored into the Redis set
      -- auth:private-users, which the services with public per-user endpoints read
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS profile_private boolean NOT NULL DEFAULT false;
    `,
  },
  {
    id: '005_supporters',
    sql: `
      -- Ko-fi supporters for the about page: one row per Ko-fi message (retries collapse), keeping
      -- only the public name, the kind of support and when; hidden lets the maintainer drop a name
      CREATE TABLE IF NOT EXISTS auth.supporters (
        message_id      text PRIMARY KEY,
        kind            text NOT NULL,
        name            text,
        is_public       boolean NOT NULL,
        is_subscription boolean NOT NULL DEFAULT false,
        tier            text,
        received_at     timestamptz NOT NULL,
        hidden          boolean NOT NULL DEFAULT false
      );
    `,
  },
  {
    id: '006_identities',
    sql: `
      -- Sign-in with Google, Apple or GitHub (routes/oauth.ts). An account made that way has no
      -- password until it sets one with a reset link.
      ALTER TABLE auth.users ALTER COLUMN password_hash DROP NOT NULL;
      -- one row per linked provider account; subject = the provider's stable user id
      CREATE TABLE IF NOT EXISTS auth.user_identities (
        provider     text NOT NULL CHECK (provider IN ('google', 'apple', 'github')),
        subject      text NOT NULL,
        user_id      uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
        email        text,
        created_at   timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz,
        PRIMARY KEY (provider, subject)
      );
      -- at most one account per provider per cubr user
      CREATE UNIQUE INDEX IF NOT EXISTS user_identities_user_provider ON auth.user_identities (user_id, provider);
    `,
  },
  {
    id: '007_email_changes',
    sql: `
      -- a change of email waiting for its confirmation link (emailChange.ts): only the SHA-256 of
      -- the token is stored; asking again replaces the user's pending change, confirming deletes it
      CREATE TABLE IF NOT EXISTS auth.email_changes (
        token_hash bytea PRIMARY KEY,
        user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        new_email  text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS email_changes_user ON auth.email_changes (user_id);
    `,
  },
  {
    id: '008_email_confirmation',
    sql: `
      -- Confirming the account's own email (routes/auth.ts): at sign-up the address gets a link (a row
      -- in auth.email_changes whose new_email is the current address). Password-reset links only go to
      -- a confirmed address, so an account made with a typo or with someone else's address can't be
      -- taken over by whoever reads that inbox.
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
      -- the accounts made before this keep getting reset links until they confirm: nobody is locked out
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS predates_email_confirmation boolean NOT NULL DEFAULT false;
      UPDATE auth.users SET predates_email_confirmation = true;
      -- an address Google, Apple or GitHub vouched for (a connected account with the same email) is
      -- confirmed already, from when it was connected
      UPDATE auth.users u SET email_verified_at = i.first_seen
        FROM (SELECT user_id, lower(email) AS email, min(created_at) AS first_seen
                FROM auth.user_identities WHERE email IS NOT NULL GROUP BY user_id, lower(email)) i
       WHERE i.user_id = u.id AND i.email = lower(u.email) AND u.email_verified_at IS NULL;
    `,
  },
];
