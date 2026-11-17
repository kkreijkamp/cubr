import { z } from 'zod';
import { maskEmail } from './mail.js';
import { RESET_TOKEN_RE } from './reset.js';

// ---------------------------------------------------------------------------------------------
// Changing the email address: schemas, the link and the two emails (pure, unit-tested). The new
// address gets a link and only takes over once it's opened (proof it's yours, and no typos); the
// old one is told afterwards. The routes are in routes/auth.ts; tokens are the reset links' kind
// (reset.ts: 32 random bytes, only the SHA-256 stored).
// ---------------------------------------------------------------------------------------------

/** How long a confirmation link works. */
export const EMAIL_CHANGE_TTL_MIN = 60;

/** An account without a password (made with Google, Apple or GitHub) proves it's you by a sign-in this recent. */
export const FRESH_SIGN_IN_SEC = 10 * 60;

export const changeEmailSchema = z.object({
  email: z.string().trim().max(254).email(),
  /** the current password; required when the account has one */
  password: z.string().min(1).max(128).optional(),
});

export const confirmEmailSchema = z.object({
  token: z.string().regex(RESET_TOKEN_RE, 'invalid link'),
});

/** Whether a token issued at `iat` (seconds) is a recent enough sign-in to stand in for a password. */
export function isFreshSignIn(iat: number | undefined, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return iat !== undefined && nowSec - iat <= FRESH_SIGN_IN_SEC && iat <= nowSec + 60;
}

/** The token goes in the fragment, which browsers never send: it stays out of access logs and Referer headers. */
export function confirmEmailLink(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/confirm-email#${token}`;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type Email = { subject: string; text: string; html: string };

/** The minimal HTML around a message, in the default theme's colours (as the reset email). */
function page(paragraphs: string[], button?: { label: string; href: string }, footnote?: string, link?: string): string {
  const ps = paragraphs.map((p) => `<p style="margin:0 0 16px">${p}</p>`).join('\n');
  const btn = button
    ? `<p style="margin:8px 0 24px"><a href="${button.href}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#00a04d;color:#ffffff;text-decoration:none;font-weight:600">${button.label}</a></p>`
    : '';
  const foot = footnote ? `<p style="margin:0 0 16px;color:#77746b;font-size:13px">${footnote}</p>` : '';
  const raw = link ? `<p style="margin:0;color:#77746b;font-size:13px;word-break:break-all">${link}</p>` : '';
  return `<!doctype html>
<html><body style="margin:0;padding:32px 16px;background:#ffffff;color:#1d2024;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55">
<div style="max-width:480px;margin:0 auto">
<p style="font-size:20px;font-weight:600;margin:0 0 24px">cubr</p>
${ps}
${btn}
${foot}
${raw}
</div>
</body></html>`;
}

/** To the new address: the link that makes it the account's email. */
export function confirmEmailMessage(o: { username: string; link: string; minutes: number }): Email {
  const subject = 'Confirm your new cubr email';
  const text = [
    `Hi ${o.username},`,
    '',
    'Someone (hopefully you) asked to use this address for your cubr account. Confirm it here:',
    '',
    o.link,
    '',
    `The link works once and expires in ${o.minutes} minutes. Until then, the account keeps its old email. If you didn't ask for this, ignore this email.`,
    '',
    '- cubr',
  ].join('\n');
  const link = escapeHtml(o.link);
  const html = page(
    [`Hi ${escapeHtml(o.username)},`, 'Someone (hopefully you) asked to use this address for your cubr account.'],
    { label: 'confirm this email', href: link },
    `The link works once and expires in ${o.minutes} minutes. Until then, the account keeps its old email. If you didn't ask for this, ignore this email.`,
    link,
  );
  return { subject, text, html };
}

/** To the old address, once the change is done: a heads-up, in case it wasn't the owner. */
export function emailChangedNotice(o: { username: string; newEmail: string }): Email {
  const subject = 'Your cubr email was changed';
  // masked: whoever reads the old inbox learns no more than they need to recognise it
  const masked = maskEmail(o.newEmail);
  const text = [
    `Hi ${o.username},`,
    '',
    `The email of your cubr account is now ${masked}. Sign-in and password-reset emails go there from now on.`,
    '',
    "If you didn't do this, reply to this email and we'll help you get the account back.",
    '',
    '- cubr',
  ].join('\n');
  const html = page([
    `Hi ${escapeHtml(o.username)},`,
    `The email of your cubr account is now <b>${escapeHtml(masked)}</b>. Sign-in and password-reset emails go there from now on.`,
    "If you didn't do this, reply to this email and we'll help you get the account back.",
  ]);
  return { subject, text, html };
}
