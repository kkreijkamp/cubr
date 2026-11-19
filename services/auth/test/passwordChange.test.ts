import { describe, expect, it } from 'vitest';
import { changePasswordSchema, passwordChangedNotice, signInUrl } from '../src/passwordChange.js';

describe('changing the password', () => {
  it('takes the new password by the sign-up rule (8 to 128 characters) and the current one, which an account without one leaves out', () => {
    expect(changePasswordSchema.parse({ password: 'old secret', newPassword: 'new secret' })).toEqual({ password: 'old secret', newPassword: 'new secret' });
    expect(changePasswordSchema.parse({ newPassword: 'n'.repeat(8) })).toEqual({ newPassword: 'n'.repeat(8) });
    expect(changePasswordSchema.parse({ newPassword: 'n'.repeat(128) }).newPassword).toHaveLength(128);
    for (const bad of [{}, { password: 'old secret' }, { newPassword: 'n'.repeat(7) }, { newPassword: 'n'.repeat(129) }, { password: '', newPassword: 'new secret' }]) {
      expect(changePasswordSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('tells the owner what changed and the way back, escaping the username in the HTML', () => {
    const m = passwordChangedNotice({ username: 'felix<b>', first: false, signInUrl: 'https://cubr.dev/login' });
    expect(m.subject).toBe('Your cubr password was changed');
    expect(m.text).toContain('Hi felix<b>,');
    expect(m.text).toMatch(/password of your cubr account was changed, and every other device was signed out/);
    expect(m.text).toMatch(/didn't do this, choose a new password with "forgot password\?" on the sign-in page \(https:\/\/cubr\.dev\/login\)/);
    expect(m.html).toContain('Hi felix&lt;b&gt;,');
    expect(m.html).not.toContain('felix<b>');
    expect(m.html).toContain('&quot;forgot password?&quot;');
  });

  it('says so when an account made with a provider set its first password', () => {
    const m = passwordChangedNotice({ username: 'felix', first: true, signInUrl: 'https://cubr.dev/login' });
    expect(m.subject).toBe('Your cubr account has a password now');
    expect(m.text).toMatch(/now has a password, so you can also sign in with your username or email/);
  });

  it("points at the sign-in page of the site the emails' links go to", () => {
    expect(signInUrl('https://cubr.dev')).toBe('https://cubr.dev/login');
    expect(signInUrl('http://localhost:8080/')).toBe('http://localhost:8080/login');
  });
});
