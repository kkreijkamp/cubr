import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, parse, type Redis, type makeAuth } from '@cubetype/common';
import { isEventId } from '@cubetype/cubestats';
import { readBoard, readUserRanks } from '../board.js';
import { PERIODS, PERIOD_KINDS, boardKey, currentPeriodKey, isKind } from '../keys.js';

export interface Deps {
  redis: Redis;
  auth: ReturnType<typeof makeAuth>;
}

const paging = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  size: z.coerce.number().int().min(1).max(100).default(50),
};

const boardQuery = z.object({
  period: z.enum(PERIODS).default('all'),
  ...paging,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function registerRoutes(app: FastifyInstance, { redis, auth }: Deps): Promise<void> {
  // GET /api/leaderboards/users/:userId/ranks → positions on every all-time board
  app.get<{ Params: { userId: string } }>('/api/leaderboards/users/:userId/ranks', async (req) => {
    const { userId } = req.params;
    if (!UUID_RE.test(userId)) throw badRequest('userId: expected a UUID');
    return { ranks: await readUserRanks(redis, userId.toLowerCase()) };
  });

  // GET /api/leaderboards/:event/:kind?period=all|weekly|daily&page=1&size=50
  app.get<{ Params: { event: string; kind: string } }>(
    '/api/leaderboards/:event/:kind',
    { preHandler: auth.optionalAuth },
    async (req) => {
      const { event, kind } = req.params;
      const q = parse(boardQuery, req.query);
      if (!isEventId(event)) throw badRequest(`event: unknown event '${event}'`);
      if (!isKind(kind)) throw badRequest(`kind: expected one of single, ao5, ao12`);
      if (!PERIOD_KINDS[q.period].includes(kind)) {
        throw badRequest(`kind: ${q.period} boards exist for ${PERIOD_KINDS[q.period].join(', ')} only`);
      }

      const periodKey = currentPeriodKey(q.period);
      const board = await readBoard(redis, boardKey(event, kind, q.period, periodKey), q.page, q.size, req.user?.id);
      return { event, kind, period: q.period, periodKey, total: board.total, page: q.page, size: q.size, entries: board.entries, me: board.me };
    },
  );
}
