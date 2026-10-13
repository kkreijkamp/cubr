import { badRequest, parse } from '@cubetype/common';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { rankQuery } from '../schemas.js';
import { requireEvent, type Service } from '../service.js';
import { validateApiValue } from '../units.js';

/** Public data is identical for every user and changes at most weekly: let browsers/proxies keep it. */
function send<T>(reply: FastifyReply, value: T, maxAgeSec = 300): T {
  reply.header('Cache-Control', `public, max-age=${maxAgeSec}`);
  return value;
}

export async function registerRoutes(app: FastifyInstance, svc: Service): Promise<void> {
  app.get('/api/wca/meta', async (_req, reply) => send(reply, await svc.meta(), 60));

  app.get('/api/wca/records', async (_req, reply) => send(reply, await svc.records()));

  app.get('/api/wca/rank', async (req, reply) => {
    const q = parse(rankQuery, req.query);
    requireEvent(q.event); // 404 for unknown events
    const problem = validateApiValue(q.event, q.value);
    if (problem) throw badRequest(problem);
    return send(reply, await svc.rank(q));
  });

  // Service-to-service only (leaderboard anti-cheat); not routed by the Ingress/gateway.
  app.get('/internal/records', async () => svc.internalRecords());
}
