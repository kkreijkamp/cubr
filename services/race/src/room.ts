import { badRequest, conflict, forbidden } from '@cubetype/common';
import { computeStandings } from './standings.js';
import type {
  Identity, Penalty, PlayerStatus, RoomState, ScrambleSource, StoredRoom,
} from './types.js';

/**
 * Pure room-state transitions. Nothing here touches Redis or sockets, so all the game rules
 * (host transfer, one result per round, round completion) are unit-testable.
 * Functions mutate the room in place and throw HttpErrors for rule violations.
 */

export const MAX_PLAYERS = 16;
export const MAX_RESULT_MS = 3_600_000;

export function newRoom(opts: { id: string; name: string; event: string; isPrivate: boolean; createdBy: string | null; now: number }): StoredRoom {
  return {
    v: 1,
    id: opts.id,
    name: opts.name,
    event: opts.event,
    isPrivate: opts.isPrivate,
    hostId: null,
    status: 'lobby',
    round: null,
    players: [],
    results: {},
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
  const hasResult = room.round ? Boolean(room.results[room.round.n]?.[who.playerId]) : false;
  room.players.push({ id: who.playerId, name: who.name, userId: who.userId, status: hasResult ? 'done' : 'idle', joinedAt: now });
}

/** Explicit leave: the player and their results disappear from the room. */
export function removePlayer(room: StoredRoom, playerId: string): boolean {
  const before = room.players.length;
  room.players = room.players.filter((p) => p.id !== playerId);
  for (const round of Object.values(room.results)) delete round[playerId];
  return room.players.length !== before;
}

function requirePlayer(room: StoredRoom, playerId: string) {
  const p = room.players.find((x) => x.id === playerId);
  if (!p) throw badRequest('You are not in this room');
  return p;
}

/** Host-only: starts round n+1 with a fresh scramble; everyone goes back to idle. */
export function startRound(room: StoredRoom, by: string, expectedN: number, scramble: string, source: ScrambleSource, now: number): void {
  requirePlayer(room, by);
  if (room.hostId !== by) throw forbidden('Only the host can start the next round');
  const n = room.round?.n ?? 0;
  if (n !== expectedN) throw conflict('Round was already advanced');
  room.round = { n: n + 1, scramble, startedAt: new Date(now).toISOString(), scrambleSource: source };
  room.results[String(n + 1)] = {};
  for (const p of room.players) p.status = 'idle';
  room.status = 'running';
}

/** Live status (inspecting/solving/…). Returns false when nothing changed (no broadcast needed). */
export function setStatus(room: StoredRoom, playerId: string, status: PlayerStatus): boolean {
  const p = requirePlayer(room, playerId);
  if (status !== 'idle' && !room.round) throw badRequest('No round in progress');
  if (room.round && room.results[room.round.n]?.[playerId] && status !== 'done') {
    throw conflict('You already submitted a result for this round');
  }
  if (p.status === status) return false;
  p.status = status;
  return true;
}

/** One result per player per round, only for the current round. */
export function submitResult(room: StoredRoom, playerId: string, round: number, timeMs: number, penalty: Penalty): void {
  const p = requirePlayer(room, playerId);
  if (!room.round) throw badRequest('No round in progress');
  if (round !== room.round.n) throw badRequest(`Results are only accepted for the current round (${room.round.n})`);
  const key = String(round);
  room.results[key] ??= {};
  if (room.results[key][playerId]) throw conflict('You already submitted a result for this round');
  room.results[key][playerId] = { timeMs, penalty };
  p.status = 'done';
}

/**
 * Invariants applied after every mutation, given who is connected right now:
 * - host transfer: if the host is gone or disconnected, the oldest connected player takes over
 *   (with nobody connected the old host is kept so they can come back);
 * - round completion: once every connected player has a result, status becomes "finished".
 */
export function normalize(room: StoredRoom, connected: Set<string>): void {
  const host = room.players.find((p) => p.id === room.hostId);
  if (!host || !connected.has(host.id)) {
    const candidates = room.players.filter((p) => connected.has(p.id)).sort((a, b) => a.joinedAt - b.joinedAt);
    if (candidates.length) room.hostId = candidates[0].id;
    else if (!host) room.hostId = null;
  }
  if (room.status === 'running' && room.round) {
    const results = room.results[room.round.n] ?? {};
    const live = room.players.filter((p) => connected.has(p.id));
    if (live.length > 0 && live.every((p) => results[p.id])) room.status = 'finished';
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
    round: room.round,
    players: room.players.map((p) => ({ id: p.id, name: p.name, userId: p.userId, status: p.status, connected: connected.has(p.id) })),
    results: room.results,
    standings: computeStandings(room.players, room.results),
    createdAt: room.createdAt,
    isPrivate: room.isPrivate,
    rev: room.rev,
  };
}
