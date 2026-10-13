import type { Server as HttpServer } from 'node:http';
import { Server, type DefaultEventsMap, type Socket } from 'socket.io';
import { z, ZodError } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import { HttpError, notFound, type Redis } from '@cubetype/common';
import { resolveIdentity } from './identity.js';
import { addPlayer, removePlayer } from './room.js';
import { ROOM_ID_RE } from './sanitize.js';
import type { RoomStore } from './store.js';
import type { Identity, RoomState } from './types.js';

interface ServerToClientEvents {
  'room:state': (state: RoomState) => void;
}

interface SocketData {
  identity: Identity;
  /** the room this socket is in (one at a time) */
  roomId: string | null;
  /** per-socket promise chain: a socket's events are handled strictly in order */
  chain: Promise<unknown>;
}

export type RaceServer = Server<DefaultEventsMap, ServerToClientEvents, DefaultEventsMap, SocketData>;
type RaceSocket = Socket<DefaultEventsMap, ServerToClientEvents, DefaultEventsMap, SocketData>;
type Ack = (res: Record<string, unknown>) => void;

/**
 * Socket.IO attached to Fastify's own HTTP server: engine.io answers `/socket.io/*` (websocket
 * upgrades only) and hands every other request to Fastify, so REST and websockets share port
 * 8080.
 */
export function createSocketServer(httpServer: HttpServer): RaceServer {
  const io: RaceServer = new Server(httpServer, {
    path: '/socket.io',
    transports: ['websocket'], // no long-polling → no sticky sessions needed behind the LB
    cors: { origin: true, credentials: true },
    serveClient: false, // the SPA bundles socket.io-client (keeps our esbuild bundle self-contained)
    maxHttpBufferSize: 16 * 1024, // all our messages are tiny
  });
  return io;
}

const schemas = {
  join: z.object({ roomId: z.string().trim().toLowerCase().regex(ROOM_ID_RE, 'invalid room id') }),
  none: z.object({}).passthrough(),
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
  redis: Redis;
  jwtSecret: string;
  log: FastifyBaseLogger;
}

export function registerSocketHandlers(deps: SocketDeps): void {
  const { io, store, redis, log } = deps;

  /** Runs `task` after the socket's previous events finished (keeps per-socket ordering). */
  function serial<T>(socket: RaceSocket, task: () => Promise<T>): Promise<T> {
    const p = socket.data.chain.then(task, task);
    socket.data.chain = p.catch(() => undefined);
    return p;
  }

  /**
   * Registers a client→server event: zod-validates the payload, runs the handler in order and
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
      if (!(err instanceof HttpError && err.code === 'NOT_FOUND')) throw err; // room expired: nothing to clean up
    }
  }

  // Handshake: resolve who this is (JWT user or guest). Never rejects — guests are welcome.
  io.use((socket, next) => {
    resolveIdentity(socket.handshake.auth, deps.jwtSecret, redis)
      .then((identity) => {
        socket.data.identity = identity;
        socket.data.roomId = null;
        socket.data.chain = Promise.resolve();
        next();
      })
      .catch(() => next(new Error('handshake failed')));
  });

  io.on('connection', (socket) => {
    const me = socket.data.identity;

    on(socket, 'room:join', schemas.join, async ({ roomId }) => {
      const extra = { playerId: me.playerId, name: me.name };
      if (socket.data.roomId === roomId) {
        const state = await store.getState(roomId); // idempotent re-join from the same socket
        if (!state) throw notFound('Room not found (it may have expired)');
        return { room: state, ...extra };
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
        return { room: state, ...extra };
      } catch (err) {
        await socket.leave(roomId);
        throw err;
      }
    });

    on(socket, 'room:leave', schemas.none, async () => {
      await leaveCurrent(socket, true);
    });

    socket.on('disconnect', () => {
      serial(socket, () => leaveCurrent(socket, false)).catch((err) =>
        log.warn({ err: (err as Error).message, playerId: me.playerId }, 'disconnect cleanup failed'),
      );
    });
  });
}
