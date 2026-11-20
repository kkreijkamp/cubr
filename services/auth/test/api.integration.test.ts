// The auth service's HTTP API against a real Postgres and Redis (@cubr/testkit): accounts, sign-in,
// sessions, password reset, account deletion, private profiles, pictures and Ko-fi supporters.
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PRIVATE_USERS_KEY, revokedUserKey, signToken } from '@cubr/common';
import { describeIntegration, startTestServer, type TestServer } from '@cubr/testkit';
import { migrations } from '../src/migrations.js';
import { registerRoutes } from '../src/routes/index.js';
import { newResetToken } from '../src/reset.js';

/** Every email the service sends (without an API key it only logs them), oldest first. */
const outbox = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock('../src/mail.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/mail.js')>();
  return {
    ...real,
    sendMail: (...args: Parameters<typeof real.sendMail>) => {
      outbox.push(args[1]);
      return real.sendMail(...args);
    },
  };
});

const KOFI_TOKEN = 'kofi-test-token-0123456789';
const PASSWORD = 'correct horse 1';

/** A fresh client IP for each call, so the per-IP limits only trip where a test means them to. */
let ipCount = 0;
const freshIp = () => `10.1.${Math.floor(++ipCount / 250)}.${(ipCount % 250) + 1}`;

/** Real pictures: the server decodes every upload and stores it again as a 256 x 256 WebP. */
const picture = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: '#00a04d' } });
const PNG = await picture(64, 64).png().toBuffer();
const JPEG = await picture(64, 64).jpeg().toBuffer();

describeIntegration('auth API', () => {
  let s: TestServer;
  let n = 0;

  beforeAll(async () => {
    vi.stubEnv('RESEND_API_KEY', ''); // never send real email from a test
    vi.stubEnv('KOFI_VERIFICATION_TOKEN', KOFI_TOKEN);
    s = await startTestServer({
      service: 'auth',
      infoPrefixes: ['/api/auth', '/api/users', '/api/supporters'],
      schemas: [{ schema: 'auth', migrations }],
      routes: ({ app, config, pool, redis, auth }) => registerRoutes(app, { config, pool, redis, auth }),
    });
  });
  afterAll(async () => {
    await s?.close();
    vi.unstubAllEnvs();
  });

  /** Registers a new account (unique name and email per call). */
  async function signUp(over: { username?: string; email?: string; password?: string } = {}) {
    const i = ++n;
    const body = { username: over.username ?? `cuber_${i}`, email: over.email ?? `cuber${i}@example.com`, password: over.password ?? PASSWORD };
    const res = await s.request('POST', '/api/auth/register', { body, ip: freshIp() });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { token: string; user: { id: string; username: string; email: string } };
  }
  const login = (loginName: string, password = PASSWORD, ip = freshIp()) => s.request('POST', '/api/auth/login', { body: { login: loginName, password }, ip });
  const me = (token: string) => s.request('GET', '/api/auth/me', { token });
  /** Confirms the account's email, as opening the link from sign-up would. */
  const confirmEmailOf = (userId: string) => s.pool.query('update auth.users set email_verified_at = now() where id = $1', [userId]);
  const mailsTo = (to: string, subject: string) => outbox.filter((m) => m.to.toLowerCase() === to.toLowerCase() && m.subject === subject);
  /** The token in the newest "confirm your email" link sent to `to` (other than `except`), once it's sent. */
  async function emailedLink(to: string, except?: string): Promise<string> {
    let token = '';
    await vi.waitFor(() => {
      const mails = mailsTo(to, 'Confirm your cubr email');
      token = /\/confirm-email#([A-Za-z0-9_-]{43})/.exec(mails[mails.length - 1]?.text ?? '')?.[1] ?? '';
      expect(token).not.toBe('');
      expect(token).not.toBe(except);
    });
    return token;
  }

  describe('register', () => {
    it('creates the account, returns a working token and keeps only a bcrypt hash of the password', async () => {
      const { token, user } = await signUp({ username: 'Felix_Z', email: 'Felix@Example.com' });
      expect(user).toMatchObject({ username: 'Felix_Z', email: 'Felix@Example.com' });
      const r = await me(token);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ user: expect.objectContaining({ id: user.id, username: 'Felix_Z' }), settings: {} });
      const { rows } = await s.pool.query('select password_hash from auth.users where id = $1', [user.id]);
      expect(rows[0].password_hash).toMatch(/^\$2[aby]\$10\$/);
      expect(rows[0].password_hash).not.toContain(PASSWORD);
    });

    it('publishes user.registered without the email address', async () => {
      const { user } = await signUp();
      const events = (await s.events('user.registered')).filter((e) => e.data.userId === user.id);
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({ userId: user.id, username: user.username });
      expect(JSON.stringify(events[0].data)).not.toContain('@example.com');
    });

    it('refuses a taken username or email, whatever the case', async () => {
      await signUp({ username: 'Taken_Name', email: 'taken@example.com' });
      const dupName = await s.request('POST', '/api/auth/register', { body: { username: 'taken_NAME', email: 'other@example.com', password: PASSWORD }, ip: freshIp() });
      expect(dupName.statusCode).toBe(409);
      expect(dupName.json().error.message).toBe('Username is already taken');
      const dupEmail = await s.request('POST', '/api/auth/register', { body: { username: 'someone_new', email: 'TAKEN@example.com', password: PASSWORD }, ip: freshIp() });
      expect(dupEmail.statusCode).toBe(409);
      expect(dupEmail.json().error.message).toBe('Email is already registered');
    });

    it.each([
      ['a short username', { username: 'ab', email: 'x1@example.com', password: PASSWORD }],
      ['a username with a space', { username: 'a b c', email: 'x2@example.com', password: PASSWORD }],
      ['a bad email', { username: 'valid_name', email: 'nope', password: PASSWORD }],
      ['a short password', { username: 'valid_name2', email: 'x3@example.com', password: 'short' }],
      ['no body', undefined],
    ])('answers 400 to %s', async (_what, body) => {
      const res = await s.request('POST', '/api/auth/register', { body, ip: freshIp() });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
    });

    it('allows 20 sign-ups an hour from one address, unless the caller has the internal token', async () => {
      const ip = freshIp();
      const attempt = (i: number, headers: Record<string, string> = {}) =>
        s.request('POST', '/api/auth/register', { body: { username: `bulk_${i}`, email: `bulk${i}@example.com`, password: PASSWORD }, ip, headers });
      for (let i = 0; i < 20; i++) expect((await attempt(i)).statusCode).toBe(201);
      expect((await attempt(20)).statusCode).toBe(429);
      expect((await attempt(21, { 'x-internal-token': s.config.internalToken })).statusCode).toBe(201);
    });
  });

  describe('login', () => {
    it('accepts the username or the email, in any case', async () => {
      const { user } = await signUp({ username: 'Login_Me', email: 'Login.Me@example.com' });
      for (const name of ['Login_Me', 'login_me', 'login.me@EXAMPLE.com']) {
        const res = await login(name);
        expect(res.statusCode, name).toBe(200);
        expect(res.json().user.id).toBe(user.id);
        expect((await me(res.json().token)).statusCode).toBe(200);
      }
      const { rows } = await s.pool.query('select last_login_at from auth.users where id = $1', [user.id]);
      expect(rows[0].last_login_at).toBeInstanceOf(Date);
    });

    it('gives the same 401 for a wrong password and an unknown account', async () => {
      const { user } = await signUp();
      const wrong = await login(user.username, 'wrong password');
      const unknown = await login('nobody_here');
      expect(wrong.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      expect(wrong.json().error.message).toBe(unknown.json().error.message);
    });

    it('allows 10 attempts a minute from one address', async () => {
      const ip = freshIp();
      for (let i = 0; i < 10; i++) expect((await login('nobody_here', 'x', ip)).statusCode).toBe(401);
      expect((await login('nobody_here', 'x', ip)).statusCode).toBe(429);
      expect((await login('nobody_here', 'x', freshIp())).statusCode).toBe(401);
    });
  });

  describe('tokens', () => {
    it('rejects a missing, malformed or foreign token, and one for a deleted account', async () => {
      expect((await s.request('GET', '/api/auth/me')).statusCode).toBe(401);
      expect((await me('not-a-jwt')).statusCode).toBe(401);
      const foreign = await signToken('some-other-secret', { id: '6f1c1b5e-1f3a-4f7e-9a51-2b8f3c4d5e6f', username: 'x' });
      expect((await me(foreign.token)).statusCode).toBe(401);
      const ghost = await s.token({ id: '6f1c1b5e-1f3a-4f7e-9a51-2b8f3c4d5e6f', username: 'ghost' });
      const res = await me(ghost);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toBe('Account no longer exists');
    });

    it('logs out one session: that token stops working, others keep going', async () => {
      const { user, token } = await signUp();
      const other = (await login(user.username)).json().token as string;
      expect((await s.request('POST', '/api/auth/logout', { token })).statusCode).toBe(204);
      expect((await me(token)).statusCode).toBe(401);
      expect((await me(other)).statusCode).toBe(200);
    });

    it('logs out with an empty JSON body (what fetch sends with a JSON content type)', async () => {
      const { token } = await signUp();
      const res = await s.request('POST', '/api/auth/logout', { token, headers: { 'content-type': 'application/json' }, body: '' });
      expect(res.statusCode).toBe(204);
    });
  });

  describe('profile and settings', () => {
    it('updates the profile, returns it and publishes user.updated', async () => {
      const { token, user } = await signUp();
      const res = await s.request('PATCH', '/api/auth/me', { token, body: { displayName: 'Felix', bio: 'sub-10 one day', country: 'AU' } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().user).toMatchObject({ displayName: 'Felix', bio: 'sub-10 one day', country: 'AU' });
      const events = (await s.events('user.updated')).filter((e) => e.data.userId === user.id);
      expect(events.at(-1)?.data).toMatchObject({ displayName: 'Felix', country: 'AU' });
      expect(JSON.stringify(events.at(-1)?.data)).not.toContain('@example.com');
    });

    it('answers an empty patch with the profile as it is, and 400 to junk', async () => {
      const { token, user } = await signUp();
      const empty = await s.request('PATCH', '/api/auth/me', { token, body: {} });
      expect(empty.statusCode).toBe(200);
      expect(empty.json().user.id).toBe(user.id);
      expect((await s.request('PATCH', '/api/auth/me', { token, body: { country: 'Australia!' } })).statusCode).toBe(400);
    });

    it('stores settings and returns them with the account; refuses oversized ones', async () => {
      const { token } = await signUp();
      const settings = { theme: 'stickerless', holdMs: 550, inspection: true };
      const put = await s.request('PUT', '/api/auth/me/settings', { token, body: { settings } });
      expect(put.statusCode, put.body).toBe(200);
      expect((await me(token)).json().settings).toEqual(settings);
      const huge = await s.request('PUT', '/api/auth/me/settings', { token, body: { settings: { blob: 'x'.repeat(70_000) } } });
      expect([400, 413]).toContain(huge.statusCode);
      expect((await me(token)).json().settings).toEqual(settings);
    });
  });

  describe('private profiles', () => {
    it('shows strangers only the name and picture, the owner everything', async () => {
      const { token, user } = await signUp();
      await s.request('PATCH', '/api/auth/me', { token, body: { displayName: 'Hidden Person', bio: 'secret bio', country: 'NZ' } });
      const priv = await s.request('PATCH', '/api/auth/me', { token, body: { private: true } });
      expect(priv.statusCode, priv.body).toBe(200);
      expect(await s.redis.sismember(PRIVATE_USERS_KEY, user.id)).toBe(1);

      const stranger = (await s.request('GET', `/api/users/${user.username}`)).json().user;
      expect(stranger.username).toBe(user.username);
      expect(JSON.stringify(stranger)).not.toMatch(/Hidden Person|secret bio|NZ/);
      const signedInStranger = (await s.request('GET', `/api/users/${user.username}`, { token: (await signUp()).token })).json().user;
      expect(JSON.stringify(signedInStranger)).not.toMatch(/Hidden Person|secret bio/);
      const owner = (await s.request('GET', `/api/users/${user.username}`, { token })).json().user;
      expect(owner).toMatchObject({ displayName: 'Hidden Person', bio: 'secret bio', country: 'NZ' });

      const event = (await s.events('user.updated')).filter((e) => e.data.userId === user.id).at(-1);
      expect(JSON.stringify(event?.data)).not.toMatch(/Hidden Person|secret bio/);

      await s.request('PATCH', '/api/auth/me', { token, body: { private: false } });
      expect(await s.redis.sismember(PRIVATE_USERS_KEY, user.id)).toBe(0);
      expect((await s.request('GET', `/api/users/${user.username}`)).json().user).toMatchObject({ bio: 'secret bio' });
    });
  });

  describe('user lookup', () => {
    it('finds users by name in any case, 404 otherwise', async () => {
      const { user } = await signUp({ username: 'Case_Test' });
      expect((await s.request('GET', '/api/users/case_test')).json().user.id).toBe(user.id);
      expect((await s.request('GET', '/api/users/no_such_user')).statusCode).toBe(404);
      expect((await s.request('GET', '/api/users/bad%20name!')).statusCode).toBe(404);
    });

    it('returns users by id in the order asked, skipping unknown ones', async () => {
      const a = (await signUp()).user;
      const b = (await signUp()).user;
      const unknown = '00000000-0000-4000-8000-000000000000';
      const res = await s.request('GET', `/api/users?ids=${b.id},${unknown},${a.id}`);
      expect(res.json().users.map((u: { id: string }) => u.id)).toEqual([b.id, a.id]);
      expect((await s.request('GET', '/api/users')).json()).toEqual({ users: [] });
    });
  });

  describe('password reset', () => {
    /** A reset link for `userId`, as if the email had arrived (the route only emails the token). */
    async function resetLinkFor(userId: string, minutes = 60): Promise<string> {
      const { token, hash } = newResetToken();
      await s.pool.query(`insert into auth.password_resets (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(mins => $3))`, [hash, userId, minutes]);
      return token;
    }
    const linkCount = async (userId: string) => Number((await s.pool.query('select count(*) from auth.password_resets where user_id = $1', [userId])).rows[0].count);

    it('answers 202 whether or not the address has an account, and stores a link only for real ones', async () => {
      const { user } = await signUp({ email: 'Forgetful@example.com' });
      await confirmEmailOf(user.id);
      const known = await s.request('POST', '/api/auth/password/forgot', { body: { email: 'forgetful@EXAMPLE.com' }, ip: freshIp() });
      const unknown = await s.request('POST', '/api/auth/password/forgot', { body: { email: 'nobody@example.com' }, ip: freshIp() });
      expect([known.statusCode, unknown.statusCode]).toEqual([202, 202]);
      expect(known.body).toBe(unknown.body);
      await vi.waitFor(async () => expect(await linkCount(user.id)).toBe(1));
      // only the hash is stored
      const { rows } = await s.pool.query('select token_hash from auth.password_resets where user_id = $1', [user.id]);
      expect(Buffer.isBuffer(rows[0].token_hash)).toBe(true);
    });

    it('sends at most 3 links an hour for one account', async () => {
      const { user } = await signUp();
      await confirmEmailOf(user.id);
      for (let i = 0; i < 5; i++) await s.request('POST', '/api/auth/password/forgot', { body: { email: user.email }, ip: freshIp() });
      await vi.waitFor(async () => expect(await linkCount(user.id)).toBe(3));
      await new Promise((r) => setTimeout(r, 200));
      expect(await linkCount(user.id)).toBe(3);
    });

    it('sends no link to an address that was never confirmed: it may be a typo, or someone else', async () => {
      const { user } = await signUp();
      const res = await s.request('POST', '/api/auth/password/forgot', { body: { email: user.email }, ip: freshIp() });
      expect(res.statusCode).toBe(202); // the same answer as for any address
      await new Promise((r) => setTimeout(r, 300));
      expect(await linkCount(user.id)).toBe(0);
      expect(mailsTo(user.email, 'Reset your cubr password')).toHaveLength(0);
    });

    it('still sends one to an account from before confirming existed, and using it confirms the address', async () => {
      const { user, token } = await signUp();
      await s.pool.query('update auth.users set predates_email_confirmation = true where id = $1', [user.id]);
      await s.request('POST', '/api/auth/password/forgot', { body: { email: user.email }, ip: freshIp() });
      let link = '';
      await vi.waitFor(() => {
        link = /\/reset#([A-Za-z0-9_-]{43})/.exec(mailsTo(user.email, 'Reset your cubr password')[0]?.text ?? '')?.[1] ?? '';
        expect(link).not.toBe('');
      });
      expect((await me(token)).json().user.emailVerified).toBe(false);
      const res = await s.request('POST', '/api/auth/password/reset', { body: { token: link, password: 'brand new pass' }, ip: freshIp() });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().user.emailVerified).toBe(true);
    });

    it('sets the new password once, signs out every other session and signs in', async () => {
      const { user, token: oldToken } = await signUp();
      const link = await resetLinkFor(user.id);
      const spare = await resetLinkFor(user.id);
      const res = await s.request('POST', '/api/auth/password/reset', { body: { token: link, password: 'brand new pass' }, ip: freshIp() });
      expect(res.statusCode, res.body).toBe(200);
      const { token: fresh } = res.json();
      expect((await me(fresh)).statusCode).toBe(200);
      expect((await me(oldToken)).statusCode).toBe(401);
      expect((await login(user.username)).statusCode).toBe(401);
      expect((await login(user.username, 'brand new pass')).statusCode).toBe(200);
      // the link works once, and the account's other links are gone too
      const again = await s.request('POST', '/api/auth/password/reset', { body: { token: link, password: 'another pass 2' }, ip: freshIp() });
      expect(again.statusCode).toBe(400);
      const viaSpare = await s.request('POST', '/api/auth/password/reset', { body: { token: spare, password: 'another pass 2' }, ip: freshIp() });
      expect(viaSpare.statusCode).toBe(400);
    });

    it('refuses an expired link and a malformed one', async () => {
      const { user } = await signUp();
      const expired = await resetLinkFor(user.id, -1);
      expect((await s.request('POST', '/api/auth/password/reset', { body: { token: expired, password: 'brand new pass' }, ip: freshIp() })).statusCode).toBe(400);
      expect((await s.request('POST', '/api/auth/password/reset', { body: { token: 'short', password: 'brand new pass' }, ip: freshIp() })).statusCode).toBe(400);
      expect((await login(user.username)).statusCode).toBe(200);
    });
  });

  describe('account deletion', () => {
    it('needs the right password', async () => {
      const { token, user } = await signUp();
      const res = await s.request('DELETE', '/api/auth/me', { token, body: { password: 'not it' } });
      expect(res.statusCode).toBe(403);
      expect((await me(token)).statusCode).toBe(200);
      expect((await s.pool.query('select 1 from auth.users where id = $1', [user.id])).rowCount).toBe(1);
    });

    it('deletes the account with its settings and picture, revokes every token and tells the other services', async () => {
      const { token, user } = await signUp();
      await s.request('PUT', '/api/auth/me/settings', { token, body: { settings: { theme: 'dnf' } } });
      await s.request('PUT', '/api/auth/me/avatar', { token, body: PNG, headers: { 'content-type': 'image/png' } });
      await s.request('PATCH', '/api/auth/me', { token, body: { private: true } });
      const res = await s.request('DELETE', '/api/auth/me', { token, body: { password: PASSWORD } });
      expect(res.statusCode, res.body).toBe(204);
      for (const table of ['users where id', 'user_settings where user_id', 'avatars where user_id']) {
        expect((await s.pool.query(`select 1 from auth.${table} = $1`, [user.id])).rowCount, table).toBe(0);
      }
      expect((await me(token)).statusCode).toBe(401);
      expect(await s.redis.get(revokedUserKey(user.id))).not.toBeNull();
      expect((await login(user.username)).statusCode).toBe(401);
      await vi.waitFor(async () => expect(await s.redis.sismember(PRIVATE_USERS_KEY, user.id)).toBe(0));
      expect((await s.events('user.deleted')).some((e) => e.data.userId === user.id && e.data.username === user.username)).toBe(true);
      // the name is free again
      expect((await s.request('POST', '/api/auth/register', { body: { username: user.username, email: 'again@example.com', password: PASSWORD }, ip: freshIp() })).statusCode).toBe(201);
    });

    it('allows 5 attempts in 10 minutes', async () => {
      const { token } = await signUp();
      for (let i = 0; i < 5; i++) expect((await s.request('DELETE', '/api/auth/me', { token, body: { password: 'nope' } })).statusCode).toBe(403);
      expect((await s.request('DELETE', '/api/auth/me', { token, body: { password: PASSWORD } })).statusCode).toBe(429);
    });
  });

  describe('profile pictures', () => {
    it('stores a picture, serves it with safe headers and caching, and removes it', async () => {
      const { token, user } = await signUp();
      const put = await s.request('PUT', '/api/auth/me/avatar', { token, body: PNG, headers: { 'content-type': 'image/png' } });
      expect(put.statusCode, put.body).toBe(200);
      const avatarUrl: string = put.json().user.avatarUrl;
      expect(avatarUrl).toMatch(new RegExp(`/api/users/${user.id}/avatar\\?v=[0-9a-f]{12}$`));

      const got = await s.app.inject({ url: avatarUrl });
      expect(got.statusCode).toBe(200);
      expect(got.headers['content-type']).toBe('image/webp');
      expect(got.headers['x-content-type-options']).toBe('nosniff');
      expect(got.headers['content-security-policy']).toContain('sandbox');
      expect(got.headers['cache-control']).toContain('immutable');
      expect(await sharp(got.rawPayload).metadata()).toMatchObject({ format: 'webp', width: 256, height: 256 });
      const byName = await s.app.inject({ url: `/api/users/${user.username}/avatar` });
      expect(byName.headers['cache-control']).toBe('public, max-age=300');
      const revalidated = await s.app.inject({ url: `/api/users/${user.username}/avatar`, headers: { 'if-none-match': got.headers.etag as string } });
      expect(revalidated.statusCode).toBe(304);

      const del = await s.request('DELETE', '/api/auth/me/avatar', { token });
      expect(del.json().user.avatarUrl).toBeNull();
      expect((await s.app.inject({ url: `/api/users/${user.id}/avatar` })).statusCode).toBe(404);
    });

    it('refuses a file whose bytes are not the type it claims, or no image at all', async () => {
      const { token } = await signUp();
      const lying = await s.request('PUT', '/api/auth/me/avatar', { token, body: JPEG, headers: { 'content-type': 'image/png' } });
      expect(lying.statusCode).toBe(400);
      const text = await s.request('PUT', '/api/auth/me/avatar', { token, body: Buffer.from('<svg onload=alert(1)>'), headers: { 'content-type': 'image/png' } });
      expect(text.statusCode).toBe(400);
      const svg = await s.request('PUT', '/api/auth/me/avatar', { token, body: Buffer.from('<svg/>'), headers: { 'content-type': 'image/svg+xml' } });
      expect(svg.statusCode).toBe(415);
    });

    it('refuses a picture over 300 KB', async () => {
      const { token } = await signUp();
      const big = Buffer.concat([PNG, Buffer.alloc(300 * 1024)]);
      const res = await s.request('PUT', '/api/auth/me/avatar', { token, body: big, headers: { 'content-type': 'image/png' } });
      expect(res.statusCode).toBe(413);
    });

    it("stores a fresh picture made from the upload's pixels: its EXIF, GPS location included, is gone", async () => {
      const { token, user } = await signUp();
      const photo = await picture(800, 600)
        .jpeg()
        .withExif({ IFD0: { ImageDescription: 'taken-at-home' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '27/1 28/1 3000/100', GPSLongitudeRef: 'E', GPSLongitude: '153/1 1/1 4800/100' } })
        .toBuffer();
      expect((await sharp(photo).metadata()).exif?.includes('taken-at-home')).toBe(true);
      const put = await s.request('PUT', '/api/auth/me/avatar', { token, body: photo, headers: { 'content-type': 'image/jpeg' } });
      expect(put.statusCode, put.body).toBe(200);
      const got = await s.app.inject({ url: `/api/users/${user.id}/avatar` });
      const meta = await sharp(got.rawPayload).metadata();
      expect(meta).toMatchObject({ format: 'webp', width: 256, height: 256 });
      expect(meta.exif).toBeUndefined();
      expect(got.rawPayload.includes('taken-at-home')).toBe(false);
      const { rows } = await s.pool.query<{ content_type: string; bytes: Buffer }>('select content_type, bytes from auth.avatars where user_id = $1', [user.id]);
      expect(rows[0].content_type).toBe('image/webp');
      expect(rows[0].bytes.equals(got.rawPayload)).toBe(true);
    });

    it("refuses a picture over 2048 px a side, or one that doesn't decode, and keeps the old one", async () => {
      const { token, user } = await signUp();
      expect((await s.request('PUT', '/api/auth/me/avatar', { token, body: PNG, headers: { 'content-type': 'image/png' } })).statusCode).toBe(200);
      const before = (await s.pool.query<{ version: string }>('select version from auth.avatars where user_id = $1', [user.id])).rows[0].version;

      const huge = await picture(3000, 3000).png().toBuffer(); // a small file, a 9-megapixel picture
      const tooBig = await s.request('PUT', '/api/auth/me/avatar', { token, body: huge, headers: { 'content-type': 'image/png' } });
      expect(tooBig.statusCode).toBe(400);
      expect(tooBig.json().error.message).toBe('Picture is too big: at most 2048 x 2048 pixels');
      const junk = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(64, 1)]); // the PNG signature, then nothing that decodes
      const broken = await s.request('PUT', '/api/auth/me/avatar', { token, body: junk, headers: { 'content-type': 'image/png' } });
      expect(broken.statusCode).toBe(400);
      expect(broken.json().error.message).toBe('File is not a valid PNG, JPEG or WebP image');

      const after = (await s.pool.query<{ version: string }>('select version from auth.avatars where user_id = $1', [user.id])).rows[0].version;
      expect(after).toBe(before);
    });
  });

  describe('Ko-fi supporters', () => {
    const kofi = (over: Record<string, unknown> = {}) =>
      new URLSearchParams({
        data: JSON.stringify({
          verification_token: KOFI_TOKEN,
          message_id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          type: 'Donation',
          is_public: true,
          from_name: 'Jo Example',
          message: 'keep it up',
          amount: '5.00',
          email: 'jo@example.com',
          currency: 'AUD',
          is_subscription_payment: false,
          is_first_subscription_payment: false,
          kofi_transaction_id: crypto.randomUUID(),
          tier_name: null,
          ...over,
        }),
      }).toString();
    const post = (form: string, ip = freshIp()) => s.request('POST', '/api/supporters/kofi', { body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' }, ip });
    const list = async () => (await s.request('GET', '/api/supporters')).json().supporters as { name: string; member: boolean }[];

    it('records a public supporter once per message, and lists names without the private details', async () => {
      const form = kofi({ from_name: 'Repeat Giver' });
      expect((await post(form)).statusCode).toBe(200);
      expect((await post(form)).statusCode).toBe(200); // Ko-fi's retry
      expect((await s.pool.query(`select 1 from auth.supporters where name = 'Repeat Giver'`)).rowCount).toBe(1);
      const names = await list();
      expect(names).toContainEqual({ name: 'Repeat Giver', member: false });
      const stored = JSON.stringify((await s.pool.query('select * from auth.supporters')).rows);
      expect(stored).not.toMatch(/jo@example\.com|5\.00|keep it up/);
    });

    it('lists a monthly member as one, and leaves out anonymous and hidden supporters', async () => {
      await post(kofi({ from_name: 'Monthly Member', type: 'Subscription', is_subscription_payment: true, tier_name: 'cube club' }));
      await post(kofi({ from_name: 'Shy Person', is_public: false }));
      await post(kofi({ from_name: 'Hidden Later' }));
      await s.pool.query(`update auth.supporters set hidden = true where name = 'Hidden Later'`);
      const names = await list();
      expect(names).toContainEqual({ name: 'Monthly Member', member: true });
      expect(names.map((x) => x.name)).not.toContain('Shy Person');
      expect(names.map((x) => x.name)).not.toContain('Hidden Later');
    });

    it('refuses a wrong verification token and junk', async () => {
      expect((await post(kofi({ verification_token: 'wrong-token' }))).statusCode).toBe(403);
      expect((await post('data=not-json')).statusCode).toBe(400);
      expect((await post('')).statusCode).toBe(400);
    });
  });

  describe('changing the email', () => {
    const change = (token: string, body: Record<string, unknown>) => s.request('POST', '/api/auth/me/email', { token, body, ip: freshIp() });
    const confirm = (token: string) => s.request('POST', '/api/auth/email/confirm', { body: { token }, ip: freshIp() });
    /** The pending change's link, as if the email had arrived (the route only emails the token). */
    async function linkFor(userId: string): Promise<string> {
      const { token, hash } = newResetToken();
      const res = await s.pool.query('update auth.email_changes set token_hash = $1 where user_id = $2', [hash, userId]);
      expect(res.rowCount).toBe(1);
      return token;
    }

    it('checks the password, emails the new address, and changes nothing until the link is opened', async () => {
      const { token, user } = await signUp();
      expect((await change(token, { email: 'new.home@example.com', password: 'wrong password' })).statusCode).toBe(403);
      expect((await change(token, { email: 'new.home@example.com' })).statusCode).toBe(403);
      const res = await change(token, { email: 'New.Home@example.com', password: PASSWORD });
      expect(res.statusCode, res.body).toBe(202);
      expect(res.json()).toEqual({ ok: true, email: 'New.Home@example.com' });
      expect((await me(token)).json().user.email).toBe(user.email);
      // only the hash is stored
      const { rows } = await s.pool.query('select token_hash from auth.email_changes where user_id = $1', [user.id]);
      expect(Buffer.isBuffer(rows[0].token_hash)).toBe(true);

      const link = await linkFor(user.id);
      const ok = await confirm(link);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toEqual({ email: 'New.Home@example.com', changed: true });
      expect((await me(token)).json().user.email).toBe('New.Home@example.com'); // the session carries on
      expect((await login('new.home@example.com')).statusCode).toBe(200);
      expect((await login(user.email)).statusCode).toBe(401);
      expect((await confirm(link)).statusCode).toBe(400); // the link works once
    });

    it('refuses the current address, one another account uses, nonsense, and no sign-in', async () => {
      const a = await signUp();
      const b = await signUp();
      expect((await change(a.token, { email: a.user.email.toUpperCase(), password: PASSWORD })).statusCode).toBe(400);
      expect((await change(a.token, { email: b.user.email, password: PASSWORD })).statusCode).toBe(409);
      expect((await change(a.token, { email: 'not an email', password: PASSWORD })).statusCode).toBe(400);
      expect((await s.request('POST', '/api/auth/me/email', { body: { email: 'x@example.com', password: PASSWORD } })).statusCode).toBe(401);
    });

    it('keeps one pending change: asking again replaces it', async () => {
      const { token, user } = await signUp();
      await change(token, { email: 'first@example.com', password: PASSWORD });
      await change(token, { email: 'second@example.com', password: PASSWORD });
      const { rows } = await s.pool.query('select new_email from auth.email_changes where user_id = $1', [user.id]);
      expect(rows).toEqual([{ new_email: 'second@example.com' }]);
    });

    it('refuses an expired or malformed link, and one whose address someone else took meanwhile', async () => {
      const a = await signUp();
      await change(a.token, { email: 'contested@example.com', password: PASSWORD });
      const link = await linkFor(a.user.id);
      await signUp({ email: 'contested@example.com' });
      expect((await confirm(link)).statusCode).toBe(409);
      expect((await me(a.token)).json().user.email).toBe(a.user.email);
      await change(a.token, { email: 'later@example.com', password: PASSWORD });
      const late = await linkFor(a.user.id);
      await s.pool.query(`update auth.email_changes set expires_at = now() - interval '1 minute' where user_id = $1`, [a.user.id]);
      expect((await confirm(late)).statusCode).toBe(400);
      expect((await confirm('short')).statusCode).toBe(400);
    });

    it('ends the pending password-reset links, which went to the old address', async () => {
      const { token, user } = await signUp();
      const reset = newResetToken();
      await s.pool.query(`insert into auth.password_resets (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 hour')`, [reset.hash, user.id]);
      await change(token, { email: 'moved@example.com', password: PASSWORD });
      expect((await confirm(await linkFor(user.id))).statusCode).toBe(200);
      const viaOld = await s.request('POST', '/api/auth/password/reset', { body: { token: reset.token, password: 'brand new pass' }, ip: freshIp() });
      expect(viaOld.statusCode).toBe(400);
    });

    it('lets an account without a password change it only right after signing in', async () => {
      const { user } = await signUp();
      await s.pool.query('update auth.users set password_hash = null where id = $1', [user.id]);
      const now = Math.floor(Date.now() / 1000);
      const stale = (await signToken(s.config.jwtSecret, user, 3600, now - 20 * 60)).token;
      const fresh = (await signToken(s.config.jwtSecret, user, 3600, now)).token;
      const res = await change(stale, { email: 'provider.new@example.com' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toMatch(/sign in again/i);
      expect((await change(fresh, { email: 'provider.new@example.com' })).statusCode).toBe(202);
    });

    it('allows 5 attempts an hour per account', async () => {
      const { token } = await signUp();
      for (let i = 0; i < 5; i++) expect((await change(token, { email: 'guess@example.com', password: `guess ${i}` })).statusCode).toBe(403);
      expect((await change(token, { email: 'guess@example.com', password: PASSWORD })).statusCode).toBe(429);
    });

    it("confirms the new address, and tells the old one only if it was confirmed (an unconfirmed one may be a stranger's)", async () => {
      const notice = 'Your cubr email was changed';
      const confirmed = await signUp();
      await confirmEmailOf(confirmed.user.id);
      await change(confirmed.token, { email: 'confirmed.moved@example.com', password: PASSWORD });
      expect((await confirm(await linkFor(confirmed.user.id))).statusCode).toBe(200);
      const never = await signUp();
      await change(never.token, { email: 'never.moved@example.com', password: PASSWORD });
      expect((await confirm(await linkFor(never.user.id))).statusCode).toBe(200);

      await vi.waitFor(() => expect(mailsTo(confirmed.user.email, notice)).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 200));
      expect(mailsTo(never.user.email, notice)).toHaveLength(0);
      for (const { token } of [confirmed, never]) expect((await me(token)).json().user.emailVerified).toBe(true);
    });
  });

  describe('changing the password', () => {
    const changePassword = (token: string, body: Record<string, unknown>) => s.request('POST', '/api/auth/me/password', { token, body, ip: freshIp() });

    it('checks the current password, then signs out every other session and signs this one in again', async () => {
      const { user, token } = await signUp();
      const otherDevice = (await login(user.username)).json().token as string;
      expect((await changePassword(token, { password: 'not it', newPassword: 'brand new pass' })).statusCode).toBe(403);
      expect((await changePassword(token, { newPassword: 'brand new pass' })).statusCode).toBe(403);
      expect((await me(token)).statusCode).toBe(200); // a wrong password changes nothing
      const res = await changePassword(token, { password: PASSWORD, newPassword: 'brand new pass' });
      expect(res.statusCode, res.body).toBe(200);
      const { token: fresh, user: after } = res.json();
      expect(after).toMatchObject({ id: user.id, username: user.username, hasPassword: true });
      expect((await me(fresh)).statusCode).toBe(200);
      expect((await me(token)).statusCode).toBe(401);
      expect((await me(otherDevice)).statusCode).toBe(401);
      expect((await login(user.username)).statusCode).toBe(401);
      expect((await login(user.username, 'brand new pass')).statusCode).toBe(200);
    });

    it('refuses the same password again, a new one under 8 characters, and no sign-in', async () => {
      const { token, user } = await signUp();
      const same = await changePassword(token, { password: PASSWORD, newPassword: PASSWORD });
      expect(same.statusCode).toBe(400);
      expect(same.json().error.message).toMatch(/already your password/i);
      expect((await changePassword(token, { password: PASSWORD, newPassword: 'short' })).statusCode).toBe(400);
      expect((await s.request('POST', '/api/auth/me/password', { body: { password: PASSWORD, newPassword: 'brand new pass' }, ip: freshIp() })).statusCode).toBe(401);
      expect((await me(token)).statusCode).toBe(200);
      expect((await login(user.username)).statusCode).toBe(200); // the password is unchanged
    });

    it('ends the pending password-reset links', async () => {
      const { token, user } = await signUp();
      const reset = newResetToken();
      await s.pool.query(`insert into auth.password_resets (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 hour')`, [reset.hash, user.id]);
      expect((await changePassword(token, { password: PASSWORD, newPassword: 'brand new pass' })).statusCode).toBe(200);
      const viaLink = await s.request('POST', '/api/auth/password/reset', { body: { token: reset.token, password: 'another pass 2' }, ip: freshIp() });
      expect(viaLink.statusCode).toBe(400);
    });

    it('lets an account without a password set its first, only right after signing in', async () => {
      const { user } = await signUp();
      await s.pool.query('update auth.users set password_hash = null where id = $1', [user.id]);
      const now = Math.floor(Date.now() / 1000);
      const stale = (await signToken(s.config.jwtSecret, user, 3600, now - 20 * 60)).token;
      const fresh = (await signToken(s.config.jwtSecret, user, 3600, now)).token;
      const refused = await changePassword(stale, { newPassword: 'first password' });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.message).toMatch(/sign in again/i);
      const res = await changePassword(fresh, { newPassword: 'first password' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().user.hasPassword).toBe(true);
      expect((await login(user.username, 'first password')).statusCode).toBe(200);
    });

    it('allows 5 attempts an hour per account', async () => {
      const { token } = await signUp();
      for (let i = 0; i < 5; i++) expect((await changePassword(token, { password: `guess ${i}`, newPassword: 'brand new pass' })).statusCode).toBe(403);
      expect((await changePassword(token, { password: PASSWORD, newPassword: 'brand new pass' })).statusCode).toBe(429);
    });

    it("tells the account's email, only if it's confirmed (an unconfirmed one may be a stranger's)", async () => {
      const notice = 'Your cubr password was changed';
      const confirmed = await signUp();
      await confirmEmailOf(confirmed.user.id);
      expect((await changePassword(confirmed.token, { password: PASSWORD, newPassword: 'brand new pass' })).statusCode).toBe(200);
      const never = await signUp();
      expect((await changePassword(never.token, { password: PASSWORD, newPassword: 'brand new pass' })).statusCode).toBe(200);

      await vi.waitFor(() => expect(mailsTo(confirmed.user.email, notice)).toHaveLength(1));
      expect(mailsTo(confirmed.user.email, notice)[0].text).toMatch(/on the sign-in page \(http\S*\/login\)/);
      await new Promise((r) => setTimeout(r, 200));
      expect(mailsTo(never.user.email, notice)).toHaveLength(0);
    });
  });

  describe('confirming the email', () => {
    const confirm = (token: string) => s.request('POST', '/api/auth/email/confirm', { body: { token }, ip: freshIp() });
    const sendAgain = (token: string) => s.request('POST', '/api/auth/me/email/confirmation', { token, ip: freshIp() });

    it('emails a link at sign-up; the account works at once, unconfirmed until the link is opened', async () => {
      const { token, user } = await signUp({ username: 'Fresh_Start', email: 'Fresh.Start@example.com' });
      expect(user).toMatchObject({ emailVerified: false });
      expect((await me(token)).json().user.emailVerified).toBe(false);
      const link = await emailedLink('Fresh.Start@example.com');
      const [mail] = mailsTo('Fresh.Start@example.com', 'Confirm your cubr email');
      expect(mail.text).toContain('Hi Fresh_Start,');
      expect(mail.text).toContain('for 7 days');
      // only the hash is stored, with the address it went to, for a week
      const { rows } = await s.pool.query(`select token_hash, new_email, expires_at > now() + interval '6 days' as week from auth.email_changes where user_id = $1`, [user.id]);
      expect(rows).toHaveLength(1);
      expect(Buffer.isBuffer(rows[0].token_hash)).toBe(true);
      expect(rows[0]).toMatchObject({ new_email: 'Fresh.Start@example.com', week: true });

      const ok = await confirm(link);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toEqual({ email: 'Fresh.Start@example.com', changed: false });
      expect((await me(token)).json().user).toMatchObject({ email: 'Fresh.Start@example.com', emailVerified: true });
      expect((await confirm(link)).statusCode).toBe(400); // the link works once
      // confirming isn't a change: no "your email was changed"
      await new Promise((r) => setTimeout(r, 200));
      expect(mailsTo('Fresh.Start@example.com', 'Your cubr email was changed')).toHaveLength(0);
    });

    it("sends none for the seed job's accounts (internal token)", async () => {
      const res = await s.request('POST', '/api/auth/register', {
        body: { username: 'seeded_one', email: 'seeded.one@example.com', password: PASSWORD },
        ip: freshIp(),
        headers: { 'x-internal-token': s.config.internalToken },
      });
      expect(res.statusCode).toBe(201);
      expect((await s.pool.query('select 1 from auth.email_changes where user_id = $1', [res.json().user.id])).rowCount).toBe(0);
      await new Promise((r) => setTimeout(r, 200));
      expect(outbox.filter((m) => m.to === 'seeded.one@example.com')).toHaveLength(0);
    });

    it('sends a new link on request, which replaces the old one; none once confirmed, none without a sign-in', async () => {
      const { token, user } = await signUp();
      const first = await emailedLink(user.email);
      const res = await sendAgain(token);
      expect(res.statusCode, res.body).toBe(202);
      expect(res.json()).toEqual({ ok: true, email: user.email });
      const second = await emailedLink(user.email, first);
      expect((await confirm(first)).statusCode).toBe(400);
      expect((await confirm(second)).statusCode).toBe(200);
      const again = await sendAgain(token);
      expect(again.statusCode).toBe(400);
      expect(again.json().error.message).toBe('Your email is already confirmed');
      expect((await s.request('POST', '/api/auth/me/email/confirmation', { ip: freshIp() })).statusCode).toBe(401);
    });

    it('sends at most 3 new links an hour per account, so an account made with your address cannot flood you', async () => {
      const { token } = await signUp();
      for (let i = 0; i < 3; i++) expect((await sendAgain(token)).statusCode).toBe(202);
      expect((await sendAgain(token)).statusCode).toBe(429);
    });

    it('ends the sign-up link when the account asks to move to another address', async () => {
      const { token, user } = await signUp();
      const fromSignUp = await emailedLink(user.email);
      expect((await s.request('POST', '/api/auth/me/email', { token, body: { email: 'elsewhere@example.com', password: PASSWORD }, ip: freshIp() })).statusCode).toBe(202);
      expect((await confirm(fromSignUp)).statusCode).toBe(400);
      expect((await me(token)).json().user).toMatchObject({ email: user.email, emailVerified: false });
    });
  });

  // what is logged, and that nothing ties it to an IP address: clientErrors.route.test.ts
  describe('front-end error reports', () => {
    const report = { kind: 'unhandledrejection', message: 'Failed to fetch', route: '/leaderboards', build: 'index-D3oOLUDV.js', browser: 'Chrome 142 on Android', installed: true };
    const post = (body: unknown, ip = freshIp()) => s.request('POST', '/api/errors', { body, ip });

    it('takes a report, without signing in, and answers with no content', async () => {
      const res = await post(report);
      expect(res.statusCode, res.body).toBe(204);
      expect(res.body).toBe('');
    });

    it('refuses anything else: other fields, a missing route, a body over 16 KB', async () => {
      expect((await post({ ...report, email: 'jo@example.com' })).statusCode).toBe(400);
      expect((await post({ ...report, route: undefined })).statusCode).toBe(400);
      expect((await post({ ...report, message: 'x'.repeat(17 * 1024) })).statusCode).toBe(413);
    });

    it('limits one address to 30 reports per 10 minutes', async () => {
      const ip = freshIp();
      for (let i = 0; i < 30; i++) expect((await post(report, ip)).statusCode).toBe(204);
      expect((await post(report, ip)).statusCode).toBe(429);
    });
  });
});
