import { loadConfig, createServer, start, createPool, pingPostgres, waitForPostgres, createRedis } from '@cubetype/common';
import { createCache } from './cache.js';
import { createDataset } from './dataset.js';
import { createRepo } from './repo.js';
import { registerRoutes } from './routes/index.js';
import { createService } from './service.js';

const config = loadConfig('wca');
const pool = createPool(config.databaseUrl);
const redis = createRedis(config.redisUrl);
const dataset = createDataset(pool);

// No migrations: the `wca` schema is owned by jobs/wca-import. Readiness gates on Postgres only,
// so the service is ready (and answers 503 "WCA data not loaded yet") before the first import.
const server = createServer(config, {
  infoPrefixes: ['/api/wca'],
  checks: { postgres: () => pingPostgres(pool) },
  softChecks: { redis: () => redis.ping() }, // cache only: fail open
  info: () => dataset.info(), // dataLoaded + export date / row counts
});
const { app } = server;

const service = createService({ repo: createRepo(pool), dataset, cache: createCache(redis, app.log) });
await registerRoutes(app, service, config.internalToken);

await start(server, config, [() => pool.end(), () => redis.quit()]);
await waitForPostgres(pool, app.log);
