import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { BaseConfig } from './config.js';
import { HttpError } from './errors.js';

export type DependencyCheck = () => Promise<unknown>;

export interface ServerOptions {
  /** Public route prefixes for this service, e.g. ['/api/solves', '/api/sessions'].
   *  `<prefix>/_info` is registered for each one. */
  infoPrefixes: string[];
  /** Named dependency checks that gate /readyz and appear in _info (e.g. { postgres: () => pingPostgres(pool) }). */
  checks?: Record<string, DependencyCheck>;
  /** Dependencies shown in _info but NOT gating readiness (the service degrades gracefully without them). */
  softChecks?: Record<string, DependencyCheck>;
  /** Max request body in bytes (default 1 MiB). */
  bodyLimit?: number;
  /** Extra fields merged into the _info payload (left out if they take longer than the 2 s check deadline). */
  info?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface Server {
  app: FastifyInstance;
  /** True once SIGTERM has been received (readiness then reports 503). */
  isShuttingDown(): boolean;
  markShuttingDown(): void;
}

const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS ?? 1);
const CHECK_TIMEOUT_MS = 2000; // probes must answer fast even when a dependency hangs

/** `p`, or a 'timeout' rejection once CHECK_TIMEOUT_MS has passed. */
function withCheckTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function runCheck(fn: DependencyCheck): Promise<'ok' | 'down'> {
  try {
    await withCheckTimeout(fn());
    return 'ok';
  } catch {
    return 'down';
  }
}

/**
 * Security headers on every API response (errors included). The API only ever answers with data,
 * so nothing it sends may run as a page or be framed (CSP), sniffed as another type, or read by other
 * sites' pages (CORP; avatars included, which only cubr's own pages show). A route may set a stricter
 * value of its own. Which pod and version answered is in <prefix>/_info and the logs, not in headers.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

/**
 * Search engines may fetch the API (Google renders pages, e.g. the leaderboards, from it, and skips
 * whatever robots.txt blocks) but must never list its answers.
 */
export const ROBOTS_HEADERS: Readonly<Record<string, string>> = { 'X-Robots-Tag': 'noindex' };

/**
 * The JSON error envelope (SPEC section 5) for whatever a route throws. HttpErrors, bad requests and
 * oversized bodies are answered without a log line, so a route that keeps its requests out of the logs
 * (logLevel warn: /api/errors, /api/feedback) never has one recorded next to the visitor's address;
 * anything else is logged as "unhandled error" and answered 500.
 */
export function replyWithError(err: FastifyError | HttpError | ZodError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof HttpError) {
    return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
  }
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    return reply.status(400).send({
      error: { code: 'BAD_REQUEST', message: `${issue.path.join('.')}: ${issue.message}` },
    });
  }
  const fe = err as FastifyError;
  if (fe.statusCode === 413 || fe.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return reply.status(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
  }
  if (fe.validation || (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500)) {
    return reply.status(fe.statusCode ?? 400).send({ error: { code: 'BAD_REQUEST', message: fe.message } });
  }
  req.log.error({ err }, 'unhandled error');
  return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}

/**
 * Creates a Fastify instance with the cross-cutting behaviour every cubr service shares:
 * JSON error envelope, the security headers, /healthz, /readyz and <prefix>/_info.
 */
export function createServer(config: BaseConfig, opts: ServerOptions): Server {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      base: { svc: config.serviceName, pod: config.podName },
    },
    bodyLimit: opts.bodyLimit ?? 1024 * 1024,
    // Number of reverse-proxy hops whose X-Forwarded-For we trust when deriving req.ip (used for
    // rate limiting). Local gateway: 1. GKE Ingress (client -> Google Front End -> pod): 2.
    // Trusting every hop would let clients spoof their IP via X-Forwarded-For.
    trustProxy: (_address: string, hop: number) => hop < TRUST_PROXY_HOPS,
  });

  const startedAt = new Date();
  let shuttingDown = false;
  const checks = opts.checks ?? {};

  // a route's own value wins (the avatars' stricter CSP adds `sandbox`, so an upload can never act as a page)
  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [name, value] of Object.entries({ ...SECURITY_HEADERS, ...ROBOTS_HEADERS })) if (!reply.hasHeader(name)) reply.header(name, value);
    return payload;
  });

  app.setErrorHandler(replyWithError);

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found` } });
  });

  // Liveness: the process is up. Never checks dependencies (a DB outage must not restart pods).
  app.get('/healthz', { logLevel: 'warn' }, async () => ({ status: 'ok' }));

  // Readiness: dependencies reachable and not shutting down. K8s / the load balancer only
  // routes traffic to ready pods.
  app.get('/readyz', { logLevel: 'warn' }, async (_req, reply) => {
    if (shuttingDown) return reply.status(503).send({ status: 'shutting-down' });
    const entries = await Promise.all(
      Object.entries(checks).map(async ([name, fn]) => [name, await runCheck(fn)] as const),
    );
    const deps = Object.fromEntries(entries);
    const ok = entries.every(([, s]) => s === 'ok');
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not-ready', deps });
  });

  const allChecks = { ...checks, ...(opts.softChecks ?? {}) };
  const infoHandler = async () => {
    // The service's extra fields may query a dependency too. Run them alongside the checks and
    // under the same deadline (left out if late), so _info answers within ~2 s: a caller
    // gives up after 2.5 s and would show "timeout" instead of which dependency is down.
    const [entries, extra] = await Promise.all([
      Promise.all(Object.entries(allChecks).map(async ([name, fn]) => [name, await runCheck(fn)] as const)),
      opts.info ? withCheckTimeout(Promise.resolve().then(opts.info)).catch(() => ({})) : {},
    ]);
    return {
      service: config.serviceName,
      version: config.version,
      pod: config.podName,
      node: config.nodeName,
      startedAt: startedAt.toISOString(),
      uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
      deps: Object.fromEntries(entries),
      ...extra,
    };
  };
  for (const prefix of opts.infoPrefixes) {
    app.get(`${prefix}/_info`, { logLevel: 'warn' }, infoHandler);
  }

  return {
    app,
    isShuttingDown: () => shuttingDown,
    markShuttingDown: () => {
      shuttingDown = true;
    },
  };
}

/**
 * Starts listening and wires graceful shutdown: on SIGTERM/SIGINT readiness flips to 503,
 * in-flight requests finish, then the `onClose` hooks (pools, consumers) run.
 */
export async function start(
  server: Server,
  config: BaseConfig,
  onClose: Array<() => Promise<unknown> | unknown> = [],
): Promise<void> {
  const { app } = server;
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    server.markShuttingDown();
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      app.log.error('forced exit after shutdown timeout');
      process.exit(1);
    }, 20_000);
    force.unref();
    try {
      await app.close();
      for (const fn of onClose) {
        try {
          await fn();
        } catch (err) {
          app.log.warn({ err }, 'error during shutdown hook');
        }
      }
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: config.port });
  app.log.info(
    { version: config.version, node: config.nodeName },
    `${config.serviceName} listening on :${config.port}`,
  );
}
