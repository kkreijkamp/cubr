import { describe, expect, it } from 'vitest';
import {
  conflictMessage,
  loginSchema,
  registerSchema,
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

describe('conflictMessage', () => {
  it('distinguishes username vs email constraint', () => {
    expect(conflictMessage('users_username_lower')).toMatch(/username/i);
    expect(conflictMessage('users_email_lower')).toMatch(/email/i);
    expect(conflictMessage(undefined)).toMatch(/username or email/i);
  });
});
