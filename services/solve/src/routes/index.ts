import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../context.js';
import { registerInternalRoutes } from './internal.js';
import { registerSessionRoutes } from './sessions.js';
import { registerSolveRoutes } from './solves.js';

/**
 * Fetch wrappers often send `Content-Type: application/json` on every request, including a
 * body-less DELETE, which Fastify's default parser rejects with 400. Treat an empty JSON body
 * as "no body" and delegate everything else to the default (prototype-poisoning-safe) parser.
 */
function allowEmptyJsonBodies(app: FastifyInstance): void {
  const defaultJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8'); // parseAs 'string' → always a string
    if (text.length === 0) return done(null, undefined);
    defaultJson(req, text, done);
  });
}

export async function registerRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  allowEmptyJsonBodies(app);
  registerSessionRoutes(app, ctx);
  registerSolveRoutes(app, ctx);
  registerInternalRoutes(app, ctx);
}
