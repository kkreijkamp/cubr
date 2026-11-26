import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { conflict, forbidden, notFound, parse, rateLimited, signToken, unauthorized, unavailable, withTx } from '@cubr/common';
import type { Deps } from './index.js';
import { allow, publishSafely, withTimeout } from '../safe.js';
import { loadMailConfig } from '../mail.js';
import {
  authorizeUrl,
  fetchIdentity,
  isProvider,
  loadOAuthConfig,
  OAuthError,
  pkce,
  randomToken,
  readCookie,
  safeNext,
  suggestUsername,
  usernameCandidates,
  type Provider,
  type ProviderConfig,
  type ProviderIdentity,
} from '../oauth.js';
import { USER_COLUMNS, UUID_RE, conflictMessage, toPrivateUser, toPublicUser, userEventData, usernameSchema, type UserRow } from '../users.js';
import { HOLDS_EMAIL, releaseUnconfirmed } from '../unconfirmed.js';
import { SUSPENDED_MESSAGE, isSuspended } from '../suspension.js';

/**
 * Sign-in with Google, Apple and GitHub (OAuth 2 authorization code flow; the providers in oauth.ts).
 *   GET    /api/auth/oauth/providers          the providers that are set up
 *   POST   /api/auth/oauth/:provider/start    {mode: signin|link, next} -> {url} (the provider's sign-in page)
 *   GET    /api/auth/oauth/:provider/callback the provider sends the browser back here (Apple: POST)
 *   POST   /api/auth/oauth/exchange           {code} -> {token, user}: the one-time code from the callback
 *   GET    /api/auth/oauth/signup/:id         a new account waiting for its username
 *   POST   /api/auth/oauth/signup             {id, username} -> 201 {token, user}
 *   GET    /api/auth/me/sign-in               how this account signs in (password, providers)
 *   DELETE /api/auth/me/identities/:provider  disconnect a provider (never the last way in)
 * The flow's state, PKCE verifier and nonce live in Redis for 10 minutes, and a cookie binds the flow
 * to the browser that started it, so a callback link someone else made can't sign you in to their
 * account (login CSRF). The callback hands the SPA a one-time code (or a sign-up id) in the URL
 * fragment, never a token, and binds that to the browser the same way: a code someone sends you
 * doesn't work in your browser.
 * A new provider account whose email already belongs to a cubr account is not linked automatically
 * (that account's email may be unconfirmed, a typo or someone else's, so that could hand over
 * someone's account): its owner signs in with the password and connects the provider on the account
 * page.
 * The provider's email is a verified one (fetchIdentity), so it counts as confirmed: an account made
 * this way starts confirmed, and connecting or signing in with a provider whose email is the
 * account's confirms the account's.
 */

const FLOW_TTL_SEC = 600;
const LOGIN_CODE_TTL_SEC = 120;
const SIGNUP_TTL_SEC = 900;
const COOKIE = 'cubr_oauth';
const COOKIE_PATH = '/api/auth/oauth';

const flowKey = (state: string) => `auth:oauth:flow:${state}`;
const loginKey = (code: string) => `auth:oauth:login:${code}`;
const signupKey = (id: string) => `auth:oauth:signup:${id}`;

interface Flow {
  provider: Provider;
  verifier: string;
  nonce: string;
  mode: 'signin' | 'link';
  userId: string | null;
  next: string;
}
interface PendingSignup {
  provider: Provider;
  subject: string;
  email: string;
  name: string | null;
  login: string | null;
}

/** Why a sign-in didn't work; the SPA turns these into messages (pages/SsoPage.tsx). */
type Failure = 'cancelled' | 'expired' | 'failed' | 'no_email' | 'email_taken' | 'linked_elsewhere' | 'already_linked' | 'busy' | 'suspended';

const startBody = z.object({ mode: z.enum(['signin', 'link']).default('signin'), next: z.string().max(300).optional() });
const exchangeBody = z.object({ code: z.string().min(16).max(100) });
const signupBody = z.object({
  id: z.string().min(16).max(100),
  username: usernameSchema,
});
const tokenString = z.string().min(16).max(100);

/** Reads and deletes a Redis key at once (each code, flow and sign-up is used once). */
async function take<T>(redis: Deps['redis'], key: string): Promise<T | null> {
  const raw = await withTimeout(redis.getdel(key), 2000, null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function registerOAuthRoutes(app: FastifyInstance, { config, pool, redis, auth }: Deps): Promise<void> {
  const providers = loadOAuthConfig();
  const publicUrl = loadMailConfig().publicUrl.replace(/\/$/, '');
  const redirectUri = (p: Provider) => `${publicUrl}/api/auth/oauth/${p}/callback`;
  const enabled = Object.keys(providers) as Provider[];
  if (enabled.length) app.log.info({ providers: enabled }, 'sign-in with providers enabled');

  const providerOf = (raw: unknown): { provider: Provider; cfg: ProviderConfig } => {
    if (!isProvider(raw) || !providers[raw]) throw notFound('This sign-in provider is not set up');
    return { provider: raw, cfg: providers[raw]! };
  };

  // SameSite=None: Apple's callback is a cross-site POST, which a Lax cookie wouldn't come with
  const bindCookie = (value: string, maxAge: number) => `${COOKIE}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=None`;
  const clearCookie = bindCookie('', 0);
  /** Whether this browser holds the cookie for `value` (a flow state, login code or sign-up id). */
  const bound = (req: FastifyRequest, value: string) => readCookie(req.headers.cookie, COOKIE) === value;

  /** Back to the SPA with the result in the fragment (not sent to servers or logs); `bind` = [value, seconds]. */
  const toSpa = (reply: FastifyReply, path: string, params: Record<string, string>, bind?: [string, number]) =>
    reply
      .header('set-cookie', bind ? bindCookie(...bind) : clearCookie)
      .header('cache-control', 'no-store')
      .redirect(`${path}#${new URLSearchParams(params).toString()}`, 303);
  const fail = (reply: FastifyReply, flow: Pick<Flow, 'mode' | 'next'> | null, provider: Provider, error: Failure) =>
    toSpa(reply, flow?.mode === 'link' ? '/account' : '/login/sso', { error, provider, ...(flow?.mode === 'link' ? {} : { next: flow?.next ?? '/' }) });

  const userById = async (id: string) => (await pool.query<UserRow>(`select ${USER_COLUMNS} from auth.users where id = $1`, [id])).rows[0] ?? null;

  /** The provider vouches for `email`: if it's the account's email, it's confirmed. */
  const confirmByProvider = async (userId: string, email: string | null) => {
    if (!email) return;
    await pool.query('update auth.users set email_verified_at = now() where id = $1 and email_verified_at is null and lower(email) = lower($2)', [userId, email]);
  };

  /** A free username close to the provider's (null if 50 tries are all taken); never a reserved or refused one. */
  async function freeUsername(identity: Pick<ProviderIdentity, 'login' | 'name' | 'email'>): Promise<string | null> {
    const candidates = usernameCandidates(suggestUsername(identity)).filter((c) => usernameSchema.safeParse(c).success);
    const { rows } = await pool.query<{ u: string }>('select lower(username) as u from auth.users where lower(username) = any($1)', [candidates.map((c) => c.toLowerCase())]);
    const taken = new Set(rows.map((r) => r.u));
    return candidates.find((c) => !taken.has(c.toLowerCase())) ?? null;
  }

  app.get('/api/auth/oauth/providers', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return { providers: enabled };
  });

  app.post<{ Params: { provider: string } }>('/api/auth/oauth/:provider/start', { preHandler: auth.optionalAuth }, async (req, reply) => {
    const { provider, cfg } = providerOf(req.params.provider);
    if (!(await allow(redis, `oauth-start:${req.ip}`, 30, 600))) throw rateLimited('Too many sign-in attempts, try again in a few minutes');
    const { mode, next } = parse(startBody, req.body ?? {});
    if (mode === 'link' && (!req.user || !UUID_RE.test(req.user.id))) throw unauthorized();
    const state = randomToken();
    const nonce = randomToken(16);
    const { verifier, challenge } = pkce();
    const flow: Flow = { provider, verifier, nonce, mode, userId: mode === 'link' ? req.user!.id.toLowerCase() : null, next: safeNext(next) };
    const stored = await withTimeout(redis.set(flowKey(state), JSON.stringify(flow), 'EX', FLOW_TTL_SEC).then(() => true), 2000, false);
    if (!stored) throw unavailable('Sign-in with a provider is unavailable right now, please retry');
    reply.header('set-cookie', bindCookie(state, FLOW_TTL_SEC)).header('cache-control', 'no-store');
    return { url: authorizeUrl(cfg, { redirectUri: redirectUri(provider), state, nonce, challenge }) };
  });

  async function callback(req: FastifyRequest, reply: FastifyReply, provider: Provider, cfg: ProviderConfig, q: Record<string, unknown>) {
    if (!(await allow(redis, `oauth-callback:${req.ip}`, 60, 600))) return fail(reply, null, provider, 'busy');
    const state = typeof q.state === 'string' ? q.state : '';
    const flow = tokenString.safeParse(state).success ? await take<Flow>(redis, flowKey(state)) : null;
    // the flow must exist, be for this provider, and have started in this browser
    if (!flow || flow.provider !== provider || !bound(req, state)) return fail(reply, flow, provider, 'expired');
    if (typeof q.error === 'string' || typeof q.code !== 'string' || !q.code) {
      req.log.info({ provider, error: q.error }, 'provider sign-in cancelled or refused');
      return fail(reply, flow, provider, 'cancelled');
    }

    let identity: ProviderIdentity;
    try {
      identity = await fetchIdentity(cfg, { code: q.code, redirectUri: redirectUri(provider), verifier: flow.verifier, nonce: flow.nonce, appleUser: q.user });
    } catch (err) {
      req.log.warn({ provider, err: (err as Error).message, reason: err instanceof OAuthError ? err.reason : 'network' }, 'provider sign-in failed');
      return fail(reply, flow, provider, 'failed');
    }

    const linked = (
      await pool.query<{ user_id: string }>('select user_id from auth.user_identities where provider = $1 and subject = $2', [provider, identity.subject])
    ).rows[0];

    if (flow.mode === 'link') {
      if (linked && linked.user_id !== flow.userId) return fail(reply, flow, provider, 'linked_elsewhere');
      if (!linked) {
        try {
          await pool.query('insert into auth.user_identities (provider, subject, user_id, email) values ($1, $2, $3, $4)', [provider, identity.subject, flow.userId, identity.email]);
        } catch (err) {
          // the unique (user_id, provider): this account already has another account of this provider
          if ((err as { code?: string }).code === '23505') return fail(reply, flow, provider, 'already_linked');
          if ((err as { code?: string }).code === '23503') return fail(reply, flow, provider, 'expired'); // the account is gone
          throw err;
        }
        req.log.info({ provider, userId: flow.userId }, 'provider connected');
      }
      await confirmByProvider(flow.userId!, identity.email);
      return toSpa(reply, '/account', { linked: provider });
    }

    if (linked) {
      if (await isSuspended(pool, linked.user_id)) return fail(reply, flow, provider, 'suspended');
      await pool.query('update auth.user_identities set last_used_at = now() where provider = $1 and subject = $2', [provider, identity.subject]);
      await confirmByProvider(linked.user_id, identity.email);
      const code = randomToken();
      const ok = await withTimeout(redis.set(loginKey(code), JSON.stringify({ userId: linked.user_id }), 'EX', LOGIN_CODE_TTL_SEC).then(() => true), 2000, false);
      if (!ok) return fail(reply, flow, provider, 'busy');
      return toSpa(reply, '/login/sso', { code, next: flow.next }, [code, LOGIN_CODE_TTL_SEC]);
    }

    // a new account: it needs a verified email (password resets) that no account uses yet (an
    // unconfirmed one past its 7 days doesn't count: it's freed when the account is made)
    if (!identity.email) return fail(reply, flow, provider, 'no_email');
    const taken = await pool.query(`select 1 from auth.users u where lower(u.email) = lower($1) and ${HOLDS_EMAIL}`, [identity.email]);
    if (taken.rowCount) return fail(reply, flow, provider, 'email_taken');
    const id = randomToken();
    const pending: PendingSignup = { provider, subject: identity.subject, email: identity.email, name: identity.name, login: identity.login };
    const ok = await withTimeout(redis.set(signupKey(id), JSON.stringify(pending), 'EX', SIGNUP_TTL_SEC).then(() => true), 2000, false);
    if (!ok) return fail(reply, flow, provider, 'busy');
    return toSpa(reply, '/login/sso', { signup: id, next: flow.next }, [id, SIGNUP_TTL_SEC]);
  }

  app.get<{ Params: { provider: string }; Querystring: Record<string, unknown> }>('/api/auth/oauth/:provider/callback', async (req, reply) => {
    const { provider, cfg } = providerOf(req.params.provider);
    return callback(req, reply, provider, cfg, req.query ?? {});
  });

  // Apple answers with a form POST (response_mode=form_post)
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 32 * 1024 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });
    scope.post<{ Params: { provider: string } }>('/api/auth/oauth/:provider/callback', { bodyLimit: 32 * 1024 }, async (req, reply) => {
      const { provider, cfg } = providerOf(req.params.provider);
      return callback(req, reply, provider, cfg, (req.body as Record<string, unknown> | undefined) ?? {});
    });
  });

  async function signedIn(row: UserRow) {
    const user = toPrivateUser(row);
    const { token } = await signToken(config.jwtSecret, user);
    return { token, user };
  }

  app.post('/api/auth/oauth/exchange', async (req, reply) => {
    if (!(await allow(redis, `oauth-exchange:${req.ip}`, 30, 600))) throw rateLimited('Too many attempts, try again in a few minutes');
    const { code } = parse(exchangeBody, req.body ?? {});
    // 404, not 401: the web app signs out on a 401, and a stale or foreign link mustn't sign anyone out
    if (!bound(req, code)) throw notFound('This sign-in link was opened in another browser, please sign in again');
    reply.header('set-cookie', clearCookie);
    const login = await take<{ userId: string }>(redis, loginKey(code));
    if (!login) throw notFound('This sign-in link has expired, please sign in again');
    // suspended in the two minutes since the code was made
    if (await isSuspended(pool, login.userId)) throw forbidden(SUSPENDED_MESSAGE);
    const { rows } = await pool.query<UserRow>(`update auth.users set last_login_at = now() where id = $1 returning ${USER_COLUMNS}`, [login.userId]);
    if (!rows[0]) throw notFound('Account no longer exists');
    return signedIn(rows[0]);
  });

  app.get<{ Params: { id: string } }>('/api/auth/oauth/signup/:id', async (req) => {
    if (!tokenString.safeParse(req.params.id).success || !bound(req, req.params.id)) throw notFound('This sign-up has expired, please start again');
    const raw = await withTimeout(redis.get(signupKey(req.params.id)), 2000, null);
    if (!raw) throw notFound('This sign-up has expired, please start again');
    const pending = JSON.parse(raw) as PendingSignup;
    return { provider: pending.provider, email: pending.email, username: await freeUsername(pending) };
  });

  app.post('/api/auth/oauth/signup', async (req, reply) => {
    if (!(await allow(redis, `register:${req.ip}`, 20, 3600))) throw rateLimited('Too many registrations from this address, try again later');
    const { id, username } = parse(signupBody, req.body ?? {});
    if (!bound(req, id)) throw notFound('This sign-up has expired, please start again');
    const raw = await withTimeout(redis.get(signupKey(id)), 2000, null);
    if (!raw) throw notFound('This sign-up has expired, please start again');
    const pending = JSON.parse(raw) as PendingSignup;
    let row: UserRow;
    try {
      row = await withTx(pool, async (c) => {
        const freed = await releaseUnconfirmed(c, pending.email);
        if (freed) req.log.info({ userId: freed, provider: pending.provider }, 'an email never confirmed in 7 days was freed for a new account');
        // the provider verified the address, so it starts confirmed
        const { rows } = await c.query<UserRow>(`insert into auth.users (username, email, password_hash, email_verified_at) values ($1, $2, null, now()) returning ${USER_COLUMNS}`, [
          username,
          pending.email,
        ]);
        await c.query('insert into auth.user_settings (user_id) values ($1)', [rows[0].id]);
        await c.query('insert into auth.user_identities (provider, subject, user_id, email, last_used_at) values ($1, $2, $3, $4, now())', [
          pending.provider,
          pending.subject,
          rows[0].id,
          pending.email,
        ]);
        return rows[0];
      });
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'user_identities_pkey') throw conflict('This account was already created, please sign in');
      if (e.code === '23505') throw conflict(conflictMessage(e.constraint)); // the username (keep the sign-up for another try) or the email
      throw err;
    }
    await withTimeout(redis.del(signupKey(id)), 2000, 0);
    reply.header('set-cookie', clearCookie);
    await publishSafely(redis, req.log, 'user.registered', userEventData(toPublicUser(row)));
    req.log.info({ provider: pending.provider, userId: row.id }, 'account created with a provider');
    return reply.status(201).send(await signedIn(row));
  });

  app.get('/api/auth/me/sign-in', { preHandler: auth.requireAuth }, async (req) => {
    const userId = req.user!.id;
    if (!UUID_RE.test(userId)) throw unauthorized();
    const [user, ids] = await Promise.all([
      pool.query<{ has_password: boolean }>('select password_hash is not null as has_password from auth.users where id = $1', [userId]),
      pool.query<{ provider: Provider; email: string | null; created_at: Date }>('select provider, email, created_at from auth.user_identities where user_id = $1 order by created_at', [
        userId,
      ]),
    ]);
    if (!user.rows[0]) throw unauthorized('Account no longer exists');
    return {
      password: user.rows[0].has_password,
      providers: enabled,
      identities: ids.rows.map((r) => ({ provider: r.provider, email: r.email, createdAt: r.created_at.toISOString() })),
    };
  });

  app.delete<{ Params: { provider: string } }>('/api/auth/me/identities/:provider', { preHandler: auth.requireAuth }, async (req, reply) => {
    const userId = req.user!.id;
    if (!UUID_RE.test(userId)) throw unauthorized();
    if (!isProvider(req.params.provider)) throw notFound('Not connected');
    const provider = req.params.provider;
    await withTx(pool, async (c) => {
      const { rows } = await c.query<{ has_password: boolean }>('select password_hash is not null as has_password from auth.users where id = $1 for update', [userId]);
      if (!rows[0]) throw unauthorized('Account no longer exists');
      const others = await c.query('select 1 from auth.user_identities where user_id = $1 and provider <> $2', [userId, provider]);
      if (!rows[0].has_password && !others.rowCount) throw conflict('This is your only way to sign in: set a password first (sign out, then "forgot password?")');
      const del = await c.query('delete from auth.user_identities where user_id = $1 and provider = $2', [userId, provider]);
      if (!del.rowCount) throw notFound('Not connected');
    });
    req.log.info({ provider, userId }, 'provider disconnected');
    return reply.status(204).send();
  });
}

