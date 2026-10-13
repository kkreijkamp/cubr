import type { Pool, Redis } from '@cubetype/common';
import type { FastifyInstance } from 'fastify';
import { registerGlobalRoutes } from './global.js';
import { registerInternalRoutes } from './internal.js';
import { registerUserRoutes } from './users.js';

export interface RouteDeps {
  pool: Pool;
  redis: Redis;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  await registerUserRoutes(app, deps.pool);
  await registerGlobalRoutes(app, deps.pool, deps.redis);
  await registerInternalRoutes(app, deps.pool);
}
