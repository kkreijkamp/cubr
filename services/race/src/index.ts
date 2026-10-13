import { createRedis, createServer, loadConfig, makeAuth, start } from '@cubetype/common';
import { registerRoutes } from './routes.js';
import { createSocketServer, registerSocketHandlers } from './socket.js';
import { RoomStore } from './store.js';

const config = loadConfig('race');
const redis = createRedis(config.redisUrl); // room state, locks, connection registry

const server = createServer(config, {
  infoPrefixes: ['/api/race'],
  // All race state lives in Redis, so a pod without Redis cannot serve anyone: gate readiness.
  checks: { redis: () => redis.ping() },
  info: () => ({ sockets: io.engine.clientsCount }),
});
const { app } = server;
const auth = makeAuth(config.jwtSecret, redis);
app.log.info({ redis: config.redisUrl.replace(/\/\/.*@/, '//***@') }, 'race service starting');

const io = createSocketServer(app.server);
const store = new RoomStore(redis, (roomId, state) => io.to(roomId).emit('room:state', state));
registerSocketHandlers({ io, store, redis, jwtSecret: config.jwtSecret, log: app.log });
registerRoutes(app, { store, redis, auth });

await start(server, config, [() => redis.quit()]);
