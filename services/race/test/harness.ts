// Helpers for the race integration tests: a race "pod" wired like src/index.ts (Fastify, Socket.IO
// with the Redis adapter, RoomStore, PodPresence) listening on an ephemeral port, and
// socket.io-client players that record every room:state and chat:message they receive.
// Several pods can share one Redis, which is how the service scales.
import type { AddressInfo } from 'node:net';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { expect, vi } from 'vitest';
import { createServer, loadConfig, makeAuth, signToken, type Redis } from '@cubr/common';
import { PodPresence } from '../src/presence.js';
import { registerRoutes } from '../src/routes.js';
import type { ScrambleFetcher, ScrambleResult } from '../src/scramble.js';
import { createSocketServer, registerSocketHandlers } from '../src/socket.js';
import { RoomStore, keys } from '../src/store.js';
import type { ChatMessage, PublicPlayer, RoomState } from '../src/types.js';

export { keys };

/** A scramble fetcher the test controls (scramble-service is not part of these tests). */
export interface FakeScrambles extends ScrambleFetcher {
  calls: string[];
  /** how the next scramble is produced; `n` counts calls since the last reset() */
  impl: (event: string, n: number) => Promise<ScrambleResult>;
  reset(): void;
}

function fakeScrambles(): FakeScrambles {
  const byDefault = async (_event: string, n: number): Promise<ScrambleResult> => ({ scramble: `R U F2 D' #${n}`, source: 'scramble-service' });
  const f: FakeScrambles = {
    calls: [],
    impl: byDefault,
    get(event) {
      f.calls.push(event);
      return f.impl(event, f.calls.length);
    },
    reset() {
      f.calls = [];
      f.impl = byDefault;
    },
  };
  return f;
}

export interface Pod {
  name: string;
  url: string;
  app: FastifyInstance;
  /** this pod's command connection (room state, locks, presence) */
  redis: Redis;
  store: RoomStore;
  presence: PodPresence;
  scrambles: FakeScrambles;
  jwtSecret: string;
  token(user: { id: string; username: string }): Promise<string>;
  inject(opts: InjectOptions): Promise<LightMyRequestResponse>;
  /** Shuts down like SIGTERM: drops the websockets, finishes their cleanup, deregisters, closes. */
  close(): Promise<void>;
}

/** Starts a race pod named `name` on `base`'s Redis database, the way src/index.ts wires one. */
export async function startPod(base: Redis, name: string, jwtSecret: string): Promise<Pod> {
  const config = { ...loadConfig('race'), logLevel: 'silent', podName: name, jwtSecret };
  const { app } = createServer(config, { infoPrefixes: ['/api/race'] });
  const redis = base.duplicate();
  const pub = base.duplicate({ maxRetriesPerRequest: null });
  const sub = base.duplicate({ maxRetriesPerRequest: null });
  for (const conn of [redis, pub, sub]) conn.on('error', () => {});
  const io = createSocketServer(app.server, pub, sub);
  const store = new RoomStore(redis, name, (roomId, state) => io.to(roomId).emit('room:state', state));
  const presence = new PodPresence(redis, store, name, app.log);
  const scrambles = fakeScrambles();
  const sockets = registerSocketHandlers({ io, store, scrambles, redis, jwtSecret, pod: name, log: app.log });
  registerRoutes(app, {
    store,
    redis,
    auth: makeAuth(jwtSecret, redis),
    internalToken: config.internalToken,
    onChatCleared: (roomId) => io.to(roomId).emit('chat:cleared', {}),
  });
  app.addHook('preClose', async () => {
    await sockets.drain();
    await presence.stop();
  });
  await presence.start();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  let closing: Promise<void> | null = null;
  return {
    name,
    url: `http://127.0.0.1:${port}`,
    app,
    redis,
    store,
    presence,
    scrambles,
    jwtSecret,
    token: async (user) => (await signToken(jwtSecret, user)).token,
    inject: (opts) => app.inject(opts),
    close() {
      closing ??= (async () => {
        await app.close();
        pub.disconnect();
        sub.disconnect();
        redis.disconnect();
      })();
      return closing;
    },
  };
}

/** A fresh client IP per call, so the per-IP room creation limit only trips where a test means it to. */
let ipCount = 0;
export const freshIp = () => `10.7.${Math.floor(++ipCount / 250)}.${(ipCount % 250) + 1}`;

/** POST /api/race/rooms; returns the new room's id. */
export async function createRoom(pod: Pod, body: Record<string, unknown> = {}, opts: { token?: string; ip?: string } = {}): Promise<string> {
  const res = await pod.inject({
    method: 'POST',
    url: '/api/race/rooms',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': opts.ip ?? freshIp(),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    payload: JSON.stringify({ name: 'Test room', event: '333', ...body }),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().room.id as string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each test reads the fields its event answers with
export type Ack = { ok: boolean; error?: string; code?: string } & Record<string, any>;

export interface Player {
  socket: Socket;
  /** every room:state received, plus the room from each join ack */
  states: RoomState[];
  chats: ChatMessage[];
  /** how many times a moderator cleared the room's chat (chat:cleared) */
  clears: number;
  /** why the socket disconnected, once it has */
  disconnectReason: string | null;
  /** playerId / name from the last successful join */
  playerId: string;
  name: string;
  roomId: string | null;
  /** The newest state of the current room (highest rev), as the web client keeps it. */
  readonly state: RoomState;
  emit(event: string, payload?: unknown): Promise<Ack>;
  /** room:join that must succeed */
  join(roomId: string): Promise<Ack>;
  /** Waits until the newest state of the current room passes `check`. */
  until(check: (s: RoomState) => boolean, what?: string): Promise<RoomState>;
  close(): void;
}

/** vi.waitFor with room for a busy CI machine: everything here crosses sockets and Redis. */
export function settle<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, { timeout: 4000, interval: 10 });
}

const openSockets = new Set<Socket>();

/** Connects a socket.io-client player to `pod` with the given handshake auth. */
export async function connect(pod: Pod, auth: Record<string, unknown> = {}): Promise<Player> {
  const socket = connectSocket(pod.url, { transports: ['websocket'], auth, reconnection: false, forceNew: true, timeout: 5000 });
  openSockets.add(socket);
  const player: Player = {
    socket,
    states: [],
    chats: [],
    clears: 0,
    disconnectReason: null,
    playerId: '',
    name: '',
    roomId: null,
    get state() {
      let best: RoomState | undefined;
      for (const s of player.states) if (s.id === player.roomId && (!best || s.rev >= best.rev)) best = s;
      if (!best) throw new Error(`no state received for room ${player.roomId}`);
      return best;
    },
    async emit(event, payload) {
      const s = socket.timeout(5000);
      const ack = (payload === undefined ? await s.emitWithAck(event) : await s.emitWithAck(event, payload)) as Ack;
      if (event === 'room:join' && ack.ok) {
        player.playerId = ack.playerId;
        player.name = ack.name;
        player.roomId = ack.room.id;
        player.states.push(ack.room);
      }
      if (event === 'room:leave' && ack.ok) player.roomId = null;
      return ack;
    },
    async join(roomId) {
      const ack = await player.emit('room:join', { roomId });
      expect(ack, JSON.stringify(ack)).toMatchObject({ ok: true });
      return ack;
    },
    until(check, what = 'expected room state') {
      return vi.waitFor(
        () => {
          const s = player.state;
          if (!check(s)) throw new Error(`${what}; newest state: ${JSON.stringify(s)}`);
          return s;
        },
        { timeout: 4000, interval: 10 },
      );
    },
    close() {
      socket.disconnect();
      openSockets.delete(socket);
    },
  };
  socket.on('room:state', (s: RoomState) => player.states.push(s));
  socket.on('chat:message', (m: ChatMessage) => player.chats.push(m));
  socket.on('chat:cleared', () => {
    player.chats = [];
    player.clears++;
  });
  socket.on('disconnect', (reason) => {
    player.disconnectReason = reason;
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return player;
}

/** Closes every socket the tests opened (afterEach). */
export function disconnectAll(): void {
  for (const s of openSockets) s.disconnect();
  openSockets.clear();
}

/** The player `id` in a state (fails the test when absent). */
export function playerIn(state: RoomState, id: string): PublicPlayer {
  const p = state.players.find((x) => x.id === id);
  if (!p) throw new Error(`player ${id} not in room ${state.id}: ${JSON.stringify(state.players)}`);
  return p;
}

/** Asserts an {ok:false} ack with this code (and message, if given). */
export function expectRefused(ack: Ack, code: string, message?: RegExp | string): void {
  expect(ack, JSON.stringify(ack)).toMatchObject({ ok: false, code });
  if (message) expect(ack.error).toMatch(message);
}
