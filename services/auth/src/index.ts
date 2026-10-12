import {
  loadConfig,
  createServer,
  start,
  createPool,
  waitForPostgres,
  migrate,
  makeAuth,
} from '@cubetype/common';
import { migrations } from './migrations.js';
import { registerRoutes } from './routes/index.js';

const config = loadConfig('auth');

let migrated = false;
const server = createServer(config, {
  infoPrefixes: ['/api/auth'],
  checks: {
    postgres: () => pool.query('select 1'),
    migrations: async () => {
      if (!migrated) throw new Error('migrations pending');
    },
  },
});
const { app } = server;
const pool = createPool(config.databaseUrl, { log: app.log });
const auth = makeAuth(config.jwtSecret);

await registerRoutes(app, { config, pool, auth });

// Listen first so liveness passes while Postgres boots; readiness stays 503 until migrated.
await start(server, config, [() => pool.end()]);
await waitForPostgres(pool, app.log);
await migrate(pool, 'auth', migrations, app.log);
migrated = true;
app.log.info('auth ready');
