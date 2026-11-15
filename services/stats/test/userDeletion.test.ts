import { describe, expect, it } from 'vitest';
import { CONSUMED_TYPES, userDeletedSchema } from '../src/eventSchemas.js';
import { migrations } from '../src/migrations.js';
import { USER_TABLES } from '../src/projector.js';

describe('user.deleted', () => {
  it('is consumed, with a uuid userId', () => {
    expect(CONSUMED_TYPES).toContain('user.deleted');
    expect(userDeletedSchema.safeParse({ eventId: 'auth-1', userId: '00000000-0000-4000-8000-000000000001' }).success).toBe(true);
    expect(userDeletedSchema.safeParse({ eventId: 'auth-1', userId: 'nope' }).success).toBe(false);
  });

  it('deletes from every stats table that has a user_id (but keeps the tombstones)', () => {
    const sql = migrations.map((m) => m.sql).join('\n');
    const withUser = [...sql.matchAll(/CREATE TABLE stats\.(\w+) \(([^;]*?)\n\);/g)]
      .filter(([, , body]) => /\buser_id\b/.test(body))
      .map(([, name]) => name)
      .filter((name) => name !== 'deleted_users');
    expect(withUser.length).toBeGreaterThan(5);
    expect([...USER_TABLES].sort()).toEqual(withUser.sort());
  });
});
