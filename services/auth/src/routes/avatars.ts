import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { badRequest, notFound, rateLimited, unauthorized, withTx } from '@cubetype/common';
import type { Deps } from './index.js';
import {
  AVATAR_MAX_BYTES,
  AVATAR_TYPES,
  USERNAME_RE,
  USER_COLUMNS,
  UUID_RE,
  baseContentType,
  sniffImageType,
  toPrivateUser,
  toPublicUser,
  userEventData,
  type UserRow,
} from '../users.js';
import { allow, publishSafely } from '../safe.js';

/**
 * Profile pictures.
 *   PUT    /api/auth/me/avatar          raw image body (image/webp|jpeg|png, ≤ 300 KB) → {user}
 *   DELETE /api/auth/me/avatar          → {user}
 *   GET    /api/users/:username/avatar  image bytes; the path segment may be a user id or a username
 * A changed picture publishes user.updated (with the new avatarUrl), so other services — e.g. the
 * leaderboard's display cache — pick it up through the event bus.
 */
export async function registerAvatarRoutes(app: FastifyInstance, { pool, redis, auth }: Deps) {
  // Image uploads arrive as raw bytes; Fastify's default parsers only handle JSON/text.
  app.addContentTypeParser([...AVATAR_TYPES], { parseAs: 'buffer', bodyLimit: AVATAR_MAX_BYTES }, (_req, body, done) => done(null, body));

  app.put('/api/auth/me/avatar', { preHandler: auth.requireAuth }, async (req) => {
    const userId = req.user!.id;
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw badRequest(`Send the picture as the raw request body with Content-Type ${AVATAR_TYPES.join(', ')}`);
    }
    const declared = baseContentType(req.headers['content-type']);
    const actual = sniffImageType(body);
    if (!actual || actual !== declared) throw badRequest('File is not a valid PNG, JPEG or WebP image');
    if (!(await allow(redis, `avatar:${userId}`, 10, 3600))) throw rateLimited('Too many picture changes, try again later');

    const version = createHash('sha256').update(body).digest('hex').slice(0, 12);
    const row = await withTx(pool, async (client) => {
      await client.query(
        `insert into auth.avatars (user_id, content_type, bytes, version) values ($1, $2, $3, $4)
         on conflict (user_id) do update set content_type = excluded.content_type, bytes = excluded.bytes,
                                             version = excluded.version, updated_at = now()`,
        [userId, actual, body, version],
      );
      const { rows } = await client.query<UserRow>(`update auth.users set avatar_version = $2 where id = $1 returning ${USER_COLUMNS}`, [userId, version]);
      return rows[0];
    });
    if (!row) throw unauthorized('Account no longer exists');
    await publishSafely(redis, req.log, 'user.updated', userEventData(toPublicUser(row)));
    return { user: toPrivateUser(row) };
  });

  app.delete('/api/auth/me/avatar', { preHandler: auth.requireAuth }, async (req) => {
    const userId = req.user!.id;
    const row = await withTx(pool, async (client) => {
      await client.query('delete from auth.avatars where user_id = $1', [userId]);
      const { rows } = await client.query<UserRow>(`update auth.users set avatar_version = null where id = $1 returning ${USER_COLUMNS}`, [userId]);
      return rows[0];
    });
    if (!row) throw unauthorized('Account no longer exists');
    await publishSafely(redis, req.log, 'user.updated', userEventData(toPublicUser(row)));
    return { user: toPrivateUser(row) };
  });

  app.get<{ Params: { username: string }; Querystring: { v?: string } }>('/api/users/:username/avatar', async (req, reply) => {
    const key = req.params.username;
    const byId = UUID_RE.test(key);
    if (!byId && !USERNAME_RE.test(key)) throw notFound('No profile picture');
    const { rows } = await pool.query<{ content_type: string; bytes: Buffer; version: string }>(
      `select a.content_type, a.bytes, a.version
         from auth.avatars a join auth.users u on u.id = a.user_id
        where ${byId ? 'u.id = $1' : 'lower(u.username) = lower($1)'}`,
      [key],
    );
    const pic = rows[0];
    if (!pic) throw notFound('No profile picture');
    const etag = `"${pic.version}"`;
    reply
      .header('Content-Type', pic.content_type)
      .header('ETag', etag)
      // a ?v= URL matching the current version never changes → cache for a year; otherwise revalidate
      .header('Cache-Control', req.query.v === pic.version ? 'public, max-age=31536000, immutable' : 'public, max-age=300')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox");
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.send(pic.bytes);
  });
}
