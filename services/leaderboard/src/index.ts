import {
  loadConfig,
  createServer,
  start,
  createRedis,
  makeAuth,
  consumeEvents,
  type Consumer,
} from '@cubr/common';
import { FloorProvider } from './floors.js';
import { CONSUMED_TYPES, makeHandler } from './ingest.js';
import { startRebuildLoop } from './rebuild.js';
import { registerRoutes } from './routes/index.js';
import { defineScripts } from './scripts.js';

const config = loadConfig('leaderboard');

let consumer: Consumer | null = null;
let rebuild: ReturnType<typeof startRebuildLoop> | null = null;

const server = createServer(config, {
  infoPrefixes: ['/api/leaderboards'],
  // All leaderboard data lives in Redis -> without it the service cannot serve anything.
  checks: { redis: () => redis.ping() },
  info: () => ({
    consumer: consumer?.stats() ?? null,
    rebuild: rebuild?.status() ?? null,
    antiCheatFloors: floors.source,
  }),
});
const { app } = server;
const redis = createRedis(config.redisUrl, app.log);
defineScripts(redis);
const auth = makeAuth(config.jwtSecret, redis);
const floors = new FloorProvider(config.urls.wca, config.internalToken, app.log);

await registerRoutes(app, { redis, auth });

await start(server, config, [
  async () => {
    rebuild?.stop();
    await consumer?.stop();
  },
  () => redis.quit(),
]);

// Background work starts after listen: the event consumer (one group shared by all replicas,
// each stream entry handled by exactly one pod) and the rebuild check.
consumer = consumeEvents(redis, {
  group: 'leaderboard',
  consumer: config.podName,
  types: CONSUMED_TYPES,
  handler: makeHandler({ redis, floors, log: app.log }),
  log: app.log,
});
rebuild = startRebuildLoop({
  redis,
  statsUrl: config.urls.stats,
  internalToken: config.internalToken,
  podName: config.podName,
  floors,
  log: app.log,
});
