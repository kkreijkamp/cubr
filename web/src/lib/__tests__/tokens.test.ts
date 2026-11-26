import { describe, expect, it } from 'vitest';
import { followStoredToken, tokenSubject } from '../api';

/** A token-shaped string for `sub` (header and signature don't matter here: nothing is verified). */
const tokenFor = (sub: string, extra: Record<string, unknown> = {}) =>
  `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub, username: 'felix', ...extra }))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')}.signature`;

describe('tokens across tabs', () => {
  const a1 = tokenFor('11111111-1111-4111-8111-111111111111', { iat: 1 });
  const a2 = tokenFor('11111111-1111-4111-8111-111111111111', { iat: 2 });
  const b = tokenFor('22222222-2222-4222-8222-222222222222');

  it("reads whose a token is, and nothing from what isn't one", () => {
    expect(tokenSubject(a1)).toBe('11111111-1111-4111-8111-111111111111');
    // base64url characters (- and _) in the payload
    expect(tokenSubject(tokenFor('x', { note: '??>>~~' }))).toBe('x');
    for (const bad of [null, undefined, '', 'nonsense', 'a.b.c', 'a.!!!.c', `x.${btoa('{"sub":42}')}.y`, `x.${btoa('null')}.y`])
      expect(tokenSubject(bad), String(bad)).toBeNull();
  });

  it("follows another tab's new token for the same account: a password change there signs out the old one", () => {
    expect(followStoredToken(a1, a2)).toBe(a2);
  });

  it("keeps this tab's token for another account's, a sign-out elsewhere, or no token here", () => {
    expect(followStoredToken(a1, b)).toBe(a1); // the 401 handler deals with a switch of account
    expect(followStoredToken(a1, null)).toBe(a1);
    expect(followStoredToken(null, a2)).toBeNull(); // signed out here: stays so
    expect(followStoredToken(a1, a1)).toBe(a1);
    expect(followStoredToken(a1, 'garbage')).toBe(a1);
  });
});
