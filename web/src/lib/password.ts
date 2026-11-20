// Passwords in the web app: the rule the auth service enforces, and where to change yours.

/** What's wrong with a new password, or null: the auth service's rule (8 to 128 characters). */
export function validatePassword(v: string): string | null {
  if (!v) return 'choose a password';
  if (v.length < 8) return 'at least 8 characters';
  if (v.length > 128) return 'at most 128 characters';
  return null;
}

/** The account page's fragment that opens the change-password dialog. */
export const CHANGE_PASSWORD_HASH = '#change-password';

/** Where to change your password. /.well-known/change-password redirects here (web/nginx), so
 *  password managers can send people straight to it. */
export const CHANGE_PASSWORD_URL = `/account${CHANGE_PASSWORD_HASH}`;
