import type { FastifyInstance } from 'fastify';
import type { VapidDetails } from 'web-push';
import type { RouteContext } from '../context.js';
import { registerImportExportRoutes } from './importExport.js';
import { registerInternalRoutes } from './internal.js';
import { registerPushRoutes } from './push.js';
import { registerSessionRoutes } from './sessions.js';
import { registerSolveRoutes } from './solves.js';

/**
 * Fetch wrappers often send `Content-Type: application/json` on every request, including a
 * body-less DELETE, which Fastify's default parser rejects with 400. Treat an empty JSON body
 * as "no body" and delegate everything else to the default (prototype-poisoning-safe) parser.
 * Route-level `bodyLimit` (import: 25 MB) still overrides the parser's default limit.
 */
function allowEmptyJsonBodies(app: FastifyInstance): void {
  const defaultJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8'); // parseAs 'string' -> always a string
    if (text.length === 0) return done(null, undefined);
    defaultJson(req, text, done);
  });
}

export async function registerRoutes(app: FastifyInstance, ctx: RouteContext, vapid: VapidDetails | null = null): Promise<void> {
  allowEmptyJsonBodies(app);
  registerSessionRoutes(app, ctx);
  registerSolveRoutes(app, ctx);
  registerImportExportRoutes(app, ctx);
  registerInternalRoutes(app, ctx);
  registerPushRoutes(app, ctx, vapid);
}
