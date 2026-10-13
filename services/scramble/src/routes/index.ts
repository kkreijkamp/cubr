import type { FastifyInstance } from 'fastify';
import type { ScrambleGenerator } from '../generator.js';
import type { ScramblePool } from '../pool.js';
import { registerScrambleRoutes } from './scrambles.js';

export interface RouteDeps {
  generator: ScrambleGenerator;
  pool: ScramblePool;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  // static paths (/events, /_info) take precedence over /:event in Fastify's router
  registerScrambleRoutes(app, deps);
}
