// Thin typed client for every cubetype microservice. All calls are same-origin paths that the
// Ingress (cloud) or gateway (local) routes to the right service — see docs/SPEC.md §3.
import type {
  ActivityDay,
  Leaderboard,
  LbKind,
  PbKind,
  Penalty,
  PrivateUser,
  PublicUser,
  Session,
  Solve,
  StatsSummary,
  UserRank,
} from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  /** network failure / service down (worth retrying later) */
  get isUnavailable(): boolean {
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

const TOKEN_KEY = 'cubetype.token';
let token: string | null = null;
try {
  token = localStorage.getItem(TOKEN_KEY);
} catch {
  token = null;
}
let unauthorizedHandler: (() => void) | null = null;

export function getToken(): string | null {
  return token;
}
export function setToken(t: string | null): void {
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}
/** Called when an authenticated request gets 401 (expired/revoked token). */
export function onUnauthorized(fn: () => void): void {
  unauthorizedHandler = fn;
}

const timeZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

export async function request<T>(method: string, path: string, body?: unknown, opts: { signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Timezone': timeZone };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
      cache: 'no-store',
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'Network error — is the server reachable?');
  }
  let json: any = null;
  if (res.status !== 204) {
    const text = await res.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
  }
  if (!res.ok) {
    if (res.status === 401 && token && unauthorizedHandler) unauthorizedHandler();
    throw new ApiError(
      res.status,
      json?.error?.code ?? `HTTP_${res.status}`,
      json?.error?.message ?? (res.status >= 500 ? 'Service temporarily unavailable' : res.statusText || 'Request failed'),
    );
  }
  return json as T;
}

const get = <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, { signal });
const qs = (params: Record<string, string | number | boolean | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
const enc = encodeURIComponent;

export interface NewSolve {
  id: string;
  sessionId: string;
  timeMs: number;
  penalty: Penalty;
  scramble: string;
  comment?: string | null;
  source?: string;
  createdAt?: string;
  daily?: { date: string; index: number };
}

export const api = {
  auth: {
    register: (body: { username: string; email: string; password: string }) =>
      request<{ token: string; user: PrivateUser }>('POST', '/api/auth/register', body),
    login: (body: { login: string; password: string }) => request<{ token: string; user: PrivateUser }>('POST', '/api/auth/login', body),
    logout: () => request<void>('POST', '/api/auth/logout'),
    me: (signal?: AbortSignal) => get<{ user: PrivateUser; settings: Record<string, unknown> }>('/api/auth/me', signal),
    updateMe: (body: Partial<Pick<PublicUser, 'displayName' | 'bio' | 'country' | 'wcaId'>>) =>
      request<{ user: PrivateUser }>('PATCH', '/api/auth/me', body),
    saveSettings: (settings: Record<string, unknown>) => request<{ settings: Record<string, unknown> }>('PUT', '/api/auth/me/settings', { settings }),
    user: (username: string, signal?: AbortSignal) => get<{ user: PublicUser }>(`/api/users/${enc(username)}`, signal),
    users: (ids: string[]) => get<{ users: PublicUser[] }>(`/api/users${qs({ ids: ids.join(',') })}`),
  },
  scrambles: {
    events: () => get<{ events: { id: string; name: string; puzzle: string }[] }>('/api/scrambles/events'),
    get: (event: string, count = 1) => get<{ event: string; scrambles: string[]; source: string }>(`/api/scrambles/${enc(event)}${qs({ count })}`),
    daily: (date?: string) => get<{ date: string; events: Record<string, string[]> }>(`/api/scrambles/daily${qs({ date })}`),
  },
  sessions: {
    list: (signal?: AbortSignal) => get<{ sessions: Session[] }>('/api/sessions', signal),
    create: (body: { id?: string; name: string; event: string }) => request<{ session: Session }>('POST', '/api/sessions', body),
    rename: (id: string, name: string) => request<{ session: Session }>('PATCH', `/api/sessions/${enc(id)}`, { name }),
    remove: (id: string) => request<void>('DELETE', `/api/sessions/${enc(id)}`),
    solves: (id: string, signal?: AbortSignal) => get<{ solves: Solve[] }>(`/api/sessions/${enc(id)}/solves`, signal),
  },
  solves: {
    create: (body: NewSolve) => request<{ solve: Solve; rolling: { ao5: number | null; ao12: number | null } }>('POST', '/api/solves', body),
    update: (id: string, body: { penalty?: Penalty; comment?: string | null }) => request<{ solve: Solve }>('PATCH', `/api/solves/${enc(id)}`, body),
    remove: (id: string) => request<void>('DELETE', `/api/solves/${enc(id)}`),
    daily: (date?: string) =>
      get<{ date: string; events: Record<string, { solves: Solve[]; ao5: number | null }> }>(`/api/solves/daily${qs({ date })}`),
  },
  stats: {
    summary: (userId: string, signal?: AbortSignal) => get<StatsSummary>(`/api/stats/users/${enc(userId)}/summary`, signal),
    activity: (userId: string, from?: string, to?: string, signal?: AbortSignal) =>
      get<{ days: ActivityDay[] }>(`/api/stats/users/${enc(userId)}/activity${qs({ from, to })}`, signal),
    pbHistory: (userId: string, event: string, signal?: AbortSignal) =>
      get<{ history: { kind: PbKind; valueMs: number; achievedAt: string }[] }>(`/api/stats/users/${enc(userId)}/pb-history${qs({ event })}`, signal),
    hourly: (userId: string, event: string, signal?: AbortSignal) =>
      get<{ hours: { hour: number; solves: number; meanMs: number | null }[] }>(`/api/stats/users/${enc(userId)}/hourly${qs({ event })}`, signal),
  },
  leaderboards: {
    get: (event: string, kind: LbKind, opts: { period?: 'all' | 'weekly' | 'daily'; page?: number; size?: number; key?: string } = {}, signal?: AbortSignal) =>
      get<Leaderboard>(`/api/leaderboards/${enc(event)}/${kind}${qs({ period: opts.period ?? 'all', page: opts.page, size: opts.size, key: opts.key })}`, signal),
    dailyChallenge: (event: string, date?: string, signal?: AbortSignal, opts: { page?: number; size?: number } = {}) =>
      get<Leaderboard>(`/api/leaderboards/daily-challenge${qs({ event, date, page: opts.page, size: opts.size })}`, signal),
    userRanks: (userId: string, signal?: AbortSignal) => get<{ ranks: UserRank[] }>(`/api/leaderboards/users/${enc(userId)}/ranks`, signal),
  },
};
