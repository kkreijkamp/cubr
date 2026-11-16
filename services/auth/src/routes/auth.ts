import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import {
  HttpError,
  INTERNAL_TOKEN_HEADER,
  TOKEN_TTL_SEC,
  badRequest,
  conflict,
  forbidden,
  internalTokenMatches,
  newEventId,
  parse,
  publishEvent,
  rateLimited,
  revokedKey,
  revokedUserKey,
  signToken,
  unauthorized,
  unavailable,
  withTx,
} from '@cubr/common';
import type { Deps } from './index.js';
import {
  SETTINGS_MAX_BYTES,
  USER_COLUMNS,
  UUID_RE,
  buildUserUpdate,
  conflictMessage,
  deleteMeSchema,
  jsonBytes,
  loginSchema,
  patchMeSchema,
  registerSchema,
  settingsSchema,
  toPrivateUser,
  toPublicUser,
  userEventData,
  type UserRow,
} from '../users.js';
import { allow, publishSafely, withTimeout } from '../safe.js';
import { loadMailConfig, sendMail } from '../mail.js';
import { RESET_TTL_MIN, forgotSchema, hashResetToken, newResetToken, resetEmail, resetLink, resetSchema } from '../reset.js';

const BCRYPT_COST = 10;

// Hash of a random password, compared against when the login name is unknown so that
// "no such user" takes about as long as "wrong password" (no user enumeration by timing).
const DUMMY_HASH = bcrypt.hash(randomUUID(), BCRYPT_COST);

const pgCode = (err: unknown) => (err as { code?: string }).code;

// Trusted in-cluster callers (the seed job) present INTERNAL_API_TOKEN in X-Internal-Token and
// skip the per-IP limits below - they legitimately create many accounts from one pod IP.
// Disabled unless the secret is configured (>= 16 chars).
function isInternalCaller(token: string, header: string | string[] | undefined): boolean {
  return token.length >= 16 && internalTokenMatches(token, header);
}

export async function registerAuthRoutes(app: FastifyInstance, { config, pool, redis, auth }: Deps) {
  /** Loads the authenticated user's row or rejects the (stale) token. */
  async function currentUser(userId: string): Promise<UserRow> {
    if (!UUID_RE.test(userId)) throw unauthorized();
    const { rows } = await pool.query<UserRow>(`select ${USER_COLUMNS} from auth.users where id = $1`, [userId]);
    if (!rows[0]) throw unauthorized('Account no longer exists');
    return rows[0];
  }

  // ---- POST /api/auth/register ----------------------------------------------------------------
  app.post('/api/auth/register', async (req, reply) => {
    if (!isInternalCaller(config.internalToken, req.headers[INTERNAL_TOKEN_HEADER]) && !(await allow(redis, `register:${req.ip}`, 20, 3600))) {
      throw rateLimited('Too many registrations from this address, try again later');
    }
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
    await publishSafely(redis, req.log, 'user.registered', userEventData(toPublicUser(row)));
    return reply.status(201).send({ token, user });
  });

  // ---- POST /api/auth/login -------------------------------------------------------------------
  app.post('/api/auth/login', async (req) => {
    if (!isInternalCaller(config.internalToken, req.headers[INTERNAL_TOKEN_HEADER]) && !(await allow(redis, `login:${req.ip}`, 10, 60))) {
      throw rateLimited('Too many login attempts, try again in a minute');
    }
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

  // ---- password reset ---------------------------------------------------------------------------
  const mail = loadMailConfig();
  if (!mail.apiKey) app.log.warn('RESEND_API_KEY is not set: password-reset emails are logged, not sent');

  /** Creates a reset link for the account of `email` (if there is one) and emails it. */
  async function sendResetLink(email: string, log: FastifyBaseLogger): Promise<void> {
    const { rows } = await pool.query<{ id: string; username: string; email: string }>(
      'select id, username, email from auth.users where lower(email) = lower($1)',
      [email],
    );
    const user = rows[0];
    if (!user) return;
    if (!(await allow(redis, `forgot-user:${user.id}`, 3, 3600))) {
      log.warn({ userId: user.id }, 'password reset: too many links for this account this hour');
      return;
    }
    const { token, hash } = newResetToken();
    await pool.query('delete from auth.password_resets where expires_at < now()');
    await pool.query(
      `insert into auth.password_resets (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(mins => $3))`,
      [hash, user.id, RESET_TTL_MIN],
    );
    const message = resetEmail({ username: user.username, link: resetLink(mail.publicUrl, token), minutes: RESET_TTL_MIN });
    await sendMail(mail, { to: user.email, ...message }, log);
    log.info({ userId: user.id }, 'password reset link sent');
  }

  // ---- POST /api/auth/password/forgot -----------------------------------------------------------
  // Always 202, answered before any lookup: neither the reply nor its timing tells whether an
  // account uses the address.
  app.post('/api/auth/password/forgot', async (req, reply) => {
    if (!(await allow(redis, `forgot:${req.ip}`, 10, 3600))) throw rateLimited('Too many reset requests, try again later');
    const { email } = parse(forgotSchema, req.body ?? {});
    sendResetLink(email, req.log).catch((err: Error) => req.log.error({ err: err.message }, 'password reset email failed'));
    return reply.status(202).send({ ok: true });
  });

  // ---- POST /api/auth/password/reset ------------------------------------------------------------
  // Uses the link once: sets the new password, ends every other reset link and every session of
  // the account (fails closed like account deletion), and signs in with a fresh token.
  app.post('/api/auth/password/reset', async (req) => {
    if (!(await allow(redis, `reset:${req.ip}`, 20, 3600))) throw rateLimited('Too many attempts, try again later');
    const { token, password } = parse(resetSchema, req.body ?? {});
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const { row, revokedAt } = await withTx(pool, async (c) => {
      const used = await c.query<{ user_id: string }>(
        'delete from auth.password_resets where token_hash = $1 and expires_at > now() returning user_id',
        [hashResetToken(token)],
      );
      if (!used.rows[0]) throw badRequest('This reset link is invalid or has expired');
      const userId = used.rows[0].user_id;
      await c.query('delete from auth.password_resets where user_id = $1', [userId]);
      const { rows } = await c.query<UserRow>(
        `update auth.users set password_hash = $2, last_login_at = now() where id = $1 returning ${USER_COLUMNS}`,
        [userId, passwordHash],
      );
      if (!rows[0]) throw badRequest('This reset link is invalid or has expired');
      const at = Math.floor(Date.now() / 1000);
      const revoked = await withTimeout(redis.set(revokedUserKey(userId), String(at), 'EX', TOKEN_TTL_SEC).then(() => true), 2000, false);
      if (!revoked) throw unavailable('Could not reset the password right now, please retry');
      return { row: rows[0], revokedAt: at };
    });
    req.log.info({ userId: row.id }, 'password reset');
    const user = toPrivateUser(row);
    const { token: jwt } = await signToken(config.jwtSecret, user, TOKEN_TTL_SEC, revokedAt + 1);
    return { token: jwt, user };
  });

  // ---- POST /api/auth/logout ------------------------------------------------------------------
  // Encapsulated so it can accept (and ignore) any body, including an empty body sent with
  // `Content-Type: application/json`, which Fastify's default parser would reject with a 400.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_req, _body, done) => done(null, undefined));
    scope.post('/api/auth/logout', { preHandler: auth.requireAuth }, async (req, reply) => {
      const user = req.user!;
      // Revocation must outlive the token, so the TTL is the token's remaining lifetime.
      const ttl = Math.max(1, user.exp - Math.floor(Date.now() / 1000));
      const ok = await withTimeout(
        redis.set(revokedKey(user.jti), '1', 'EX', ttl).then(() => true),
        2000,
        false,
      );
      if (!ok) throw unavailable('Could not revoke the token right now, please retry');
      return reply.status(204).send();
    });
  });

  // ---- DELETE /api/auth/me --------------------------------------------------------------------
  // Deletes the account, after asking for the password again. One transaction: the user row goes
  // (settings and avatar cascade), every token issued so far is revoked, and user.deleted is
  // published - solve, stats and leaderboard delete the user's data when they see it. If Redis
  // can't take the revocation or the event, nothing is deleted (503, try again).
  app.delete('/api/auth/me', { preHandler: auth.requireAuth }, async (req, reply) => {
    const me = req.user!;
    if (!UUID_RE.test(me.id)) throw unauthorized();
    if (!(await allow(redis, `delete:${me.id}`, 5, 600))) throw rateLimited('Too many attempts, try again in a few minutes');
    const { password } = parse(deleteMeSchema, req.body ?? {});
    await withTx(pool, async (c) => {
      const { rows } = await c.query<{ username: string; password_hash: string }>(
        'select username, password_hash from auth.users where id = $1 for update',
        [me.id],
      );
      if (!rows[0]) throw unauthorized('Account no longer exists');
      // 403, not 401: a wrong password must not look like an expired session to the client
      if (!(await bcrypt.compare(password, rows[0].password_hash))) throw forbidden('Wrong password');
      await c.query('delete from auth.users where id = $1', [me.id]);

      const revokedAt = String(Math.floor(Date.now() / 1000));
      const revoked = await withTimeout(redis.set(revokedUserKey(me.id), revokedAt, 'EX', TOKEN_TTL_SEC).then(() => true), 2000, false);
      if (!revoked) throw unavailable('Could not delete the account right now, please retry');
      const data = { eventId: newEventId('auth'), userId: me.id, username: rows[0].username };
      const published = await withTimeout(publishEvent(redis, 'user.deleted', data).then(() => true), 2000, false);
      if (!published) {
        // the row stays (rollback), so the tokens must keep working too
        await withTimeout(redis.del(revokedUserKey(me.id)), 2000, 0);
        throw unavailable('Could not delete the account right now, please retry');
      }
    });
    req.log.info({ userId: me.id }, 'account deleted');
    return reply.status(204).send();
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

  // ---- PATCH /api/auth/me ---------------------------------------------------------------------
  app.patch('/api/auth/me', { preHandler: auth.requireAuth }, async (req) => {
    const patch = parse(patchMeSchema, req.body ?? {});
    const { sets, values } = buildUserUpdate(patch);
    if (sets.length === 0) return { user: toPrivateUser(await currentUser(req.user!.id)) };
    if (!UUID_RE.test(req.user!.id)) throw unauthorized();

    values.push(req.user!.id);
    const { rows } = await pool.query<UserRow>(
      `update auth.users set ${sets.join(', ')} where id = $${values.length} returning ${USER_COLUMNS}`,
      values,
    );
    if (!rows[0]) throw unauthorized('Account no longer exists');
    await publishSafely(redis, req.log, 'user.updated', userEventData(toPublicUser(rows[0])));
    return { user: toPrivateUser(rows[0]) };
  });

  // ---- PUT /api/auth/me/settings --------------------------------------------------------------
  app.put('/api/auth/me/settings', { preHandler: auth.requireAuth }, async (req) => {
    const { settings } = parse(settingsSchema, req.body);
    if (jsonBytes(settings) > SETTINGS_MAX_BYTES) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `settings must be at most ${SETTINGS_MAX_BYTES} bytes of JSON`);
    }
    if (!UUID_RE.test(req.user!.id)) throw unauthorized();
    try {
      const { rows } = await pool.query<{ settings: Record<string, unknown> }>(
        `insert into auth.user_settings (user_id, settings, updated_at) values ($1, $2::jsonb, now())
         on conflict (user_id) do update set settings = excluded.settings, updated_at = now()
         returning settings`,
        [req.user!.id, JSON.stringify(settings)],
      );
      return { settings: rows[0].settings };
    } catch (err) {
      if (pgCode(err) === '23503') throw unauthorized('Account no longer exists'); // FK: user gone
      throw err;
    }
  });
}
