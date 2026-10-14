import { badRequest, parse, requireInternal } from '@cubetype/common';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Cached } from '../cache.js';
import { WCA_ID_RE, distributionQuery, personParams, personSearchQuery, rankQuery } from '../schemas.js';
import { requireEvent, type Service } from '../service.js';
import { validateApiValue } from '../units.js';

/** Public data is identical for every user and changes at most weekly: let browsers/proxies keep it. */
function send<T>(reply: FastifyReply, result: Cached<T> | { value: T; hit?: undefined }, maxAgeSec = 300): T {
  if (result.hit !== undefined) reply.header('X-Cache', result.hit ? 'HIT' : 'MISS'); // Redis cache-aside result
  reply.header('Cache-Control', `public, max-age=${maxAgeSec}`);
  return result.value;
}

export async function registerRoutes(app: FastifyInstance, svc: Service, internalToken: string): Promise<void> {
  app.get('/api/wca/meta', async (_req, reply) => send(reply, await svc.meta(), 60));

  app.get('/api/wca/records', async (_req, reply) => send(reply, await svc.records()));

  app.get('/api/wca/rank', async (req, reply) => {
    const q = parse(rankQuery, req.query);
    requireEvent(q.event); // 404 for unknown events
    const problem = validateApiValue(q.event, q.value);
    if (problem) throw badRequest(problem);
    return send(reply, { value: await svc.rank(q) }); // value-specific, fast enough uncached
  });

  app.get('/api/wca/distribution', async (req, reply) => {
    const q = parse(distributionQuery, req.query);
    requireEvent(q.event);
    return send(reply, await svc.distribution(q));
  });

  app.get('/api/wca/persons', async (req, reply) => {
    const q = parse(personSearchQuery, req.query);
    const upper = q.q.toUpperCase();
    return send(reply, await svc.searchPersons(q, WCA_ID_RE.test(upper) ? upper : null), 60);
  });

  app.get('/api/wca/persons/:wcaId', async (req, reply) => {
    const { wcaId } = parse(personParams, req.params);
    return send(reply, await svc.person(wcaId));
  });

  app.get('/api/wca/countries', async (_req, reply) => send(reply, await svc.countries()));

  // Service-to-service only (leaderboard anti-cheat); not routed by the Ingress/gateway, and
  // callers must send X-Internal-Token.
  app.get('/internal/records', { preHandler: requireInternal(internalToken, app.log) }, async () => svc.internalRecords());
}
