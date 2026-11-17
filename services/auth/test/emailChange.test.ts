import { describe, expect, it } from 'vitest';
import {
  changeEmailSchema,
  confirmAccountEmailMessage,
  confirmEmailLink,
  confirmEmailMessage,
  confirmEmailSchema,
  EMAIL_CONFIRM_TTL_DAYS,
  EMAIL_CONFIRM_TTL_MIN,
  emailChangedNotice,
  FRESH_SIGN_IN_SEC,
  isFreshSignIn,
} from '../src/emailChange.js';

describe('confirming the account email', () => {
  it('gives the sign-up link a week, as people open it later', () => {
    expect(EMAIL_CONFIRM_TTL_DAYS).toBe(7);
    expect(EMAIL_CONFIRM_TTL_MIN).toBe(7 * 24 * 60);
  });

  it('asks the address to confirm, says why and for how long, and escapes the username in the HTML', () => {
    const link = 'https://cubr.dev/confirm-email#abc_DEF-123';
    const m = confirmAccountEmailMessage({ username: 'felix<b>', link, days: 7 });
    expect(m.subject).toBe('Confirm your cubr email');
    expect(m.text).toContain('Hi felix<b>,');
    expect(m.text).toContain(link);
    expect(m.text).toMatch(/reset link can reach you here/);
    expect(m.text).toMatch(/works once, for 7 days/);
    expect(m.text).toMatch(/didn't make a cubr account, ignore this email/);
    expect(m.html).toContain('Hi felix&lt;b&gt;,');
    expect(m.html).not.toContain('felix<b>');
    expect(m.html).toContain(`href="${link}"`);
    expect(m.html).toContain('confirm my email');
  });
});

describe('changing the email', () => {
  it('takes a new address (trimmed) and the password, which an account without one leaves out', () => {
    expect(changeEmailSchema.parse({ email: '  new@example.com ', password: 'secret 1' })).toEqual({ email: 'new@example.com', password: 'secret 1' });
    expect(changeEmailSchema.parse({ email: 'new@example.com' })).toEqual({ email: 'new@example.com' });
    for (const bad of [{ email: 'not an email' }, { email: `${'a'.repeat(250)}@x.io` }, { email: 'a@b.io', password: '' }]) expect(changeEmailSchema.safeParse(bad).success).toBe(false);
  });

  it('takes only a well-formed link token', () => {
    expect(confirmEmailSchema.safeParse({ token: 'A'.repeat(43) }).success).toBe(true);
    for (const token of ['short', 'A'.repeat(44), `${'A'.repeat(42)}=`]) expect(confirmEmailSchema.safeParse({ token }).success).toBe(false);
  });

  it('counts a sign-in in the last 10 minutes as proof for an account without a password', () => {
    const now = 1_800_000_000;
    expect(isFreshSignIn(now, now)).toBe(true);
    expect(isFreshSignIn(now - FRESH_SIGN_IN_SEC, now)).toBe(true);
    expect(isFreshSignIn(now - FRESH_SIGN_IN_SEC - 1, now)).toBe(false);
    expect(isFreshSignIn(undefined, now)).toBe(false); // a token from before iat existed
    expect(isFreshSignIn(now + 3600, now)).toBe(false); // from the future: not trusted
  });

  it('puts the token in the link fragment, which browsers never send to the server', () => {
    expect(confirmEmailLink('https://cubr.dev/', 'tok')).toBe('https://cubr.dev/confirm-email#tok');
    expect(confirmEmailLink('http://localhost:8080', 'tok')).toBe('http://localhost:8080/confirm-email#tok');
  });

  it('asks the new address to confirm, with the link and how long it works', () => {
    const m = confirmEmailMessage({ username: 'koen_k', link: 'https://cubr.dev/confirm-email#tok', minutes: 60 });
    expect(m.subject).toBe('Confirm your new cubr email');
    for (const part of [m.text, m.html]) {
      expect(part).toContain('koen_k');
      expect(part).toContain('https://cubr.dev/confirm-email#tok');
      expect(part).toContain('60 minutes');
    }
    expect(confirmEmailMessage({ username: '<b>x</b>', link: 'https://e.x/#"', minutes: 60 }).html).not.toMatch(/<b>x<\/b>|#"/);
  });

  it('tells the old address afterwards, with the new one masked', () => {
    const m = emailChangedNotice({ username: 'koen_k', newEmail: 'jo.example@mail.example.com' });
    expect(m.subject).toBe('Your cubr email was changed');
    for (const part of [m.text, m.html]) {
      expect(part).toContain('j***@mail.example.com');
      expect(part).not.toContain('jo.example@');
      expect(part).toMatch(/reply to this email/);
    }
  });
});
