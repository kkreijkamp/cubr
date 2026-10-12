import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { conflict, parse, signToken, unauthorized, withTx } from '@cubetype/common';
import type { Deps } from './index.js';
import {
  USER_COLUMNS,
  UUID_RE,
  conflictMessage,
  loginSchema,
  registerSchema,
  toPrivateUser,
  type UserRow,
} from '../users.js';

const BCRYPT_COST = 10;

// Hash of a random password, compared against when the login name is unknown so that
// "no such user" takes about as long as "wrong password" (no user enumeration by timing).
const DUMMY_HASH = bcrypt.hash(randomUUID(), BCRYPT_COST);

const pgCode = (err: unknown) => (err as { code?: string }).code;

export async function registerAuthRoutes(app: FastifyInstance, { config, pool, auth }: Deps) {
  // ---- POST /api/auth/register ----------------------------------------------------------------
  app.post('/api/auth/register', async (req, reply) => {
    const body = parse(registerSchema, req.body);
    const passwordHash = await bcrypt.hash(body.password, BCRYPT_COST);

    let row: UserRow;
    try {
      row = await withTx(pool, async (client) => {
        const { rows } = await client.query<UserRow>(
          `insert into auth.users (username, email, password_hash) values ($1, $2, $3) returning ${USER_COLUMNS}`,
          [body.username, body.email, passwordHash],
        );
        await client.query(`insert into auth.user_settings (user_id) values ($1)`, [rows[0].id]);
        return rows[0];
      });
    } catch (err) {
      if (pgCode(err) === '23505') throw conflict(conflictMessage((err as { constraint?: string }).constraint));
      throw err;
    }

    const user = toPrivateUser(row);
    const { token } = await signToken(config.jwtSecret, user);
    return reply.status(201).send({ token, user });
  });

  // ---- POST /api/auth/login -------------------------------------------------------------------
  app.post('/api/auth/login', async (req) => {
    const body = parse(loginSchema, req.body);
    // Usernames cannot contain '@' and emails always do, so at most one row matches.
    const { rows } = await pool.query<UserRow & { password_hash: string }>(
      `select ${USER_COLUMNS}, password_hash from auth.users
        where lower(username) = lower($1) or lower(email) = lower($1)
        limit 1`,
      [body.login],
    );
    const found = rows[0];
    const ok = await bcrypt.compare(body.password, found ? found.password_hash : await DUMMY_HASH);
    if (!found || !ok) throw unauthorized('Invalid username/email or password');

    const updated = await pool.query<UserRow>(
      `update auth.users set last_login_at = now() where id = $1 returning ${USER_COLUMNS}`,
      [found.id],
    );
    const user = toPrivateUser(updated.rows[0] ?? found);
    const { token } = await signToken(config.jwtSecret, user);
    return { token, user };
  });

  // ---- GET /api/auth/me -----------------------------------------------------------------------
  app.get('/api/auth/me', { preHandler: auth.requireAuth }, async (req) => {
    const userId = req.user!.id;
    if (!UUID_RE.test(userId)) throw unauthorized();
    const { rows } = await pool.query<UserRow & { settings: Record<string, unknown> }>(
      `select ${USER_COLUMNS}, coalesce(s.settings, '{}'::jsonb) as settings
         from auth.users u left join auth.user_settings s on s.user_id = u.id
        where u.id = $1`,
      [userId],
    );
    if (!rows[0]) throw unauthorized('Account no longer exists');
    return { user: toPrivateUser(rows[0]), settings: rows[0].settings };
  });
}
