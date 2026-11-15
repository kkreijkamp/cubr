import type { FastifyInstance } from 'fastify';
import { parse } from '@cubr/common';
import type { DailyChallenges } from '../daily.js';
import { toHttpError } from '../errors.js';
import { dailyQuerySchema, resolveDailyDate } from '../validation.js';

export function registerDailyRoutes(app: FastifyInstance, deps: { daily: DailyChallenges }) {
  app.get('/api/scrambles/daily', async (req) => {
    const date = resolveDailyDate(parse(dailyQuerySchema, req.query).date);
    try {
      return await deps.daily.get(date);
    } catch (err) {
      throw toHttpError(err);
    }
  });
}
