import { describe, expect, it } from 'vitest';
import { HttpError } from '@cubetype/common';
import { MAX_PLAYERS, addPlayer, newRoom, normalize, removePlayer, toRoomState } from '../src/room.js';
import { connectedFrom } from '../src/store.js';
import type { Identity, StoredRoom } from '../src/types.js';

const guest = (id: string, name = id): Identity => ({ playerId: id, name, userId: null, guest: true });

function room(): StoredRoom {
  return newRoom({ id: 'abcd1234', name: 'Test', event: '333', isPrivate: false, createdBy: null, now: 0 });
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof HttpError ? err.code : 'OTHER';
  }
  return undefined;
}

describe('room rules', () => {
  it('first connected player becomes host; host passes to the oldest connected player', () => {
    const r = room();
    addPlayer(r, guest('guest-aaaaaa'), 1);
    addPlayer(r, guest('guest-bbbbbb'), 2);
    addPlayer(r, guest('guest-cccccc'), 3);
    normalize(r, new Set(['guest-aaaaaa', 'guest-bbbbbb', 'guest-cccccc']));
    expect(r.hostId).toBe('guest-aaaaaa');

    normalize(r, new Set(['guest-cccccc', 'guest-bbbbbb'])); // host disconnected
    expect(r.hostId).toBe('guest-bbbbbb');

    normalize(r, new Set(['guest-aaaaaa', 'guest-bbbbbb', 'guest-cccccc'])); // a is back: b stays host
    expect(r.hostId).toBe('guest-bbbbbb');

    normalize(r, new Set()); // nobody connected → keep the old host
    expect(r.hostId).toBe('guest-bbbbbb');

    removePlayer(r, 'guest-bbbbbb');
    normalize(r, new Set(['guest-cccccc']));
    expect(r.hostId).toBe('guest-cccccc');
  });

  it('re-join with the same playerId updates the name instead of duplicating', () => {
    const r = room();
    addPlayer(r, guest('guest-aaaaaa', 'old'), 1);
    addPlayer(r, guest('guest-aaaaaa', 'new'), 5);
    expect(r.players).toHaveLength(1);
    expect(r.players[0]).toMatchObject({ name: 'new', joinedAt: 1 });
  });

  it('a full room evicts its oldest disconnected player, or rejects when everyone is connected', () => {
    const r = room();
    const ids = Array.from({ length: MAX_PLAYERS }, (_, i) => `guest-p${String(i).padStart(5, '0')}`);
    ids.forEach((id, i) => addPlayer(r, guest(id), i));
    expect(code(() => addPlayer(r, guest('guest-zzzzzz'), 99, new Set(ids)))).toBe('CONFLICT');
    const connected = new Set(ids.filter((id) => id !== ids[3] && id !== ids[7]));
    connected.add('guest-zzzzzz');
    addPlayer(r, guest('guest-zzzzzz'), 99, connected);
    expect(r.players).toHaveLength(MAX_PLAYERS);
    expect(r.players.some((p) => p.id === ids[3])).toBe(false); // oldest disconnected one went
    expect(r.players.some((p) => p.id === ids[7])).toBe(true);
  });

  it('explicit leave removes the player', () => {
    const r = room();
    addPlayer(r, guest('guest-aaaaaa'), 1);
    addPlayer(r, guest('guest-bbbbbb'), 2);
    expect(removePlayer(r, 'guest-bbbbbb')).toBe(true);
    expect(removePlayer(r, 'guest-bbbbbb')).toBe(false);
    expect(r.players.map((p) => p.id)).toEqual(['guest-aaaaaa']);
  });
});

describe('connections → RoomState', () => {
  it('a player is connected while at least one socket is open', () => {
    const connected = connectedFrom({ 'guest-aaaaaa': '2', 'guest-bbbbbb': '0' });
    expect([...connected]).toEqual(['guest-aaaaaa']);

    const r = room();
    addPlayer(r, guest('guest-aaaaaa', 'A'), 1);
    addPlayer(r, guest('guest-bbbbbb', 'B'), 2);
    normalize(r, connected);
    const state = toRoomState(r, connected);
    expect(state.hostId).toBe('guest-aaaaaa');
    expect(state.players).toEqual([
      { id: 'guest-aaaaaa', name: 'A', userId: null, status: 'idle', connected: true },
      { id: 'guest-bbbbbb', name: 'B', userId: null, status: 'idle', connected: false },
    ]);
    expect(state).toMatchObject({ id: 'abcd1234', name: 'Test', event: '333', status: 'lobby', isPrivate: false, rev: 0 });
  });
});
