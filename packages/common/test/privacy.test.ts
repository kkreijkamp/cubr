import { describe, expect, it } from 'vitest';
import { canViewProfile, isPrivateProfile, PRIVATE_USERS_KEY } from '../src/privacy.js';
import type { Redis } from '../src/redis.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

function fakeRedis(members: string[], mode: 'ok' | 'throw' | 'hang' = 'ok') {
  return {
    async sismember(key: string, id: string) {
      if (mode === 'throw') throw new Error('connection is closed');
      if (mode === 'hang') return new Promise(() => {});
      return key === PRIVATE_USERS_KEY && members.includes(id) ? 1 : 0;
    },
  } as unknown as Redis;
}

describe('private profiles', () => {
  it('reads the set (ids compared lower-case)', async () => {
    expect(await isPrivateProfile(fakeRedis([A]), A.toUpperCase())).toBe(true);
    expect(await isPrivateProfile(fakeRedis([A]), B)).toBe(false);
  });

  it('fails closed when Redis errors or is too slow', async () => {
    expect(await isPrivateProfile(fakeRedis([], 'throw'), B)).toBe(true);
    expect(await isPrivateProfile(fakeRedis([], 'hang'), B, 20)).toBe(true);
  });

  it('always lets the owner in; strangers only into public profiles', async () => {
    const r = fakeRedis([A]);
    expect(await canViewProfile(r, A, A)).toBe(true);
    expect(await canViewProfile(fakeRedis([A], 'throw'), A, A)).toBe(true);
    expect(await canViewProfile(r, B, A)).toBe(false);
    expect(await canViewProfile(r, null, A)).toBe(false);
    expect(await canViewProfile(r, null, B)).toBe(true);
  });
});
