import {
  loadConfig,
  createServer,
  start,
  createPool,
  pingPostgres,
  waitForPostgres,
  migrate,
  createRedis,
  makeAuth,
} from '@cubr/common';
import { migrations } from './migrations.js';
import { registerRoutes } from './routes/index.js';
import { startPrivacySync } from './privacySync.js';

const config = loadConfig('auth');

let migrated = false;
const server = createServer(config, {
  infoPrefixes: ['/api/auth', '/api/users', '/api/supporters'],
  checks: {
    postgres: () => pingPostgres(pool),
    migrations: async () => {
      if (!migrated) throw new Error('migrations pending');
    },
  },
  // Redis only backs rate limits, logout revocation and event publishing -> degrade, don't gate.
  softChecks: { redis: () => redis.ping() },
});
const { app } = server;
const pool = createPool(config.databaseUrl, { log: app.log });
const redis = createRedis(config.redisUrl, app.log);
const auth = makeAuth(config.jwtSecret, redis);

await registerRoutes(app, { config, pool, redis, auth });

// Listen first so liveness passes while Postgres boots; readiness stays 503 until migrated.
await start(server, config, [() => pool.end(), () => redis.quit()]);
await waitForPostgres(pool, app.log);
await migrate(pool, 'auth', migrations, app.log);
migrated = true;
startPrivacySync(pool, redis, app.log);
app.log.info('auth ready');
