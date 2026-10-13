// API types — mirror docs/SPEC.md §9 exactly.
import type { Penalty } from '@cubetype/cubestats';

export type { Penalty };

export interface PublicUser {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  country: string | null;
  wcaId: string | null;
  createdAt: string;
}
export interface PrivateUser extends PublicUser {
  email: string;
}

export interface Session {
  id: string;
  name: string;
  event: string;
  createdAt: string;
  updatedAt: string;
  solveCount: number;
}

export type SolveSource = 'timer' | 'manual' | 'import' | 'race' | 'daily' | 'seed';

export interface Solve {
  id: string;
  sessionId: string;
  event: string;
  timeMs: number;
  penalty: Penalty;
  scramble: string;
  comment: string | null;
  source: SolveSource | string;
  createdAt: string;
  dailyDate?: string | null;
  dailyIndex?: number | null;
}

/** averages/PB values: ms, -1 = DNF, null = n/a */
export type ApiValue = number | null;

export interface PB {
  valueMs: number;
  solveId: string | null;
  achievedAt: string;
}
export type PbKind = 'single' | 'mo3' | 'ao5' | 'ao12' | 'ao50' | 'ao100';

export interface StatsSummary {
  userId: string;
  totals: {
    solves: number;
    totalMs: number;
    firstSolveAt: string | null;
    lastSolveAt: string | null;
    activeDays: number;
    currentStreak: number;
    longestStreak: number;
  };
  events: {
    event: string;
    solves: number;
    totalMs: number;
    meanMs: number | null;
    pbs: Record<PbKind, PB | null>;
  }[];
}

export interface ActivityDay {
  date: string;
  solves: number;
  totalMs: number;
}

export type LbKind = 'single' | 'ao5' | 'ao12';
export type LbPeriod = 'all' | 'weekly' | 'daily' | 'challenge';
export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  country: string | null;
  valueMs: number;
  achievedAt: string | null;
}
export interface Leaderboard {
  event: string;
  kind: string;
  period: LbPeriod;
  periodKey: string;
  total: number;
  page: number;
  size: number;
  entries: LeaderboardEntry[];
  me: { rank: number; valueMs: number } | null;
}
export interface UserRank {
  event: string;
  kind: string;
  period: 'all';
  rank: number;
  total: number;
  valueMs: number;
}

export interface RaceRoomSummary {
  id: string;
  name: string;
  event: string;
  players: number;
  status: string;
  createdAt: string;
}
export interface RacePlayer {
  id: string;
  name: string;
  userId: string | null;
  status: 'idle' | 'inspecting' | 'solving' | 'done' | string;
  connected: boolean;
  /** pods this player's sockets are connected to */
  pods?: string[];
}
export interface RoomState {
  id: string;
  name: string;
  event: string;
  /** monotonically increasing revision — ignore states older than the last one seen */
  rev?: number;
  isPrivate?: boolean;
  hostId: string | null;
  status: 'lobby' | 'running' | 'finished';
  round: { n: number; scramble: string; startedAt: string; scrambleSource?: string } | null;
  players: RacePlayer[];
  results: Record<string, Record<string, { timeMs: number; penalty: Penalty }>>;
  standings: { playerId: string; name: string; wins: number; solves: number; meanMs: number | null; ao5: number | null }[];
  createdAt: string;
}
