import type { FastifyInstance, FastifyRequest } from 'fastify';
import { INTERNAL_TOKEN_HEADER, internalTokenMatches, notFound, parse, rateLimit, rateLimited, type Redis } from '@cubr/common';
import { EVENTS, isEventId } from '@cubr/cubestats';
import { toHttpError } from '../errors.js';
import type { ScrambleGenerator } from '../generator.js';
import type { ScramblePool } from '../pool.js';
import { errorMessage, throttledWarn } from '../util.js';
import { scrambleQuerySchema } from '../validation.js';

/**
 * Per-IP limits for internet callers (fixed one-minute windows). Pool hits are cheap; generating
 * is CPU work (a 4x4 random-state scramble is ~0.2 CPU-s), so it has its own, smaller budget
 * counted in scrambles. Normal use (a queue of ~5 per event, mostly served from the pool) stays
 * far below both, even for a school network behind one address.
 */
export const REQUESTS_PER_MIN = 120;
export const GENERATED_PER_MIN = 60;

export interface ScrambleRouteDeps {
  generator: ScrambleGenerator;
  pool: ScramblePool;
  redis: Redis;
  /** INTERNAL_API_TOKEN: callers presenting it (in-cluster load tests) skip the limits and may use fresh=1 */
  internalToken: string;
}

export function registerScrambleRoutes(app: FastifyInstance, deps: ScrambleRouteDeps) {
  const { generator, pool, redis, internalToken } = deps;
  const warn = throttledWarn(app.log, 15_000);
  const isInternal = (req: FastifyRequest) => internalToken.length >= 16 && internalTokenMatches(internalToken, req.headers[INTERNAL_TOKEN_HEADER]);

  app.get('/api/scrambles/events', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return { events: EVENTS.map(({ id, name, short, puzzle }) => ({ id, name, short, puzzle })) };
  });

  app.get<{ Params: { event: string } }>('/api/scrambles/:event', async (req, reply) => {
    const { event } = req.params;
    if (!isEventId(event)) throw notFound(`Unknown event "${event}"`);
    const query = parse(scrambleQuerySchema, req.query);
    const internal = isInternal(req);
    // fresh=1 always generates (the load-test / HPA path). From the internet it would let anyone
    // keep the generator busy, so only internal callers get it; for everyone else it is ignored.
    const fresh = query.fresh && internal;
    const { count } = query;
    if (!internal && !(await rateLimit(redis, `scramble-req:${req.ip}`, REQUESTS_PER_MIN, 60))) {
      throw rateLimited('Too many scramble requests, try again in a minute');
    }
    reply.header('cache-control', 'no-store'); // every scramble must be unique

    // 1) take what the shared Redis pool has
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
      if (!internal && !(await rateLimit(redis, `scramble-gen:${req.ip}`, GENERATED_PER_MIN, 60, missing))) {
        // over the generation budget: hand out what the pool had rather than nothing
        if (scrambles.length > 0) return { event, scrambles, source: 'pool' };
        throw rateLimited('Too many new scrambles requested, try again in a minute');
      }
      try {
        scrambles = scrambles.concat(await generator.generateMany(event, missing, 'request'));
      } catch (err) {
        throw toHttpError(err);
      }
    }
    return { event, scrambles, source: missing > 0 ? 'generated' : 'pool' };
  });
}
