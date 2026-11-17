import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, canViewProfile, forbidden, parse, type Redis, type makeAuth } from '@cubr/common';
import { DAILY_EVENTS, isEventId } from '@cubr/cubestats';
import { readBoard, readUserRanks } from '../board.js';
import {
  PERIODS,
  PERIOD_KINDS,
  boardKey,
  challengeKey,
  currentPeriodKey,
  isKind,
  isValidDay,
  isValidWeek,
  utcDay,
} from '../keys.js';

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
  /** optional past board: YYYY-MM-DD (daily) or YYYY-Www (weekly); ignored for period=all */
  key: z.string().max(10).optional(),
  ...paging,
});

const challengeQuery = z.object({
  date: z.string().max(10).optional(),
  event: z.string().max(10).default('333'),
  ...paging,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function registerRoutes(app: FastifyInstance, { redis, auth }: Deps): Promise<void> {
  // GET /api/leaderboards/daily-challenge?date=YYYY-MM-DD&event=333 (date defaults to today, UTC)
  app.get('/api/leaderboards/daily-challenge', { preHandler: auth.optionalAuth }, async (req) => {
    const q = parse(challengeQuery, req.query);
    if (!(DAILY_EVENTS as string[]).includes(q.event)) {
      throw badRequest(`event: no daily challenge for '${q.event}' (one of ${DAILY_EVENTS.join(', ')})`);
    }
    const date = q.date ?? utcDay(new Date());
    if (!isValidDay(date)) throw badRequest('date: expected YYYY-MM-DD');
    const board = await readBoard(redis, challengeKey(date, q.event), q.page, q.size, req.user?.id);
    return { event: q.event, kind: 'ao5', period: 'challenge', periodKey: date, total: board.total, page: q.page, size: q.size, entries: board.entries, me: board.me, flagged: board.flagged };
  });

  // GET /api/leaderboards/users/:userId/ranks -> positions on every all-time board. A private
  // profile's ranks go to its owner only (the boards themselves still list them).
  app.get<{ Params: { userId: string } }>('/api/leaderboards/users/:userId/ranks', { preHandler: auth.optionalAuth }, async (req) => {
    const { userId } = req.params;
    if (!UUID_RE.test(userId)) throw badRequest('userId: expected a UUID');
    if (!(await canViewProfile(redis, req.user?.id, userId))) throw forbidden('This profile is private');
    return { ranks: await readUserRanks(redis, userId.toLowerCase()) };
  });

  // GET /api/leaderboards/:event/:kind?period=all|weekly|daily&page=1&size=50[&key=...]
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

      let periodKey = currentPeriodKey(q.period);
      if (q.key !== undefined && q.period !== 'all') {
        const ok = q.period === 'daily' ? isValidDay(q.key) : isValidWeek(q.key);
        if (!ok) throw badRequest(`key: expected ${q.period === 'daily' ? 'YYYY-MM-DD' : 'YYYY-Www'}`);
        periodKey = q.key;
      }

      const board = await readBoard(redis, boardKey(event, kind, q.period, periodKey), q.page, q.size, req.user?.id);
      return { event, kind, period: q.period, periodKey, total: board.total, page: q.page, size: q.size, entries: board.entries, me: board.me, flagged: board.flagged };
    },
  );
}
