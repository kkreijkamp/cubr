import { randomUUID } from 'node:crypto';
import { HttpError, notFound, type Redis } from '@cubetype/common';
import { newRoom, normalize, toRoomState } from './room.js';
import { newRoomId } from './sanitize.js';
import type { ChatMessage, Presence, RoomState, StoredRoom } from './types.js';

/**
 * Redis keyspace (everything prefixed `race:`; no pod keeps authoritative state in memory):
 *   race:room:<id>         string  JSON StoredRoom                          EX 2 h, refreshed on change
 *   race:room:<id>:conns   hash    "<pod>|<playerId>" -> open sockets        EX 2 h
 *   race:room:<id>:chat    list    last 50 chat messages (JSON)              EX 2 h
 *   race:lock:<id>         string  per-room mutex token                      PX 2 s
 *   race:rooms             zset    public lobby, score = last activity (ms)
 *   race:pods              zset    pod heartbeats, score = last beat (ms)
 *   race:pod:<pod>:rooms   set     rooms in which <pod> registered sockets (for crash cleanup)
 *   race:janitor           string  "one janitor at a time" lock               PX 3 s
 * (Socket.IO's Redis adapter additionally uses pub/sub channels prefixed `race:sio`.)
 */
export const keys = {
  room: (id: string) => `race:room:${id}`,
  conns: (id: string) => `race:room:${id}:conns`,
  chat: (id: string) => `race:room:${id}:chat`,
  lock: (id: string) => `race:lock:${id}`,
  lobby: 'race:rooms',
  pods: 'race:pods',
  podRooms: (pod: string) => `race:pod:${pod}:rooms`,
};

export const ROOM_TTL_SEC = 2 * 3600;
/** Rooms with nobody connected for this long drop out of the public lobby list. */
export const LOBBY_IDLE_MS = 10 * 60_000;
/** A pod whose heartbeat is older than this is considered dead; its sockets no longer count. */
export const POD_TTL_MS = 15_000;
const LOCK_TTL_MS = 2000;
const LOCK_WAIT_MS = 3000;
const CHAT_HISTORY = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Compare-and-delete: only release the lock if we still own it (it may have expired and been
// taken by another pod in the meantime).
const RELEASE_LOCK_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export interface LobbyRoom {
  id: string;
  name: string;
  event: string;
  players: number;
  status: string;
  createdAt: string;
}

/** Changes to the connection registry, applied together with the room update. */
export interface ConnChange {
  /** this pod gained (+1) / lost (-1) a socket for playerId */
  conn?: { playerId: string; delta: number };
  /** forget every socket a (dead) pod had registered */
  dropPod?: string;
  /** rewrite this pod's entries from its local socket registry (self-healing reconciliation) */
  resync?: boolean;
}

export type Broadcast = (roomId: string, state: RoomState) => void;

/** Builds playerId -> [pods] from the conns hash, counting only sockets on live pods. */
export function presenceFrom(conns: Record<string, string>, livePods: Set<string>): Presence {
  const presence: Presence = new Map();
  for (const [field, raw] of Object.entries(conns)) {
    const sep = field.indexOf('|');
    const pod = field.slice(0, sep);
    const playerId = field.slice(sep + 1);
    if (sep < 0 || Number(raw) <= 0 || !livePods.has(pod)) continue;
    const pods = presence.get(playerId) ?? [];
    pods.push(pod);
    presence.set(playerId, pods.sort());
  }
  return presence;
}

export class RoomStore {
  /**
   * roomId -> playerId -> number of sockets on THIS pod. It is only changed while holding the
   * room lock (or after a failed write for a socket that is already gone), so a resync, which
   * also runs under the lock, always writes a consistent snapshot.
   */
  readonly local = new Map<string, Map<string, number>>();

  constructor(
    private readonly redis: Redis,
    readonly pod: string,
    private readonly broadcast: Broadcast,
  ) {}

  trackLocal(roomId: string, playerId: string, delta: number): void {
    const room = this.local.get(roomId) ?? new Map<string, number>();
    const n = (room.get(playerId) ?? 0) + delta;
    if (n > 0) room.set(playerId, n);
    else room.delete(playerId);
    if (room.size) this.local.set(roomId, room);
    else this.local.delete(roomId);
  }

  /** Pods with a recent heartbeat (this pod always counts as live). */
  async livePods(): Promise<Set<string>> {
    const pods = await this.redis.zrangebyscore(keys.pods, Date.now() - POD_TTL_MS, '+inf');
    return new Set([...pods, this.pod]);
  }

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

  /** Current room + presence (read-only, no lock). Host/finished invariants are applied but not saved. */
  async load(id: string): Promise<{ room: StoredRoom; presence: Presence } | null> {
    const [[, json], [, conns]] = (await this.redis.multi().get(keys.room(id)).hgetall(keys.conns(id)).exec()) as [
      [Error | null, string | null],
      [Error | null, Record<string, string>],
    ];
    if (!json) return null;
    const room = JSON.parse(json) as StoredRoom;
    const presence = presenceFrom(conns ?? {}, await this.livePods());
    normalize(room, new Set(presence.keys()));
    return { room, presence };
  }

  async getState(id: string): Promise<RoomState | null> {
    const loaded = await this.load(id);
    return loaded ? toRoomState(loaded.room, loaded.presence) : null;
  }

  /**
   * Per-room mutex: SET NX PX with retry/backoff, released by compare-and-delete. Every pod
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
   * The single write path for room state: lock -> load room + connection registry -> apply the
   * connection change and `fn` -> enforce invariants (host transfer, round completion) -> save
   * everything in one MULTI (refreshing the 2 h TTL on all room keys) -> broadcast `room:state`
   * to the Socket.IO room, which the Redis adapter fans out to sockets on every pod.
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

      // 1. connection registry changes (in memory first; persisted below in the same MULTI)
      const writes = new Map<string, number>();
      const setConn = (field: string, value: number) => {
        const n = Math.max(0, value);
        if (n === Number(conns[field] ?? 0)) return;
        writes.set(field, n);
        if (n > 0) conns[field] = String(n);
        else delete conns[field];
      };
      const mine = `${this.pod}|`;
      if (change.dropPod) {
        for (const field of Object.keys(conns)) if (field.startsWith(`${change.dropPod}|`)) setConn(field, 0);
      }
      if (change.resync) {
        const want = this.local.get(id) ?? new Map<string, number>();
        for (const field of Object.keys(conns)) {
          if (field.startsWith(mine) && !want.has(field.slice(mine.length))) setConn(field, 0);
        }
        for (const [playerId, n] of want) setConn(mine + playerId, n);
        if (!want.size) await this.redis.srem(keys.podRooms(this.pod), id);
      }
      if (change.conn) {
        const field = mine + change.conn.playerId;
        setConn(field, Number(conns[field] ?? 0) + change.conn.delta);
      }
      const presence = presenceFrom(conns, await this.livePods());
      const connected = new Set(presence.keys());

      // 2. domain change + invariants
      const before = JSON.stringify(room);
      normalize(room, connected); // e.g. the host's pod died since the last write
      await fn(room, connected);
      normalize(room, connected);
      const changed = writes.size > 0 || JSON.stringify(room) !== before;
      if (!changed) {
        if (change.conn) this.trackLocal(id, change.conn.playerId, change.conn.delta);
        return { state: toRoomState(room, presence), changed };
      }

      // 3. persist atomically
      room.rev += 1;
      room.updatedAt = Date.now();
      const tx = this.redis.multi().set(keys.room(id), JSON.stringify(room), 'EX', ROOM_TTL_SEC);
      for (const [field, n] of writes) {
        if (n > 0) tx.hset(keys.conns(id), field, String(n));
        else tx.hdel(keys.conns(id), field);
      }
      tx.expire(keys.conns(id), ROOM_TTL_SEC).expire(keys.chat(id), ROOM_TTL_SEC);
      if ([...writes].some(([field, n]) => n > 0 && field.startsWith(mine))) {
        tx.sadd(keys.podRooms(this.pod), id).expire(keys.podRooms(this.pod), ROOM_TTL_SEC);
      }
      if (!room.isPrivate) tx.zadd(keys.lobby, room.updatedAt, id);
      await tx.exec();
      if (change.conn) this.trackLocal(id, change.conn.playerId, change.conn.delta);

      // 4. fan out (still under the lock, so broadcasts leave in commit order)
      const state = toRoomState(room, presence);
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
    const live = await this.livePods();

    const rooms: LobbyRoom[] = [];
    const stale: string[] = [];
    entries.forEach((e, i) => {
      const json = res[i * 2]?.[1] as string | null;
      const conns = (res[i * 2 + 1]?.[1] ?? {}) as Record<string, string>;
      if (!json) return void stale.push(e.id);
      const room = JSON.parse(json) as StoredRoom;
      const players = presenceFrom(conns, live).size;
      if (room.isPrivate || (players === 0 && e.score < now - LOBBY_IDLE_MS)) return void stale.push(e.id);
      if (rooms.length < limit) {
        rooms.push({ id: room.id, name: room.name, event: room.event, players, status: room.status, createdAt: room.createdAt });
      }
    });
    if (stale.length) await this.redis.zrem(keys.lobby, ...stale);
    return rooms;
  }

  async appendChat(id: string, msg: ChatMessage): Promise<void> {
    await this.redis
      .multi()
      .lpush(keys.chat(id), JSON.stringify(msg))
      .ltrim(keys.chat(id), 0, CHAT_HISTORY - 1)
      .expire(keys.chat(id), ROOM_TTL_SEC)
      .expire(keys.room(id), ROOM_TTL_SEC)
      .expire(keys.conns(id), ROOM_TTL_SEC)
      .exec();
  }

  async recentChat(id: string): Promise<ChatMessage[]> {
    const items = await this.redis.lrange(keys.chat(id), 0, CHAT_HISTORY - 1);
    return items.reverse().map((s) => JSON.parse(s) as ChatMessage);
  }
}
