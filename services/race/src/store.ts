import { randomUUID } from 'node:crypto';
import { HttpError, notFound, type Redis } from '@cubetype/common';
import { newRoom, normalize, toRoomState } from './room.js';
import { newRoomId } from './sanitize.js';
import type { RoomState, StoredRoom } from './types.js';

/**
 * Redis keyspace (everything prefixed `race:`; no pod keeps authoritative state in memory):
 *   race:room:<id>         string  JSON StoredRoom                          EX 2 h, refreshed on change
 *   race:room:<id>:conns   hash    playerId → open sockets                   EX 2 h
 *   race:lock:<id>         string  per-room mutex token                      PX 2 s
 *   race:rooms             zset    public lobby, score = last activity (ms)
 */
export const keys = {
  room: (id: string) => `race:room:${id}`,
  conns: (id: string) => `race:room:${id}:conns`,
  lock: (id: string) => `race:lock:${id}`,
  lobby: 'race:rooms',
};

export const ROOM_TTL_SEC = 2 * 3600;
/** Rooms with nobody connected for this long drop out of the public lobby list. */
export const LOBBY_IDLE_MS = 10 * 60_000;
const LOCK_TTL_MS = 2000;
const LOCK_WAIT_MS = 3000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Compare-and-delete: only release the lock if we still own it (it may have expired and been
// taken by another request in the meantime).
const RELEASE_LOCK_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export interface LobbyRoom {
  id: string;
  name: string;
  event: string;
  players: number;
  status: string;
  createdAt: string;
}

/** Change to the connection registry, applied together with the room update. */
export interface ConnChange {
  /** a socket for playerId was opened (+1) / closed (-1) */
  conn?: { playerId: string; delta: number };
}

export type Broadcast = (roomId: string, state: RoomState) => void;

/** Players with at least one open socket, from the conns hash. */
export function connectedFrom(conns: Record<string, string>): Set<string> {
  const connected = new Set<string>();
  for (const [playerId, raw] of Object.entries(conns)) if (Number(raw) > 0) connected.add(playerId);
  return connected;
}

export class RoomStore {
  constructor(
    private readonly redis: Redis,
    private readonly broadcast: Broadcast,
  ) {}

  async createRoom(opts: { name: string; event: string; isPrivate: boolean; createdBy: string | null }): Promise<StoredRoom> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const now = Date.now();
      const room = newRoom({ ...opts, id: newRoomId(), now });
      // NX: never overwrite an existing room if a random id collides
      const ok = await this.redis.set(keys.room(room.id), JSON.stringify(room), 'EX', ROOM_TTL_SEC, 'NX');
      if (ok !== 'OK') continue;
      if (!room.isPrivate) await this.redis.zadd(keys.lobby, now, room.id);
      return room;
    }
    throw new HttpError(503, 'UNAVAILABLE', 'Could not allocate a room id');
  }

  /** Current room + who is connected (read-only, no lock). The host invariant is applied but not saved. */
  async load(id: string): Promise<{ room: StoredRoom; connected: Set<string> } | null> {
    const [[, json], [, conns]] = (await this.redis.multi().get(keys.room(id)).hgetall(keys.conns(id)).exec()) as [
      [Error | null, string | null],
      [Error | null, Record<string, string>],
    ];
    if (!json) return null;
    const room = JSON.parse(json) as StoredRoom;
    const connected = connectedFrom(conns ?? {});
    normalize(room, connected);
    return { room, connected };
  }

  async getState(id: string): Promise<RoomState | null> {
    const loaded = await this.load(id);
    return loaded ? toRoomState(loaded.room, loaded.connected) : null;
  }

  /**
   * Per-room mutex: SET NX PX with retry/backoff, released by compare-and-delete. Every request
   * mutates a room only while holding it, so read-modify-write cycles never interleave.
   */
  async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const key = keys.lock(id);
    const token = randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (let attempt = 0; ; attempt++) {
      const ok = await this.redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX');
      if (ok === 'OK') break;
      if (Date.now() > deadline) throw new HttpError(503, 'UNAVAILABLE', 'Room is busy, please retry');
      await sleep(Math.min(5 * 2 ** attempt, 100) + Math.random() * 10);
    }
    try {
      return await fn();
    } finally {
      await this.redis.eval(RELEASE_LOCK_LUA, 1, key, token).catch(() => undefined);
    }
  }

  /**
   * The single write path for room state: lock → load room + connection registry → apply the
   * connection change and `fn` → enforce invariants (host transfer) → save everything in one
   * MULTI (refreshing the 2 h TTL on all room keys) → broadcast `room:state` to the Socket.IO room.
   * Nothing is written or broadcast when the state did not actually change.
   */
  async mutateRoom(
    id: string,
    fn: (room: StoredRoom, connected: Set<string>) => void | Promise<void>,
    change: ConnChange = {},
  ): Promise<{ state: RoomState; changed: boolean }> {
    return this.withLock(id, async () => {
      const [[, json], [, rawConns]] = (await this.redis.multi().get(keys.room(id)).hgetall(keys.conns(id)).exec()) as [
        [Error | null, string | null],
        [Error | null, Record<string, string>],
      ];
      if (!json) throw notFound('Room not found (it may have expired)');
      const room = JSON.parse(json) as StoredRoom;
      const conns: Record<string, string> = { ...(rawConns ?? {}) };

      // 1. connection registry change (in memory first; persisted below in the same MULTI)
      const writes = new Map<string, number>();
      const setConn = (field: string, value: number) => {
        const n = Math.max(0, value);
        if (n === Number(conns[field] ?? 0)) return;
        writes.set(field, n);
        if (n > 0) conns[field] = String(n);
        else delete conns[field];
      };
      if (change.conn) {
        const field = change.conn.playerId;
        setConn(field, Number(conns[field] ?? 0) + change.conn.delta);
      }
      const connected = connectedFrom(conns);

      // 2. domain change + invariants
      const before = JSON.stringify(room);
      normalize(room, connected); // e.g. the host disconnected since the last write
      await fn(room, connected);
      normalize(room, connected);
      const changed = writes.size > 0 || JSON.stringify(room) !== before;
      if (!changed) return { state: toRoomState(room, connected), changed };

      // 3. persist atomically
      room.rev += 1;
      room.updatedAt = Date.now();
      const tx = this.redis.multi().set(keys.room(id), JSON.stringify(room), 'EX', ROOM_TTL_SEC);
      for (const [field, n] of writes) {
        if (n > 0) tx.hset(keys.conns(id), field, String(n));
        else tx.hdel(keys.conns(id), field);
      }
      tx.expire(keys.conns(id), ROOM_TTL_SEC);
      if (!room.isPrivate) tx.zadd(keys.lobby, room.updatedAt, id);
      await tx.exec();

      // 4. fan out (still under the lock, so broadcasts leave in commit order)
      const state = toRoomState(room, connected);
      this.broadcast(id, state);
      return { state, changed };
    });
  }

  /** Public lobby: newest activity first; lazily prunes expired, private and long-empty rooms. */
  async listPublic(limit = 50): Promise<LobbyRoom[]> {
    const now = Date.now();
    await this.redis.zremrangebyscore(keys.lobby, '-inf', now - ROOM_TTL_SEC * 1000);
    const flat = await this.redis.zrevrange(keys.lobby, 0, limit * 4 - 1, 'WITHSCORES');
    if (!flat.length) return [];
    const entries: { id: string; score: number }[] = [];
    for (let i = 0; i < flat.length; i += 2) entries.push({ id: flat[i], score: Number(flat[i + 1]) });

    const pipe = this.redis.pipeline();
    for (const e of entries) pipe.get(keys.room(e.id)).hgetall(keys.conns(e.id));
    const res = (await pipe.exec()) ?? [];

    const rooms: LobbyRoom[] = [];
    const stale: string[] = [];
    entries.forEach((e, i) => {
      const json = res[i * 2]?.[1] as string | null;
      const conns = (res[i * 2 + 1]?.[1] ?? {}) as Record<string, string>;
      if (!json) return void stale.push(e.id);
      const room = JSON.parse(json) as StoredRoom;
      const players = connectedFrom(conns).size;
      if (room.isPrivate || (players === 0 && e.score < now - LOBBY_IDLE_MS)) return void stale.push(e.id);
      if (rooms.length < limit) {
        rooms.push({ id: room.id, name: room.name, event: room.event, players, status: room.status, createdAt: room.createdAt });
      }
    });
    if (stale.length) await this.redis.zrem(keys.lobby, ...stale);
    return rooms;
  }
}
