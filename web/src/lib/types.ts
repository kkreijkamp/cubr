// API types - mirror docs/SPEC.md section 9 exactly.
import type { Penalty } from '@cubr/cubestats';

export type { Penalty };

export interface PublicUser {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  country: string | null;
  wcaId: string | null;
  /** null when the profile is private and you aren't its owner */
  createdAt: string | null;
  /** same-origin, immutable URL of the profile picture (`/api/users/<id>/avatar?v=...`); null = none.
   *  Optional because older API responses don't include it. */
  avatarUrl?: string | null;
  /** a private profile: strangers get only the username and picture (everything else null) */
  private?: boolean;
}
export interface PrivateUser extends PublicUser {
  email: string;
  /** false: the account was made with Google, Apple or GitHub and has no password (yet) */
  hasPassword?: boolean;
}

/** Sign-in with a provider (services/auth/src/routes/oauth.ts) */
export type OAuthProvider = 'google' | 'apple' | 'github';
export interface SignInMethods {
  password: boolean;
  /** the providers this server has set up */
  providers: OAuthProvider[];
  identities: { provider: OAuthProvider; email: string | null; createdAt: string }[];
}

export interface Session {
  id: string;
  name: string;
  event: string;
  /** a practice session: its solves count for no personal best and no leaderboard (absent = no) */
  practice?: boolean;
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
    /** years with solves, newest first (the cuber's timezone); absent from an older stats service */
    activeYears?: number[];
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

/** One UTC day of your daily challenges in one event (GET /api/solves/daily/history). */
export interface DailyDay {
  date: string;
  /** attempts made, 1-5 */
  attempts: number;
  /** the official ao5 in ms, -1 = DNF, null until all five attempts exist */
  ao5: number | null;
}

export interface GlobalStats {
  users: number;
  solves: number;
  totalMs: number;
  solvesToday: number;
  activeUsersToday: number;
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
  avatarUrl?: string | null;
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
  /** your own best time here that the anti-cheat refused (faster than the world record), if any */
  flagged?: { valueMs: number; floorMs: number; achievedAt: string | null } | null;
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
  /** monotonically increasing revision - ignore states older than the last one seen */
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

export interface WcaMeta {
  exportDate: string;
  exportVersion: string;
  counts: Record<string, number>;
}
export interface WcaRecordValue {
  value: number;
  personId: string;
  personName: string;
  countryId: string;
  countryIso2: string | null;
}
export interface WcaRecord {
  event: string;
  eventName: string;
  unit: 'time' | 'moves';
  single: (WcaRecordValue & { holders?: WcaRecordValue[] }) | null;
  average: (WcaRecordValue & { holders?: WcaRecordValue[] }) | null;
}
export interface WcaRank {
  event: string;
  kind: 'single' | 'average';
  value: number;
  world: { rank: number; total: number; percentile: number };
  unit?: 'time' | 'moves';
  country: { rank: number; total: number; percentile: number; countryId: string; countryIso2: string | null; countryName?: string } | null;
  neighbours: { personId: string; name: string; countryId: string; countryIso2: string | null; value: number; worldRank: number }[];
}
export interface WcaDistribution {
  event: string;
  kind: string;
  unit?: 'time' | 'moves';
  total: number;
  p99?: number;
  min?: number;
  below?: number;
  above?: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  buckets: { from: number; to: number; count: number }[];
}
export interface WcaPersonSummary {
  wcaId: string;
  name: string;
  countryId: string;
  countryIso2: string | null;
}
export interface WcaRankValue {
  value: number;
  worldRank: number;
  continentRank: number;
  countryRank: number;
}
export interface WcaPerson {
  person: { wcaId: string; name: string; countryId: string; countryIso2: string | null; gender: string | null };
  pbs: { event: string; single: WcaRankValue | null; average: WcaRankValue | null }[];
}

export interface ServiceInfo {
  service: string;
  version: string;
  pod: string;
  node: string;
  startedAt: string;
  uptimeSec: number;
  deps: Record<string, 'ok' | 'down'>;
  [k: string]: unknown;
}
