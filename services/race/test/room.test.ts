import { describe, expect, it } from 'vitest';
import { HttpError } from '@cubetype/common';
import { MAX_PLAYERS, addPlayer, newRoom, normalize, removePlayer, setStatus, startRound, submitResult, toRoomState } from '../src/room.js';
import { presenceFrom } from '../src/store.js';
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

  it('only the host starts rounds; double "next" is rejected', () => {
    const r = room();
    addPlayer(r, guest('guest-aaaaaa'), 1);
    addPlayer(r, guest('guest-bbbbbb'), 2);
    normalize(r, new Set(['guest-aaaaaa', 'guest-bbbbbb']));
    expect(code(() => startRound(r, 'guest-bbbbbb', 0, 'R U', 'fallback', 10))).toBe('FORBIDDEN');
    startRound(r, 'guest-aaaaaa', 0, "R U R'", 'scramble-service', 10);
    expect(r.round).toMatchObject({ n: 1, scramble: "R U R'", scrambleSource: 'scramble-service' });
    expect(r.status).toBe('running');
    expect(code(() => startRound(r, 'guest-aaaaaa', 0, 'F', 'fallback', 11))).toBe('CONFLICT');
  });

  it('results: current round only, once per player, sets status done, completes the round', () => {
    const r = room();
    const both = new Set(['guest-aaaaaa', 'guest-bbbbbb']);
    addPlayer(r, guest('guest-aaaaaa'), 1);
    addPlayer(r, guest('guest-bbbbbb'), 2);
    normalize(r, both);
    expect(code(() => submitResult(r, 'guest-aaaaaa', 1, 9000, 'OK'))).toBe('BAD_REQUEST'); // no round yet
    startRound(r, 'guest-aaaaaa', 0, 'R', 'fallback', 10);
    setStatus(r, 'guest-aaaaaa', 'solving');
    expect(code(() => submitResult(r, 'guest-aaaaaa', 2, 9000, 'OK'))).toBe('BAD_REQUEST');
    submitResult(r, 'guest-aaaaaa', 1, 9000, '+2');
    expect(r.players[0].status).toBe('done');
    expect(code(() => submitResult(r, 'guest-aaaaaa', 1, 8000, 'OK'))).toBe('CONFLICT');
    expect(code(() => setStatus(r, 'guest-aaaaaa', 'solving'))).toBe('CONFLICT');
    normalize(r, both);
    expect(r.status).toBe('running');
    submitResult(r, 'guest-bbbbbb', 1, 8000, 'DNF');
    normalize(r, both);
    expect(r.status).toBe('finished');
    startRound(r, 'guest-aaaaaa', 1, 'U', 'fallback', 20);
    expect(r.status).toBe('running');
    expect(r.players.every((p) => p.status === 'idle')).toBe(true);
  });

  it('a disconnected straggler does not block round completion', () => {
    const r = room();
    addPlayer(r, guest('guest-aaaaaa'), 1);
    addPlayer(r, guest('guest-bbbbbb'), 2);
    normalize(r, new Set(['guest-aaaaaa', 'guest-bbbbbb']));
    startRound(r, 'guest-aaaaaa', 0, 'R', 'fallback', 10);
    submitResult(r, 'guest-aaaaaa', 1, 9000, 'OK');
    normalize(r, new Set(['guest-aaaaaa']));
    expect(r.status).toBe('finished');
  });

  it('status changes need a round and a room membership; no-op returns false', () => {
    const r = room();
    addPlayer(r, guest('guest-aaaaaa'), 1);
    expect(code(() => setStatus(r, 'guest-aaaaaa', 'inspecting'))).toBe('BAD_REQUEST');
    expect(setStatus(r, 'guest-aaaaaa', 'idle')).toBe(false);
    expect(code(() => setStatus(r, 'guest-nobody', 'idle'))).toBe('BAD_REQUEST');
  });

  it('explicit leave removes the player and their results', () => {
    const r = room();
    addPlayer(r, guest('guest-aaaaaa'), 1);
    addPlayer(r, guest('guest-bbbbbb'), 2);
    normalize(r, new Set(['guest-aaaaaa', 'guest-bbbbbb']));
    startRound(r, 'guest-aaaaaa', 0, 'R', 'fallback', 10);
    submitResult(r, 'guest-bbbbbb', 1, 9000, 'OK');
    expect(removePlayer(r, 'guest-bbbbbb')).toBe(true);
    expect(r.results['1']).toEqual({});
    expect(r.players.map((p) => p.id)).toEqual(['guest-aaaaaa']);
  });
});

describe('presence → RoomState', () => {
  it('counts only sockets on live pods and lists the pods per player', () => {
    const presence = presenceFrom(
      { 'race-a|guest-aaaaaa': '1', 'race-b|guest-aaaaaa': '2', 'race-b|guest-bbbbbb': '1', 'race-dead|guest-cccccc': '1', 'race-a|guest-dddddd': '0' },
      new Set(['race-a', 'race-b']),
    );
    expect(presence.get('guest-aaaaaa')).toEqual(['race-a', 'race-b']);
    expect(presence.get('guest-bbbbbb')).toEqual(['race-b']);
    expect(presence.has('guest-cccccc')).toBe(false);
    expect(presence.has('guest-dddddd')).toBe(false);

    const r = room();
    addPlayer(r, guest('guest-aaaaaa', 'A'), 1);
    addPlayer(r, guest('guest-cccccc', 'C'), 2);
    normalize(r, new Set(presence.keys()));
    const state = toRoomState(r, presence);
    expect(state.hostId).toBe('guest-aaaaaa');
    expect(state.players).toEqual([
      { id: 'guest-aaaaaa', name: 'A', userId: null, status: 'idle', connected: true, pods: ['race-a', 'race-b'] },
      { id: 'guest-cccccc', name: 'C', userId: null, status: 'idle', connected: false, pods: [] },
    ]);
    expect(state.standings).toHaveLength(2);
    expect(state).toMatchObject({ id: 'abcd1234', name: 'Test', event: '333', status: 'lobby', round: null, results: {} });
  });
});
