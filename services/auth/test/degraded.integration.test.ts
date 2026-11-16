// Auth with Redis down. Redis is a soft dependency (src/safe.ts): sign-up, login and tokens keep
// working (rate limits and revocation checks fail open, events are logged), but every change that
// would weaken security without it - making a profile private, logging out, deleting the account,
// resetting a password - refuses with 503 and changes nothing. Also the private-profile set sync.
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';
import { makeAuth, PRIVATE_USERS_KEY } from '@cubr/common';
import { describeIntegration, startTestServer, type TestServer } from '@cubr/testkit';
import { migrations } from '../src/migrations.js';
import { syncPrivateUsers } from '../src/privacySync.js';
import { newResetToken } from '../src/reset.js';
import { registerRoutes } from '../src/routes/index.js';

const PASSWORD = 'correct horse 1';

describeIntegration('auth with Redis down', () => {
  let s: TestServer;
  let deadRedis: Redis;
  let n = 0;

  beforeAll(async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    // never connects and doesn't queue: every command fails at once, as when Redis is down
    deadRedis = new Redis('redis://127.0.0.1:1', { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
    deadRedis.on('error', () => undefined); // expected: nothing listens there
    s = await startTestServer({
      service: 'auth',
      infoPrefixes: ['/api/auth', '/api/users', '/api/supporters'],
      schemas: [{ schema: 'auth', migrations }],
      routes: ({ app, config, pool }) => registerRoutes(app, { config, pool, redis: deadRedis, auth: makeAuth(config.jwtSecret, deadRedis) }),
    });
  });
  afterAll(async () => {
    await s?.close();
    deadRedis?.disconnect();
    vi.unstubAllEnvs();
  });

  async function signUp() {
    const i = ++n;
    const res = await s.request('POST', '/api/auth/register', { body: { username: `offline_${i}`, email: `offline${i}@example.com`, password: PASSWORD } });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { token: string; user: { id: string; username: string } };
  }
  const row = async (id: string) => (await s.pool.query('select profile_private, password_hash from auth.users where id = $1', [id])).rows[0];

  it('still signs up, logs in and accepts tokens', async () => {
    const { user, token } = await signUp();
    expect((await s.request('GET', '/api/auth/me', { token })).statusCode).toBe(200);
    const login = await s.request('POST', '/api/auth/login', { body: { login: user.username, password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    expect((await s.request('PATCH', '/api/auth/me', { token, body: { bio: 'still works' } })).statusCode).toBe(200);
  }, 20_000);

  it('refuses to make a profile private rather than leave it readable', async () => {
    const { user, token } = await signUp();
    const res = await s.request('PATCH', '/api/auth/me', { token, body: { private: true, bio: 'set together' } });
    expect(res.statusCode).toBe(503);
    expect((await row(user.id)).profile_private).toBe(false);
    // the whole update rolled back, not just the flag
    expect((await s.request('GET', `/api/users/${user.username}`)).json().user.bio ?? null).toBeNull();
  }, 20_000);

  it('refuses to log out rather than leave the token working', async () => {
    const { token } = await signUp();
    expect((await s.request('POST', '/api/auth/logout', { token })).statusCode).toBe(503);
  }, 20_000);

  it('refuses to delete the account rather than leave its tokens valid, and deletes nothing', async () => {
    const { user, token } = await signUp();
    expect((await s.request('DELETE', '/api/auth/me', { token, body: { password: PASSWORD } })).statusCode).toBe(503);
    expect(await row(user.id)).toBeDefined();
  }, 20_000);

  it('refuses a password reset it cannot follow by signing out the other sessions, and keeps the link', async () => {
    const { user } = await signUp();
    const { token: link, hash } = newResetToken();
    await s.pool.query(`insert into auth.password_resets (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 hour')`, [hash, user.id]);
    const before = (await row(user.id)).password_hash;
    const res = await s.request('POST', '/api/auth/password/reset', { body: { token: link, password: 'brand new pass' } });
    expect(res.statusCode).toBe(503);
    expect((await row(user.id)).password_hash).toBe(before);
    expect((await s.pool.query('select 1 from auth.password_resets where user_id = $1', [user.id])).rowCount).toBe(1);
  }, 20_000);
});

describeIntegration('the private-profile set', () => {
  let s: TestServer;

  beforeAll(async () => {
    vi.stubEnv('RESEND_API_KEY', '');
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

  it('is rebuilt from the database after Redis loses it, and sync never removes anyone', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await s.request('POST', '/api/auth/register', { body: { username: `sync_${i}`, email: `sync${i}@example.com`, password: PASSWORD } });
      ids.push(res.json().user.id);
      if (i < 2) await s.request('PATCH', '/api/auth/me', { token: res.json().token, body: { private: true } });
    }
    await s.redis.del(PRIVATE_USERS_KEY); // e.g. Redis restarted without its data
    await s.redis.sadd(PRIVATE_USERS_KEY, ids[2]); // a stray member: a sync must not be the thing that removes it
    expect(await syncPrivateUsers(s.pool, s.redis)).toBe(2);
    expect((await s.redis.smembers(PRIVATE_USERS_KEY)).sort()).toEqual([...ids].sort());
  });
});
