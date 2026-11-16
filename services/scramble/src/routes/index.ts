import type { FastifyInstance } from 'fastify';
import type { Redis } from '@cubr/common';
import type { DailyChallenges } from '../daily.js';
import type { ScrambleGenerator } from '../generator.js';
import type { ScramblePool } from '../pool.js';
import { registerDailyRoutes } from './daily.js';
import { registerScrambleRoutes } from './scrambles.js';

export interface RouteDeps {
  generator: ScrambleGenerator;
  pool: ScramblePool;
  daily: DailyChallenges;
  redis: Redis;
  internalToken: string;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  // static paths (/events, /daily, /_info) take precedence over /:event in Fastify's router
  registerDailyRoutes(app, deps);
  registerScrambleRoutes(app, deps);
}
