import type { FastifyInstance } from 'fastify';
import type { BaseConfig, Pool, Redis, makeAuth } from '@cubetype/common';
import { registerAuthRoutes } from './auth.js';
import { registerUserRoutes } from './users.js';

export interface Deps {
  config: BaseConfig;
  pool: Pool;
  redis: Redis;
  auth: ReturnType<typeof makeAuth>;
}

export async function registerRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  await registerAuthRoutes(app, deps);
  await registerUserRoutes(app, deps);
}
