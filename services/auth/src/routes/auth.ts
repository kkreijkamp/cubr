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
  PRIVATE_USERS_KEY,
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
import {
  EMAIL_CHANGE_TTL_MIN,
  EMAIL_CONFIRM_TTL_DAYS,
  EMAIL_CONFIRM_TTL_MIN,
  changeEmailSchema,
  confirmAccountEmailMessage,
  confirmEmailLink,
  confirmEmailMessage,
  confirmEmailSchema,
  emailChangedNotice,
  isFreshSignIn,
} from '../emailChange.js';

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

  const mail = loadMailConfig();
  if (!mail.apiKey) app.log.warn('RESEND_API_KEY is not set: emails (password resets, email confirmations) are logged, not sent');

  /**
   * Emails the link that confirms the account's own address; its row in auth.email_changes is in
   * place already. If the email can't be sent, the row goes too (nothing waits for a link that never
   * came) and the error is rethrown.
   */
  async function emailConfirmation(user: { id: string; username: string; email: string }, link: { token: string; hash: Buffer }, log: FastifyBaseLogger): Promise<void> {
    try {
      const message = confirmAccountEmailMessage({ username: user.username, link: confirmEmailLink(mail.publicUrl, link.token), days: EMAIL_CONFIRM_TTL_DAYS });
      await sendMail(mail, { to: user.email, ...message }, log);
    } catch (err) {
      await pool.query('delete from auth.email_changes where token_hash = $1', [link.hash]).catch(() => undefined);
      log.error({ userId: user.id, err: (err as Error).message }, 'email confirmation: the email failed');
      throw err;
    }
    log.info({ userId: user.id }, 'email confirmation link sent');
  }

  // ---- POST /api/auth/register ----------------------------------------------------------------
  // The account works at once; its email gets a link that confirms it (password-reset links only go
  // to a confirmed address). The seed job's accounts (internal token) get none.
  app.post('/api/auth/register', async (req, reply) => {
    const internal = isInternalCaller(config.internalToken, req.headers[INTERNAL_TOKEN_HEADER]);
    if (!internal && !(await allow(redis, `register:${req.ip}`, 20, 3600))) {
      throw rateLimited('Too many registrations from this address, try again later');
    }
    const body = parse(registerSchema, req.body);
    const passwordHash = await bcrypt.hash(body.password, BCRYPT_COST);
    const confirmation = internal ? null : newResetToken();

    let row: UserRow;
    try {
      row = await withTx(pool, async (client) => {
        const { rows } = await client.query<UserRow>(
          `insert into auth.users (username, email, password_hash) values ($1, $2, $3) returning ${USER_COLUMNS}`,
          [body.username, body.email, passwordHash],
        );
        await client.query(`insert into auth.user_settings (user_id) values ($1)`, [rows[0].id]);
        if (confirmation) {
          await client.query(
            `insert into auth.email_changes (token_hash, user_id, new_email, expires_at) values ($1, $2, $3, now() + make_interval(mins => $4))`,
            [confirmation.hash, rows[0].id, rows[0].email, EMAIL_CONFIRM_TTL_MIN],
          );
        }
        return rows[0];
      });
    } catch (err) {
      if (pgCode(err) === '23505') throw conflict(conflictMessage((err as { constraint?: string }).constraint));
      throw err;
    }

    const user = toPrivateUser(row);
    const { token } = await signToken(config.jwtSecret, user);
    await publishSafely(redis, req.log, 'user.registered', userEventData(toPublicUser(row)));
    // not awaited: sign-up doesn't wait for the mail provider. A failure is logged, and the account
    // page offers a new link.
    if (confirmation) emailConfirmation(row, confirmation, req.log).catch(() => undefined);
    return reply.status(201).send({ token, user });
  });

  // ---- POST /api/auth/login -------------------------------------------------------------------
  app.post('/api/auth/login', async (req) => {
    if (!isInternalCaller(config.internalToken, req.headers[INTERNAL_TOKEN_HEADER]) && !(await allow(redis, `login:${req.ip}`, 10, 60))) {
      throw rateLimited('Too many login attempts, try again in a minute');
    }
    const body = parse(loginSchema, req.body);
    // Usernames cannot contain '@' and emails always do, so at most one row matches.
    const { rows } = await pool.query<UserRow & { password_hash: string | null }>(
      `select ${USER_COLUMNS}, password_hash from auth.users
        where lower(username) = lower($1) or lower(email) = lower($1)
        limit 1`,
      [body.login],
    );
    const found = rows[0];
    // an account made with Google, Apple or GitHub has no password: the same answer, the same timing
    const ok = await bcrypt.compare(body.password, found?.password_hash ?? (await DUMMY_HASH));
    if (!found?.password_hash || !ok) throw unauthorized('Invalid username/email or password');

    const updated = await pool.query<UserRow>(
      `update auth.users set last_login_at = now() where id = $1 returning ${USER_COLUMNS}`,
      [found.id],
    );
    const user = toPrivateUser(updated.rows[0] ?? found);
    const { token } = await signToken(config.jwtSecret, user);
    return { token, user };
  });

  // ---- password reset ---------------------------------------------------------------------------
  /**
   * Creates a reset link for the account of `email` and emails it, if there's an account and its
   * address is confirmed, or the account is older than confirming (predates_email_confirmation). An
   * unconfirmed address may be a typo or someone else's, and whoever reads it could take the account.
   */
  async function sendResetLink(email: string, log: FastifyBaseLogger): Promise<void> {
    const { rows } = await pool.query<{ id: string; username: string; email: string; trusted: boolean }>(
      `select id, username, email, (email_verified_at is not null or predates_email_confirmation) as trusted
         from auth.users where lower(email) = lower($1)`,
      [email],
    );
    const user = rows[0];
    if (!user) return;
    if (!user.trusted) {
      log.info({ userId: user.id }, 'password reset: no link, the email is not confirmed');
      return;
    }
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
      // the link reached the address (and links end when the address changes): that confirms it
      const { rows } = await c.query<UserRow>(
        `update auth.users set password_hash = $2, last_login_at = now(), email_verified_at = coalesce(email_verified_at, now())
          where id = $1 returning ${USER_COLUMNS}`,
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

  // ---- POST /api/auth/me/email ------------------------------------------------------------------
  // Asks to change the email. Proof it's you: the password, or for an account without one (made with
  // Google, Apple or GitHub) a sign-in in the last 10 minutes. The new address gets a link
  // (emailChange.ts); nothing changes until it's opened. Asking again replaces the pending change.
  app.post('/api/auth/me/email', { preHandler: auth.requireAuth }, async (req, reply) => {
    const me = req.user!;
    if (!UUID_RE.test(me.id)) throw unauthorized();
    if (!(await allow(redis, `email-change:${me.id}`, 5, 3600))) throw rateLimited('Too many attempts, try again later');
    const { email, password } = parse(changeEmailSchema, req.body ?? {});
    const { rows } = await pool.query<{ username: string; email: string; password_hash: string | null }>(
      'select username, email, password_hash from auth.users where id = $1',
      [me.id],
    );
    const user = rows[0];
    if (!user) throw unauthorized('Account no longer exists');
    if (email.toLowerCase() === user.email.toLowerCase()) throw badRequest("That's already your email");
    // 403, not 401: a wrong password must not look like an expired session to the client
    if (user.password_hash) {
      if (!password || !(await bcrypt.compare(password, user.password_hash))) throw forbidden('Wrong password');
    } else if (!isFreshSignIn(me.iat)) {
      throw forbidden('Sign in again to change your email');
    }
    const taken = await pool.query('select 1 from auth.users where lower(email) = lower($1) and id <> $2', [email, me.id]);
    if (taken.rowCount) throw conflict('That email is already in use');
    const { token, hash } = newResetToken();
    await withTx(pool, async (c) => {
      await c.query('delete from auth.email_changes where user_id = $1 or expires_at < now()', [me.id]);
      await c.query(
        `insert into auth.email_changes (token_hash, user_id, new_email, expires_at) values ($1, $2, $3, now() + make_interval(mins => $4))`,
        [hash, me.id, email, EMAIL_CHANGE_TTL_MIN],
      );
    });
    try {
      const message = confirmEmailMessage({ username: user.username, link: confirmEmailLink(mail.publicUrl, token), minutes: EMAIL_CHANGE_TTL_MIN });
      await sendMail(mail, { to: email, ...message }, req.log);
    } catch (err) {
      await pool.query('delete from auth.email_changes where token_hash = $1', [hash]);
      req.log.error({ err: (err as Error).message }, 'email change: the confirmation email failed');
      throw unavailable('Could not send the confirmation email right now, please retry');
    }
    req.log.info({ userId: me.id }, 'email change: confirmation link sent');
    return reply.status(202).send({ ok: true, email });
  });

  // ---- POST /api/auth/me/email/confirmation -----------------------------------------------------
  // A new link that confirms the account's current email (the one from sign-up expired, got lost or
  // went to spam). No password needed: it only goes to the account's own address. It replaces any
  // pending link or change. Capped per account per hour and per day, so an account made with someone
  // else's address can't flood them.
  app.post('/api/auth/me/email/confirmation', { preHandler: auth.requireAuth }, async (req, reply) => {
    const me = req.user!;
    if (!UUID_RE.test(me.id)) throw unauthorized();
    const { rows } = await pool.query<{ id: string; username: string; email: string; verified: boolean }>(
      'select id, username, email, email_verified_at is not null as verified from auth.users where id = $1',
      [me.id],
    );
    const user = rows[0];
    if (!user) throw unauthorized('Account no longer exists');
    if (user.verified) throw badRequest('Your email is already confirmed');
    if (!(await allow(redis, `email-confirm:${me.id}`, 3, 3600)) || !(await allow(redis, `email-confirm-day:${me.id}`, 5, 86_400))) {
      throw rateLimited('Too many links, try again later');
    }
    const link = newResetToken();
    await withTx(pool, async (c) => {
      await c.query('delete from auth.email_changes where user_id = $1 or expires_at < now()', [me.id]);
      await c.query(
        `insert into auth.email_changes (token_hash, user_id, new_email, expires_at) values ($1, $2, $3, now() + make_interval(mins => $4))`,
        [link.hash, me.id, user.email, EMAIL_CONFIRM_TTL_MIN],
      );
    });
    try {
      await emailConfirmation(user, link, req.log);
    } catch {
      throw unavailable('Could not send the email right now, please retry');
    }
    return reply.status(202).send({ ok: true, email: user.email });
  });

  // ---- POST /api/auth/email/confirm -------------------------------------------------------------
  // A link from an email, used once; no sign-in needed, the link is the proof the address is the
  // person's. Either it confirms the account's own address (changed: false), or a new address
  // becomes the email (changed: true): pending password-reset links end (they went to the old
  // address), and the old address is told, if it was a confirmed one (an unconfirmed address may be
  // a stranger's).
  app.post('/api/auth/email/confirm', async (req) => {
    if (!(await allow(redis, `confirm-email:${req.ip}`, 20, 3600))) throw rateLimited('Too many attempts, try again later');
    const { token } = parse(confirmEmailSchema, req.body ?? {});
    const done = await withTx(pool, async (c) => {
      const used = await c.query<{ user_id: string; new_email: string }>(
        'delete from auth.email_changes where token_hash = $1 and expires_at > now() returning user_id, new_email',
        [hashResetToken(token)],
      );
      const change = used.rows[0];
      if (!change) throw badRequest('This link is invalid or has expired');
      const before = await c.query<{ username: string; email: string; trusted: boolean }>(
        `select username, email, (email_verified_at is not null or predates_email_confirmation) as trusted
           from auth.users where id = $1 for update`,
        [change.user_id],
      );
      if (!before.rows[0]) throw badRequest('This link is invalid or has expired');
      const changed = before.rows[0].email.toLowerCase() !== change.new_email.toLowerCase();
      try {
        await c.query('update auth.users set email = $2, email_verified_at = now() where id = $1', [change.user_id, changed ? change.new_email : before.rows[0].email]);
      } catch (err) {
        // someone else took the address since (the unique index): nothing changes, the link stays
        if (pgCode(err) === '23505') throw conflict('That email is now used by another account');
        throw err;
      }
      await c.query('delete from auth.email_changes where user_id = $1', [change.user_id]);
      if (changed) await c.query('delete from auth.password_resets where user_id = $1', [change.user_id]);
      return { userId: change.user_id, username: before.rows[0].username, oldEmail: before.rows[0].email, oldTrusted: before.rows[0].trusted, newEmail: change.new_email, changed };
    });
    if (!done.changed) {
      req.log.info({ userId: done.userId }, 'email confirmed');
      return { email: done.oldEmail, changed: false };
    }
    req.log.info({ userId: done.userId }, 'email changed');
    if (done.oldTrusted) {
      sendMail(mail, { to: done.oldEmail, ...emailChangedNotice({ username: done.username, newEmail: done.newEmail }) }, req.log).catch((err: Error) =>
        req.log.error({ err: err.message }, 'email change: the notice to the old address failed'),
      );
    }
    return { email: done.newEmail, changed: true };
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
    const { password, confirm } = parse(deleteMeSchema, req.body ?? {});
    await withTx(pool, async (c) => {
      const { rows } = await c.query<{ username: string; password_hash: string | null }>(
        'select username, password_hash from auth.users where id = $1 for update',
        [me.id],
      );
      if (!rows[0]) throw unauthorized('Account no longer exists');
      // 403, not 401: a wrong password must not look like an expired session to the client
      const hash = rows[0].password_hash;
      if (hash) {
        if (!password || !(await bcrypt.compare(password, hash))) throw forbidden('Wrong password');
      } else if (confirm?.toLowerCase() !== rows[0].username.toLowerCase()) {
        // no password (made with a provider): typing the username confirms
        throw forbidden('Type your username to confirm');
      }
      await c.query('delete from auth.users where id = $1', [me.id]);
      void withTimeout(redis.srem(PRIVATE_USERS_KEY, me.id.toLowerCase()), 2000, 0); // tidy-up only: the account is gone

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
    const userId = req.user!.id.toLowerCase();

    values.push(userId);
    const row = await withTx(pool, async (c) => {
      const { rows } = await c.query<UserRow>(
        `update auth.users set ${sets.join(', ')} where id = $${values.length} returning ${USER_COLUMNS}`,
        values,
      );
      if (!rows[0]) throw unauthorized('Account no longer exists');
      if (patch.private !== undefined) {
        // Mirror the flag into the set the other services read, inside the transaction: if Redis
        // can't take it, the change rolls back rather than leaving a "private" profile readable.
        const op = patch.private ? redis.sadd(PRIVATE_USERS_KEY, userId) : redis.srem(PRIVATE_USERS_KEY, userId);
        const mirrored = await withTimeout(op.then(() => true), 2000, false);
        if (!mirrored) throw unavailable('Could not change who can see your profile right now, please retry');
      }
      return rows[0];
    });
    await publishSafely(redis, req.log, 'user.updated', userEventData(toPublicUser(row)));
    return { user: toPrivateUser(row) };
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
