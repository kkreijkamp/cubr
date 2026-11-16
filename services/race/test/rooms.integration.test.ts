// The race REST API against a real Redis: creating rooms (validation, the per-IP / per-account
// limit), the public lobby (what it lists, its order, its lazy pruning) and room expiry.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { Redis } from '@cubr/common';
import { createTestRedis, describeIntegration } from '@cubr/testkit';
import { generateGuestId } from '../src/sanitize.js';
import type { LobbyRoom } from '../src/store.js';
import { connect, createRoom, disconnectAll, freshIp, keys, settle, startPod, type Pod } from './harness.js';

const SECRET = 'race-rooms-test-secret';

describeIntegration('race rooms API', () => {
  let base: Redis;
  let pod: Pod;

  beforeAll(async () => {
    base = await createTestRedis();
    pod = await startPod(base, 'race-rooms-1', SECRET);
  });
  afterEach(() => disconnectAll());
  afterAll(async () => {
    disconnectAll();
    await pod?.close();
    base?.disconnect();
  });

  const post = (body: unknown, opts: { token?: string; ip?: string } = {}) =>
    pod.inject({
      method: 'POST',
      url: '/api/race/rooms',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': opts.ip ?? freshIp(),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      payload: JSON.stringify(body),
    });
  const lobby = async (): Promise<LobbyRoom[]> => {
    const res = await pod.inject({ method: 'GET', url: '/api/race/rooms' });
    expect(res.statusCode).toBe(200);
    return res.json().rooms;
  };
  const stored = async (id: string) => JSON.parse((await base.get(keys.room(id)))!);
  const join = async (roomId: string) => {
    const p = await connect(pod, { guestId: generateGuestId() });
    await p.join(roomId);
    return p;
  };

  it('creates a public room with an 8-character id and a cleaned-up name for a guest', async () => {
    const res = await post({ name: '  Friday\u0007   night  race ', event: 'pyram' });
    expect(res.statusCode).toBe(201);
    const { room } = res.json();
    expect(room).toEqual({ id: expect.stringMatching(/^[a-z0-9]{8}$/), name: 'Friday night race', event: 'pyram', isPrivate: false });
    expect(await stored(room.id)).toMatchObject({ name: 'Friday night race', createdBy: null, hostId: null, players: [], status: 'lobby' });
  });

  it('records the signed-in creator of a private room', async () => {
    const user = { id: randomUUID(), username: 'creator' };
    const res = await post({ name: 'Just us', event: '333', isPrivate: true }, { token: await pod.token(user) });
    expect(res.statusCode).toBe(201);
    expect(res.json().room.isPrivate).toBe(true);
    expect((await stored(res.json().room.id)).createdBy).toBe(user.id);
  });

  const del = (id: string, token?: string) =>
    pod.inject({ method: 'DELETE', url: `/api/race/rooms/${id}`, headers: token ? { authorization: `Bearer ${token}` } : {} });

  it('lets the signed-in creator delete an empty room: it leaves the lobby and its keys go at once', async () => {
    const token = await pod.token({ id: randomUUID(), username: 'tidy_host' });
    const { room } = (await post({ name: 'Short lived', event: '333' }, { token })).json();
    const p = await join(room.id);
    await p.emit('chat:send', { text: 'hi' });
    p.close();
    await settle(async () => expect((await lobby()).find((r) => r.id === room.id)?.players).toBe(0));

    expect((await del(room.id, token)).statusCode).toBe(204);
    expect((await lobby()).some((r) => r.id === room.id)).toBe(false);
    expect(await base.exists(keys.room(room.id), keys.conns(room.id), keys.chat(room.id))).toBe(0);
    expect(await base.zscore(keys.lobby, room.id)).toBeNull();
    expect((await del(room.id, token)).statusCode).toBe(404); // already gone
    const late = await connect(pod, { guestId: generateGuestId() });
    expect((await late.emit('room:join', { roomId: room.id })).ok).toBe(false); // and can't be joined
  });

  it('deletes a room only for its signed-in creator, and not while somebody is in it', async () => {
    const owner = await pod.token({ id: randomUUID(), username: 'owner' });
    const other = await pod.token({ id: randomUUID(), username: 'other' });
    const { room } = (await post({ name: 'Mine', event: '333' }, { token: owner })).json();
    expect((await del(room.id)).statusCode).toBe(401); // a guest
    expect((await del(room.id, other)).statusCode).toBe(403);
    const guests = (await post({ name: 'Made by a guest', event: '333' })).json().room;
    expect((await del(guests.id, other)).statusCode).toBe(403); // nobody owns a guest's room
    expect((await del('NOT-a-room!', owner)).statusCode).toBe(404);
    expect((await del('zzzzzzzz', owner)).statusCode).toBe(404);

    const p = await join(room.id);
    const busy = await del(room.id, owner);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('CONFLICT');
    expect(await stored(room.id)).toMatchObject({ name: 'Mine' });
    p.close();
    await settle(async () => expect((await del(room.id, owner)).statusCode).toBe(204));
  });

  it.each([
    ['no name', { event: '333' }],
    ['an empty name', { name: '', event: '333' }],
    ['a name of spaces', { name: '    ', event: '333' }],
    ['a name of invisible characters', { name: '\u200b\u200b\u202e', event: '333' }],
    ['a name over 40 characters', { name: 'x'.repeat(41), event: '333' }],
    ['an unknown event', { name: 'Room', event: 'bogus' }],
    ['multi-blind (not supported)', { name: 'Room', event: '333mbf' }],
    ['no event', { name: 'Room' }],
    ['isPrivate as text', { name: 'Room', event: '333', isPrivate: 'yes' }],
    ['an array body', ['Room', '333']],
  ])('answers 400 to %s', async (_what, body) => {
    const res = await post(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });

  it('allows 20 new rooms a minute per address, and per account for signed-in users', async () => {
    const ip = freshIp();
    for (let i = 0; i < 20; i++) expect((await post({ name: `r${i}`, event: '333' }, { ip })).statusCode).toBe(201);
    const over = await post({ name: 'one more', event: '333' }, { ip });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('RATE_LIMITED');
    expect((await post({ name: 'next door', event: '333' })).statusCode).toBe(201); // another address

    // a signed-in user on that address has their own budget, and it follows them to other addresses
    const token = await pod.token({ id: randomUUID(), username: 'busy_host' });
    expect((await post({ name: 'u0', event: '333' }, { ip, token })).statusCode).toBe(201);
    for (let i = 1; i < 20; i++) expect((await post({ name: `u${i}`, event: '333' }, { token })).statusCode).toBe(201);
    expect((await post({ name: 'u20', event: '333' }, { token })).statusCode).toBe(429);
  });

  it('lists public rooms with their connected players, most recent activity first, and never private ones', async () => {
    const quiet = await createRoom(pod, { name: 'Quiet' });
    const busy = await createRoom(pod, { name: 'Busy', event: '222' });
    const hidden = await createRoom(pod, { name: 'Hidden', isPrivate: true });
    const first = await join(busy);
    await join(busy);
    await join(hidden);

    const mine = (await lobby()).filter((r) => [quiet, busy, hidden].includes(r.id));
    expect(mine).toEqual([
      { id: busy, name: 'Busy', event: '222', players: 2, status: 'lobby', createdAt: expect.any(String) },
      { id: quiet, name: 'Quiet', event: '333', players: 0, status: 'lobby', createdAt: expect.any(String) },
    ]);
    expect(await base.zscore(keys.lobby, hidden)).toBeNull();

    first.close(); // players counts connected players only
    await settle(async () => expect((await lobby()).find((r) => r.id === busy)?.players).toBe(1));
  });

  it('prunes rooms that expired or sat empty for 10 minutes, and lists them again once somebody joins', async () => {
    const expired = await createRoom(pod, { name: 'Expired' });
    const idle = await createRoom(pod, { name: 'Idle' });
    const occupied = await createRoom(pod, { name: 'Occupied' });
    await join(occupied);
    await base.del(keys.room(expired)); // the 2 h TTL ran out
    const elevenMinutesAgo = Date.now() - 11 * 60_000;
    await base.zadd(keys.lobby, elevenMinutesAgo, idle, elevenMinutesAgo, occupied);

    const ids = (await lobby()).map((r) => r.id);
    expect(ids).toContain(occupied); // quiet for a while, but somebody is there
    expect(ids).not.toContain(expired);
    expect(ids).not.toContain(idle);
    expect(await base.zscore(keys.lobby, expired)).toBeNull();
    expect(await base.zscore(keys.lobby, idle)).toBeNull();

    await join(idle); // a direct link still works
    expect((await lobby()).map((r) => r.id)).toContain(idle);
  });

  it('expires room keys 2 hours after the last change, and every change or message pushes that back', async () => {
    const roomId = await createRoom(pod);
    const fresh = await base.ttl(keys.room(roomId));
    expect(fresh).toBeGreaterThan(7100);
    expect(fresh).toBeLessThanOrEqual(7200);

    await base.expire(keys.room(roomId), 60); // most of the 2 h have passed
    const p = await join(roomId);
    expect(await base.ttl(keys.room(roomId))).toBeGreaterThan(7100);
    expect(await base.ttl(keys.conns(roomId))).toBeGreaterThan(7100);

    await base.expire(keys.room(roomId), 60);
    expect((await p.emit('chat:send', { text: 'still here' })).ok).toBe(true);
    expect(await base.ttl(keys.room(roomId))).toBeGreaterThan(7100);
    expect(await base.ttl(keys.chat(roomId))).toBeGreaterThan(7100);
  });

  // last: it fills the lobby
  it('shows at most 50 rooms', async () => {
    for (let i = 0; i < 55; i++) await createRoom(pod, { name: `bulk ${i}` });
    const rooms = await lobby();
    expect(rooms).toHaveLength(50);
    expect(rooms.every((r) => r.name.startsWith('bulk '))).toBe(true); // the newest ones
  });
});
