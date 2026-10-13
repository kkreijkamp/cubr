import { conflict } from '@cubetype/common';
import type { Identity, RoomState, StoredRoom } from './types.js';

/**
 * Pure room-state transitions. Nothing here touches Redis or sockets, so all the game rules
 * (host transfer, room capacity) are unit-testable.
 * Functions mutate the room in place and throw HttpErrors for rule violations.
 */

export const MAX_PLAYERS = 16;

export function newRoom(opts: { id: string; name: string; event: string; isPrivate: boolean; createdBy: string | null; now: number }): StoredRoom {
  return {
    v: 1,
    id: opts.id,
    name: opts.name,
    event: opts.event,
    isPrivate: opts.isPrivate,
    hostId: null,
    status: 'lobby',
    players: [],
    createdAt: new Date(opts.now).toISOString(),
    createdBy: opts.createdBy,
    rev: 0,
    updatedAt: opts.now,
  };
}

/**
 * Adds the player (or refreshes name/userId when they re-join with the same playerId).
 * A full room makes space by dropping its longest-standing disconnected player.
 */
export function addPlayer(room: StoredRoom, who: Identity, now: number, connected: Set<string> = new Set()): void {
  const existing = room.players.find((p) => p.id === who.playerId);
  if (existing) {
    existing.name = who.name;
    existing.userId = who.userId;
    return;
  }
  if (room.players.length >= MAX_PLAYERS) {
    const idle = room.players.filter((p) => !connected.has(p.id)).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (!idle) throw conflict(`Room is full (max ${MAX_PLAYERS} players)`);
    removePlayer(room, idle.id);
  }
  room.players.push({ id: who.playerId, name: who.name, userId: who.userId, status: 'idle', joinedAt: now });
}

/** Explicit leave: the player disappears from the room. */
export function removePlayer(room: StoredRoom, playerId: string): boolean {
  const before = room.players.length;
  room.players = room.players.filter((p) => p.id !== playerId);
  return room.players.length !== before;
}

/**
 * Invariants applied after every mutation, given who is connected right now:
 * - host transfer: if the host is gone or disconnected, the oldest connected player takes over
 *   (with nobody connected the old host is kept so they can come back).
 */
export function normalize(room: StoredRoom, connected: Set<string>): void {
  const host = room.players.find((p) => p.id === room.hostId);
  if (!host || !connected.has(host.id)) {
    const candidates = room.players.filter((p) => connected.has(p.id)).sort((a, b) => a.joinedAt - b.joinedAt);
    if (candidates.length) room.hostId = candidates[0].id;
    else if (!host) room.hostId = null;
  }
}

/** Renders the SPEC RoomState (connected flags come from the connection registry). */
export function toRoomState(room: StoredRoom, connected: Set<string>): RoomState {
  return {
    id: room.id,
    name: room.name,
    event: room.event,
    hostId: room.hostId,
    status: room.status,
    players: room.players.map((p) => ({ id: p.id, name: p.name, userId: p.userId, status: p.status, connected: connected.has(p.id) })),
    createdAt: room.createdAt,
    isPrivate: room.isPrivate,
    rev: room.rev,
  };
}
