import {
  loadConfig, createServer, start, createPool, pingPostgres, waitForPostgres, migrate, createRedis, makeAuth, consumeEvents,
  registerDeadLetterRoutes, type Consumer,
} from '@cubr/common';
import { migrations } from './migrations.js';
import { startOutboxRelay, type Relay } from './outbox.js';
import { makeUserPurge, PURGE_TYPES } from './purge.js';
import { registerRoutes } from './routes/index.js';

const config = loadConfig('solve');
const pool = createPool(config.databaseUrl);
const redis = createRedis(config.redisUrl);

let migrated = false;
let relay: Relay | undefined;
let consumer: Consumer | undefined;

const server = createServer(config, {
  infoPrefixes: ['/api/solves', '/api/sessions'],
  checks: {
    postgres: () => pingPostgres(pool),
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
registerDeadLetterRoutes(app, { redis, group: 'solve', internalToken: config.internalToken });

// Listen first so liveness passes while Postgres boots; readiness stays 503 until migrated.
// Shutdown order: stop the relay and the consumer (they hold pool clients), then close Postgres and Redis.
await start(server, config, [() => relay?.stop(), () => consumer?.stop(), () => pool.end(), () => redis.quit()]);
await waitForPostgres(pool, app.log);
await migrate(pool, 'solve', migrations, app.log);
migrated = true;
relay = startOutboxRelay({ pool, redis, log: app.log });
// The only event solve consumes: user.deleted (delete the account's sessions and solves).
consumer = consumeEvents(redis, { group: 'solve', consumer: config.podName, types: PURGE_TYPES, handler: makeUserPurge({ pool, log: app.log }), log: app.log });
