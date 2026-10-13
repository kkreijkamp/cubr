import type { FastifyBaseLogger } from 'fastify';
import { HttpError, type Redis } from '@cubetype/common';
import { POD_TTL_MS, keys, type RoomStore } from './store.js';

const HEARTBEAT_MS = 5000;
const JANITOR_MS = 5000;
const RECONCILE_MS = 60_000;
const JANITOR_LOCK = 'race:janitor';

const isNotFound = (err: unknown) => err instanceof HttpError && err.code === 'NOT_FOUND';

/**
 * Pod liveness + crash recovery for the connection registry (`race:room:<id>:conns`).
 *
 * - Heartbeat: every pod writes its name into the `race:pods` zset every 5 s. A socket only
 *   counts as connected if the pod holding it has a heartbeat younger than 15 s (presenceFrom),
 *   so when a pod dies without cleaning up (OOM kill, node failure, `kubectl delete --force`)
 *   its players flip to connected:false automatically.
 * - Janitor: every 5 s one pod (Redis lock `race:janitor`) deletes the registry entries of dead
 *   pods and re-broadcasts the affected rooms — which also hands the host role to a connected
 *   player.
 * - Reconcile: every 60 s (and after a Redis restart) each pod rewrites its own registry entries
 *   from the sockets it actually holds, so any drift (e.g. a disconnect that happened while Redis
 *   was unreachable) heals itself.
 */
export class PodPresence {
  private timers: NodeJS.Timeout[] = [];
  private registered = false;

  constructor(
    private readonly redis: Redis,
    private readonly store: RoomStore,
    private readonly pod: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  stats() {
    let sockets = 0;
    for (const room of this.store.local.values()) for (const n of room.values()) sockets += n;
    return { roomsOnThisPod: this.store.local.size, playersSocketsOnThisPod: sockets };
  }

  /** Call once at startup, before the server accepts sockets. */
  async start(): Promise<void> {
    // A previous process with the same POD_NAME (local restart, StatefulSet) may have left
    // entries behind; we hold no sockets yet, so reconciling removes them.
    await this.reconcile();
    await this.heartbeat();
    this.timers.push(setInterval(() => void this.heartbeat(), HEARTBEAT_MS));
    this.timers.push(setInterval(() => void this.janitor(), JANITOR_MS));
    this.timers.push(setInterval(() => void this.reconcile(), RECONCILE_MS));
    for (const t of this.timers) t.unref();
  }

  /** Call during shutdown after the local sockets were drained. */
  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    try {
      // Everything cleaned up → forget this pod. Otherwise leave the room set for the janitor.
      if (this.store.local.size === 0) await this.redis.del(keys.podRooms(this.pod));
      await this.redis.zrem(keys.pods, this.pod);
    } catch {
      // Redis unreachable: the heartbeat simply goes stale and the janitor takes over
    }
  }

  private async heartbeat(): Promise<void> {
    try {
      const added = Number(await this.redis.zadd(keys.pods, Date.now(), this.pod));
      // Missing from race:pods although we registered before → Redis lost its data or other
      // pods declared us dead during a network blip: re-register our sockets right away.
      if (added === 1 && this.registered) {
        this.log.warn('pod heartbeat was missing from Redis, re-registering local sockets');
        await this.reconcile();
      }
      this.registered = true;
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'race heartbeat failed');
    }
  }

  /** Rewrites this pod's registry entries (in every room it served) from its real sockets. */
  async reconcile(): Promise<void> {
    try {
      const rooms = new Set([...this.store.local.keys(), ...(await this.redis.smembers(keys.podRooms(this.pod)))]);
      for (const roomId of rooms) {
        try {
          await this.store.mutateRoom(roomId, () => undefined, { resync: true });
        } catch (err) {
          if (isNotFound(err)) await this.redis.srem(keys.podRooms(this.pod), roomId);
          else throw err;
        }
      }
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'race reconcile failed');
    }
  }

  private async janitor(): Promise<void> {
    try {
      const got = await this.redis.set(JANITOR_LOCK, this.pod, 'PX', JANITOR_MS - 2000, 'NX');
      if (got !== 'OK') return; // another pod is on duty this round
      const dead = await this.redis.zrangebyscore(keys.pods, '-inf', Date.now() - POD_TTL_MS);
      for (const pod of dead) {
        if (pod === this.pod) continue;
        this.log.warn({ deadPod: pod }, 'cleaning up connections of dead race pod');
        await this.cleanupDeadPod(pod);
      }
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'race janitor failed');
    }
  }

  private async cleanupDeadPod(pod: string): Promise<void> {
    const rooms = await this.redis.smembers(keys.podRooms(pod));
    for (const roomId of rooms) {
      try {
        await this.store.mutateRoom(roomId, () => undefined, { dropPod: pod });
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
    await this.redis.del(keys.podRooms(pod));
    await this.redis.zrem(keys.pods, pod);
  }
}
