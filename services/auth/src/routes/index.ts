import type { FastifyInstance } from 'fastify';
import type { BaseConfig, Pool, Redis, makeAuth } from '@cubr/common';
import { registerAuthRoutes } from './auth.js';
import { registerAvatarRoutes } from './avatars.js';
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
  await registerAvatarRoutes(app, deps);
}
