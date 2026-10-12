import { describe, expect, it } from 'vitest';
import {
  buildUserUpdate,
  conflictMessage,
  jsonBytes,
  loginSchema,
  parseIdList,
  patchMeSchema,
  registerSchema,
  settingsSchema,
  toPrivateUser,
  toPublicUser,
  type UserRow,
} from '../src/users.js';

const row: UserRow = {
  id: '6f1c1b5e-1f3a-4f7e-9a51-2b8f3c4d5e6f',
  username: 'Felix_Z',
  email: 'felix@example.com',
  password_hash: '$2a$10$secret',
  display_name: 'Felix',
  bio: null,
  country: 'AU',
  wca_id: null,
  created_at: new Date('2026-01-02T03:04:05.000Z'),
};

describe('registerSchema', () => {
  it('accepts a valid registration and trims', () => {
    const r = registerSchema.parse({ username: ' cuber_01 ', email: ' a@b.co ', password: 'password1' });
    expect(r).toEqual({ username: 'cuber_01', email: 'a@b.co', password: 'password1' });
  });
  it.each([
    [{ username: 'ab', email: 'a@b.co', password: 'password1' }],
    [{ username: 'has space', email: 'a@b.co', password: 'password1' }],
    [{ username: 'a'.repeat(21), email: 'a@b.co', password: 'password1' }],
    [{ username: 'abc', email: 'not-an-email', password: 'password1' }],
    [{ username: 'abc', email: 'a@b.co', password: 'short' }],
    [{ username: 'abc', email: 'a@b.co', password: 'x'.repeat(129) }],
    [{ username: 'abc', email: 'a@b.co' }],
  ])('rejects %j', (input) => {
    expect(registerSchema.safeParse(input).success).toBe(false);
  });
});

describe('loginSchema', () => {
  it('requires login and password', () => {
    expect(loginSchema.safeParse({ login: 'x', password: 'y' }).success).toBe(true);
    expect(loginSchema.safeParse({ login: '', password: 'y' }).success).toBe(false);
    expect(loginSchema.safeParse({ login: 'x' }).success).toBe(false);
  });
});

describe('patchMeSchema', () => {
  it('uppercases country and wcaId', () => {
    expect(patchMeSchema.parse({ country: 'au', wcaId: '2015abcd01' })).toEqual({ country: 'AU', wcaId: '2015ABCD01' });
  });
  it('treats null and blank strings as clear', () => {
    expect(patchMeSchema.parse({ country: null, bio: '  ', displayName: '' })).toEqual({
      country: null,
      bio: null,
      displayName: null,
    });
  });
  it('leaves missing fields undefined', () => {
    expect(patchMeSchema.parse({})).toEqual({});
  });
  it.each([
    [{ country: 'AUS' }],
    [{ country: 'A1' }],
    [{ wcaId: '15ABCD01' }],
    [{ wcaId: '2015KRE101' }],
    [{ displayName: 'x'.repeat(41) }],
    [{ bio: 'x'.repeat(281) }],
    [{ bio: 42 }],
  ])('rejects %j', (input) => {
    expect(patchMeSchema.safeParse(input).success).toBe(false);
  });
});

describe('settingsSchema / jsonBytes', () => {
  it('accepts objects, rejects arrays and primitives', () => {
    expect(settingsSchema.safeParse({ settings: { theme: 'serika' } }).success).toBe(true);
    expect(settingsSchema.safeParse({ settings: [1, 2] }).success).toBe(false);
    expect(settingsSchema.safeParse({ settings: 'x' }).success).toBe(false);
    expect(settingsSchema.safeParse({ settings: null }).success).toBe(false);
  });
  it('measures UTF-8 bytes of the JSON', () => {
    expect(jsonBytes({ a: 1 })).toBe(7);
    expect(jsonBytes({ a: 'é' })).toBe(10);
  });
});

describe('row mapping', () => {
  it('maps to PublicUser without email or password', () => {
    const u = toPublicUser(row);
    expect(u).toEqual({
      id: row.id,
      username: 'Felix_Z',
      displayName: 'Felix',
      bio: null,
      country: 'AU',
      wcaId: null,
      createdAt: '2026-01-02T03:04:05.000Z',
    });
    expect(u).not.toHaveProperty('email');
    expect(u).not.toHaveProperty('password_hash');
  });
  it('PrivateUser adds email only', () => {
    const u = toPrivateUser(row);
    expect(u.email).toBe('felix@example.com');
    expect(u).not.toHaveProperty('passwordHash');
    expect(u).not.toHaveProperty('password_hash');
  });
  it('trims padded char(2) country and handles string timestamps', () => {
    const u = toPublicUser({ ...row, country: '  ', created_at: '2026-01-02T03:04:05Z' });
    expect(u.country).toBeNull();
    expect(u.createdAt).toBe('2026-01-02T03:04:05.000Z');
  });
});

describe('buildUserUpdate', () => {
  it('only includes provided fields with positional params', () => {
    expect(buildUserUpdate({ bio: 'hi', country: null })).toEqual({
      sets: ['bio = $1', 'country = $2'],
      values: ['hi', null],
    });
    expect(buildUserUpdate({})).toEqual({ sets: [], values: [] });
  });
});

describe('parseIdList', () => {
  const a = '6f1c1b5e-1f3a-4f7e-9a51-2b8f3c4d5e6f';
  const b = '00000000-0000-4000-8000-000000000001';
  it('drops invalid ids and duplicates, keeps order, lowercases', () => {
    expect(parseIdList(`${b}, nope ,${a.toUpperCase()},${b},`)).toEqual([b, a]);
  });
  it('returns [] for empty input and null when over the limit', () => {
    expect(parseIdList(undefined)).toEqual([]);
    expect(parseIdList('')).toEqual([]);
    expect(parseIdList(Array(101).fill(a).join(','))).toBeNull();
    expect(parseIdList(Array(100).fill(a).join(','))).toEqual([a]);
  });
});

describe('conflictMessage', () => {
  it('distinguishes username vs email constraint', () => {
    expect(conflictMessage('users_username_lower')).toMatch(/username/i);
    expect(conflictMessage('users_email_lower')).toMatch(/email/i);
    expect(conflictMessage(undefined)).toMatch(/username or email/i);
  });
});
