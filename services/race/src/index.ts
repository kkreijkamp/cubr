import { createRedis, createServer, loadConfig, makeAuth, start } from '@cubr/common';
import { PodPresence } from './presence.js';
import { registerRoutes } from './routes.js';
import { makeScrambleFetcher } from './scramble.js';
import { createSocketServer, registerSocketHandlers } from './socket.js';
import { RoomStore } from './store.js';

const config = loadConfig('race');

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

const redis = createRedis(config.redisUrl, app.log); // commands (room state, locks, presence)
// Socket.IO adapter connections: one publishes broadcasts, one is in subscriber mode. The adapter
// never handles the promises of its PUBLISH and (P)SUBSCRIBE calls, so these two connections keep
// commands queued until Redis is back (maxRetriesPerRequest: null) instead of rejecting them - an
// unhandled rejection would end the process whenever Redis restarts.
const pub = redis.duplicate({ maxRetriesPerRequest: null });
const sub = redis.duplicate({ maxRetriesPerRequest: null });
for (const conn of [pub, sub]) conn.on('error', () => {}); // the command connection already logs Redis errors

// Last line of defence: a stray rejected promise is logged instead of taking the pod down.
process.on('unhandledRejection', (err) => app.log.error({ err }, 'unhandled promise rejection'));

const auth = makeAuth(config.jwtSecret, redis);
app.log.info({ redis: config.redisUrl.replace(/\/\/.*@/, '//***@') }, 'race service starting');

const io = createSocketServer(app.server, pub, sub);
const store = new RoomStore(redis, config.podName, (roomId, state) => io.to(roomId).emit('room:state', state));
const presence = new PodPresence(redis, store, config.podName, app.log);
const sockets = registerSocketHandlers({
  io,
  store,
  scrambles: makeScrambleFetcher(config.urls.scramble, app.log, undefined, config.internalToken),
  redis,
  jwtSecret: config.jwtSecret,
  pod: config.podName,
  log: app.log,
});
registerRoutes(app, { store, redis, auth });

// Shutdown order: preClose runs before Fastify closes the HTTP server - drop our websockets
// (clients reconnect to another pod) and finish their Redis cleanup while Redis is still open.
app.addHook('preClose', async () => {
  await sockets.drain();
  await presence.stop();
});

// Register in Redis (and clear leftovers of a previous process with this POD_NAME) before
// accepting sockets. This never throws: while Redis is unreachable it logs a warning, readiness
// stays 503, and the heartbeat and the periodic reconcile catch up once Redis is back.
await presence.start();
// The adapter connections are closed without QUIT: while Redis is down a QUIT would wait forever
// behind their queued commands (whatever they already sent has been written to the socket).
await start(server, config, [() => redis.quit(), () => pub.disconnect(), () => sub.disconnect()]);
