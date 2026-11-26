// Migration 008 (email confirmation) on a database that already has accounts, as production will:
// they all keep password reset until they confirm, and an address Google, Apple or GitHub vouched
// for counts as confirmed. Accounts made afterwards start unconfirmed, without the exemption.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from '@cubr/common';
import { describeIntegration, startTestServer, type TestServer } from '@cubr/testkit';
import { migrations } from '../src/migrations.js';

describeIntegration('auth migration 008 on existing accounts', () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startTestServer({
      service: 'auth',
      infoPrefixes: [],
      schemas: [{ schema: 'auth', migrations: migrations.filter((m) => m.id < '008') }],
      routes: () => undefined,
    });
  });
  afterAll(async () => {
    await s?.close();
  });

  const add = async (username: string, email: string, withPassword = true) =>
    (
      await s.pool.query<{ id: string }>('insert into auth.users (username, email, password_hash) values ($1, $2, $3) returning id', [
        username,
        email,
        withPassword ? '$2a$10$hash' : null,
      ])
    ).rows[0].id;
  const link = (provider: string, userId: string, email: string | null, createdAt = new Date()) =>
    s.pool.query('insert into auth.user_identities (provider, subject, user_id, email, created_at) values ($1, $2, $3, $4, $5)', [
      provider,
      `${provider}-${userId}`,
      userId,
      email,
      createdAt,
    ]);

  it('keeps reset links for every existing account, and confirms the addresses a provider vouched for', async () => {
    await add('a_password', 'password.only@example.com');
    const google = await add('b_google', 'G.User@example.com', false);
    await link('google', google, 'g.user@example.com', new Date('2026-11-16T10:00:00Z'));
    const other = await add('c_other', 'own.address@example.com');
    await link('github', other, 'a.different.one@example.com');
    const noEmail = await add('d_apple', 'hidden@example.com');
    await link('apple', noEmail, null);

    await migrate(s.pool, 'auth', migrations); // applies 008 only

    const { rows } = await s.pool.query(
      'select username, predates_email_confirmation as predates, email_verified_at as verified from auth.users order by username',
    );
    expect(rows).toEqual([
      { username: 'a_password', predates: true, verified: null },
      { username: 'b_google', predates: true, verified: new Date('2026-11-16T10:00:00Z') },
      { username: 'c_other', predates: true, verified: null },
      { username: 'd_apple', predates: true, verified: null },
    ]);

    await add('e_new', 'brand.new@example.com');
    const fresh = await s.pool.query("select predates_email_confirmation as predates, email_verified_at as verified from auth.users where username = 'e_new'");
    expect(fresh.rows[0]).toEqual({ predates: false, verified: null });
  });
});
