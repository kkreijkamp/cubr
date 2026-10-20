import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, notFound, parse } from '@cubetype/common';
import type { Deps } from './index.js';
import { MAX_IDS, USERNAME_RE, USER_COLUMNS, parseIdList, toPublicUser, type UserRow } from '../users.js';

const idsQuery = z.object({ ids: z.string().max(10_000).optional() });

/** Public profile routes (no auth). */
export async function registerUserRoutes(app: FastifyInstance, { pool }: Deps) {
  // GET /api/users?ids=a,b,c -> {users: PublicUser[]} in the order requested (unknown ids omitted)
  app.get('/api/users', async (req) => {
    const { ids: raw } = parse(idsQuery, req.query);
    const ids = parseIdList(raw);
    if (ids === null) throw badRequest(`ids: at most ${MAX_IDS} ids allowed`);
    if (ids.length === 0) return { users: [] };
    const { rows } = await pool.query<UserRow>(`select ${USER_COLUMNS} from auth.users where id = any($1::uuid[])`, [ids]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const users = ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [toPublicUser(row)] : [];
    });
    return { users };
  });

  // GET /api/users/:username (case-insensitive) -> {user: PublicUser}
  app.get<{ Params: { username: string } }>('/api/users/:username', async (req) => {
    const { username } = req.params;
    if (!USERNAME_RE.test(username)) throw notFound('User not found');
    const { rows } = await pool.query<UserRow>(
      `select ${USER_COLUMNS} from auth.users where lower(username) = lower($1)`,
      [username],
    );
    if (!rows[0]) throw notFound('User not found');
    return { user: toPublicUser(rows[0]) };
  });
}
