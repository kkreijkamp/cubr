import type { Pool, Redis, makeAuth } from '@cubr/common';
import type { FastifyInstance } from 'fastify';
import { registerGlobalRoutes } from './global.js';
import { registerInternalRoutes } from './internal.js';
import { registerUserRoutes } from './users.js';

export interface RouteDeps {
  pool: Pool;
  redis: Redis;
  /** shared secret for /internal routes (X-Internal-Token) */
  internalToken: string;
  /** optional sign-in on the per-user routes: owners see their own private profile */
  auth: ReturnType<typeof makeAuth>;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  await registerUserRoutes(app, deps);
  await registerGlobalRoutes(app, deps.pool, deps.redis);
  await registerInternalRoutes(app, deps.pool, deps.internalToken);
}
