// Sign-in with Google, Apple and GitHub, browser side: the API calls, the messages for each failure
// the server reports, and where the app may send the browser afterwards.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, onUnauthorized, setToken } from '../../../lib/api';
import { ssoErrorMessage } from '../Sso';
import { safeNext } from '../util';

interface Call {
  url: string;
  method: string;
  body: unknown;
  authorization: string | null;
}
let calls: Call[] = [];

/** a fetch that records each request and answers `status` with `body` (no body for a 204) */
const answer = (status: number, body?: unknown) =>
  vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      authorization: new Headers(init.headers).get('authorization'),
    });
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
  onUnauthorized(() => {});
});

describe('the sign-in API', () => {
  it('starts a sign-in with the mode and where to go afterwards, and returns the provider page', async () => {
    vi.stubGlobal('fetch', answer(200, { url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }));
    await expect(api.auth.oauth.start('google', 'signin', '/daily')).resolves.toEqual({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });
    expect(calls).toEqual([{ url: '/api/auth/oauth/google/start', method: 'POST', body: { mode: 'signin', next: '/daily' }, authorization: null }]);
  });

  it('connecting a provider sends the token, so the server knows which account', async () => {
    setToken('tok-1');
    vi.stubGlobal('fetch', answer(200, { url: 'https://github.com/login/oauth/authorize' }));
    await api.auth.oauth.start('github', 'link', '/account');
    expect(calls[0]).toMatchObject({ url: '/api/auth/oauth/github/start', body: { mode: 'link', next: '/account' }, authorization: 'Bearer tok-1' });
  });

  it('exchanges the one-time code for a session', async () => {
    vi.stubGlobal('fetch', answer(200, { token: 't', user: { id: 'u1', username: 'cuber' } }));
    await expect(api.auth.oauth.exchange('code-123')).resolves.toMatchObject({ token: 't', user: { username: 'cuber' } });
    expect(calls[0]).toMatchObject({ url: '/api/auth/oauth/exchange', method: 'POST', body: { code: 'code-123' } });
  });

  it('puts the sign-up id in the path safely', async () => {
    vi.stubGlobal('fetch', answer(200, { provider: 'apple', email: 'a@privaterelay.appleid.com', username: null }));
    await expect(api.auth.oauth.signup('a/b?c#d')).resolves.toEqual({ provider: 'apple', email: 'a@privaterelay.appleid.com', username: null });
    expect(calls[0]).toMatchObject({ url: '/api/auth/oauth/signup/a%2Fb%3Fc%23d', method: 'GET' });
  });

  it('finishes a sign-up with the chosen username', async () => {
    vi.stubGlobal('fetch', answer(201, { token: 't', user: { id: 'u2', username: 'new_cuber' } }));
    await api.auth.oauth.completeSignup('signup-id', 'new_cuber');
    expect(calls[0]).toMatchObject({ url: '/api/auth/oauth/signup', method: 'POST', body: { id: 'signup-id', username: 'new_cuber' } });
  });

  it('reads how the account signs in, and disconnects a provider', async () => {
    setToken('tok-2');
    const methods = {
      password: false,
      providers: ['google', 'github'],
      identities: [{ provider: 'google', email: 'x@example.com', createdAt: '2026-11-17T00:00:00.000Z' }],
    };
    vi.stubGlobal('fetch', answer(200, methods));
    await expect(api.auth.oauth.methods()).resolves.toEqual(methods);
    vi.stubGlobal('fetch', answer(204));
    await api.auth.oauth.disconnect('github');
    expect(calls.map((c) => `${c.method} ${c.url} ${c.authorization}`)).toEqual([
      'GET /api/auth/me/sign-in Bearer tok-2',
      'DELETE /api/auth/me/identities/github Bearer tok-2',
    ]);
  });

  it('deletes an account with its password, or with its username when it has none', async () => {
    setToken('tok-3');
    vi.stubGlobal('fetch', answer(204));
    await api.auth.deleteMe({ password: 'hunter22' });
    await api.auth.deleteMe({ confirm: 'Apple_Dev' });
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['DELETE', '/api/auth/me', { password: 'hunter22' }],
      ['DELETE', '/api/auth/me', { confirm: 'Apple_Dev' }],
    ]);
  });

  it("a stale or foreign sign-in link (404) doesn't sign the browser's own account out", async () => {
    setToken('tok-4');
    const signOut = vi.fn();
    onUnauthorized(signOut);
    vi.stubGlobal('fetch', answer(404, { error: { code: 'NOT_FOUND', message: 'This sign-in link has expired, please sign in again' } }));
    const err = await api.auth.oauth.exchange('someone-elses-code').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404 });
    expect(signOut).not.toHaveBeenCalled();
    // whereas a 401 means the token itself is no good
    vi.stubGlobal('fetch', answer(401, { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }));
    await api.auth.oauth.methods().catch(() => {});
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

describe('ssoErrorMessage', () => {
  it('names the provider and says what to do for each failure', () => {
    expect(ssoErrorMessage('cancelled', 'google')).toBe('sign-in with Google was cancelled.');
    expect(ssoErrorMessage('no_email', 'github')).toBe('your GitHub account has no verified email address. cubr needs one, for password resets.');
    expect(ssoErrorMessage('email_taken', 'apple')).toBe(
      'an account already uses the email of that Apple account. sign in with your password, then connect Apple on your account page.',
    );
    expect(ssoErrorMessage('linked_elsewhere', 'github')).toBe('that GitHub account is already connected to another cubr account.');
    expect(ssoErrorMessage('already_linked', 'google')).toBe('your account is already connected to a different Google account. disconnect it first.');
    expect(ssoErrorMessage('expired', 'apple')).toContain('took too long');
    expect(ssoErrorMessage('busy', 'google')).toContain('too many sign-in attempts');
  });

  it('falls back to a general message, and never shows an unknown provider name', () => {
    expect(ssoErrorMessage('failed', 'github')).toBe("sign-in with GitHub didn't work. please try again.");
    expect(ssoErrorMessage(null, null)).toBe("sign-in with the provider didn't work. please try again.");
    expect(ssoErrorMessage('something-new', 'google')).toBe("sign-in with Google didn't work. please try again.");
    expect(ssoErrorMessage('cancelled', '<script>')).toBe('sign-in with the provider was cancelled.');
    expect(ssoErrorMessage('cancelled', 'constructor')).toBe('sign-in with the provider was cancelled.');
  });
});

describe('safeNext (where a sign-in may send the browser)', () => {
  it('keeps a path inside the app', () => {
    expect(safeNext('/daily')).toBe('/daily');
    expect(safeNext('/profile/koen_k?tab=solves#pbs')).toBe('/profile/koen_k?tab=solves#pbs');
  });

  it('turns anything else into the fallback', () => {
    for (const next of [null, undefined, '', 'daily', 'https://evil.example', '//evil.example', '/\\evil.example', '/login', '/login/sso', '/login?next=/x']) {
      expect(safeNext(next)).toBe('/account');
    }
    expect(safeNext('//evil.example', '/')).toBe('/');
  });
});
