import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';

// ---------------------------------------------------------------------------------------------
// Outgoing email: the page every account email shares, and sending it through Resend's HTTPS API
// (no SDK, no SMTP: GCP blocks port 25 anyway). Every email comes from "cubr <no-reply@cubr.dev>",
// with replies going to hello@cubr.dev (the feedback form's, to hello@cubr.dev, are answered to the
// sender), in plain text and in HTML.
// Without RESEND_API_KEY (local stack, CI) nothing is sent: the message is logged instead, so the
// password-reset and email-confirmation flows can be tried by reading the link from
// `docker compose logs auth`. scripts/test-email.ts sends a real one to any address (mail-tester.com).
// ---------------------------------------------------------------------------------------------

export interface MailConfig {
  apiKey: string;
  from: string;
  replyTo: string;
  /** where links in emails point, e.g. https://cubr.dev */
  publicUrl: string;
}

export function loadMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig {
  return {
    apiKey: env.RESEND_API_KEY ?? '',
    from: env.MAIL_FROM || 'cubr <no-reply@cubr.dev>',
    replyTo: env.MAIL_REPLY_TO || 'hello@cubr.dev',
    publicUrl: env.PUBLIC_URL || 'https://cubr.dev',
  };
}

/** What an email says: the subject, the plain-text version and the HTML one (mail apps show one of them). */
export interface Email {
  subject: string;
  text: string;
  html: string;
}

export interface Mail extends Email {
  to: string;
  /** where replies go instead of MAIL_REPLY_TO: the feedback form's emails go to cubr's inbox, answered to the sender */
  replyTo?: string;
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * The emails' colours: white cross, the default theme, and white cross dark for mail apps in dark mode
 * (web/src/lib/themes.ts; test/mail.test.ts checks they still match). The small print in light mode
 * is darker than white cross's labels (#959aa1, too faint at 13 px): the same cool grey at 5:1, as
 * WCAG asks of small text.
 */
export const EMAIL_COLOURS = {
  light: { bg: '#ffffff', text: '#1d2024', small: '#6b6f74' },
  dark: { bg: '#1d2024', text: '#f1f3f5', small: '#868c94' },
  green: '#00a04d',
} as const;

export interface PageContent {
  /** the subject, which is also the page's title */
  title: string;
  /** the message, one paragraph each, as HTML (escape what goes in them) */
  paragraphs: string[];
  /** the action, as a green button; its address is printed under the small print too, for mail apps where the button won't work */
  button?: { label: string; href: string };
  /** the small print, as HTML */
  footnote?: string;
}

/**
 * The HTML version of an account email: the "cubr" wordmark, the message, a button and the small print,
 * at most 480 px wide. Styles are inline, which every mail app keeps; the <style> block only adds dark
 * mode for the apps that read it (Apple Mail; Gmail ignores it and keeps the light colours, or
 * darkens them itself).
 */
export function page({ title, paragraphs, button, footnote }: PageContent): string {
  const { light, dark, green } = EMAIL_COLOURS;
  const small = `color:${light.small};font-size:13px`;
  const parts = [`<p style="margin:0 0 24px;font-size:20px;font-weight:600">cubr</p>`, ...paragraphs.map((p) => `<p style="margin:0 0 16px">${p}</p>`)];
  const href = button ? escapeHtml(button.href) : '';
  if (button) {
    parts.push(
      `<p style="margin:8px 0 24px"><a href="${href}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:${green};color:#ffffff;text-decoration:none;font-weight:600">${escapeHtml(button.label)}</a></p>`,
    );
  }
  if (footnote) parts.push(`<p class="small" style="margin:0 0 16px;${small}">${footnote}</p>`);
  if (button) parts.push(`<p class="small" style="margin:0;${small};word-break:break-all"><a href="${href}" style="color:${light.small}">${href}</a></p>`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  body, .page { background: ${dark.bg} !important; color: ${dark.text} !important; }
  .small, .small a { color: ${dark.small} !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:${light.bg}">
<div class="page" style="padding:32px 16px;background:${light.bg};color:${light.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55">
<div style="max-width:480px;margin:0 auto">
${parts.join('\n')}
</div>
</div>
</body>
</html>`;
}

/** a***@example.com - enough to tell messages apart in logs without storing the address */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at <= 0 ? '***' : `${email[0]}***${email.slice(at)}`;
}

/**
 * Whether the address is on a domain that can never receive mail (RFC 2606, RFC 6761): example.com,
 * .net and .org, and the .test, .example, .invalid and .localhost names. The smoke test and the
 * tests sign up with them; mail to them is never sent, so it can't bounce and hurt cubr.dev's
 * sending reputation.
 */
export function isReservedDomain(email: string): boolean {
  const domain = email
    .slice(email.lastIndexOf('@') + 1)
    .toLowerCase()
    .replace(/\.$/, '');
  return /(^|\.)(example\.(com|net|org)|test|example|invalid|localhost)$/.test(domain);
}

/**
 * Sends one email. Without an API key (local stack, CI) it's logged instead, text and all, so a
 * link can be read from the log; to a reserved domain it's skipped, and the log leaves the text out
 * (the links in it work). Throws when Resend refuses it.
 *
 * Each email gets its own X-Entity-Ref-ID, so Gmail shows it on its own instead of folding it into a
 * thread with the earlier ones of the same subject (a second reset link would be hidden under the
 * first). Resend documents this header for exactly that.
 */
export async function sendMail(cfg: MailConfig, mail: Mail, log: FastifyBaseLogger, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!cfg.apiKey) {
    log.warn({ to: maskEmail(mail.to), subject: mail.subject, text: mail.text }, 'email not sent (no RESEND_API_KEY): logged instead');
    return;
  }
  if (isReservedDomain(mail.to)) {
    log.info({ to: maskEmail(mail.to), subject: mail.subject }, 'email not sent: the address is on a reserved domain');
    return;
  }
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: cfg.from,
      to: [mail.to],
      reply_to: mail.replyTo ?? cfg.replyTo,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: { 'X-Entity-Ref-ID': randomUUID() },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend answered ${res.status}: ${detail.slice(0, 200)}`);
  }
}
