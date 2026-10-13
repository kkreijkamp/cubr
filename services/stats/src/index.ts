import {
  consumeEvents, createPool, createRedis, createServer, loadConfig, migrate, start, waitForPostgres,
  type Consumer,
} from '@cubetype/common';
import { CONSUMED_TYPES } from './eventSchemas.js';
import { migrations } from './migrations.js';
import { createProjector } from './projector.js';
import { registerRoutes } from './routes/index.js';

const config = loadConfig('stats');
const pool = createPool(config.databaseUrl);
const redis = createRedis(config.redisUrl);

let migrated = false;
let consumer: Consumer | null = null;

const server = createServer(config, {
  infoPrefixes: ['/api/stats'],
  checks: {
    postgres: () => pool.query('select 1'),
    migrations: async () => {
      if (!migrated) throw new Error('migrations pending');
    },
  },
  // Redis down only delays event processing (the consumer retries) and disables the global cache.
  softChecks: { redis: () => redis.ping() },
  info: () => ({ consumer: consumer?.stats() ?? null }),
});
const { app } = server;

await registerRoutes(app, { pool, redis });

// Listen first so liveness passes while Postgres boots; readiness stays 503 until migrated.
await start(server, config, [
  () => consumer?.stop(),
  () => pool.end(),
  () => redis.quit(),
]);
await waitForPostgres(pool, app.log);
await migrate(pool, 'stats', migrations, app.log);
migrated = true;

// Background work: the event consumer (CQRS projection).
const handle = createProjector({ pool, redis, log: app.log });
consumer = consumeEvents(redis, {
  group: 'stats',
  consumer: config.podName,
  types: [...CONSUMED_TYPES],
  handler: handle,
  log: app.log,
});
app.log.info({ group: 'stats', consumer: config.podName }, 'stats projection started');
