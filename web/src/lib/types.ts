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
}
