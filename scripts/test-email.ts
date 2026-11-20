// Sends cubr's password-reset email to one address as cubr.dev sends it: the same template, sender
// ("cubr <no-reply@cubr.dev>"), reply-to (hello@cubr.dev) and headers, through Resend. It's for
// seeing how the email lands: mail-tester.com shows an address to send to, then scores what arrives
// (spam filters, SPF, DKIM, DMARC, the HTML). The link in it has a made-up token, so it opens
// cubr.dev's "link expired" page.
//
//   RESEND_API_KEY="$(security find-generic-password -s cubr-resend-api -w)" npx tsx scripts/test-email.ts <address>
import type { FastifyBaseLogger } from 'fastify';
import { isReservedDomain, loadMailConfig, sendMail } from '../services/auth/src/mail.js';
import { RESET_TTL_MIN, newResetToken, resetEmail, resetLink } from '../services/auth/src/reset.js';

const to = process.argv[2] ?? '';
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || isReservedDomain(to)) {
  console.error('usage: RESEND_API_KEY=... npx tsx scripts/test-email.ts <address>   (one that receives mail, e.g. from mail-tester.com)');
  process.exit(2);
}
// production's settings: compose.prod.yml gives the auth service the key, and the rest are the defaults
const cfg = loadMailConfig({ RESEND_API_KEY: process.env.RESEND_API_KEY });
if (!cfg.apiKey) {
  console.error('RESEND_API_KEY is not set; the key is in the keychain: security find-generic-password -s cubr-resend-api -w');
  process.exit(2);
}
const email = resetEmail({ username: 'cubr_test', link: resetLink(cfg.publicUrl, newResetToken().token), minutes: RESET_TTL_MIN });
await sendMail(cfg, { to, ...email }, console as unknown as FastifyBaseLogger);
console.log(`sent "${email.subject}" from ${cfg.from} (replies to ${cfg.replyTo}) to ${to}`);
