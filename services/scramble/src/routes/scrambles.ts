import type { FastifyInstance } from 'fastify';
import { notFound, parse } from '@cubr/common';
import { EVENTS, isEventId } from '@cubr/cubestats';
import { toHttpError } from '../errors.js';
import type { ScrambleGenerator } from '../generator.js';
import type { ScramblePool } from '../pool.js';
import { errorMessage, throttledWarn } from '../util.js';
import { scrambleQuerySchema } from '../validation.js';

export function registerScrambleRoutes(app: FastifyInstance, deps: { generator: ScrambleGenerator; pool: ScramblePool }) {
  const { generator, pool } = deps;
  const warn = throttledWarn(app.log, 15_000);

  app.get('/api/scrambles/events', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return { events: EVENTS.map(({ id, name, short, puzzle }) => ({ id, name, short, puzzle })) };
  });

  app.get<{ Params: { event: string } }>('/api/scrambles/:event', async (req, reply) => {
    const { event } = req.params;
    if (!isEventId(event)) throw notFound(`Unknown event "${event}"`);
    const { count, fresh } = parse(scrambleQuerySchema, req.query);
    reply.header('cache-control', 'no-store'); // every scramble must be unique

    // 1) take what the shared Redis pool has (unless fresh=1, the load-test / HPA path)
    let scrambles: string[] = [];
    if (!fresh && pool.available()) {
      try {
        scrambles = await pool.take(event, count);
      } catch (err) {
        warn('take', { err: errorMessage(err) }, 'scramble pool unavailable, generating directly');
      }
    }
    // 2) generate the rest on the fly (CPU-bound: this is what makes the HPA scale out)
    const missing = count - scrambles.length;
    if (missing > 0) {
      try {
        scrambles = scrambles.concat(await generator.generateMany(event, missing, 'request'));
      } catch (err) {
        throw toHttpError(err);
      }
    }
    return { event, scrambles, source: missing > 0 ? 'generated' : 'pool' };
  });
}
