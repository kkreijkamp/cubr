// Sign-in with Google, Apple and GitHub, end to end against a real Postgres and Redis and a fake of
// each provider (fakeProviders.ts): the redirect, the callback, the one-time code, sign-up with a
// username, linking and unlinking, and everything a browser or a provider could get wrong.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { describeIntegration, startTestServer, type TestServer } from '@cubr/testkit';
import { migrations } from '../src/migrations.js';
import { newResetToken } from '../src/reset.js';
import { registerRoutes } from '../src/routes/index.js';
import { FakeProviders, IDS, type Person, type Tamper } from './fakeProviders.js';

type Provider = 'google' | 'apple' | 'github';
const PASSWORD = 'correct horse 1';
let ipCount = 0;
const freshIp = () => `10.9.${Math.floor(++ipCount / 250)}.${(ipCount % 250) + 1}`;
let subCount = 1000;
const person = (over: Partial<Person> = {}): Person => {
  const n = ++subCount;
  return { sub: String(n), email: `sso${n}@example.com`, emailVerified: true, name: `Sso Person ${n}`, ...over };
};

/** The cubr_oauth value a response sets ('' when it clears it). */
function cookieOf(res: { headers: Record<string, unknown> }): string | null {
  const raw = res.headers['set-cookie'];
  const line = (Array.isArray(raw) ? raw : [raw]).find((l) => typeof l === 'string' && l.startsWith('cubr_oauth='));
  return line ? (line as string).slice('cubr_oauth='.length).split(';')[0] : null;
}

describeIntegration('sign-in with Google, Apple and GitHub', () => {
  let s: TestServer;
  let fake: FakeProviders;

  beforeAll(async () => {
    fake = await new FakeProviders().start();
    vi.stubEnv('RESEND_API_KEY', '');
    vi.stubEnv('PUBLIC_URL', 'https://cubr.test');
    for (const [k, v] of Object.entries(fake.env())) vi.stubEnv(k, v);
    s = await startTestServer({
      service: 'auth',
      infoPrefixes: ['/api/auth', '/api/users', '/api/supporters'],
      schemas: [{ schema: 'auth', migrations }],
      routes: ({ app, config, pool, redis, auth }) => registerRoutes(app, { config, pool, redis, auth }),
    });
  });
  afterAll(async () => {
    await s?.close();
    await fake?.close();
    vi.unstubAllEnvs();
  });

  /** POST start: the provider page's URL and the browser's cookie for the flow. */
  async function begin(provider: Provider, opts: { mode?: 'signin' | 'link'; token?: string; next?: string } = {}) {
    const res = await s.request('POST', `/api/auth/oauth/${provider}/start`, { body: { mode: opts.mode ?? 'signin', next: opts.next }, token: opts.token, ip: freshIp() });
    expect(res.statusCode, res.body).toBe(200);
    const url = new URL(res.json().url);
    return { url, state: url.searchParams.get('state')!, cookie: `cubr_oauth=${cookieOf(res)}`, setCookie: String(res.headers['set-cookie']) };
  }

  /** The provider sends the browser back: the redirect into the SPA, its fragment and new cookie. */
  async function back(provider: Provider, flow: Awaited<ReturnType<typeof begin>>, who: Person, opts: { cookie?: string | null; tamper?: Tamper; params?: Record<string, string> } = {}) {
    const code = fake.issue(provider, flow.url, who, opts.tamper);
    const params = { code, state: flow.state, ...opts.params };
    const cookie = opts.cookie === undefined ? flow.cookie : opts.cookie;
    const headers: Record<string, string> = cookie ? { cookie } : {};
    const res =
      provider === 'apple'
        ? await s.request('POST', '/api/auth/oauth/apple/callback', { body: new URLSearchParams(params).toString(), headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, ip: freshIp() })
        : await s.request('GET', `/api/auth/oauth/${provider}/callback?${new URLSearchParams(params)}`, { headers, ip: freshIp() });
    expect(res.statusCode, res.body).toBe(303);
    const [path, hash] = String(res.headers.location).split('#');
    const bound = cookieOf(res);
    return { path, fragment: new URLSearchParams(hash), cookie: bound ? `cubr_oauth=${bound}` : null };
  }

  /** A new provider account all the way to a cubr account. */
  async function signUpWith(provider: Provider, who: Person, username?: string) {
    const r = await back(provider, await begin(provider), who);
    expect(r.fragment.get('signup'), r.fragment.toString()).toBeTruthy();
    const info = await s.request('GET', `/api/auth/oauth/signup/${r.fragment.get('signup')}`, { headers: { cookie: r.cookie! } });
    const chosen = username ?? info.json().username;
    const res = await s.request('POST', '/api/auth/oauth/signup', { body: { id: r.fragment.get('signup'), username: chosen }, headers: { cookie: r.cookie! }, ip: freshIp() });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { token: string; user: { id: string; username: string; email: string; hasPassword: boolean } };
  }

  /** An existing link all the way to a token. */
  async function signInWith(provider: Provider, who: Person) {
    const r = await back(provider, await begin(provider), who);
    expect(r.fragment.get('code'), r.fragment.toString()).toBeTruthy();
    const res = await s.request('POST', '/api/auth/oauth/exchange', { body: { code: r.fragment.get('code') }, headers: { cookie: r.cookie! }, ip: freshIp() });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { token: string; user: { id: string; username: string } };
  }

  async function passwordAccount(email = `pw${++subCount}@example.com`) {
    const res = await s.request('POST', '/api/auth/register', { body: { username: `pw_${subCount}`, email, password: PASSWORD }, ip: freshIp() });
    expect(res.statusCode).toBe(201);
    return res.json() as { token: string; user: { id: string; username: string; email: string } };
  }

  it('lists the providers that are set up', async () => {
    expect((await s.request('GET', '/api/auth/oauth/providers')).json()).toEqual({ providers: ['google', 'apple', 'github'] });
  });

  describe('starting', () => {
    it("sends the browser to each provider's page with a state, and binds the flow to that browser", async () => {
      for (const provider of ['google', 'apple', 'github'] as const) {
        const flow = await begin(provider);
        const q = flow.url.searchParams;
        expect(flow.url.origin + flow.url.pathname).toBe(`${fake.url}/${provider}/authorize`);
        expect(q.get('client_id')).toBe(IDS[provider].clientId);
        expect(q.get('redirect_uri')).toBe(`https://cubr.test/api/auth/oauth/${provider}/callback`);
        expect(q.get('response_type')).toBe('code');
        expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(flow.setCookie).toMatch(/HttpOnly/);
        expect(flow.setCookie).toMatch(/Secure/);
        expect(flow.setCookie).toMatch(/SameSite=None/);
        expect(flow.setCookie).toMatch(/Path=\/api\/auth\/oauth/);
      }
    });

    it('uses PKCE for Google and GitHub, a nonce for Google and Apple, and form_post for Apple', async () => {
      const g = (await begin('google')).url.searchParams;
      expect(g.get('code_challenge_method')).toBe('S256');
      expect(g.get('nonce')).toBeTruthy();
      expect(g.get('scope')).toBe('openid email profile');
      const a = (await begin('apple')).url.searchParams;
      expect(a.get('response_mode')).toBe('form_post');
      expect(a.get('nonce')).toBeTruthy();
      expect(a.get('code_challenge')).toBeNull();
      const h = (await begin('github')).url.searchParams;
      expect(h.get('code_challenge_method')).toBe('S256');
      expect(h.get('nonce')).toBeNull();
    });

    it('answers 404 for a provider that does not exist, and connecting one needs a signed-in user', async () => {
      expect((await s.request('POST', '/api/auth/oauth/facebook/start', { body: {} })).statusCode).toBe(404);
      expect((await s.request('POST', '/api/auth/oauth/google/start', { body: { mode: 'link' } })).statusCode).toBe(401);
    });
  });

  describe('a new account', () => {
    it('signs up with Google: a username to pick (suggested from the name), then a token, with no password', async () => {
      const who = person({ name: 'Zoë Speedcuber' });
      const r = await back('google', await begin('google', { next: '/daily' }), who);
      expect(r.path).toBe('/login/sso');
      expect(r.fragment.get('next')).toBe('/daily');
      const info = (await s.request('GET', `/api/auth/oauth/signup/${r.fragment.get('signup')}`, { headers: { cookie: r.cookie! } })).json();
      expect(info).toEqual({ provider: 'google', email: who.email, username: 'Zoe_Speedcuber' });
      const res = await s.request('POST', '/api/auth/oauth/signup', { body: { id: r.fragment.get('signup'), username: 'zoe_cubes' }, headers: { cookie: r.cookie! }, ip: freshIp() });
      expect(res.statusCode, res.body).toBe(201);
      const { token, user } = res.json();
      // the provider verified the address, so it starts confirmed
      expect(user).toMatchObject({ username: 'zoe_cubes', email: who.email, hasPassword: false, emailVerified: true });
      expect((await s.request('GET', '/api/auth/me', { token })).json().user.id).toBe(user.id);
      expect((await s.events('user.registered')).some((e) => e.data.userId === user.id)).toBe(true);
      // the sign-up is used up
      expect((await s.request('POST', '/api/auth/oauth/signup', { body: { id: r.fragment.get('signup'), username: 'zoe_again' }, headers: { cookie: r.cookie! } })).statusCode).toBe(404);
    });

    it('then signs in straight away with the same Google account', async () => {
      const who = person();
      const made = await signUpWith('google', who);
      const again = await signInWith('google', who);
      expect(again.user.id).toBe(made.user.id);
      expect((await s.request('GET', '/api/auth/me', { token: again.token })).statusCode).toBe(200);
    });

    it('keeps the sign-up when the username is taken, so another one can be tried', async () => {
      const taken = await passwordAccount();
      const r = await back('google', await begin('google'), person());
      const post = (username: string) => s.request('POST', '/api/auth/oauth/signup', { body: { id: r.fragment.get('signup'), username }, headers: { cookie: r.cookie! }, ip: freshIp() });
      const clash = await post(taken.user.username.toUpperCase());
      expect(clash.statusCode).toBe(409);
      expect(clash.json().error.message).toBe('Username is already taken');
      expect((await post('bad name!')).statusCode).toBe(400);
      expect((await post(`free_${subCount}`)).statusCode).toBe(201);
    });

    it('suggests a free username when the obvious one is taken', async () => {
      await passwordAccount(); // pw_<n>
      const clash = `pw_${subCount}`;
      const r = await back('github', await begin('github'), person({ login: clash }));
      const info = (await s.request('GET', `/api/auth/oauth/signup/${r.fragment.get('signup')}`, { headers: { cookie: r.cookie! } })).json();
      expect(info.username).toBe(`${clash}2`);
    });

    it('signs up with Apple through its form POST, with the name Apple sends the first time and a signed client secret', async () => {
      const who = person({ name: null });
      const flow = await begin('apple');
      const r = await back('apple', flow, who, { params: { user: JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' }, email: who.email }) } });
      const info = (await s.request('GET', `/api/auth/oauth/signup/${r.fragment.get('signup')}`, { headers: { cookie: r.cookie! } })).json();
      expect(info).toMatchObject({ provider: 'apple', email: who.email, username: 'Ada_Lovelace' });
      expect(fake.badAppleSecrets).toBe(0);
    });

    it("signs up with GitHub using the account's verified email and its GitHub username", async () => {
      const verifiedEmail = `verified${subCount}@example.com`;
      const who = person({
        login: 'Octo-Cat',
        emails: [
          { email: 'unverified@example.com', primary: true, verified: false },
          { email: verifiedEmail, primary: false, verified: true },
        ],
      });
      const r = await back('github', await begin('github'), who);
      const info = (await s.request('GET', `/api/auth/oauth/signup/${r.fragment.get('signup')}`, { headers: { cookie: r.cookie! } })).json();
      expect(info).toEqual({ provider: 'github', email: verifiedEmail, username: 'Octo_Cat' });
    });

    it('refuses a provider account without a verified email (cubr needs one for password resets)', async () => {
      expect((await back('google', await begin('google'), person({ emailVerified: false }))).fragment.get('error')).toBe('no_email');
      expect((await back('github', await begin('github'), person({ emails: [{ email: 'x@example.com', primary: true, verified: false }] }))).fragment.get('error')).toBe('no_email');
    });

    it("does not hand an existing account to a provider account with the same email", async () => {
      // its email may not be confirmed yet: whoever registered this address may not own it
      const existing = await passwordAccount();
      const r = await back('google', await begin('google'), person({ email: existing.user.email.toUpperCase() }));
      expect(r.fragment.get('error')).toBe('email_taken');
      expect(r.fragment.get('provider')).toBe('google');
      expect((await s.pool.query('select 1 from auth.user_identities where user_id = $1', [existing.user.id])).rowCount).toBe(0);
    });

    it('takes an address another account never confirmed within its 7 days (the provider vouches for it)', async () => {
      const stale = await passwordAccount();
      await s.pool.query("update auth.users set created_at = now() - interval '8 days' where id = $1", [stale.user.id]);
      await s.pool.query("update auth.email_changes set expires_at = now() - interval '1 minute' where user_id = $1", [stale.user.id]);
      const made = await signUpWith('google', person({ email: stale.user.email }));
      expect(made.user).toMatchObject({ email: stale.user.email, emailVerified: true });
      const { rows } = await s.pool.query('select email from auth.users where id = $1', [stale.user.id]);
      expect(rows[0].email).toBe(`released-${stale.user.id}@cubr.invalid`);
    });
  });

  describe('what a callback must not get away with', () => {
    it('refuses a callback without the cookie of the browser that started it (login CSRF)', async () => {
      const r = await back('google', await begin('google'), person(), { cookie: null });
      expect(r.fragment.get('error')).toBe('expired');
      const other = await back('google', await begin('google'), person(), { cookie: 'cubr_oauth=someone-elses-state-value-xxxxxxxxxxxxxxxxxx' });
      expect(other.fragment.get('error')).toBe('expired');
    });

    it('uses a state once, and only for the provider it was made for', async () => {
      const flow = await begin('google');
      const who = person();
      expect((await back('google', flow, who)).fragment.get('signup')).toBeTruthy();
      expect((await back('google', flow, who)).fragment.get('error')).toBe('expired');
      const g = await begin('google');
      const res = await s.request('GET', `/api/auth/oauth/github/callback?code=x&state=${g.state}`, { headers: { cookie: g.cookie } });
      expect(new URLSearchParams(String(res.headers.location).split('#')[1]).get('error')).toBe('expired');
    });

    it('turns "cancel" on the provider page into a cancelled sign-in', async () => {
      const r = await back('google', await begin('google'), person(), { params: { error: 'access_denied', code: '' } });
      expect(r.fragment.get('error')).toBe('cancelled');
    });

    it.each(['nonce', 'audience', 'issuer', 'signature', 'expired'] as const)('refuses an ID token with a bad %s', async (tamper) => {
      expect((await back('google', await begin('google'), person(), { tamper })).fragment.get('error')).toBe('failed');
      expect((await back('apple', await begin('apple'), person(), { tamper })).fragment.get('error')).toBe('failed');
    });

    it('refuses a code that the provider never issued', async () => {
      const flow = await begin('github');
      const res = await s.request('GET', `/api/auth/oauth/github/callback?code=made-up&state=${flow.state}`, { headers: { cookie: flow.cookie } });
      expect(new URLSearchParams(String(res.headers.location).split('#')[1]).get('error')).toBe('failed');
    });

    it('lets the one-time code and a sign-up work only in the browser they were issued to, and the code only once', async () => {
      const who = person();
      await signUpWith('google', who);
      const r = await back('google', await begin('google'), who);
      const code = r.fragment.get('code')!;
      // 404s, never 401: the web app signs out on a 401, so a link someone sends you would sign you out
      expect((await s.request('POST', '/api/auth/oauth/exchange', { body: { code } })).statusCode).toBe(404); // a code someone sent you
      expect((await s.request('POST', '/api/auth/oauth/exchange', { body: { code }, headers: { cookie: r.cookie! } })).statusCode).toBe(200);
      expect((await s.request('POST', '/api/auth/oauth/exchange', { body: { code }, headers: { cookie: r.cookie! } })).statusCode).toBe(404);

      const pending = await back('google', await begin('google'), person());
      const id = pending.fragment.get('signup')!;
      expect((await s.request('GET', `/api/auth/oauth/signup/${id}`)).statusCode).toBe(404);
      expect((await s.request('POST', '/api/auth/oauth/signup', { body: { id, username: 'hijacker_1' } })).statusCode).toBe(404);
    });
  });

  describe('connecting providers to an account', () => {
    it('connects Google to a password account, which then signs in to it', async () => {
      const acct = await passwordAccount();
      const who = person({ email: 'different@example.com' });
      const r = await back('google', await begin('google', { mode: 'link', token: acct.token }), who);
      expect(r.path).toBe('/account');
      expect(r.fragment.get('linked')).toBe('google');
      const methods = (await s.request('GET', '/api/auth/me/sign-in', { token: acct.token })).json();
      expect(methods).toMatchObject({ password: true, providers: ['google', 'apple', 'github'], identities: [{ provider: 'google', email: 'different@example.com' }] });
      expect((await signInWith('google', who)).user.id).toBe(acct.user.id);
    });

    it("refuses a provider account that belongs to someone else, and a second account of the same provider", async () => {
      const owner = await passwordAccount();
      const who = person();
      await back('github', await begin('github', { mode: 'link', token: owner.token }), who);
      const other = await passwordAccount();
      expect((await back('github', await begin('github', { mode: 'link', token: other.token }), who)).fragment.get('error')).toBe('linked_elsewhere');
      expect((await back('github', await begin('github', { mode: 'link', token: owner.token }), person())).fragment.get('error')).toBe('already_linked');
      // connecting the one it already has again is fine
      expect((await back('github', await begin('github', { mode: 'link', token: owner.token }), who)).fragment.get('linked')).toBe('github');
    });

    it("confirms the account's email when a provider vouches for that same address, not for another one", async () => {
      const acct = await passwordAccount();
      const confirmed = async () => (await s.request('GET', '/api/auth/me', { token: acct.token })).json().user.emailVerified;
      expect(await confirmed()).toBe(false);
      await back('google', await begin('google', { mode: 'link', token: acct.token }), person({ email: 'someone.else@example.com' }));
      expect(await confirmed()).toBe(false);
      const who = person({ email: acct.user.email.toUpperCase() });
      await back('apple', await begin('apple', { mode: 'link', token: acct.token }), who);
      expect(await confirmed()).toBe(true);
    });

    it('disconnects a provider, but never the last way to sign in', async () => {
      const made = await signUpWith('google', person());
      const del = (p: Provider) => s.request('DELETE', `/api/auth/me/identities/${p}`, { token: made.token });
      expect((await del('google')).statusCode).toBe(409);
      await back('github', await begin('github', { mode: 'link', token: made.token }), person());
      expect((await del('google')).statusCode).toBe(204);
      expect((await del('google')).statusCode).toBe(404);
      expect((await s.request('GET', '/api/auth/me/sign-in', { token: made.token })).json().identities.map((i: { provider: string }) => i.provider)).toEqual(['github']);
      expect((await del('github')).statusCode).toBe(409);
    });
  });

  describe('an account without a password', () => {
    it("can't sign in with a password, and is deleted by typing its username", async () => {
      const made = await signUpWith('github', person());
      const login = await s.request('POST', '/api/auth/login', { body: { login: made.user.username, password: 'anything at all' }, ip: freshIp() });
      expect(login.statusCode).toBe(401);
      expect((await s.request('DELETE', '/api/auth/me', { token: made.token, body: { password: 'anything at all' } })).statusCode).toBe(403);
      expect((await s.request('DELETE', '/api/auth/me', { token: made.token, body: { confirm: 'someone_else' } })).statusCode).toBe(403);
      expect((await s.request('DELETE', '/api/auth/me', { token: made.token, body: { confirm: made.user.username.toUpperCase() } })).statusCode).toBe(204);
      expect((await s.pool.query('select 1 from auth.user_identities where user_id = $1', [made.user.id])).rowCount).toBe(0);
    });

    it('gets a password from a reset link, and can then sign in either way', async () => {
      const who = person();
      const made = await signUpWith('google', who);
      const { token: link, hash } = newResetToken();
      await s.pool.query(`insert into auth.password_resets (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 hour')`, [hash, made.user.id]);
      const reset = await s.request('POST', '/api/auth/password/reset', { body: { token: link, password: 'my new password' }, ip: freshIp() });
      expect(reset.statusCode).toBe(200);
      expect(reset.json().user.hasPassword).toBe(true);
      expect((await s.request('POST', '/api/auth/login', { body: { login: made.user.email, password: 'my new password' }, ip: freshIp() })).statusCode).toBe(200);
      expect((await signInWith('google', who)).user.id).toBe(made.user.id);
    });
  });
});

describeIntegration('sign-in with providers when none is set up', () => {
  let s: TestServer;
  beforeAll(async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    for (const k of ['GOOGLE_CLIENT_ID', 'APPLE_CLIENT_ID', 'GITHUB_CLIENT_ID']) vi.stubEnv(k, '');
    s = await startTestServer({
      service: 'auth',
      infoPrefixes: ['/api/auth'],
      schemas: [{ schema: 'auth', migrations }],
      routes: ({ app, config, pool, redis, auth }) => registerRoutes(app, { config, pool, redis, auth }),
    });
  });
  afterAll(async () => {
    await s?.close();
    vi.unstubAllEnvs();
  });

  it('lists none and refuses to start', async () => {
    expect((await s.request('GET', '/api/auth/oauth/providers')).json()).toEqual({ providers: [] });
    expect((await s.request('POST', '/api/auth/oauth/google/start', { body: {} })).statusCode).toBe(404);
  });
});
