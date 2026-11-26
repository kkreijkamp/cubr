import type { FastifyInstance, LogLevel } from 'fastify';
import { parse, rateLimited } from '@cubr/common';
import type { Deps } from './index.js';
import { allow } from '../safe.js';
import { CLIENT_ERROR_LIMITS as L, clientErrorSchema, scrubClientError } from '../clientErrors.js';

/**
 * POST /api/errors: a browser reports an uncaught error in the web app (web/src/lib/errorReports.ts).
 * The report is logged as "client error" at warn level and nothing is stored. The route's log level
 * (warn) turns off its request log lines, which carry the visitor's IP address, so a report never
 * sits next to one in the logs (the gateway doesn't log the route either). The address is only used,
 * briefly, for the rate limit.
 */
const LEVELS: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: Infinity };

/** A route's log level that leaves out its request lines (info): warn, or the service's own level when that is stricter (error, silent). */
export function quietLogLevel(serviceLevel: string): LogLevel {
  return ((LEVELS[serviceLevel] ?? 30) > LEVELS.warn ? serviceLevel : 'warn') as LogLevel;
}

export async function registerClientErrorRoutes(app: FastifyInstance, { config, redis }: Deps) {
  const logLevel = quietLogLevel(config.logLevel);
  app.post('/api/errors', { bodyLimit: L.bodyBytes, logLevel }, async (req, reply) => {
    if (!(await allow(redis, `client-error:${req.ip}`, L.perIp, L.perIpWindowSec))) throw rateLimited('Too many error reports');
    const report = parse(clientErrorSchema, req.body);
    // past the overall cap, accept and drop: the sender can't do anything about it
    if (await allow(redis, 'client-error:all', L.total, L.totalWindowSec)) req.log.warn({ clientError: scrubClientError(report) }, 'client error');
    return reply.status(204).send();
  });
}
