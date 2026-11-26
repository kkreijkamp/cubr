// The race real-time protocol over a real Socket.IO server and Redis (one pod; see
// pods.integration.test.ts for several): who a socket plays as, joining and leaving rooms,
// rounds, results and standings, chat, payload validation and the abuse limits.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { revokedKey, revokedUserKey, signToken, verifyToken, type Redis } from '@cubr/common';
import { createTestRedis, describeIntegration } from '@cubr/testkit';
import { GUEST_ID_RE, generateGuestId } from '../src/sanitize.js';
import type { ChatMessage } from '../src/types.js';
import { connect, createRoom, disconnectAll, expectRefused, keys, playerIn, settle, startPod, type Player, type Pod } from './harness.js';

const SECRET = 'race-socket-test-secret';
const POD = 'race-socket-1';

describeIntegration('race socket protocol', () => {
  let base: Redis;
  let pod: Pod;

  beforeAll(async () => {
    base = await createTestRedis();
    pod = await startPod(base, POD, SECRET);
  });
  afterEach(() => {
    disconnectAll();
    pod.scrambles.reset();
  });
  afterAll(async () => {
    disconnectAll();
    await pod?.close();
    base?.disconnect();
  });

  /** A guest with a stable guest id (as the web client keeps in localStorage). */
  const guest = (name?: string) => connect(pod, { guestId: generateGuestId(), ...(name ? { name } : {}) });
  let userCount = 0;
  const newUser = () => ({ id: randomUUID(), username: `racer_${++userCount}` });

  /** Alone in a new room with round 1 running. */
  async function soloRound(): Promise<Player> {
    const p = await guest();
    await p.join(await createRoom(pod));
    expect((await p.emit('round:next')).ok).toBe(true);
    return p;
  }

  describe('handshake and identity', () => {
    it('gives a guest without an id a fresh guest id and a default name', async () => {
      const p = await connect(pod);
      const ack = await p.join(await createRoom(pod));
      expect(ack.playerId).toMatch(GUEST_ID_RE);
      expect(ack.name).toBe(`guest-${ack.playerId.slice(-4)}`);
      expect(playerIn(ack.room, ack.playerId)).toMatchObject({ name: ack.name, userId: null });
    });

    it('keeps a well-formed guestId across reconnects and cleans up the nickname', async () => {
      const roomId = await createRoom(pod);
      const guestId = generateGuestId();
      const first = await connect(pod, { guestId, name: '\u202eAlice\u0007   Smith\u200b ' });
      expect(await first.join(roomId)).toMatchObject({ playerId: guestId, name: 'Alice Smith' });
      first.close();

      const again = await connect(pod, { guestId, name: 'A'.repeat(30) });
      const ack = await again.join(roomId);
      expect(ack).toMatchObject({ playerId: guestId, name: 'A'.repeat(20) });
      expect(ack.room.players).toHaveLength(1);
      expect(playerIn(ack.room, guestId)).toMatchObject({ name: 'A'.repeat(20), connected: true });
    });

    it.each([
      ['in upper case', 'guest-ABCDEF12'],
      ['too short', 'guest-abc'],
      ['too long', `guest-${'a'.repeat(25)}`],
      ['without the prefix', 'abcdef123456'],
      ["a user's id", '6f1c1b5e-1f3a-4f7e-9a51-2b8f3c4d5e6f'],
      ['with markup', 'guest-<b>hi</b>'],
      ['a number', 1234567],
    ])('replaces a guestId %s with a fresh one', async (_what, guestId) => {
      const p = await connect(pod, { guestId });
      const ack = await p.join(await createRoom(pod));
      expect(ack.playerId).not.toBe(guestId);
      expect(ack.playerId).toMatch(GUEST_ID_RE);
      expect(playerIn(ack.room, ack.playerId).userId).toBeNull();
    });

    it('lets a signed-in user play as themselves, whatever name or guestId they also send', async () => {
      const user = newUser();
      const p = await connect(pod, { token: await pod.token(user), name: 'Imposter', guestId: generateGuestId() });
      const ack = await p.join(await createRoom(pod));
      expect(ack).toMatchObject({ playerId: user.id, name: user.username });
      expect(playerIn(ack.room, user.id)).toMatchObject({ name: user.username, userId: user.id });
    });

    it.each([
      ['a malformed token', async () => 'not-a-jwt'],
      ['a token signed with another secret', async () => (await signToken('another-secret', newUser())).token],
      ['an expired token', async () => (await signToken(SECRET, newUser(), -60)).token],
    ])('connects %s as a guest instead of refusing it', async (_what, makeToken) => {
      const guestId = generateGuestId();
      const p = await connect(pod, { token: await makeToken(), guestId });
      const ack = await p.join(await createRoom(pod));
      expect(ack.playerId).toBe(guestId);
      expect(playerIn(ack.room, guestId).userId).toBeNull();
    });

    it('connects a logged-out (revoked) token as a guest', async () => {
      const { token, jti } = await signToken(SECRET, newUser());
      await base.set(revokedKey(jti), '1', 'EX', 60);
      const guestId = generateGuestId();
      const p = await connect(pod, { token, guestId });
      expect((await p.join(await createRoom(pod))).playerId).toBe(guestId);
    });

    // a token revoked for the whole account (password reset, deletion): auth:revoked-user:<userId>
    it('connects a token revoked for the whole account (password reset, deletion) as a guest, but not one issued after', async () => {
      const user = newUser();
      const { token } = await signToken(SECRET, user);
      const { iat } = await verifyToken(SECRET, token);
      await base.set(revokedUserKey(user.id), String(iat), 'EX', 60);
      const guestId = generateGuestId();
      const old = await connect(pod, { token, guestId });
      expect((await old.join(await createRoom(pod))).playerId).toBe(guestId);

      const fresh = (await signToken(SECRET, user, 3600, iat! + 1)).token; // the sign-in after the reset
      const now = await connect(pod, { token: fresh });
      expect((await now.join(await createRoom(pod))).playerId).toBe(user.id);
    });
  });

  describe('joining and leaving', () => {
    it('answers a join with the room, who you are, the serving pod and the chat; the first player is host', async () => {
      const roomId = await createRoom(pod, { name: 'Sunday race', event: '222' });
      const guestId = generateGuestId();
      const p = await connect(pod, { guestId, name: 'Alice' });
      const ack = await p.join(roomId);
      expect(ack).toMatchObject({ ok: true, playerId: guestId, name: 'Alice', servedBy: POD, chat: [] });
      expect(ack.room).toMatchObject({
        id: roomId,
        name: 'Sunday race',
        event: '222',
        isPrivate: false,
        hostId: guestId,
        status: 'lobby',
        round: null,
        results: {},
      });
      expect(ack.room.players).toEqual([{ id: guestId, name: 'Alice', userId: null, status: 'idle', connected: true, pods: [POD] }]);
      expect(ack.room.standings).toEqual([{ playerId: guestId, name: 'Alice', wins: 0, solves: 0, meanMs: null, ao5: null }]);
      expect(ack.room.rev).toBeGreaterThan(0);
      expect(Date.parse(ack.room.createdAt)).not.toBeNaN();
    });

    it('shows a new player to everyone in the room, and to nobody outside it', async () => {
      const roomId = await createRoom(pod);
      const otherRoom = await createRoom(pod);
      const alice = await guest('Alice');
      const carol = await guest('Carol');
      await alice.join(roomId);
      await carol.join(otherRoom);
      const bob = await guest('Bob');
      await bob.join(roomId);

      const seen = await alice.until((s) => s.players.length === 2, 'alice sees bob');
      expect(seen.players.map((p) => [p.name, p.connected])).toEqual([
        ['Alice', true],
        ['Bob', true],
      ]);
      expect(seen.hostId).toBe(alice.playerId);
      await carol.emit('player:status', { status: 'idle' }); // a round trip, so a stray broadcast would be here by now
      expect(carol.states.every((s) => s.id === otherRoom)).toBe(true);
    });

    it('accepts a room id in any case and with stray spaces', async () => {
      const roomId = await createRoom(pod);
      const ack = await (await guest()).join(`  ${roomId.toUpperCase()} `);
      expect(ack.room.id).toBe(roomId);
    });

    it.each([
      ['an empty id', ''],
      ['a short id', 'abc'],
      ['a long id', 'a'.repeat(33)],
      ['an id with a space inside', 'abcd efgh'],
      ['a path', '../../etc/passwd'],
      ['a key pattern', 'room:*'],
      ['a number', 12345678],
      ['no id', undefined],
    ])('refuses %s as a room id', async (_what, roomId) => {
      const p = await guest();
      expectRefused(await p.emit('room:join', { roomId }), 'BAD_REQUEST', /^roomId: /);
    });

    it('answers NOT_FOUND for a room that does not exist or has expired, and leaves nothing behind', async () => {
      const p = await guest();
      expectRefused(await p.emit('room:join', { roomId: 'zzzz0000' }), 'NOT_FOUND', /may have expired/);
      const roomId = await createRoom(pod);
      await base.del(keys.room(roomId)); // what the 2 h TTL does
      expectRefused(await p.emit('room:join', { roomId }), 'NOT_FOUND');
      expect(await base.exists(keys.conns(roomId))).toBe(0);
      expect(p.roomId).toBeNull();
    });

    it('treats a second join of the same room from one socket as a no-op', async () => {
      const roomId = await createRoom(pod);
      const p = await guest();
      const first = await p.join(roomId);
      const second = await p.join(roomId);
      expect(second.room.rev).toBe(first.room.rev);
      expect(second.room.players).toHaveLength(1);
      expect(await base.hgetall(keys.conns(roomId))).toEqual({ [`${POD}|${p.playerId}`]: '1' });
    });

    it('moves a player who joins another room out of the first one, results and all; a missing target keeps them where they are', async () => {
      const roomA = await createRoom(pod);
      const roomB = await createRoom(pod);
      const alice = await guest('Alice');
      const bob = await guest('Bob');
      await alice.join(roomA);
      await bob.join(roomA);
      expect((await alice.emit('round:next')).ok).toBe(true);
      expect((await bob.emit('player:result', { round: 1, timeMs: 9000, penalty: 'OK' })).ok).toBe(true);

      await bob.join(roomB);
      const a = await alice.until((s) => s.players.length === 1, 'bob left room A');
      expect(a.results['1']).toEqual({});
      expect(a.standings.map((s) => s.playerId)).toEqual([alice.playerId]);
      expect(await base.hget(keys.conns(roomA), `${POD}|${bob.playerId}`)).toBeNull();
      expect(bob.state).toMatchObject({ id: roomB, hostId: bob.playerId });

      expectRefused(await bob.emit('room:join', { roomId: 'nope0000' }), 'NOT_FOUND');
      const still = await bob.join(roomB); // same socket, same room: the current state
      expect(playerIn(still.room, bob.playerId).connected).toBe(true);
    });

    it('removes a player who leaves, with their results, and hands the host role to the oldest connected player', async () => {
      const roomId = await createRoom(pod);
      const alice = await guest('Alice');
      const bob = await guest('Bob');
      const carol = await guest('Carol');
      for (const p of [alice, bob, carol]) await p.join(roomId);
      await alice.emit('round:next');
      await alice.emit('player:result', { round: 1, timeMs: 8000, penalty: 'OK' });

      expect(await alice.emit('room:leave', {})).toEqual({ ok: true });
      const s = await carol.until((x) => x.players.length === 2, 'alice is gone');
      expect(s.players.map((p) => p.name)).toEqual(['Bob', 'Carol']);
      expect(s.hostId).toBe(bob.playerId);
      expect(s.results['1']).toEqual({});
      expectRefused(await carol.emit('round:next'), 'FORBIDDEN');
      expect((await bob.emit('round:next')).ok).toBe(true);
      expectRefused(await alice.emit('player:status', { status: 'idle' }), 'BAD_REQUEST', 'Join a room first');
    });

    it('accepts a leave outside any room as a no-op', async () => {
      const p = await guest();
      expect(await p.emit('room:leave', {})).toEqual({ ok: true });
      expect(await p.emit('room:leave')).toEqual({ ok: true });
    });

    it('keeps a disconnected player as connected:false, moves the host role on, and restores them with their results when they rejoin', async () => {
      const roomId = await createRoom(pod);
      const aliceId = generateGuestId();
      const alice = await connect(pod, { guestId: aliceId, name: 'Alice' });
      const bob = await guest('Bob');
      await alice.join(roomId);
      await bob.join(roomId);
      await alice.emit('round:next');
      await alice.emit('player:result', { round: 1, timeMs: 7000, penalty: '+2' });

      alice.close();
      const s = await bob.until((x) => !playerIn(x, aliceId).connected, 'alice shows as disconnected');
      expect(s.hostId).toBe(bob.playerId);
      expect(playerIn(s, aliceId)).toMatchObject({ status: 'done', pods: [] });
      expect(s.results['1'][aliceId]).toEqual({ timeMs: 7000, penalty: '+2' });
      expect(s.status).toBe('running'); // bob, the only connected player, has no result yet

      const back = await connect(pod, { guestId: aliceId, name: 'Alice' });
      const ack = await back.join(roomId);
      expect(ack.playerId).toBe(aliceId);
      expect(ack.room.players).toHaveLength(2);
      expect(playerIn(ack.room, aliceId)).toMatchObject({ connected: true, status: 'done' });
      expect(ack.room.results['1'][aliceId]).toEqual({ timeMs: 7000, penalty: '+2' });
      expect(ack.room.hostId).toBe(bob.playerId); // the host role does not snap back
    });

    it('keeps a player with another tab open in the room when one tab leaves, and marks them disconnected when the last one closes', async () => {
      const roomId = await createRoom(pod);
      const user = newUser();
      const token = await pod.token(user);
      const tab1 = await connect(pod, { token });
      const tab2 = await connect(pod, { token });
      const watcher = await guest('Watcher');
      await tab1.join(roomId);
      await tab2.join(roomId);
      await watcher.join(roomId);
      expect(await base.hget(keys.conns(roomId), `${POD}|${user.id}`)).toBe('2');

      expect((await tab1.emit('room:leave', {})).ok).toBe(true);
      expect(await base.hget(keys.conns(roomId), `${POD}|${user.id}`)).toBe('1');
      const s = await watcher.until((x) => x.players.length === 2);
      expect(playerIn(s, user.id).connected).toBe(true);

      tab2.close();
      const after = await watcher.until((x) => !playerIn(x, user.id).connected, 'last tab closed');
      expect(after.players.map((p) => p.id)).toContain(user.id); // closing a tab is not leaving
    });

    it('holds 16 players: a 17th is refused while everyone is connected, and otherwise replaces the disconnected player who joined first', async () => {
      const roomId = await createRoom(pod);
      const players: Player[] = [];
      for (let i = 0; i < 16; i++) {
        const p = await guest(`P${i}`);
        await p.join(roomId);
        players.push(p);
      }
      const lateId = generateGuestId();
      const late = await connect(pod, { guestId: lateId, name: 'Late' });
      expectRefused(await late.emit('room:join', { roomId }), 'CONFLICT', /full/);
      expect(await base.hget(keys.conns(roomId), `${POD}|${lateId}`)).toBeNull();

      players[3].close();
      players[7].close();
      await players[0].until((s) => s.players.filter((p) => !p.connected).length === 2, 'two players disconnected');
      const ids = (await late.join(roomId)).room.players.map((p: { id: string }) => p.id);
      expect(ids).toHaveLength(16);
      expect(ids).toContain(lateId);
      expect(ids).not.toContain(players[3].playerId);
      expect(ids).toContain(players[7].playerId);
    });
  });

  describe('rounds', () => {
    it('lets only the host start a round; everyone gets the same scramble and starts idle', async () => {
      const roomId = await createRoom(pod, { event: '444' });
      const alice = await guest('Alice');
      const bob = await guest('Bob');
      await alice.join(roomId);
      await bob.join(roomId);
      expectRefused(await bob.emit('round:next'), 'FORBIDDEN', /host/);
      expect(pod.scrambles.calls).toEqual([]); // refused before fetching a scramble

      const ack = await alice.emit('round:next', {});
      expect(ack).toMatchObject({ ok: true, round: { n: 1, scramble: "R U F2 D' #1", scrambleSource: 'scramble-service' } });
      expect(Date.parse(ack.round.startedAt)).not.toBeNaN();
      expect(pod.scrambles.calls).toEqual(['444']);
      for (const p of [alice, bob]) {
        const s = await p.until((x) => x.round?.n === 1, 'round 1');
        expect(s.round).toEqual(ack.round);
        expect(s.status).toBe('running');
        expect(s.players.map((x) => x.status)).toEqual(['idle', 'idle']);
        expect(s.results).toEqual({ '1': {} });
      }
    });

    it('marks a round whose scramble came from the fallback generator', async () => {
      pod.scrambles.impl = async () => ({ scramble: "F R U' L2", source: 'fallback' });
      const p = await guest();
      await p.join(await createRoom(pod));
      expect((await p.emit('round:next')).round).toMatchObject({ scramble: "F R U' L2", scrambleSource: 'fallback' });
    });

    it.each([
      ['round:next', {}],
      ['player:status', { status: 'inspecting' }],
      ['player:result', { round: 1, timeMs: 9000, penalty: 'OK' }],
      ['chat:send', { text: 'hi' }],
    ])('refuses %s before joining a room', async (event, payload) => {
      expectRefused(await (await guest()).emit(event, payload), 'BAD_REQUEST', 'Join a room first');
    });

    it('starts one round, not two, when two tabs of the host press "next" at the same moment', async () => {
      const roomId = await createRoom(pod);
      const token = await pod.token(newUser());
      const tab1 = await connect(pod, { token });
      const tab2 = await connect(pod, { token });
      await tab1.join(roomId);
      await tab2.join(roomId);
      // hold both scramble fetches until both requests have read the room (still round 0)
      let release!: () => void;
      const bothFetching = new Promise<void>((resolve) => (release = resolve));
      pod.scrambles.impl = async (_event, n) => {
        if (n === 2) release();
        await bothFetching;
        return { scramble: `scramble ${n}`, source: 'scramble-service' };
      };

      const acks = await Promise.all([tab1.emit('round:next'), tab2.emit('round:next')]);
      expect(acks.filter((a) => a.ok)).toHaveLength(1);
      expectRefused(acks.find((a) => !a.ok)!, 'CONFLICT', /already advanced/);
      await tab1.until((s) => s.round?.n === 1);
      expect(JSON.parse((await base.get(keys.room(roomId)))!).round.n).toBe(1);
    });

    it('refuses results for any round but the current one', async () => {
      const p = await soloRound();
      await p.emit('round:next'); // alone, the host may move on without a result
      expectRefused(await p.emit('player:result', { round: 1, timeMs: 9000, penalty: 'OK' }), 'BAD_REQUEST', /current round \(2\)/);
      expectRefused(await p.emit('player:result', { round: 3, timeMs: 9000, penalty: 'OK' }), 'BAD_REQUEST', /current round \(2\)/);
      expect((await p.emit('player:result', { round: 2, timeMs: 9000, penalty: 'OK' })).ok).toBe(true);
    });

    it('shares live status during a round, refuses it before the first one, and saves nothing when it does not change', async () => {
      const roomId = await createRoom(pod);
      const alice = await guest('Alice');
      const bob = await guest('Bob');
      await alice.join(roomId);
      await bob.join(roomId);
      expectRefused(await bob.emit('player:status', { status: 'solving' }), 'BAD_REQUEST', 'No round in progress');
      expect((await bob.emit('player:status', { status: 'idle' })).ok).toBe(true);

      await alice.emit('round:next');
      await bob.emit('player:status', { status: 'inspecting' });
      const s1 = await alice.until((s) => s.round !== null && playerIn(s, bob.playerId).status === 'inspecting', 'bob inspecting');
      expect((await bob.emit('player:status', { status: 'inspecting' })).ok).toBe(true); // no change
      await bob.emit('player:status', { status: 'solving' });
      const s2 = await alice.until((s) => playerIn(s, bob.playerId).status === 'solving', 'bob solving');
      expect(s2.rev).toBe(s1.rev + 1);
    });

    it.each([
      ['an unknown status', { status: 'flying' }],
      ['a status in upper case', { status: 'DONE' }],
      ['no status', {}],
      ['a bare string', 'solving'],
    ])('refuses %s', async (_what, payload) => {
      const p = await soloRound();
      expectRefused(await p.emit('player:status', payload), 'BAD_REQUEST');
    });
  });

  describe('results and standings', () => {
    it('marks a result done for everyone and finishes the round once every connected player has one', async () => {
      const roomId = await createRoom(pod);
      const alice = await guest('Alice');
      const bob = await guest('Bob');
      await alice.join(roomId);
      await bob.join(roomId);
      await alice.emit('round:next');

      expect(await alice.emit('player:result', { round: 1, timeMs: 9120, penalty: 'OK' })).toEqual({ ok: true });
      const mid = await bob.until((s) => playerIn(s, alice.playerId).status === 'done', 'alice done');
      expect(mid.status).toBe('running');
      expect(mid.results['1']).toEqual({ [alice.playerId]: { timeMs: 9120, penalty: 'OK' } });

      await bob.emit('player:result', { round: 1, timeMs: 8000, penalty: 'DNF' });
      const end = await alice.until((s) => s.status === 'finished', 'round finished');
      expect(end.standings).toEqual([
        { playerId: alice.playerId, name: 'Alice', wins: 1, solves: 1, meanMs: 9120, ao5: null },
        { playerId: bob.playerId, name: 'Bob', wins: 0, solves: 1, meanMs: null, ao5: null },
      ]);
    });

    it('accepts one result per player per round, after which live status can only be "done"', async () => {
      const p = await soloRound();
      expect((await p.emit('player:result', { round: 1, timeMs: 10_000, penalty: 'OK' })).ok).toBe(true);
      expectRefused(await p.emit('player:result', { round: 1, timeMs: 5_000, penalty: 'OK' }), 'CONFLICT', /already submitted/);
      expectRefused(await p.emit('player:status', { status: 'solving' }), 'CONFLICT');
      expect((await p.emit('player:status', { status: 'done' })).ok).toBe(true);
      expect(p.state.results['1'][p.playerId]).toEqual({ timeMs: 10_000, penalty: 'OK' });
    });

    it('accepts the boundary times of 1 ms and one hour', async () => {
      const p = await soloRound();
      expect((await p.emit('player:result', { round: 1, timeMs: 1, penalty: 'OK' })).ok).toBe(true);
      await p.emit('round:next');
      expect((await p.emit('player:result', { round: 2, timeMs: 3_600_000, penalty: '+2' })).ok).toBe(true);
    });

    it.each([
      ['round 0', { round: 0, timeMs: 9000, penalty: 'OK' }, /^round: /],
      ['a fractional round', { round: 1.5, timeMs: 9000, penalty: 'OK' }, /^round: /],
      ['the round as text', { round: '1', timeMs: 9000, penalty: 'OK' }, /^round: /],
      ['a zero time', { round: 1, timeMs: 0, penalty: 'OK' }, /^timeMs: /],
      ['a negative time', { round: 1, timeMs: -5, penalty: 'OK' }, /^timeMs: /],
      ['a time over an hour', { round: 1, timeMs: 3_600_001, penalty: 'OK' }, /^timeMs: /],
      ['a fractional time', { round: 1, timeMs: 9000.5, penalty: 'OK' }, /^timeMs: /],
      ['the time as text', { round: 1, timeMs: '9000', penalty: 'OK' }, /^timeMs: /],
      ['an unknown penalty', { round: 1, timeMs: 9000, penalty: 'DNS' }, /^penalty: /],
      ['no penalty', { round: 1, timeMs: 9000 }, /^penalty: /],
      ['a bare string', 'fast', /object/],
    ])('refuses a result with %s and records nothing', async (_what, payload, message) => {
      const p = await soloRound();
      expectRefused(await p.emit('player:result', payload), 'BAD_REQUEST', message);
      expect(JSON.parse((await base.get(keys.room(p.roomId!)))!).results).toEqual({ '1': {} });
    });

    it('does not let a disconnected player hold up the end of the round', async () => {
      const roomId = await createRoom(pod);
      const alice = await guest('Alice');
      const bob = await guest('Bob');
      await alice.join(roomId);
      await bob.join(roomId);
      await alice.emit('round:next');
      await alice.emit('player:result', { round: 1, timeMs: 9000, penalty: 'OK' });
      expect(alice.state.status).toBe('running');
      bob.close();
      const s = await alice.until((x) => x.status === 'finished', 'finished without bob');
      expect(playerIn(s, bob.playerId).connected).toBe(false);
    });

    it('ranks by wins, then mean: +2 counts, ties share the win, a DNF never wins; every change raises rev by one', async () => {
      const roomId = await createRoom(pod);
      const a = await guest('Ann');
      const b = await guest('Ben');
      const c = await guest('Cat');
      for (const p of [a, b, c]) await p.join(roomId);
      const rounds: [Player, number, string][][] = [
        [[a, 10_000, 'OK'], [b, 9_000, '+2'], [c, 8_000, 'DNF']], // Ann wins (Ben = 11 s)
        [[a, 12_000, 'OK'], [b, 12_000, 'OK'], [c, 11_000, '+2']], // Ann and Ben tie (Cat = 13 s)
        [[a, 5_000, 'DNF'], [b, 5_000, 'DNF'], [c, 5_000, 'DNF']], // nobody wins
      ];
      for (const [i, round] of rounds.entries()) {
        expect((await a.emit('round:next')).round.n).toBe(i + 1);
        for (const [p, timeMs, penalty] of round) expect((await p.emit('player:result', { round: i + 1, timeMs, penalty })).ok).toBe(true);
      }
      const end = await a.until((s) => s.round?.n === 3 && s.status === 'finished');
      expect(end.standings).toEqual([
        { playerId: a.playerId, name: 'Ann', wins: 2, solves: 3, meanMs: 11_000, ao5: null },
        { playerId: b.playerId, name: 'Ben', wins: 1, solves: 3, meanMs: 11_500, ao5: null },
        { playerId: c.playerId, name: 'Cat', wins: 0, solves: 3, meanMs: 13_000, ao5: null },
      ]);
      // one broadcast per saved change, in order, each one rev higher than the last
      const revs = [...new Set(a.states.filter((s) => s.id === roomId).map((s) => s.rev))];
      expect(revs).toEqual(Array.from({ length: revs.length }, (_, i) => revs[0] + i));
      expect(revs.at(-1)).toBe(end.rev);
    });
  });

  describe('chat', () => {
    it('delivers a cleaned-up message with its sender and time to everyone in the room, keeps it for later joiners, and tells nobody else', async () => {
      const roomId = await createRoom(pod);
      const alice = await guest('Alice');
      const bob = await guest('Bob');
      const eve = await guest('Eve');
      await alice.join(roomId);
      await bob.join(roomId);
      await eve.join(await createRoom(pod));

      const before = Date.now();
      expect(await alice.emit('chat:send', { text: '  good\u0000 luck\n\n everyone \u200b ' })).toEqual({ ok: true });
      await settle(() => expect(bob.chats).toHaveLength(1));
      const msg = bob.chats[0];
      expect(msg).toEqual({ playerId: alice.playerId, name: 'Alice', text: 'good luck everyone', at: expect.any(String) });
      expect(Date.parse(msg.at)).toBeGreaterThanOrEqual(before - 1000);
      expect(alice.chats).toEqual([msg]);
      await eve.emit('player:status', { status: 'idle' }); // a round trip
      expect(eve.chats).toEqual([]);

      const late = await guest('Late');
      expect((await late.join(roomId)).chat).toEqual([msg]);
    });

    it("lets a moderator clear a room's chat: its history goes, and its players are told", async () => {
      const roomId = await createRoom(pod);
      const alice = await guest('Alice');
      await alice.join(roomId);
      expect((await alice.emit('chat:send', { text: 'something to remove' })).ok).toBe(true);
      await settle(() => expect(alice.chats).toHaveLength(1));
      const res = await pod.inject({ method: 'POST', url: `/internal/moderation/rooms/${roomId}/clear-chat` });
      expect(res.statusCode).toBe(204);
      await settle(() => expect(alice.clears).toBe(1));
      expect(alice.chats).toEqual([]);
      const late = await guest('Late');
      expect((await late.join(roomId)).chat).toEqual([]);
      expect((await pod.inject({ method: 'POST', url: '/internal/moderation/rooms/no!/clear-chat' })).statusCode).toBe(404);
    });

    it('refuses a slur, and takes ordinary swearing', async () => {
      const p = await guest();
      await p.join(await createRoom(pod));
      expectRefused(await p.emit('chat:send', { text: 'you are a r3tard' }), 'BAD_REQUEST', "text: that message has a word cubr doesn't allow");
      expect((await p.emit('chat:send', { text: 'what a shit solve' })).ok).toBe(true);
    });

    it('accepts a message of exactly 200 characters', async () => {
      const p = await guest();
      await p.join(await createRoom(pod));
      expect((await p.emit('chat:send', { text: 'x'.repeat(200) })).ok).toBe(true);
    });

    it.each([
      ['an empty message', { text: '' }, 'text: message is empty'],
      ['a message of spaces', { text: '    ' }, 'text: message is empty'],
      ['a message of invisible characters', { text: '\u200b\u202e\u0007' }, 'text: message is empty'],
      ['a message over 200 characters', { text: 'x'.repeat(201) }, /^text: /],
      ['a number', { text: 42 }, /^text: /],
      ['no text', {}, /^text: /],
    ])('refuses %s', async (_what, payload, message) => {
      const p = await guest();
      await p.join(await createRoom(pod));
      expectRefused(await p.emit('chat:send', payload), 'BAD_REQUEST', message);
      expect(p.chats).toEqual([]);
    });

    it('allows a player 5 messages per 10 seconds, on any socket', async () => {
      const roomId = await createRoom(pod);
      const alice = await guest('Alice');
      const bob = await guest('Bob');
      await alice.join(roomId);
      await bob.join(roomId);
      for (let i = 1; i <= 5; i++) expect((await alice.emit('chat:send', { text: `msg ${i}` })).ok).toBe(true);
      expectRefused(await alice.emit('chat:send', { text: 'msg 6' }), 'RATE_LIMITED', /5 messages per 10 seconds/);
      expect((await bob.emit('chat:send', { text: 'my turn' })).ok).toBe(true);
      await settle(() => expect(bob.chats.map((m) => m.text)).toEqual(['msg 1', 'msg 2', 'msg 3', 'msg 4', 'msg 5', 'my turn']));

      const aliceAgain = await connect(pod, { guestId: alice.playerId });
      await aliceAgain.join(roomId);
      expectRefused(await aliceAgain.emit('chat:send', { text: 'new tab' }), 'RATE_LIMITED');
    });

    it('gives a new joiner the last 50 messages, oldest first', async () => {
      const roomId = await createRoom(pod);
      for (let i = 1; i <= 55; i++) {
        await pod.store.appendChat(roomId, { playerId: 'guest-history01', name: 'H', text: `m${i}`, at: new Date(i * 1000).toISOString() });
      }
      const ack = await (await guest()).join(roomId);
      expect(ack.chat.map((m: ChatMessage) => m.text)).toEqual(Array.from({ length: 50 }, (_, i) => `m${i + 6}`));
    });
  });

  describe('abuse limits', () => {
    it('tells a socket that sends more than 60 events in 10 seconds to slow down', async () => {
      const p = await guest();
      const acks = await Promise.all(Array.from({ length: 61 }, () => p.emit('room:leave', {})));
      expect(acks.slice(0, 60).every((a) => a.ok)).toBe(true);
      expectRefused(acks[60], 'RATE_LIMITED', /slow down/);
      expect((await (await guest()).emit('room:leave', {})).ok).toBe(true); // the budget is per socket
    });

    it('answers payloads that are not objects with BAD_REQUEST and still handles events sent without an ack', async () => {
      const roomId = await createRoom(pod);
      const watcher = await guest('Watcher');
      await watcher.join(roomId);
      const guestId = generateGuestId();
      const p = await connect(pod, { guestId });
      expectRefused(await p.emit('room:join', 'abc'), 'BAD_REQUEST');
      expectRefused(await p.emit('room:join', [roomId]), 'BAD_REQUEST');
      expectRefused(await p.emit('room:join', null), 'BAD_REQUEST', /^roomId: /);
      p.socket.emit('player:status'); // no payload and no ack: refused silently, nothing breaks
      p.socket.emit('room:join', { roomId }); // no ack, but it still joins
      await watcher.until((s) => s.players.some((x) => x.id === guestId && x.connected), 'the ack-less join went through');
    });

    it('drops a socket that sends a message over 16 KB, and cleans up after it', async () => {
      const roomId = await createRoom(pod);
      const watcher = await guest('Watcher');
      const big = await guest('Big');
      await watcher.join(roomId);
      await big.join(roomId);
      big.socket.emit('chat:send', { text: 'x'.repeat(20_000) });
      await settle(() => expect(big.disconnectReason).not.toBeNull());
      await watcher.until((s) => !playerIn(s, big.playerId).connected, 'big shows as disconnected');
      expect(watcher.chats).toEqual([]);
    });
  });

  describe('while the pod cannot reach Redis', () => {
    let lonely: Pod;
    afterEach(async () => {
      disconnectAll();
      await lonely?.close();
    });

    async function cutOff(): Promise<Player> {
      lonely = await startPod(base, 'race-socket-cut-off', SECRET);
      const p = await connect(lonely, { guestId: generateGuestId() });
      await p.join(await createRoom(lonely));
      await p.emit('round:next');
      lonely.redis.disconnect(); // the pod's command connection is gone (the adapter's are fine)
      await settle(() => expect(lonely.redis.status).toBe('end'));
      return p;
    }

    it('refuses chat instead of delivering it later', async () => {
      const p = await cutOff();
      expectRefused(await p.emit('chat:send', { text: 'anyone?' }), 'UNAVAILABLE', /reconnects/);
      expect(p.chats).toEqual([]);
    });

    it('fails room changes with UNAVAILABLE (they need the room lock)', async () => {
      const p = await cutOff();
      expectRefused(await p.emit('player:status', { status: 'inspecting' }), 'UNAVAILABLE');
      expectRefused(await p.emit('player:result', { round: 1, timeMs: 9000, penalty: 'OK' }), 'UNAVAILABLE');
    });
  });
});
