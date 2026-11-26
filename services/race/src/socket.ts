import type { Server as HttpServer } from 'node:http';
import { Server, type DefaultEventsMap, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { z, ZodError } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import { HttpError, badRequest, forbidden, hasSlur, notFound, rateLimit, rateLimited, unavailable, type Redis } from '@cubr/common';
import { resolveIdentity } from './identity.js';
import { MAX_RESULT_MS, addPlayer, removePlayer, setStatus, startRound, submitResult } from './room.js';
import { ROOM_ID_RE, sanitizeText } from './sanitize.js';
import type { ScrambleFetcher } from './scramble.js';
import type { RoomStore } from './store.js';
import type { ChatMessage, Identity, RoomState } from './types.js';

interface ServerToClientEvents {
  'room:state': (state: RoomState) => void;
  'chat:message': (msg: ChatMessage) => void;
}

interface SocketData {
  identity: Identity;
  /** the room this socket is in (one at a time) */
  roomId: string | null;
  /** per-socket promise chain: a socket's events are handled strictly in order */
  chain: Promise<unknown>;
  flood: { windowStart: number; count: number };
}

export type RaceServer = Server<DefaultEventsMap, ServerToClientEvents, DefaultEventsMap, SocketData>;
type RaceSocket = Socket<DefaultEventsMap, ServerToClientEvents, DefaultEventsMap, SocketData>;
type Ack = (res: Record<string, unknown>) => void;

const FLOOD_WINDOW_MS = 10_000;
const FLOOD_MAX_EVENTS = 60;

/**
 * Socket.IO attached to Fastify's own HTTP server: engine.io answers `/socket.io/*` (websocket
 * upgrades only) and hands every other request to Fastify, so REST and websockets share port
 * 8080. The Redis adapter turns `io.to(room).emit()` into a Redis PUBLISH that every race pod
 * receives and forwards to its local members of that room.
 */
export function createSocketServer(httpServer: HttpServer, pub: Redis, sub: Redis): RaceServer {
  const io: RaceServer = new Server(httpServer, {
    path: '/socket.io',
    transports: ['websocket'], // no long-polling -> no sticky sessions needed behind the LB
    cors: { origin: true, credentials: true },
    serveClient: false, // the SPA bundles socket.io-client (keeps our esbuild bundle self-contained)
    maxHttpBufferSize: 16 * 1024, // all our messages are tiny
  });
  io.adapter(createAdapter(pub, sub, { key: 'race:sio' }));
  return io;
}

const schemas = {
  join: z.object({ roomId: z.string().trim().toLowerCase().regex(ROOM_ID_RE, 'invalid room id') }),
  none: z.object({}).passthrough(),
  status: z.object({ status: z.enum(['idle', 'inspecting', 'solving', 'done']) }),
  result: z.object({
    round: z.number().int().min(1),
    timeMs: z.number().int().min(1).max(MAX_RESULT_MS),
    penalty: z.enum(['OK', '+2', 'DNF']),
  }),
  chat: z.object({ text: z.string().max(200) }),
};

function errorReply(err: unknown): { error: string; code: string } {
  if (err instanceof HttpError) return { error: err.message, code: err.code };
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    return { error: `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`, code: 'BAD_REQUEST' };
  }
  return { error: 'Internal error', code: 'INTERNAL' };
}

export interface SocketDeps {
  io: RaceServer;
  store: RoomStore;
  scrambles: ScrambleFetcher;
  redis: Redis;
  jwtSecret: string;
  pod: string;
  log: FastifyBaseLogger;
}

export function registerSocketHandlers(deps: SocketDeps) {
  const { io, store, scrambles, redis, pod, log } = deps;
  /** in-flight disconnect cleanups, awaited during graceful shutdown */
  const pendingCleanups = new Set<Promise<unknown>>();

  /** Runs `task` after the socket's previous events finished (keeps per-socket ordering). */
  function serial<T>(socket: RaceSocket, task: () => Promise<T>): Promise<T> {
    const p = socket.data.chain.then(task, task);
    socket.data.chain = p.catch(() => undefined);
    return p;
  }

  function flooding(socket: RaceSocket): boolean {
    const f = socket.data.flood;
    const now = Date.now();
    if (now - f.windowStart > FLOOD_WINDOW_MS) {
      f.windowStart = now;
      f.count = 0;
    }
    return ++f.count > FLOOD_MAX_EVENTS;
  }

  /**
   * Registers a client->server event: zod-validates the payload, runs the handler in order and
   * always answers the ack with {ok:true,...} or {ok:false,error,code}. Never throws.
   */
  function on<S extends z.ZodTypeAny>(
    socket: RaceSocket,
    event: string,
    schema: S,
    handler: (data: z.output<S>) => Promise<Record<string, unknown> | void>,
  ) {
    socket.on(event, (...args: unknown[]) => {
      const ack = (typeof args[args.length - 1] === 'function' ? args.pop() : undefined) as Ack | undefined;
      const payload = args[0];
      void serial(socket, async () => {
        try {
          if (flooding(socket)) throw rateLimited('Too many messages, slow down');
          const data = schema.parse(payload ?? {});
          const res = await handler(data);
          ack?.({ ok: true, ...(res ?? {}) });
        } catch (err) {
          const reply = errorReply(err);
          if (reply.code === 'INTERNAL' || reply.code === 'UNAVAILABLE') {
            log.error({ err, event, playerId: socket.data.identity.playerId }, 'race socket handler failed');
          }
          ack?.({ ok: false, ...reply });
        }
      });
    });
  }

  function currentRoom(socket: RaceSocket): string {
    if (!socket.data.roomId) throw badRequest('Join a room first');
    return socket.data.roomId;
  }

  /** Socket leaves its room. Explicit leave removes the player unless they have another tab open. */
  async function leaveCurrent(socket: RaceSocket, explicit: boolean): Promise<void> {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const { playerId } = socket.data.identity;
    socket.data.roomId = null;
    await socket.leave(roomId);
    try {
      await store.mutateRoom(
        roomId,
        (room, connected) => {
          if (explicit && !connected.has(playerId)) removePlayer(room, playerId);
        },
        { conn: { playerId, delta: -1 } },
      );
    } catch (err) {
      // The socket is gone either way: keep the local registry truthful; the periodic
      // reconcile fixes Redis once it is reachable again.
      store.trackLocal(roomId, playerId, -1);
      if (!(err instanceof HttpError && err.code === 'NOT_FOUND')) throw err;
    }
  }

  // Handshake: resolve who this is (JWT user or guest). Never rejects - guests are welcome.
  io.use((socket, next) => {
    resolveIdentity(socket.handshake.auth, deps.jwtSecret, redis)
      .then((identity) => {
        socket.data.identity = identity;
        socket.data.roomId = null;
        socket.data.chain = Promise.resolve();
        socket.data.flood = { windowStart: Date.now(), count: 0 };
        next();
      })
      .catch(() => next(new Error('handshake failed')));
  });

  io.on('connection', (socket) => {
    const me = socket.data.identity;

    on(socket, 'room:join', schemas.join, async ({ roomId }) => {
      const extra = { playerId: me.playerId, name: me.name, servedBy: pod };
      if (socket.data.roomId === roomId) {
        const state = await store.getState(roomId); // idempotent re-join from the same socket
        if (!state) throw notFound('Room not found (it may have expired)');
        return { room: state, ...extra, chat: await store.recentChat(roomId).catch(() => []) };
      }
      if (socket.data.roomId) {
        // switching rooms: make sure the target exists before giving up the current one
        if (!(await store.load(roomId))) throw notFound('Room not found (it may have expired)');
        await leaveCurrent(socket, true);
      }
      // Join the Socket.IO room *before* the state change so no broadcast can slip between
      // our write and our subscription.
      await socket.join(roomId);
      try {
        const { state } = await store.mutateRoom(roomId, (room, connected) => addPlayer(room, me, Date.now(), connected), {
          conn: { playerId: me.playerId, delta: +1 },
        });
        socket.data.roomId = roomId;
        return { room: state, ...extra, chat: await store.recentChat(roomId).catch(() => []) };
      } catch (err) {
        await socket.leave(roomId);
        throw err;
      }
    });

    on(socket, 'room:leave', schemas.none, async () => {
      await leaveCurrent(socket, true);
    });

    on(socket, 'round:next', schemas.none, async () => {
      const roomId = currentRoom(socket);
      const loaded = await store.load(roomId);
      if (!loaded) throw notFound('Room not found (it may have expired)');
      if (loaded.room.hostId !== me.playerId) throw forbidden('Only the host can start the next round');
      const expectedN = loaded.room.round?.n ?? 0;
      // Network call happens outside the room lock; startRound re-checks host + round number.
      const { scramble, source } = await scrambles.get(loaded.room.event);
      const { state } = await store.mutateRoom(roomId, (room) =>
        startRound(room, me.playerId, expectedN, scramble, source, Date.now()),
      );
      return { round: state.round };
    });

    on(socket, 'player:status', schemas.status, async ({ status }) => {
      const roomId = currentRoom(socket);
      await store.mutateRoom(roomId, (room) => {
        setStatus(room, me.playerId, status);
      });
    });

    on(socket, 'player:result', schemas.result, async ({ round, timeMs, penalty }) => {
      const roomId = currentRoom(socket);
      await store.mutateRoom(roomId, (room) => submitResult(room, me.playerId, round, timeMs, penalty));
    });

    on(socket, 'chat:send', schemas.chat, async ({ text }) => {
      const roomId = currentRoom(socket);
      const clean = sanitizeText(text, 200);
      if (!clean) throw badRequest('text: message is empty');
      // slurs are refused; guests chat too (packages/common moderation.ts)
      if (hasSlur(clean)) throw badRequest("text: that message has a word cubr doesn't allow");
      // Without Redis a message can neither be stored nor reach players on other pods (and the
      // rate limit below fails open): refuse it instead of delivering it after the outage.
      if (redis.status !== 'ready') throw unavailable('Chat is unavailable while the server reconnects');
      if (!(await rateLimit(redis, `race-chat:${me.playerId}`, 5, 10))) {
        throw rateLimited('Slow down: at most 5 messages per 10 seconds');
      }
      const msg: ChatMessage = { playerId: me.playerId, name: me.name, text: clean, at: new Date().toISOString() };
      io.to(roomId).emit('chat:message', msg);
      await store.appendChat(roomId, msg).catch((err) => log.warn({ err: (err as Error).message }, 'chat history write failed'));
    });

    socket.on('disconnect', () => {
      const p = serial(socket, () => leaveCurrent(socket, false)).catch((err) =>
        log.warn({ err: (err as Error).message, playerId: me.playerId }, 'disconnect cleanup failed'),
      );
      pendingCleanups.add(p);
      void p.finally(() => pendingCleanups.delete(p));
    });
  });

  return {
    /**
     * Graceful shutdown: drop every websocket on this pod at the transport level (clients see
     * "transport close" and auto-reconnect - through the load balancer, to another pod), then
     * wait for the resulting registry cleanups so other players see the move promptly.
     */
    async drain(timeoutMs = 5000): Promise<void> {
      io.engine.close();
      const deadline = Date.now() + timeoutMs;
      while (pendingCleanups.size && Date.now() < deadline) {
        await Promise.race([Promise.allSettled([...pendingCleanups]), new Promise((r) => setTimeout(r, 100))]);
      }
    },
  };
}
