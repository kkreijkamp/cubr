import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { makeAuth, revokedKey, revokedUserKey, signToken, tokenRevoked, verifyToken } from '../src/auth.js';
import type { Redis } from '../src/redis.js';

const SECRET = 'test-secret-at-least-32-characters-long';
const USER = { id: '00000000-0000-4000-8000-000000000001', username: 'cuber' };

/** Just enough of ioredis for the revocation check: MGET on an in-memory store. */
function fakeRedis(store: Record<string, string> = {}, opts: { fail?: boolean } = {}) {
  return {
    async mget(...keys: string[]) {
      if (opts.fail) throw new Error('connection is closed');
      return keys.map((k) => store[k] ?? null);
    },
  } as unknown as Redis;
}

const request = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as unknown as FastifyRequest;

describe('token revocation', () => {
  it('a revoked jti, or a user revoked at or after the token was issued, is revoked', () => {
    expect(tokenRevoked({ iat: 100 }, null, null)).toBe(false);
    expect(tokenRevoked({ iat: 100 }, '1', null)).toBe(true);
    expect(tokenRevoked({ iat: 100 }, null, '100')).toBe(true);
    expect(tokenRevoked({ iat: 100 }, null, '150')).toBe(true);
    // issued after the revocation (e.g. a deletion that was rolled back, then a new login)
    expect(tokenRevoked({ iat: 100 }, null, '99')).toBe(false);
    expect(tokenRevoked({}, null, '1')).toBe(true);
  });

  it('resolve() rejects tokens of a deleted account and keeps others', async () => {
    const { token, jti } = await signToken(SECRET, USER);
    const { iat } = await verifyToken(SECRET, token);
    expect(typeof iat).toBe('number');

    expect((await makeAuth(SECRET, fakeRedis()).resolve(request(token)))?.id).toBe(USER.id);
    expect(await makeAuth(SECRET, fakeRedis({ [revokedKey(jti)]: '1' })).resolve(request(token))).toBeNull();
    expect(await makeAuth(SECRET, fakeRedis({ [revokedUserKey(USER.id)]: String(iat) })).resolve(request(token))).toBeNull();
    expect((await makeAuth(SECRET, fakeRedis({ [revokedUserKey(USER.id)]: String(iat! - 1) })).resolve(request(token)))?.id).toBe(USER.id);
    // another user's revocation does not matter
    expect((await makeAuth(SECRET, fakeRedis({ [revokedUserKey('someone-else')]: '9999999999' })).resolve(request(token)))?.id).toBe(USER.id);
  });

  it('fails open when Redis is down', async () => {
    const { token } = await signToken(SECRET, USER);
    expect((await makeAuth(SECRET, fakeRedis({}, { fail: true })).resolve(request(token)))?.id).toBe(USER.id);
  });
});

describe('rotating the signing key (JWT_SECRET_PREVIOUS)', () => {
  const OLD = 'the-old-secret-also-32-characters-long!';
  const req = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as unknown as FastifyRequest;

  it('verifies a token signed with the previous key while it is given, and not once it is gone', async () => {
    const { token } = await signToken(OLD, USER);
    await expect(verifyToken(SECRET, token, OLD)).resolves.toMatchObject({ id: USER.id, username: USER.username });
    await expect(verifyToken(SECRET, token)).rejects.toThrow();
    const fresh = await signToken(SECRET, USER); // new tokens: the new key, whichever is given as previous
    await expect(verifyToken(SECRET, fresh.token, OLD)).resolves.toMatchObject({ id: USER.id });
  });

  it('keeps an expired token expired, and a token of some other key refused', async () => {
    const expired = await signToken(SECRET, USER, -60); // expired a minute ago
    await expect(verifyToken(SECRET, expired.token, OLD)).rejects.toThrow(/exp/);
    const oldExpired = await signToken(OLD, USER, -60);
    await expect(verifyToken(SECRET, oldExpired.token, OLD)).rejects.toThrow(/exp/);
    const stranger = await signToken('some-other-secret-of-32-characters!!', USER);
    await expect(verifyToken(SECRET, stranger.token, OLD)).rejects.toThrow();
  });

  it('signs in with a previous-key token through makeAuth too', async () => {
    const { token } = await signToken(OLD, USER);
    const withPrevious = makeAuth(SECRET, undefined, OLD);
    const r = req(token);
    await withPrevious.requireAuth(r, {} as never);
    expect(r.user).toMatchObject({ id: USER.id });
    await expect(makeAuth(SECRET).requireAuth(req(token), {} as never)).rejects.toThrow();
  });
});
