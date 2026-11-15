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
