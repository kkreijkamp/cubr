import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PRIVATE_USERS_KEY, TOKEN_TTL_SEC, conflict, notFound, parse, requireInternal, revokedUserKey, unavailable, withTx } from '@cubr/common';
import type { Deps } from './index.js';
import { maskEmail } from '../mail.js';
import { publishSafely, withTimeout } from '../safe.js';
import { USERNAME_RE, USER_COLUMNS, toPublicUser, userEventData, usernameSchema, type UserRow } from '../users.js';

/**
 * Moderation, for whoever runs cubr (decided 2026-11-26). deploy/vps/moderate.sh calls these from inside
 * the auth container, with its internal token; /internal is never routed publicly. Look an account up,
 * rename it, clear its display name and bio, remove its picture, suspend it (suspension.ts) or lift the
 * suspension. Each change is logged with the account's id, and published as user.updated so the other
 * services (boards, stats, race names) follow.
 */
type Row = UserRow & { suspended_at: Date | null; suspended_note: string | null };
const COLUMNS = `${USER_COLUMNS}, suspended_at, suspended_note`;

/** An account as the tool shows it: enough to decide, the email masked. */
function summary(row: Row) {
  return {
    id: row.id,
    username: row.username,
    email: maskEmail(row.email),
    displayName: row.display_name ?? null,
    bio: row.bio ?? null,
    picture: row.avatar_version !== null && row.avatar_version !== undefined,
    private: row.profile_private === true,
    suspendedAt: row.suspended_at,
    suspendedNote: row.suspended_note,
    createdAt: row.created_at,
  };
}

export async function registerModerationRoutes(app: FastifyInstance, { config, pool, redis }: Deps) {
  const internalOnly = { preHandler: requireInternal(config.internalToken, app.log) };
  type Named = { Params: { username: string } };

  async function find(username: string): Promise<Row> {
    if (!USERNAME_RE.test(username)) throw notFound('No such account');
    const { rows } = await pool.query<Row>(`select ${COLUMNS} from auth.users where lower(username) = lower($1)`, [username]);
    if (!rows[0]) throw notFound('No such account');
    return rows[0];
  }

  /** Publishes the account's public profile after a change, so the other services follow. */
  const changed = (row: Row, log: FastifyInstance['log']) => publishSafely(redis, log, 'user.updated', userEventData(toPublicUser(row)));

  app.get<Named>('/internal/moderation/users/:username', internalOnly, async (req) => ({ user: summary(await find(req.params.username)) }));

  // every session ends, sign-in is refused, the profile turns private; the times stay
  app.post<Named>('/internal/moderation/users/:username/suspend', internalOnly, async (req) => {
    const { note } = parse(z.object({ note: z.string().trim().max(500).optional() }), req.body ?? {});
    const user = await find(req.params.username);
    const row = await withTx(pool, async (c) => {
      const { rows } = await c.query<Row>(
        `update auth.users set suspended_at = coalesce(suspended_at, now()), suspended_note = $2, profile_private = true where id = $1 returning ${COLUMNS}`,
        [user.id, note ?? null],
      );
      await c.query('delete from auth.password_resets where user_id = $1', [user.id]);
      // its tokens stop working and the other services see it private, or nothing changes
      const at = Math.floor(Date.now() / 1000);
      const done = redis
        .multi()
        .set(revokedUserKey(user.id), String(at), 'EX', TOKEN_TTL_SEC)
        .sadd(PRIVATE_USERS_KEY, user.id.toLowerCase())
        .exec()
        .then((res) => (res ?? []).every(([err]) => !err));
      if (!(await withTimeout(done, 2000, false))) throw unavailable('Redis is unavailable: nothing changed');
      return rows[0];
    });
    req.log.warn({ userId: row.id }, 'moderation: account suspended');
    await changed(row, req.log);
    return { user: summary(row) };
  });

  // it can sign in again; its profile stays private until it changes that
  app.post<Named>('/internal/moderation/users/:username/unsuspend', internalOnly, async (req) => {
    const user = await find(req.params.username);
    const { rows } = await pool.query<Row>(`update auth.users set suspended_at = null, suspended_note = null where id = $1 returning ${COLUMNS}`, [user.id]);
    req.log.warn({ userId: user.id }, 'moderation: suspension lifted');
    return { user: summary(rows[0]) };
  });

  app.post<Named>('/internal/moderation/users/:username/rename', internalOnly, async (req) => {
    const { to } = parse(z.object({ to: usernameSchema }), req.body ?? {});
    const user = await find(req.params.username);
    let row: Row;
    try {
      ({ rows: [row] } = await pool.query<Row>(`update auth.users set username = $2 where id = $1 returning ${COLUMNS}`, [user.id, to]));
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('Username is already taken');
      throw err;
    }
    req.log.warn({ userId: user.id }, 'moderation: account renamed');
    await changed(row, req.log);
    return { user: summary(row) };
  });

  app.post<Named>('/internal/moderation/users/:username/clear-profile', internalOnly, async (req) => {
    const user = await find(req.params.username);
    const { rows } = await pool.query<Row>(`update auth.users set display_name = null, bio = null where id = $1 returning ${COLUMNS}`, [user.id]);
    req.log.warn({ userId: user.id }, 'moderation: display name and bio cleared');
    await changed(rows[0], req.log);
    return { user: summary(rows[0]) };
  });

  app.post<Named>('/internal/moderation/users/:username/remove-picture', internalOnly, async (req) => {
    const user = await find(req.params.username);
    const row = await withTx(pool, async (c) => {
      await c.query('delete from auth.avatars where user_id = $1', [user.id]);
      const { rows } = await c.query<Row>(`update auth.users set avatar_version = null where id = $1 returning ${COLUMNS}`, [user.id]);
      return rows[0];
    });
    req.log.warn({ userId: user.id }, 'moderation: profile picture removed');
    await changed(row, req.log);
    return { user: summary(row) };
  });
}
