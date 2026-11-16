// Several race pods sharing one Redis, the way the service scales: players on different pods in
// one room, simultaneous writes, and the presence machinery (heartbeat, janitor, reconcile) that
// keeps `connected` right when pods shut down, crash, restart or Redis loses data.
// Only setInterval is faked, so each pod's heartbeat (5 s), janitor (5 s) and reconcile (60 s)
// run exactly when a test advances the clock; sockets, Redis and Date stay real.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Redis } from '@cubr/common';
import { createTestRedis, describeIntegration } from '@cubr/testkit';
import { generateGuestId } from '../src/sanitize.js';
import { connect, createRoom, disconnectAll, keys, playerIn, settle, startPod, type Player, type Pod } from './harness.js';

const SECRET = 'race-pods-test-secret';
const JANITOR_LOCK = 'race:janitor';

describeIntegration('race across pods', () => {
  let base: Redis;
  const pods: Pod[] = [];
  const start = async (name: string) => {
    const pod = await startPod(base, name, SECRET);
    pods.push(pod);
    return pod;
  };
  const player = (pod: Pod, name: string) => connect(pod, { guestId: generateGuestId(), name });

  /** A pod dies without cleaning up: its Redis connection goes first, so nothing it does afterwards reaches Redis. */
  async function crash(pod: Pod): Promise<void> {
    pod.redis.disconnect();
    await settle(() => expect(pod.redis.status).toBe('end'));
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    base = await createTestRedis();
  });
  afterEach(async () => {
    disconnectAll();
    await Promise.all(pods.splice(0).map((p) => p.close()));
  });
  afterAll(() => {
    base?.disconnect();
    vi.useRealTimers();
  });

  it('lets players on different pods race together: joins, status, results, chat and the lobby agree', async () => {
    const a = await start('pods-a1');
    const b = await start('pods-b1');
    const roomId = await createRoom(a);
    const alice = await player(a, 'Alice');
    const bob = await player(b, 'Bob');
    expect((await alice.join(roomId)).servedBy).toBe('pods-a1');
    expect((await bob.join(roomId)).servedBy).toBe('pods-b1');

    const s = await alice.until((x) => x.players.length === 2, 'alice sees bob');
    expect(s.players.map((p) => [p.name, p.connected, p.pods])).toEqual([
      ['Alice', true, ['pods-a1']],
      ['Bob', true, ['pods-b1']],
    ]);
    const lobby = (await b.inject({ method: 'GET', url: '/api/race/rooms' })).json().rooms;
    expect(lobby.find((r: { id: string }) => r.id === roomId)?.players).toBe(2);

    const { round } = await alice.emit('round:next');
    expect((await bob.until((x) => x.round?.n === 1)).round).toEqual(round);
    await bob.emit('player:status', { status: 'solving' });
    await alice.until((x) => playerIn(x, bob.playerId).status === 'solving', 'alice sees bob solving');
    await bob.emit('player:result', { round: 1, timeMs: 8000, penalty: 'OK' });
    await alice.emit('player:result', { round: 1, timeMs: 9000, penalty: 'OK' });
    for (const p of [alice, bob]) {
      const end = await p.until((x) => x.status === 'finished');
      expect(end.standings.map((x) => [x.name, x.wins])).toEqual([
        ['Bob', 1],
        ['Alice', 0],
      ]);
    }

    await bob.emit('chat:send', { text: 'gg from pod b' });
    await settle(() => expect(alice.chats.map((m) => m.text)).toEqual(['gg from pod b']));

    // a second tab on the other pod: still one player, now on both pods
    const aliceTab2 = await connect(b, { guestId: alice.playerId, name: 'Alice' });
    await aliceTab2.join(roomId);
    const both = await bob.until((x) => playerIn(x, alice.playerId).pods.length === 2, 'alice on both pods');
    expect(playerIn(both, alice.playerId).pods).toEqual(['pods-a1', 'pods-b1']);
    expect(both.players).toHaveLength(2);
  });

  it('keeps every result when players on both pods submit at the same moment', async () => {
    const a = await start('pods-a2');
    const b = await start('pods-b2');
    const roomId = await createRoom(a);
    const players: Player[] = [];
    for (let i = 0; i < 8; i++) {
      const p = await player(i % 2 ? b : a, `P${i}`);
      await p.join(roomId);
      players.push(p);
    }
    await players[0].emit('round:next');
    const started = await players[0].until((x) => x.round?.n === 1);

    const acks = await Promise.all(players.map((p, i) => p.emit('player:result', { round: 1, timeMs: 10_000 + i, penalty: 'OK' })));
    expect(acks.every((ack) => ack.ok)).toBe(true);
    for (const p of players) {
      const end = await p.until((x) => x.status === 'finished', `${p.name} sees the round finish`);
      expect(Object.keys(end.results['1'])).toHaveLength(8);
      expect(end.rev).toBe(started.rev + 8); // eight changes, applied one after the other
    }
    const stored = JSON.parse((await base.get(keys.room(roomId)))!);
    expect(Object.keys(stored.results['1']).sort()).toEqual(players.map((p) => p.playerId).sort());
  });

  it("stops counting a crashed pod's players at once, and the janitor then clears its entries and moves the host role", async () => {
    const a = await start('pods-a3');
    const b = await start('pods-b3');
    const roomId = await createRoom(a);
    const alice = await player(b, 'Alice');
    const bob = await player(a, 'Bob');
    await alice.join(roomId);
    await bob.join(roomId);
    await bob.until((x) => x.players.length === 2 && x.players.every((p) => p.connected));
    expect(bob.state.hostId).toBe(alice.playerId);

    await crash(b);
    alice.close(); // pod b cannot tell Redis
    await settle(() => expect(b.store.local.size).toBe(0));
    expect(await base.hget(keys.conns(roomId), `pods-b3|${alice.playerId}`)).toBe('1');
    await base.zadd(keys.pods, Date.now() - 20_000, 'pods-b3'); // its last heartbeat was 20 s ago

    // reads already ignore sockets on a dead pod
    const now = (await bob.join(roomId)).room; // same socket: the current state
    expect(playerIn(now, alice.playerId)).toMatchObject({ connected: false, pods: [] });
    expect(now.hostId).toBe(bob.playerId);

    await base.del(JANITOR_LOCK); // no janitor on duty right now
    vi.advanceTimersByTime(5000);
    const after = await bob.until((x) => x.rev > now.rev, 'the janitor re-broadcast the room');
    expect(after.hostId).toBe(bob.playerId);
    expect(playerIn(after, alice.playerId).connected).toBe(false);
    await settle(async () => {
      expect(await base.hgetall(keys.conns(roomId))).toEqual({ [`pods-a3|${bob.playerId}`]: '1' });
      expect(await base.exists(keys.podRooms('pods-b3'))).toBe(0);
      expect(await base.zscore(keys.pods, 'pods-b3')).toBeNull();
    });
  });

  it('drops its sockets at the transport level when shutting down, so other pods see those players leave, and deregisters', async () => {
    const a = await start('pods-a4');
    const b = await start('pods-b4');
    const roomId = await createRoom(a);
    const alice = await player(a, 'Alice');
    const carol = await player(b, 'Carol');
    await alice.join(roomId);
    await carol.join(roomId);
    await alice.until((x) => x.players.length === 2 && x.players.every((p) => p.connected));

    await b.close();
    // "transport close" makes socket.io-client reconnect by itself (through the load balancer, to another pod)
    await settle(() => expect(carol.disconnectReason).toBe('transport close'));
    const s = await alice.until((x) => !playerIn(x, carol.playerId).connected, 'carol shows as disconnected');
    expect(playerIn(s, carol.playerId).pods).toEqual([]);
    expect(await base.hgetall(keys.conns(roomId))).toEqual({ [`pods-a4|${alice.playerId}`]: '1' });
    expect(await base.zscore(keys.pods, 'pods-b4')).toBeNull();
    expect(await base.exists(keys.podRooms('pods-b4'))).toBe(0);
  });

  it('clears what its previous process left behind when a pod restarts with the same name', async () => {
    const a = await start('pods-a5');
    const old = await start('pods-r5');
    const roomId = await createRoom(a);
    const alice = await player(a, 'Alice');
    const dave = await player(old, 'Dave');
    await alice.join(roomId);
    await dave.join(roomId);

    await crash(old);
    dave.close();
    await settle(() => expect(old.store.local.size).toBe(0));
    await old.close();
    // the name's heartbeat is still fresh, so the leftover entry still counts
    const before = (await alice.join(roomId)).room;
    expect(playerIn(before, dave.playerId).connected).toBe(true);

    await start('pods-r5');
    await alice.until((x) => x.rev > before.rev && !playerIn(x, dave.playerId).connected, 'the restart cleared dave');
    expect(await base.hgetall(keys.conns(roomId))).toEqual({ [`pods-a5|${alice.playerId}`]: '1' });
    expect(await base.sismember(keys.podRooms('pods-r5'), roomId)).toBe(0);
  });

  it('re-registers its sockets when its heartbeat has vanished from Redis', async () => {
    const a = await start('pods-a6');
    const roomId = await createRoom(a);
    const alice = await player(a, 'Alice');
    await alice.join(roomId);
    // Redis restarted without its data (the room itself survived in this test)
    await base.del(keys.conns(roomId), keys.podRooms('pods-a6'));
    await base.zrem(keys.pods, 'pods-a6');

    vi.advanceTimersByTime(5000); // the next heartbeat notices
    await settle(async () => {
      expect(await base.hgetall(keys.conns(roomId))).toEqual({ [`pods-a6|${alice.playerId}`]: '1' });
      expect(await base.sismember(keys.podRooms('pods-a6'), roomId)).toBe(1);
      expect(await base.zscore(keys.pods, 'pods-a6')).not.toBeNull();
    });
  });

  it('drops registry entries for sockets it no longer holds at the next reconcile, every 60 s', async () => {
    const a = await start('pods-a7');
    const roomId = await createRoom(a);
    const alice = await player(a, 'Alice');
    const bob = await player(a, 'Bob');
    await alice.join(roomId);
    await bob.join(roomId);
    bob.close();
    await alice.until((x) => !playerIn(x, bob.playerId).connected);
    // a disconnect whose cleanup never reached Redis (it was unreachable at the time)
    await base.hset(keys.conns(roomId), `pods-a7|${bob.playerId}`, '1');
    const drifted = (await alice.join(roomId)).room;
    expect(playerIn(drifted, bob.playerId).connected).toBe(true);

    vi.advanceTimersByTime(60_000);
    await alice.until((x) => x.rev > drifted.rev && !playerIn(x, bob.playerId).connected, 'the reconcile fixed bob');
    expect(await base.hgetall(keys.conns(roomId))).toEqual({ [`pods-a7|${alice.playerId}`]: '1' });
  });
});
