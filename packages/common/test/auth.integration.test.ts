// makeAuth's requireAuth / optionalAuth against a real Redis (@cubr/testkit): logout revocation
// (auth:revoked:<jti>), account-wide revocation (auth:revoked-user:<id>, password reset and
// account deletion), forged tokens, and failing open when Redis is down or does not answer.
import { randomUUID } from 'node:crypto';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { SignJWT, UnsecuredJWT } from 'jose';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestRedis, describeIntegration } from '@cubr/testkit';
import { makeAuth, revokedKey, revokedUserKey, signToken, verifyToken } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createRedis, type Redis } from '../src/redis.js';
import { createServer } from '../src/server.js';

const SECRET = 'auth-integration-secret-0123456789abcdef';
const key = new TextEncoder().encode(SECRET);

describeIntegration('makeAuth with revocation', () => {
  let redis: Redis;
  const apps: FastifyInstance[] = [];

  /** /private needs a token, /maybe takes one if it is good; both say who they think you are. */
  async function appWith(client: Redis): Promise<FastifyInstance> {
    const { app } = createServer({ ...loadConfig('test'), logLevel: 'silent' }, { infoPrefixes: [] });
    const auth = makeAuth(SECRET, client);
    app.get('/private', { preHandler: auth.requireAuth }, async (req) => ({ id: req.user!.id, username: req.user!.username }));
    app.get('/maybe', { preHandler: auth.optionalAuth }, async (req) => ({ id: req.user?.id ?? null }));
    await app.ready();
    apps.push(app);
    return app;
  }
  let app: FastifyInstance;
  const call = (path: string, authorization?: string, target = app) => target.inject({ url: path, headers: authorization ? { authorization } : {} });
  const bearer = (token: string) => `Bearer ${token}`;
  const newUser = () => ({ id: randomUUID(), username: `user_${randomUUID().slice(0, 8)}` });

  beforeAll(async () => {
    redis = await createTestRedis();
    app = await appWith(redis);
  });
  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
    redis?.disconnect();
  });

  it('accepts a valid token and refuses it once it is logged out', async () => {
    const user = newUser();
    const { token, jti, exp } = await signToken(SECRET, user);
    const ok = await call('/private', bearer(token));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(user);

    await redis.set(revokedKey(jti), '1', 'EX', exp - Math.floor(Date.now() / 1000));
    const out = await call('/private', bearer(token));
    expect(out.statusCode).toBe(401);
    expect(out.json().error.code).toBe('UNAUTHORIZED');
    expect((await call('/maybe', bearer(token))).json()).toEqual({ id: null }); // optional routes: anonymous
  });

  it('refuses every token of a user issued up to an account-wide revocation, but not the new one issued after it', async () => {
    const user = newUser();
    const older = await signToken(SECRET, user);
    const { iat } = await verifyToken(SECRET, older.token);
    await redis.set(revokedUserKey(user.id), String(iat), 'EX', 60); // what a password reset stores
    expect((await call('/private', bearer(older.token))).statusCode).toBe(401);
    expect((await call('/maybe', bearer(older.token))).json()).toEqual({ id: null });

    const newer = await signToken(SECRET, user, 3600, iat! + 1); // the sign-in that comes with the reset
    expect((await call('/private', bearer(newer.token))).json()).toEqual(user);
  });

  it("ignores other tokens' and other users' revocations", async () => {
    const user = newUser();
    const mine = await signToken(SECRET, user);
    const other = await signToken(SECRET, user);
    await redis.set(revokedKey(other.jti), '1', 'EX', 60);
    await redis.set(revokedUserKey(randomUUID()), '9999999999', 'EX', 60);
    expect((await call('/private', bearer(mine.token))).statusCode).toBe(200);
  });

  /** A token for `user` built by hand, so a test can break one thing about it. */
  async function craft(
    user: { id: string; username: string },
    opts: { alg?: string; secret?: Uint8Array; issuer?: string; claims?: Record<string, unknown>; jti?: boolean; exp?: string | number } = {},
  ) {
    const jwt = new SignJWT({ username: user.username, ...opts.claims })
      .setProtectedHeader({ alg: opts.alg ?? 'HS256' })
      .setSubject(user.id)
      .setIssuer(opts.issuer ?? 'cubr')
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '1h');
    if (opts.jti !== false) jwt.setJti(randomUUID());
    return jwt.sign(opts.secret ?? key);
  }

  it.each([
    [
      'an unsigned token (alg "none")',
      async (u: { id: string; username: string }) =>
        new UnsecuredJWT({ username: u.username }).setSubject(u.id).setIssuer('cubr').setJti(randomUUID()).setIssuedAt().setExpirationTime('1h').encode(),
    ],
    [
      'a token signed with another secret',
      async (u: { id: string; username: string }) => craft(u, { secret: new TextEncoder().encode('not-the-secret-not-the-secret-xx') }),
    ],
    ['a token signed with HS512', async (u: { id: string; username: string }) => craft(u, { alg: 'HS512' })],
    ['a token from another issuer', async (u: { id: string; username: string }) => craft(u, { issuer: 'evil' })],
    ['an expired token', async (u: { id: string; username: string }) => craft(u, { exp: Math.floor(Date.now() / 1000) - 10 })],
    ['a token without a username', async (u: { id: string; username: string }) => craft(u, { claims: { username: undefined } })],
    ['a token without a jti', async (u: { id: string; username: string }) => craft(u, { jti: false })],
    [
      'a token whose payload was edited',
      async (u: { id: string; username: string }) => {
        const [header, payload, signature] = (await signToken(SECRET, u)).token.split('.');
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
        return [header, Buffer.from(JSON.stringify({ ...claims, sub: randomUUID(), username: 'admin' })).toString('base64url'), signature].join('.');
      },
    ],
  ])('refuses %s', async (_what, make) => {
    const token = await make(newUser());
    expect((await call('/private', bearer(token))).statusCode).toBe(401);
    expect((await call('/maybe', bearer(token))).json()).toEqual({ id: null });
  });

  it.each([
    ['no header', undefined],
    ['an empty bearer', 'Bearer '],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
    ['a bare token', 'eyJhbGciOiJIUzI1NiJ9.e30.x'],
  ])('answers 401 to %s', async (_what, authorization) => {
    expect((await call('/private', authorization)).statusCode).toBe(401);
  });

  it('fails open when Redis is down: good tokens still work (revoked ones too), forged ones still do not', async () => {
    const closed = redis.duplicate();
    await closed.quit();
    const down = await appWith(closed);
    const user = newUser();
    const { token, jti } = await signToken(SECRET, user);
    await redis.set(revokedKey(jti), '1', 'EX', 60);
    expect((await call('/private', bearer(token), down)).statusCode).toBe(200);
    expect((await call('/private', bearer(await craft(user, { issuer: 'evil' })), down)).statusCode).toBe(401);
  });

  it('does not wait more than about 300 ms for a Redis that never answers', async () => {
    // accepts connections and never replies: like a paused or partitioned Redis
    const sockets = new Set<Socket>();
    const silent: TcpServer = createTcpServer((s) => void sockets.add(s));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const hanging = createRedis(`redis://127.0.0.1:${(silent.address() as AddressInfo).port}`);
    try {
      const slow = await appWith(hanging);
      const { token } = await signToken(SECRET, newUser());
      const started = performance.now();
      expect((await call('/private', bearer(token), slow)).statusCode).toBe(200);
      const ms = performance.now() - started;
      expect(ms).toBeGreaterThanOrEqual(250);
      expect(ms).toBeLessThan(2000);
    } finally {
      hanging.disconnect();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});
