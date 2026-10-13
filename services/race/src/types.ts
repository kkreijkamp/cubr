export type PlayerStatus = 'idle' | 'inspecting' | 'solving' | 'done';
export type RoomStatus = 'lobby' | 'running' | 'finished';

export interface StoredPlayer {
  id: string;
  name: string;
  userId: string | null;
  status: PlayerStatus;
  /** first join (ms) — the oldest connected player becomes host when the host goes away */
  joinedAt: number;
}

/**
 * What is persisted in Redis under `race:room:<id>`. Note there is no `connected` flag here:
 * connectivity is derived from the connection registry (`race:room:<id>:conns`) every time
 * the state is rendered, so it is always up to date.
 */
export interface StoredRoom {
  v: 1;
  id: string;
  name: string;
  event: string;
  isPrivate: boolean;
  hostId: string | null;
  status: RoomStatus;
  players: StoredPlayer[];
  createdAt: string;
  createdBy: string | null;
  /** incremented on every saved change — clients ignore room:state with an older rev */
  rev: number;
  updatedAt: number;
}

export interface PublicPlayer {
  id: string;
  name: string;
  userId: string | null;
  status: PlayerStatus;
  connected: boolean;
}

/** SPEC §9.6 RoomState, plus isPrivate and rev. */
export interface RoomState {
  id: string;
  name: string;
  event: string;
  hostId: string | null;
  status: RoomStatus;
  players: PublicPlayer[];
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
