import { loadConfig, createServer, start, createPool, waitForPostgres } from '@cubetype/common';
import { createDataset } from './dataset.js';
import { createRepo } from './repo.js';
import { registerRoutes } from './routes/index.js';
import { createService } from './service.js';

const config = loadConfig('wca');
const pool = createPool(config.databaseUrl);
const dataset = createDataset(pool);

// No migrations: the `wca` schema is owned by jobs/wca-import. Readiness gates on Postgres only,
// so the service is ready (and answers 503 "WCA data not loaded yet") before the first import.
const server = createServer(config, {
  infoPrefixes: ['/api/wca'],
  checks: { postgres: () => pool.query('select 1') },
  info: () => dataset.info(), // dataLoaded + export date / row counts
});
const { app } = server;

const service = createService({ repo: createRepo(pool), dataset });
await registerRoutes(app, service);

await start(server, config, [() => pool.end()]);
await waitForPostgres(pool, app.log);
