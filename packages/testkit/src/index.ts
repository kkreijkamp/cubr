// Integration-test helpers. Each test file gets its own Postgres database and Redis database, the
// service's real routes on a Fastify instance (requests via app.inject, no network) and signed
// tokens for any user.
//
// Needs TEST_DATABASE_URL (a superuser connection to a throwaway Postgres server) and TEST_REDIS_URL.
// `npm run test:integration` starts both in Docker and removes them afterwards; CI runs them as
// service containers. Without them the integration suites are skipped, so `npm test` works anywhere.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { describe } from 'vitest';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import {
  createPool,
  createRedis,
  createServer,
  EVENT_STREAM,
  loadConfig,
  makeAuth,
  migrate,
  signToken,
  type BaseConfig,
  type Migration,
  type Pool,
  type Redis,
} from '@cubr/common';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const REDIS_URL = process.env.TEST_REDIS_URL ?? '';

/** Whether Postgres and Redis for integration tests are configured. */
export const integrationEnabled = DATABASE_URL !== '' && REDIS_URL !== '';

/** `describe` for suites that need Postgres and Redis; skipped (saying why) without them. */
export function describeIntegration(name: string, fn: () => void): void {
  if (integrationEnabled) describe(name, fn);
  else describe.skip(`${name} [needs Postgres and Redis: npm run test:integration]`, fn);
}

/** vitest runs test files in parallel workers; each worker uses its own Redis database (0-15). */
const worker = Number(process.env.VITEST_POOL_ID ?? 0);

/** A new, empty database on the test server, and a way to drop it. */
export async function createTestDatabase(): Promise<{ name: string; url: string; drop(): Promise<void> }> {
  const name = `cubr_test_${worker}_${randomBytes(4).toString('hex')}`;
  const admin = async (sql: string) => {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    // a server that has just started (CI service containers) can refuse connections for a moment
    for (let attempt = 1; ; attempt++) {
      try {
        await client.connect();
        break;
      } catch (err) {
        if (attempt >= 40) throw err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  await admin(`create database ${name}`);
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  return { name, url: url.toString(), drop: () => admin(`drop database if exists ${name} with (force)`) };
}

/** This worker's Redis database, emptied. */
export async function createTestRedis(): Promise<Redis> {
  const url = new URL(REDIS_URL);
  url.pathname = `/${worker % 16}`;
  const redis = createRedis(url.toString());
  await redis.flushdb();
  return redis;
}

export interface RequestOptions {
  /** bearer token */
  token?: string;
  /** JSON body (or a string/Buffer sent as is) */
  body?: unknown;
  headers?: Record<string, string>;
  /** the client's IP (rate limits are per IP) */
  ip?: string;
}

export interface TestServer {
  app: FastifyInstance;
  config: BaseConfig;
  pool: Pool;
  redis: Redis;
  auth: ReturnType<typeof makeAuth>;
  request(method: InjectOptions['method'], url: string, opts?: RequestOptions): Promise<LightMyRequestResponse>;
  /** A valid bearer token for any user id and name, signed with this server's secret. */
  token(user: { id: string; username: string }): Promise<string>;
  /** Domain events published to the Redis stream so far, oldest first. */
  events(type?: string): Promise<{ type: string; data: Record<string, unknown> }[]>;
  /** Closes the app and the connections, and drops the database. */
  close(): Promise<void>;
}

export interface TestServerOptions {
  service: string;
  infoPrefixes: string[];
  /** schemas to migrate, in order (a service can read another's tables) */
  schemas?: { schema: string; migrations: Migration[] }[];
  bodyLimit?: number;
  config?: Partial<BaseConfig>;
  /** registers the service's routes */
  routes(deps: { app: FastifyInstance; config: BaseConfig; pool: Pool; redis: Redis; auth: ReturnType<typeof makeAuth> }): Promise<void> | void;
}

/** A service with a fresh database (migrated) and Redis, ready for app.inject. */
export async function startTestServer(opts: TestServerOptions): Promise<TestServer> {
  const db = await createTestDatabase();
  const config: BaseConfig = {
    ...loadConfig(opts.service),
    logLevel: 'silent',
    databaseUrl: db.url,
    redisUrl: REDIS_URL,
    jwtSecret: `test-secret-${randomBytes(8).toString('hex')}`,
    internalToken: 'test-internal-token',
    ...opts.config,
  };
  const pool = createPool(db.url, { max: 5 });
  const redis = await createTestRedis();
  const auth = makeAuth(config.jwtSecret, redis);
  for (const { schema, migrations } of opts.schemas ?? []) await migrate(pool, schema, migrations);
  const { app } = createServer(config, { infoPrefixes: opts.infoPrefixes, ...(opts.bodyLimit ? { bodyLimit: opts.bodyLimit } : {}) });
  await opts.routes({ app, config, pool, redis, auth });
  await app.ready();

  return {
    app,
    config,
    pool,
    redis,
    auth,
    request(method, url, { token, body, headers = {}, ip } = {}) {
      const json = body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body);
      return app.inject({
        method,
        url,
        headers: {
          ...(json ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(ip ? { 'x-forwarded-for': ip } : {}),
          ...headers,
        },
        ...(body !== undefined ? { payload: json ? JSON.stringify(body) : (body as string | Buffer) } : {}),
      });
    },
    async token(user) {
      return (await signToken(config.jwtSecret, user)).token;
    },
    async events(type) {
      const entries = await redis.xrange(EVENT_STREAM, '-', '+');
      const out = entries.map(([, fields]) => {
        const f: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) f[fields[i]] = fields[i + 1];
        return { type: f.type, data: JSON.parse(f.data ?? '{}') as Record<string, unknown> };
      });
      return type ? out.filter((e) => e.type === type) : out;
    },
    async close() {
      await app.close();
      await pool.end();
      redis.disconnect();
      await db.drop();
    },
  };
}
