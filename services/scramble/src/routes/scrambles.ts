import type { FastifyInstance, FastifyRequest } from 'fastify';
import { INTERNAL_TOKEN_HEADER, internalTokenMatches, notFound, parse, rateLimit, rateLimited, type Redis } from '@cubr/common';
import { ALL_EVENTS, defaultScrambleType, getScrambleType, isEventId, isWcaEvent, scrambleTypesFor } from '@cubr/cubestats';
import { toHttpError } from '../errors.js';
import type { ScrambleGenerator } from '../generator.js';
import type { CsTimerHost } from '../cstimer.js';
import { cstimerImageRequest, makeScramble, ScrambleTypeUnavailableError, type MakeDeps } from '../kinds.js';
import type { ScramblePool } from '../pool.js';
import { errorMessage, throttledWarn } from '../util.js';
import { imageQuerySchema, scrambleQuerySchema } from '../validation.js';

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
  /** csTimer's scramblers and drawings (cstimer.ts) */
  cstimer: CsTimerHost;
}

export function registerScrambleRoutes(app: FastifyInstance, deps: ScrambleRouteDeps) {
  const { generator, pool, redis, internalToken, cstimer } = deps;
  const warn = throttledWarn(app.log, 15_000);
  const isInternal = (req: FastifyRequest) => internalToken.length >= 16 && internalTokenMatches(internalToken, req.headers[INTERNAL_TOKEN_HEADER]);

  app.get('/api/scrambles/events', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return {
      events: ALL_EVENTS.map(({ id, name, short, puzzle, kind }) => ({
        id,
        name,
        short,
        puzzle,
        kind,
        types: scrambleTypesFor(id).map(({ id: type, label, pending }) => ({ id: type, label, ...(pending ? { pending } : {}) })),
      })),
    };
  });

  /** a WCA event's default scramble for a relay or cuboid: the pool's first, else a new one */
  const wcaScramble = async (event: string): Promise<string> => {
    if (pool.available()) {
      try {
        const [s] = await pool.take(event, 1);
        if (s) return s;
      } catch (err) {
        warn('take', { err: errorMessage(err) }, 'scramble pool unavailable, generating directly');
      }
    }
    return generator.generate(event, 'request');
  };
  const make: MakeDeps = { generate: (job) => generator.generate(job, 'request'), wca: wcaScramble, cstimer: (type, length) => cstimer.scramble(type, length) };

  /** csTimer's drawings of the scrambles cubr can't draw (no cubing.js puzzle), by scramble: cached */
  const images = new Map<string, string>();
  app.get<{ Params: { event: string } }>('/api/scrambles/:event/image', async (req, reply) => {
    const { event } = req.params;
    if (!isEventId(event)) throw notFound(`Unknown event "${event}"`);
    const query = parse(imageQuerySchema, req.query);
    const ask = cstimerImageRequest(event, query.type, query.scramble);
    if (!ask) throw notFound(`no csTimer drawing for ${event}${query.type ? ` (${query.type})` : ''}`);
    if (!isInternal(req) && !(await rateLimit(redis, `scramble-req:${req.ip}`, REQUESTS_PER_MIN, 60))) {
      throw rateLimited('Too many scramble requests, try again in a minute');
    }
    const key = `${ask.type}\n${ask.scramble}`;
    let svg = images.get(key);
    if (svg === undefined) {
      let drawn: string | null;
      try {
        drawn = await cstimer.image(ask.type, ask.scramble);
      } catch (err) {
        throw toHttpError(err);
      }
      // an SVG of polygons and labels: anything that could run or load something is refused
      if (!drawn || !drawn.startsWith('<svg') || /<script|<foreignObject|\bon\w+\s*=|javascript:|<image|href=/i.test(drawn)) {
        throw notFound(`csTimer can't draw ${event}`);
      }
      svg = drawn;
      images.set(key, svg);
      if (images.size > 500) images.delete(images.keys().next().value!);
    }
    reply
      .header('content-type', 'image/svg+xml; charset=utf-8')
      .header('cache-control', 'public, max-age=86400')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      .header('x-content-type-options', 'nosniff');
    return svg;
  });

  app.get<{ Params: { event: string } }>('/api/scrambles/:event', async (req, reply) => {
    const { event } = req.params;
    if (!isEventId(event)) throw notFound(`Unknown event "${event}"`);
    const query = parse(scrambleQuerySchema, req.query);
    const type = query.type === undefined ? defaultScrambleType(event) : getScrambleType(event, query.type);
    if (!type) throw notFound(`Unknown scramble type "${query.type}" for ${event}`);
    if (type.pending) throw notFound(`${event}: ${type.label} scrambles aren't available yet`);
    const pooled = isWcaEvent(event) && type === defaultScrambleType(event);
    const internal = isInternal(req);
    // fresh=1 always generates (the load-test / HPA path). From the internet it would let anyone
    // keep the generator busy, so only internal callers get it; for everyone else it is ignored.
    const fresh = query.fresh && internal;
    const { count } = query;
    if (!internal && !(await rateLimit(redis, `scramble-req:${req.ip}`, REQUESTS_PER_MIN, 60))) {
      throw rateLimited('Too many scramble requests, try again in a minute');
    }
    reply.header('cache-control', 'no-store'); // every scramble must be unique

    // practice types and the other events: made on request (most are random moves or a quick
    // solve), counted against the generation budget like the pool's misses
    if (!pooled) {
      if (!internal && !(await rateLimit(redis, `scramble-gen:${req.ip}`, GENERATED_PER_MIN, 60, count))) {
        throw rateLimited('Too many new scrambles requested, try again in a minute');
      }
      try {
        const scrambles = await Promise.all(Array.from({ length: count }, () => makeScramble(event, type.id, make)));
        return { event, type: type.id, scrambles, source: 'generated' };
      } catch (err) {
        if (err instanceof ScrambleTypeUnavailableError) throw notFound(err.message);
        throw toHttpError(err);
      }
    }

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
