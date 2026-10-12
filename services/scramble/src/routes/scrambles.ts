import type { FastifyInstance } from 'fastify';
import { notFound, parse } from '@cubetype/common';
import { EVENTS, isEventId } from '@cubetype/cubestats';
import { toHttpError } from '../errors.js';
import type { ScrambleGenerator } from '../generator.js';
import { scrambleQuerySchema } from '../validation.js';

export function registerScrambleRoutes(app: FastifyInstance, deps: { generator: ScrambleGenerator }) {
  const { generator } = deps;

  app.get('/api/scrambles/events', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return { events: EVENTS.map(({ id, name, short, puzzle }) => ({ id, name, short, puzzle })) };
  });

  app.get<{ Params: { event: string } }>('/api/scrambles/:event', async (req, reply) => {
    const { event } = req.params;
    if (!isEventId(event)) throw notFound(`Unknown event "${event}"`);
    const { count } = parse(scrambleQuerySchema, req.query);
    reply.header('cache-control', 'no-store'); // every scramble must be unique

    // random-state search: pure CPU work, queued in front of cubing.js
    try {
      const scrambles = await generator.generateMany(event, count);
      return { event, scrambles, source: 'generated' };
    } catch (err) {
      throw toHttpError(err);
    }
  });
}
