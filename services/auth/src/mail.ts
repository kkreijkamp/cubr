import type { FastifyBaseLogger } from 'fastify';

// ---------------------------------------------------------------------------------------------
// Outgoing email through Resend's HTTPS API (no SDK, no SMTP: GCP blocks port 25 anyway).
// Without RESEND_API_KEY (local stack, CI) nothing is sent: the message is logged instead, so the
// whole password-reset flow can be tried by reading the link from `docker compose logs auth`.
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

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** a***@example.com - enough to tell messages apart in logs without storing the address */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at <= 0 ? '***' : `${email[0]}***${email.slice(at)}`;
}

/** Sends one email, or logs it when no API key is configured. Throws when Resend refuses it. */
export async function sendMail(cfg: MailConfig, mail: Mail, log: FastifyBaseLogger, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!cfg.apiKey) {
    log.warn({ to: maskEmail(mail.to), subject: mail.subject, text: mail.text }, 'email not sent (no RESEND_API_KEY): logged instead');
    return;
  }
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: cfg.from, to: [mail.to], reply_to: cfg.replyTo, subject: mail.subject, text: mail.text, html: mail.html }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend answered ${res.status}: ${detail.slice(0, 200)}`);
  }
}
