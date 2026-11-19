import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { escapeHtml, page, type Email } from './mail.js';

// ---------------------------------------------------------------------------------------------
// Password reset: token helpers, request schemas and the email (pure, unit-tested). The routes are
// in routes/auth.ts, sending in mail.ts.
// ---------------------------------------------------------------------------------------------

/** How long a reset link works. */
export const RESET_TTL_MIN = 60;

/** 32 random bytes as base64url: 43 characters, no padding. */
export const RESET_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const forgotSchema = z.object({
  email: z.string().trim().max(254).email(),
});

export const resetSchema = z.object({
  token: z.string().regex(RESET_TOKEN_RE, 'invalid reset token'),
  // same rule as registerSchema
  password: z.string().min(8).max(128),
});

export function hashResetToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export function newResetToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashResetToken(token) };
}

/** The token goes in the fragment, which browsers never send: it stays out of access logs and Referer headers. */
export function resetLink(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/reset#${token}`;
}

/** The reset email, in plain text and HTML (mail.ts's page, like every account email). */
export function resetEmail(o: { username: string; link: string; minutes: number }): Email {
  const subject = 'Reset your cubr password';
  const text = [
    `Hi ${o.username},`,
    '',
    'Someone (hopefully you) asked to reset the password of your cubr account. Choose a new one here:',
    '',
    o.link,
    '',
    `The link works once and expires in ${o.minutes} minutes. If you didn't ask for it, ignore this email: your password stays the same.`,
    '',
    '- cubr',
  ].join('\n');
  const html = page({
    title: subject,
    paragraphs: [`Hi ${escapeHtml(o.username)},`, 'Someone (hopefully you) asked to reset the password of your cubr account.'],
    button: { label: 'choose a new password', href: o.link },
    footnote: `The link works once and expires in ${o.minutes} minutes. If you didn't ask for it, ignore this email: your password stays the same.`,
  });
  return { subject, text, html };
}
