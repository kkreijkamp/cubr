import { z } from 'zod';
import { escapeHtml, page, type Email } from './emailChange.js';

// ---------------------------------------------------------------------------------------------
// Changing the password while signed in (POST /api/auth/me/password): the request schema and the
// notice to the account's email (pure, unit-tested). The route is in routes/auth.ts. Proof it's you:
// the current password. An account without one (made with Google, Apple or GitHub) sets its first
// one instead, after a recent sign-in (emailChange.ts, FRESH_SIGN_IN_SEC), as for changing the email.
// ---------------------------------------------------------------------------------------------

export const changePasswordSchema = z.object({
  /** the current password; required when the account has one */
  password: z.string().min(1).max(128).optional(),
  // same rule as registerSchema
  newPassword: z.string().min(8).max(128),
});

/**
 * To the account's email once it's done (`first`: an account without a password set one): a
 * heads-up, in case it wasn't the owner, with the way back (a reset link from the sign-in page).
 */
export function passwordChangedNotice(o: { username: string; first: boolean; signInUrl: string }): Email {
  const subject = o.first ? 'Your cubr account has a password now' : 'Your cubr password was changed';
  const what = o.first
    ? 'Your cubr account now has a password, so you can also sign in with your username or email. Every other device was signed out.'
    : 'The password of your cubr account was changed, and every other device was signed out.';
  const back = `If you didn't do this, choose a new password with "forgot password?" on the sign-in page (${o.signInUrl}), or reply to this email and we'll help you get the account back.`;
  const text = [`Hi ${o.username},`, '', what, '', back, '', '- cubr'].join('\n');
  const html = page([`Hi ${escapeHtml(o.username)},`, escapeHtml(what), escapeHtml(back)]);
  return { subject, text, html };
}

/** Where the notice's "sign-in page" is: the login page of the site the emails' links point to. */
export function signInUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/login`;
}
