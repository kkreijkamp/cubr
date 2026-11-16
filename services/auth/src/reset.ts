import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

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

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The reset email: plain text plus a minimal HTML version in the default theme's colours. */
export function resetEmail(o: { username: string; link: string; minutes: number }): { subject: string; text: string; html: string } {
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
  const user = escapeHtml(o.username);
  const link = escapeHtml(o.link);
  const html = `<!doctype html>
<html><body style="margin:0;padding:32px 16px;background:#ffffff;color:#20201e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55">
<div style="max-width:480px;margin:0 auto">
<p style="font-size:20px;font-weight:600;margin:0 0 24px">cubr</p>
<p style="margin:0 0 16px">Hi ${user},</p>
<p style="margin:0 0 24px">Someone (hopefully you) asked to reset the password of your cubr account.</p>
<p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#00a04d;color:#ffffff;text-decoration:none;font-weight:600">choose a new password</a></p>
<p style="margin:0 0 16px;color:#77746b;font-size:13px">The link works once and expires in ${o.minutes} minutes. If you didn't ask for it, ignore this email: your password stays the same.</p>
<p style="margin:0;color:#77746b;font-size:13px;word-break:break-all">${link}</p>
</div>
</body></html>`;
  return { subject, text, html };
}
