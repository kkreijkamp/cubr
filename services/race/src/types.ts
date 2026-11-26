import type { Penalty } from '@cubr/cubestats';

export type { Penalty };
export type PlayerStatus = 'idle' | 'inspecting' | 'solving' | 'done';
export type RoomStatus = 'lobby' | 'running' | 'finished';
export type ScrambleSource = 'scramble-service' | 'fallback';

export interface ResultEntry {
  timeMs: number;
  penalty: Penalty;
}

/** results[roundN][playerId] */
export type Results = Record<string, Record<string, ResultEntry>>;

export interface Round {
  n: number;
  scramble: string;
  startedAt: string;
  /** lets the UI flag rounds whose scramble came from the local fallback generator */
  scrambleSource: ScrambleSource;
}

export interface StoredPlayer {
  id: string;
  name: string;
  userId: string | null;
  status: PlayerStatus;
  /** first join (ms) - the oldest connected player becomes host when the host goes away */
  joinedAt: number;
}

/**
 * What is persisted in Redis under `race:room:<id>`. Note there is no `connected` flag here:
 * connectivity is derived from the connection registry (`race:room:<id>:conns`) every time
 * the state is rendered, so it is always correct across pods.
 */
export interface StoredRoom {
  v: 1;
  id: string;
  name: string;
  event: string;
  isPrivate: boolean;
  hostId: string | null;
  status: RoomStatus;
  round: Round | null;
  players: StoredPlayer[];
  results: Results;
  /** per player, the totals of rounds no longer kept in `results` (room.ts ROUNDS_KEPT), for the standings */
  earlier?: Record<string, EarlierTotals>;
  createdAt: string;
  createdBy: string | null;
  /** incremented on every saved change - clients ignore room:state with an older rev */
  rev: number;
  updatedAt: number;
}

/** A player's results in rounds that were pruned: what the standings need of them. */
export interface EarlierTotals {
  wins: number;
  solves: number;
  /** sum and count of the effective times that weren't DNF */
  sumMs: number;
  finite: number;
  /** the last 5 results, oldest first (an ao5 can reach back into pruned rounds) */
  last: ResultEntry[];
}

export interface Standing {
  playerId: string;
  name: string;
  wins: number;
  solves: number;
  meanMs: number | null;
  ao5: number | null;
}

export interface PublicPlayer {
  id: string;
  name: string;
  userId: string | null;
  status: PlayerStatus;
  connected: boolean;
  /** the race pods currently holding this player's socket(s), so the UI can show the scaling */
  pods: string[];
}

/** SPEC section 9.6 RoomState, plus isPrivate, rev, round.scrambleSource and players[].pods. */
export interface RoomState {
  id: string;
  name: string;
  event: string;
  hostId: string | null;
  status: RoomStatus;
  round: Round | null;
  players: PublicPlayer[];
  results: Results;
  standings: Standing[];
  createdAt: string;
  isPrivate: boolean;
  rev: number;
}

export interface Identity {
  playerId: string;
  name: string;
  userId: string | null;
  guest: boolean;
}

/** playerId -> pods that hold a live socket for that player in this room. */
export type Presence = Map<string, string[]>;

export interface ChatMessage {
  playerId: string;
  name: string;
  text: string;
  at: string;
}
