import {
  loadConfig, createServer, start, createPool, waitForPostgres, migrate, createRedis, makeAuth,
} from '@cubetype/common';
import { migrations } from './migrations.js';
import { startOutboxRelay, type Relay } from './outbox.js';
import { queryWithTimeout } from './pgTimeout.js';
import { registerRoutes } from './routes/index.js';

const config = loadConfig('solve');
const pool = createPool(config.databaseUrl);
const redis = createRedis(config.redisUrl);

let migrated = false;
let relay: Relay | undefined;

const server = createServer(config, {
  infoPrefixes: ['/api/solves', '/api/sessions'],
  checks: {
    // Timeout-guarded so a probe against a dead-but-open connection drops that client instead of
    // leaking it (otherwise frequent probes during an outage can exhaust the pool for good).
    postgres: () => queryWithTimeout(pool, 'select 1', [], 1500),
    migrations: async () => {
      if (!migrated) throw new Error('migrations pending');
    },
  },
  // Redis is soft: the transactional outbox keeps accepting solves while Redis is down.
  softChecks: { redis: () => redis.ping() },
  info: async () => ({ outbox: relay ? await relay.info() : null }),
});
const { app } = server;
const auth = makeAuth(config.jwtSecret, redis);

await registerRoutes(app, { config, pool, redis, auth });

// Listen first so liveness passes while Postgres boots; readiness stays 503 until migrated.
// Shutdown order: stop the relay (it holds a pool client), then close Postgres and Redis.
await start(server, config, [() => relay?.stop(), () => pool.end(), () => redis.quit()]);
await waitForPostgres(pool, app.log);
await migrate(pool, 'solve', migrations, app.log);
migrated = true;
relay = startOutboxRelay({ pool, redis, log: app.log });
