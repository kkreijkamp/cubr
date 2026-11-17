import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { RESET_TOKEN_RE, forgotSchema, hashResetToken, newResetToken, resetEmail, resetLink, resetSchema } from '../src/reset.js';
import { isReservedDomain, loadMailConfig, maskEmail, sendMail } from '../src/mail.js';

const log = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) as never;

describe('reset tokens', () => {
  it('are 32 random bytes as base64url, stored only as their SHA-256', () => {
    const a = newResetToken();
    const b = newResetToken();
    expect(a.token).toMatch(RESET_TOKEN_RE);
    expect(a.token).not.toBe(b.token);
    expect(a.hash.equals(createHash('sha256').update(a.token).digest())).toBe(true);
    expect(hashResetToken(a.token).equals(a.hash)).toBe(true);
  });

  it('go in the link fragment', () => {
    expect(resetLink('https://cubr.dev/', 'abc')).toBe('https://cubr.dev/reset#abc');
    expect(resetLink('http://localhost:8080', 'abc')).toBe('http://localhost:8080/reset#abc');
  });
});

describe('schemas', () => {
  it('forgot takes one email', () => {
    expect(forgotSchema.parse({ email: '  a@b.co ' })).toEqual({ email: 'a@b.co' });
    expect(forgotSchema.safeParse({ email: 'nope' }).success).toBe(false);
  });
  it('reset takes a well-formed token and a sign-up-strength password', () => {
    const { token } = newResetToken();
    expect(resetSchema.safeParse({ token, password: 'longenough' }).success).toBe(true);
    expect(resetSchema.safeParse({ token, password: 'short' }).success).toBe(false);
    expect(resetSchema.safeParse({ token: 'x'.repeat(43) + '!', password: 'longenough' }).success).toBe(false);
  });
});

describe('resetEmail', () => {
  it('has the link, the username and the expiry, in text and HTML', () => {
    const m = resetEmail({ username: 'demo', link: 'https://cubr.dev/reset#tok', minutes: 60 });
    expect(m.subject).toBe('Reset your cubr password');
    for (const body of [m.text, m.html]) {
      expect(body).toContain('https://cubr.dev/reset#tok');
      expect(body).toContain('demo');
      expect(body).toContain('60 minutes');
    }
  });
  it('escapes HTML', () => {
    const m = resetEmail({ username: '<b>x</b>', link: 'https://x/reset#a"b', minutes: 60 });
    expect(m.html).not.toContain('<b>x</b>');
    expect(m.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(m.html).toContain('a&quot;b');
  });
});

describe('mail', () => {
  it('defaults to cubr.dev senders', () => {
    expect(loadMailConfig({})).toEqual({ apiKey: '', from: 'cubr <no-reply@cubr.dev>', replyTo: 'hello@cubr.dev', publicUrl: 'https://cubr.dev' });
  });
  it('masks addresses for logs', () => {
    expect(maskEmail('koen@example.com')).toBe('k***@example.com');
    expect(maskEmail('bad')).toBe('***');
  });
  it('logs instead of sending without an API key', async () => {
    const l = log();
    const fetchImpl = vi.fn();
    await sendMail(loadMailConfig({}), { to: 'a@b.co', subject: 's', text: 't', html: 'h' }, l, fetchImpl as never);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((l as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledOnce();
  });
  it('knows the domains that can never receive mail (RFC 2606, RFC 6761)', () => {
    for (const reserved of ['a@example.com', 'a@EXAMPLE.org', 'a@mail.example.net', 'a@x.test', 'a@foo.example', 'a@bar.invalid', 'a@localhost', 'a@me.localhost', 'a@example.com.']) {
      expect(isReservedDomain(reserved), reserved).toBe(true);
    }
    for (const real of ['a@gmail.com', 'a@cubr.dev', 'a@myexample.com', 'a@example.co', 'a@testing.dev', 'a@contest.org', 'a@example.com.au']) {
      expect(isReservedDomain(real), real).toBe(false);
    }
  });
  it('never sends to a reserved domain, and logs it without the text (its links work)', async () => {
    const cfg = loadMailConfig({ RESEND_API_KEY: 're_test' });
    const l = log();
    const fetchImpl = vi.fn();
    await sendMail(cfg, { to: 'smoke_1@example.com', subject: 's', text: 'the link', html: 'h' }, l, fetchImpl as never);
    expect(fetchImpl).not.toHaveBeenCalled();
    const info = (l as { info: ReturnType<typeof vi.fn> }).info;
    expect(info).toHaveBeenCalledOnce();
    expect(JSON.stringify(info.mock.calls[0])).not.toContain('the link');
  });
  it('posts to Resend with the reply-to, and throws on a refusal', async () => {
    const cfg = loadMailConfig({ RESEND_API_KEY: 're_test' });
    const ok = vi.fn().mockResolvedValue(new Response('{"id":"1"}', { status: 200 }));
    await sendMail(cfg, { to: 'a@b.co', subject: 's', text: 't', html: 'h' }, log(), ok as never);
    const [url, init] = ok.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
    expect(JSON.parse(init.body as string)).toEqual({ from: 'cubr <no-reply@cubr.dev>', to: ['a@b.co'], reply_to: 'hello@cubr.dev', subject: 's', text: 't', html: 'h' });
    const refused = vi.fn().mockResolvedValue(new Response('{"message":"domain not verified"}', { status: 403 }));
    await expect(sendMail(cfg, { to: 'a@b.co', subject: 's', text: 't', html: 'h' }, log(), refused as never)).rejects.toThrow(/403/);
  });
});
