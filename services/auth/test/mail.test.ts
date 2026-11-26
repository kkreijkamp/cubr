import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { confirmAccountEmailMessage, confirmEmailMessage, emailChangedNotice } from '../src/emailChange.js';
import { EMAIL_COLOURS, escapeHtml, isReservedDomain, loadMailConfig, maskEmail, page, sendMail } from '../src/mail.js';
import { passwordChangedNotice } from '../src/passwordChange.js';
import { resetEmail } from '../src/reset.js';

const log = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) as never;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** WCAG's contrast ratio of two '#rrggbb' colours */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** One of the web app's themes (web/src/lib/themes.ts lists them one JSON object per line). */
function webTheme(name: string): Record<string, string> {
  const src = readFileSync(new URL('../../../web/src/lib/themes.ts', import.meta.url), 'utf8');
  const found = src.match(new RegExp(`\\{"name":"${name}"[^}]*\\}`));
  if (!found) throw new Error(`no theme ${name} in web/src/lib/themes.ts`);
  return JSON.parse(found[0]);
}

describe('the email page', () => {
  const href = 'https://cubr.dev/reset#a"b&c';
  const escaped = 'https://cubr.dev/reset#a&quot;b&amp;c';
  const html = page({ title: 'Reset your <cubr> password', paragraphs: ['Hi demo,', 'Someone asked.'], button: { label: 'choose a new password', href }, footnote: 'The link works once.' });

  it('is a whole document: in English, UTF-8, sized for phones and titled with the subject', () => {
    expect(html.startsWith('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">')).toBe(true);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<title>Reset your &lt;cubr&gt; password</title>');
    expect(html.endsWith('</body>\n</html>')).toBe(true);
  });

  it("has the message, the button, and the button's address under the small print as a plain link", () => {
    expect(html).toContain('<p style="margin:0 0 16px">Someone asked.</p>');
    expect(html).toContain(`<a href="${escaped}" style="display:inline-block;`);
    expect(html).toContain('>choose a new password</a>');
    expect(html.split(`href="${escaped}"`)).toHaveLength(3); // the button and the plain link, no other links
    expect(html.indexOf('The link works once.')).toBeLessThan(html.indexOf(`>${escaped}</a>`));
    const notice = page({ title: 'Your cubr email was changed', paragraphs: ['no action'] });
    expect(notice).not.toContain('<a ');
    expect(notice).not.toContain('class="small"');
  });

  it('turns into white cross dark in mail apps in dark mode', () => {
    const { dark } = EMAIL_COLOURS;
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('@media (prefers-color-scheme: dark) {');
    expect(html).toContain(`body, .page { background: ${dark.bg} !important; color: ${dark.text} !important; }`);
    expect(html).toContain(`.small, .small a { color: ${dark.small} !important; }`);
  });

  it("keeps the default themes' colours, with small print readable in both (WCAG AA: 4.5:1)", () => {
    const light = webTheme('white_cross');
    const dark = webTheme('white_cross_dark');
    const c = EMAIL_COLOURS;
    expect([c.light.bg, c.light.text, c.green]).toEqual([light.bg, light.text, light.main]);
    expect([c.dark.bg, c.dark.text, c.dark.small]).toEqual([dark.bg, dark.text, dark.sub]);
    expect(contrast(light.sub, light.bg)).toBeLessThan(4.5); // why the light small print is darker than the theme's labels
    for (const m of [c.light, c.dark]) {
      expect(contrast(m.small, m.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(m.text, m.bg)).toBeGreaterThanOrEqual(7);
    }
  });

  it('is what every account email uses, beside a plain-text version', () => {
    const emails = [
      resetEmail({ username: 'demo', link: 'https://cubr.dev/reset#tok', minutes: 60 }),
      confirmAccountEmailMessage({ username: 'demo', link: 'https://cubr.dev/confirm-email#tok', days: 7 }),
      confirmEmailMessage({ username: 'demo', link: 'https://cubr.dev/confirm-email#tok', minutes: 60 }),
      emailChangedNotice({ username: 'demo', newEmail: 'new@mail.example.com' }),
      passwordChangedNotice({ username: 'demo', first: false, signInUrl: 'https://cubr.dev/login' }),
    ];
    for (const m of emails) {
      expect(m.html, m.subject).toContain('<html lang="en">');
      expect(m.html, m.subject).toContain(`<title>${escapeHtml(m.subject)}</title>`);
      expect(m.text, m.subject).toMatch(/^Hi demo,\n[^<>]+\n- cubr$/);
    }
  });
});

describe('sending', () => {
  it('defaults to cubr.dev senders: from "cubr", with replies to hello@cubr.dev', () => {
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
  it('posts both versions to Resend with the reply-to, and throws on a refusal', async () => {
    const cfg = loadMailConfig({ RESEND_API_KEY: 're_test' });
    const ok = vi.fn().mockImplementation(async () => new Response('{"id":"1"}', { status: 200 }));
    await sendMail(cfg, { to: 'a@b.co', subject: 's', text: 't', html: 'h' }, log(), ok as never);
    const [url, init] = ok.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'cubr <no-reply@cubr.dev>',
      to: ['a@b.co'],
      reply_to: 'hello@cubr.dev',
      subject: 's',
      text: 't',
      html: 'h',
      headers: { 'X-Entity-Ref-ID': expect.stringMatching(UUID_RE) },
    });
    const refused = vi.fn().mockResolvedValue(new Response('{"message":"domain not verified"}', { status: 403 }));
    await expect(sendMail(cfg, { to: 'a@b.co', subject: 's', text: 't', html: 'h' }, log(), refused as never)).rejects.toThrow(/403/);
  });
  it("lets an email name its own reply-to (the feedback form's: the sender's address)", async () => {
    const cfg = loadMailConfig({ RESEND_API_KEY: 're_test' });
    const ok = vi.fn().mockImplementation(async () => new Response('{"id":"1"}', { status: 200 }));
    await sendMail(cfg, { to: 'hello@cubr.dev', replyTo: 'jo@example.com', subject: 's', text: 't', html: 'h' }, log(), ok as never);
    expect(JSON.parse((ok.mock.calls[0] as [string, RequestInit])[1].body as string)).toMatchObject({ to: ['hello@cubr.dev'], reply_to: 'jo@example.com' });
  });
  it("gives every email its own X-Entity-Ref-ID, so Gmail doesn't fold a second reset link into the first one's thread", async () => {
    const cfg = loadMailConfig({ RESEND_API_KEY: 're_test' });
    const ok = vi.fn().mockImplementation(async () => new Response('{"id":"1"}', { status: 200 }));
    for (let i = 0; i < 2; i++) await sendMail(cfg, { to: 'a@b.co', subject: 'Reset your cubr password', text: 't', html: 'h' }, log(), ok as never);
    const ids = ok.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).headers['X-Entity-Ref-ID']);
    expect(new Set(ids).size).toBe(2);
  });
});
