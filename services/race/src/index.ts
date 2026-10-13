import { createRedis, createServer, loadConfig, makeAuth, start } from '@cubetype/common';
import { PodPresence } from './presence.js';
import { registerRoutes } from './routes.js';
import { makeScrambleFetcher } from './scramble.js';
import { createSocketServer, registerSocketHandlers } from './socket.js';
import { RoomStore } from './store.js';

const config = loadConfig('race');
const redis = createRedis(config.redisUrl); // commands (room state, locks, presence)
const pub = createRedis(config.redisUrl); // Socket.IO adapter: publishes broadcasts
const sub = createRedis(config.redisUrl); // Socket.IO adapter: subscriber-mode connection

const server = createServer(config, {
  infoPrefixes: ['/api/race'],
  // All race state lives in Redis, so a pod without Redis cannot serve anyone: gate readiness.
  checks: {
    redis: () => redis.ping(),
    pubsub: async () => {
      if (sub.status !== 'ready') throw new Error(`subscriber ${sub.status}`);
    },
  },
  info: () => ({ sockets: io.engine.clientsCount, ...presence.stats() }),
});
const { app } = server;
const auth = makeAuth(config.jwtSecret, redis);
app.log.info({ redis: config.redisUrl.replace(/\/\/.*@/, '//***@') }, 'race service starting');

const io = createSocketServer(app.server, pub, sub);
const store = new RoomStore(redis, config.podName, (roomId, state) => io.to(roomId).emit('room:state', state));
const presence = new PodPresence(redis, store, config.podName, app.log);
const sockets = registerSocketHandlers({
  io,
  store,
  scrambles: makeScrambleFetcher(config.urls.scramble, app.log),
  redis,
  jwtSecret: config.jwtSecret,
  pod: config.podName,
  log: app.log,
});
registerRoutes(app, { store, redis, auth });

// Shutdown order: preClose runs before Fastify closes the HTTP server — drop our websockets
// (clients reconnect to another pod) and finish their Redis cleanup while Redis is still open.
app.addHook('preClose', async () => {
  await sockets.drain();
  await presence.stop();
});

// Register in Redis (and clear leftovers of a previous process with this POD_NAME) before
// accepting sockets.
// Retry until Redis is reachable (e.g. Redis pod still starting) instead of crashing.
for (let delay = 500; ; delay = Math.min(delay * 2, 5000)) {
  try {
    await presence.start();
    break;
  } catch (err) {
    app.log.warn({ err: (err as Error).message }, `redis not ready, retrying presence start in ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));
  }
}
await start(server, config, [() => redis.quit(), () => pub.quit(), () => sub.quit()]);
