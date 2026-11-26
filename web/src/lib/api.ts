// Thin typed client for every cubr microservice. All calls are same-origin paths that the
// Ingress (cloud) or gateway (local) routes to the right service - see docs/SPEC.md section 3.
import type {
  ActivityDay,
  GlobalStats,
  Leaderboard,
  LbKind,
  PbKind,
  Penalty,
  PrivateUser,
  PublicUser,
  RaceRoomSummary,
  ServiceInfo,
  Session,
  Solve,
  StatsSummary,
  UserRank,
  WcaDistribution,
  WcaMeta,
  WcaPerson,
  WcaPersonSummary,
  WcaRank,
  WcaRecord,
  OAuthProvider,
  SignInMethods,
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

const TOKEN_KEY = 'cubr.token';
let token: string | null = null;
try {
  token = localStorage.getItem(TOKEN_KEY);
} catch {
  token = null;
}
let unauthorizedHandler: ((sent: string) => void) | null = null;

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
/** The token in storage, which another tab may have replaced since this one read it. */
export function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
/** Called when an authenticated request gets 401 (expired/revoked token), with the token it sent. */
export function onUnauthorized(fn: (sent: string) => void): void {
  unauthorizedHandler = fn;
}

/** Whose a token is (its `sub`), read without verifying it: only to tell whether two tokens belong to
 *  the same account. */
export function tokenSubject(t: string | null | undefined): string | null {
  try {
    const payload: unknown = JSON.parse(atob((t ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const sub = (payload as { sub?: unknown } | null)?.sub;
    return typeof sub === 'string' ? sub : null;
  } catch {
    return null;
  }
}

/** The token this tab should use when another tab stores `stored`: that one if it's the same
 *  account's (a password change there signs out every older token), else this tab's own. */
export function followStoredToken(current: string | null, stored: string | null): string | null {
  if (!current || !stored || stored === current) return current;
  const sub = tokenSubject(stored);
  return sub !== null && sub === tokenSubject(current) ? stored : current;
}

// Another tab changed the password, or reset it: carry on with its new token here too, rather than
// being signed out by the next request. (A different account's token is left to the 401 handler.)
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key === TOKEN_KEY) token = followStoredToken(token, e.newValue);
  });
}

const timeZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

export interface RawResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  ms: number;
}

/** GETs give up after this long, so a hanging service fails its own widget instead of spinning. */
const GET_TIMEOUT_MS = 15_000;

/** The caller's signal combined with a timeout (`AbortSignal.any` where the browser has it). */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  const ctrl = new AbortController();
  for (const s of [signal, timeout]) {
    if (s.aborted) ctrl.abort(s.reason);
    else s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

/** fetch / body-read failures as ApiError; an abort by the caller is passed through unchanged. */
function transportError(err: unknown): unknown {
  const name = (err as Error | null)?.name;
  if (name === 'AbortError') return err;
  if (name === 'TimeoutError') return new ApiError(0, 'TIMEOUT', 'Request timed out');
  return new ApiError(0, 'NETWORK', 'Network error - is the server reachable?');
}

/** Low-level request returning body + headers (and how long it took).
 *  A `Blob` body is sent as raw bytes with the blob's own content type (avatar upload); anything
 *  else is sent as JSON. */
export async function requestRaw<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RawResponse<T>> {
  const headers: Record<string, string> = { 'X-Timezone': timeZone };
  const raw = body instanceof Blob;
  if (raw) headers['content-type'] = body.type || 'application/octet-stream';
  else if (body !== undefined) headers['content-type'] = 'application/json';
  const sent = token;
  if (sent) headers.Authorization = `Bearer ${sent}`;
  const started = performance.now();
  let res: Response;
  const signal = withTimeout(opts.signal, opts.timeoutMs);
  try {
    res = await fetch(path, {
      method,
      headers,
      body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
      signal,
      cache: 'no-store',
    });
  } catch (err) {
    throw transportError(err);
  }
  const ms = performance.now() - started;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each api.* call types its own answer
  let json: any = null;
  let notJson = false;
  if (res.status !== 204) {
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw transportError(err);
    }
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        notJson = true;
      }
    }
  }
  if (!res.ok) {
    if (res.status === 401 && sent && unauthorizedHandler) unauthorizedHandler(sent);
    throw new ApiError(
      res.status,
      json?.error?.code ?? `HTTP_${res.status}`,
      json?.error?.message ?? (res.status >= 500 ? 'Service temporarily unavailable' : res.statusText || 'Request failed'),
    );
  }
  // a 2xx that isn't JSON, e.g. the SPA's index.html for a path no service handles
  if (notJson) throw new ApiError(res.status, 'BAD_RESPONSE', 'Unexpected response from the server (not JSON)');
  return { data: json as T, status: res.status, headers: res.headers, ms };
}

export async function request<T>(method: string, path: string, body?: unknown, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
  return (await requestRaw<T>(method, path, body, opts)).data;
}

const get = <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, { signal, timeoutMs: GET_TIMEOUT_MS });
const qs = (params: Record<string, string | number | boolean | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
const enc = encodeURIComponent;

/**
 * csTimer's drawing of a scramble (the scramble service draws it; cached by the browser), for the
 * puzzles cubing.js can't draw and the scrambles it can't read (components/TwistyPreview fetches it
 * only then). `type`: the session's practice scramble type, if any.
 */
export function scrambleImageUrl(event: string, scramble: string, type?: string): string {
  return `/api/scrambles/${enc(event)}/image${qs({ scramble: scramble.slice(0, 2000), type })}`;
}

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

export interface ImportPayload {
  sessions: {
    name: string;
    event: string;
    practice?: boolean;
    /** a practice scramble type (always a practice session) */
    scramble?: string;
    solves: { timeMs: number; penalty: Penalty; scramble: string; comment?: string | null; createdAt: string }[];
  }[];
}

export const api = {
  auth: {
    register: (body: { username: string; email: string; password: string }) =>
      request<{ token: string; user: PrivateUser }>('POST', '/api/auth/register', body),
    login: (body: { login: string; password: string }) => request<{ token: string; user: PrivateUser }>('POST', '/api/auth/login', body),
    logout: () => request<void>('POST', '/api/auth/logout'),
    /** every other session ends; this one gets a fresh token */
    logoutEverywhere: () => request<{ token: string; user: PrivateUser }>('POST', '/api/auth/logout/everywhere'),
    /** Always 202: the answer doesn't say whether an account uses the address. */
    forgotPassword: (email: string) => request<{ ok: true }>('POST', '/api/auth/password/forgot', { email }),
    /** Uses a reset link's token once; signs out every other session and returns a fresh one. */
    resetPassword: (body: { token: string; password: string }) => request<{ token: string; user: PrivateUser }>('POST', '/api/auth/password/reset', body),
    /** Changes the password (`password`: the current one, 403 if wrong), or sets the first one for an
     *  account without (it must have signed in in the last 10 minutes, 403 otherwise). Signs out
     *  every other session and returns a fresh token. 400 if it's the same password, 429 after 5 an
     *  hour. */
    changePassword: (body: { newPassword: string; password?: string }) => request<{ token: string; user: PrivateUser }>('POST', '/api/auth/me/password', body),
    me: (signal?: AbortSignal) => get<{ user: PrivateUser; settings: Record<string, unknown> }>('/api/auth/me', signal),
    /** Asks to change the email: the new address gets a link, nothing changes until it's opened. The
     *  password is asked again (403 if wrong); an account without one must have signed in in the last
     *  10 minutes (403 otherwise). 409 if another account uses the address. */
    changeEmail: (body: { email: string; password?: string }) => request<{ ok: true; email: string }>('POST', '/api/auth/me/email', body),
    /** Uses a link from an email once (no sign-in needed): it confirms the account's own address
     *  (changed: false), or makes a new address its email (changed: true). 400 expired or used, 409
     *  the new address was taken meanwhile. */
    confirmEmail: (token: string) => request<{ email: string; changed?: boolean }>('POST', '/api/auth/email/confirm', { token }),
    /** Sends a new link that confirms the account's current email (it works for 7 days). 400 if it's
     *  confirmed already, 429 after 3 an hour or 5 a day. */
    sendEmailConfirmation: () => request<{ ok: true; email: string }>('POST', '/api/auth/me/email/confirmation'),
    updateMe: (body: Partial<Pick<PublicUser, 'displayName' | 'bio' | 'country' | 'wcaId' | 'private'>>) =>
      request<{ user: PrivateUser }>('PATCH', '/api/auth/me', body),
    saveSettings: (settings: Record<string, unknown>) => request<{ settings: Record<string, unknown> }>('PUT', '/api/auth/me/settings', { settings }),
    /** PUT the raw image bytes (image/webp | image/jpeg | image/png, <= 300 KB) -> user with the new avatarUrl. */
    uploadAvatar: (blob: Blob) => request<{ user: PrivateUser }>('PUT', '/api/auth/me/avatar', blob, { timeoutMs: 30_000 }),
    removeAvatar: () => request<{ user: PrivateUser }>('DELETE', '/api/auth/me/avatar'),
    /** Deletes the account and everything in it; the password is asked again (403 if wrong), or the
     *  username for an account without a password. */
    deleteMe: (proof: { password: string } | { confirm: string }) => request<void>('DELETE', '/api/auth/me', proof),
    /** Sign-in with Google, Apple or GitHub. The one-time code and a sign-up only work in the browser
     *  that started them (a cookie the server set). */
    oauth: {
      providers: (signal?: AbortSignal) => get<{ providers: OAuthProvider[] }>('/api/auth/oauth/providers', signal),
      /** The provider's sign-in page to send the browser to; `link` connects it to this account. */
      start: (provider: OAuthProvider, mode: 'signin' | 'link', next?: string) =>
        request<{ url: string }>('POST', `/api/auth/oauth/${provider}/start`, { mode, next }),
      exchange: (code: string) => request<{ token: string; user: PrivateUser }>('POST', '/api/auth/oauth/exchange', { code }),
      signup: (id: string, signal?: AbortSignal) =>
        get<{ provider: OAuthProvider; email: string; username: string | null }>(`/api/auth/oauth/signup/${enc(id)}`, signal),
      completeSignup: (id: string, username: string) => request<{ token: string; user: PrivateUser }>('POST', '/api/auth/oauth/signup', { id, username }),
      methods: () => get<SignInMethods>('/api/auth/me/sign-in'),
      disconnect: (provider: OAuthProvider) => request<void>('DELETE', `/api/auth/me/identities/${provider}`),
    },
    user: (username: string, signal?: AbortSignal) => get<{ user: PublicUser }>(`/api/users/${enc(username)}`, signal),
    users: (ids: string[]) => get<{ users: PublicUser[] }>(`/api/users${qs({ ids: ids.join(',') })}`),
  },
  scrambles: {
    events: () => get<{ events: { id: string; name: string; puzzle: string | null }[] }>('/api/scrambles/events'),
    /** `type`: a practice scramble type (the event's default when omitted) */
    get: (event: string, count = 1, fresh = false, opts: { signal?: AbortSignal; timeoutMs?: number; type?: string } = {}) =>
      request<{ event: string; scrambles: string[]; source: string }>(
        'GET',
        `/api/scrambles/${enc(event)}${qs({ count, fresh: fresh ? 1 : undefined, type: opts.type })}`,
        undefined,
        { signal: opts.signal, timeoutMs: opts.timeoutMs },
      ),
    daily: (date?: string) => get<{ date: string; events: Record<string, string[]> }>(`/api/scrambles/daily${qs({ date })}`),
  },
  sessions: {
    list: (signal?: AbortSignal) => get<{ sessions: Session[] }>('/api/sessions', signal),
    create: (body: { id?: string; name: string; event: string; practice?: boolean; scramble?: string; createdAt?: string }) =>
      request<{ session: Session }>('POST', '/api/sessions', body),
    rename: (id: string, name: string) => request<{ session: Session }>('PATCH', `/api/sessions/${enc(id)}`, { name }),
    /** practice: its solves count for no personal best and no leaderboard */
    setPractice: (id: string, practice: boolean) => request<{ session: Session }>('PATCH', `/api/sessions/${enc(id)}`, { practice }),
    remove: (id: string) => request<void>('DELETE', `/api/sessions/${enc(id)}`),
    solves: (id: string, signal?: AbortSignal) =>
      request<{ solves: Solve[] }>('GET', `/api/sessions/${enc(id)}/solves`, undefined, { signal, timeoutMs: 60_000 }),
    import: (payload: ImportPayload) =>
      request<{ imported: { sessions: number; solves: number }; skipped?: number; continued?: number }>('POST', '/api/sessions/import', payload, {
        timeoutMs: 120_000,
      }),
    /** Moves every solve of `sourceIds` (1-50, same event, not the target) into `targetId` and
     *  deletes the sources, atomically. 404 = unknown session, 409 = different event. */
    merge: (targetId: string, sourceIds: string[]) =>
      request<{ session: Session; merged: { sessions: number; solves: number } }>(
        'POST',
        `/api/sessions/${enc(targetId)}/merge`,
        { sourceIds },
        { timeoutMs: 60_000 },
      ),
  },
  solves: {
    create: (body: NewSolve) => request<{ solve: Solve; rolling: { ao5: number | null; ao12: number | null } }>('POST', '/api/solves', body),
    update: (id: string, body: { penalty?: Penalty; comment?: string | null }) => request<{ solve: Solve }>('PATCH', `/api/solves/${enc(id)}`, body),
    remove: (id: string) => request<void>('DELETE', `/api/solves/${enc(id)}`),
    export: () => request<{ exportedAt: string; sessions: (Session & { solves: Solve[] })[] }>('GET', '/api/solves/export', undefined, { timeoutMs: 120_000 }),
    daily: (date?: string) =>
      get<{
        date: string;
        events: Record<string, { solves: Solve[]; attempts?: { index: number; timeMs: number; penalty: Penalty; solveId: string }[]; ao5: number | null }>;
      }>(`/api/solves/daily${qs({ date })}`),
    /** an official daily attempt starts: `abandoned` = it had started before, so it's a DNF now */
    dailyStart: (body: { date: string; event: string; index: number }) =>
      request<{ abandoned: boolean; attempt?: { index: number; timeMs: number; penalty: Penalty } }>('POST', '/api/solves/daily/start', body),
  },
  stats: {
    summary: (userId: string, signal?: AbortSignal) => get<StatsSummary>(`/api/stats/users/${enc(userId)}/summary`, signal),
    activity: (userId: string, from?: string, to?: string, signal?: AbortSignal, event?: string) =>
      get<{ from: string; to: string; days: ActivityDay[] }>(`/api/stats/users/${enc(userId)}/activity${qs({ from, to, event })}`, signal),
    pbHistory: (userId: string, event: string, signal?: AbortSignal) =>
      get<{ history: { kind: PbKind; valueMs: number; achievedAt: string }[] }>(`/api/stats/users/${enc(userId)}/pb-history${qs({ event })}`, signal),
    /** chronological solve series: rows are [unixSeconds, timeMs, effectiveMs | null (DNF), sessionIndex] */
    solves: (userId: string, event: string, signal?: AbortSignal, opts: { limit?: number } = {}) =>
      get<{
        event: string;
        total: number;
        truncated: boolean;
        sessions?: { id: string; name: string | null; practice?: boolean; solves: number; firstAt: string; lastAt: string }[];
        solves: [number, number, number | null, number?][];
      }>(`/api/stats/users/${enc(userId)}/solves${qs({ event, limit: opts.limit })}`, signal),
    hourly: (userId: string, event: string, signal?: AbortSignal) =>
      get<{ hours: { hour: number; solves: number; meanMs: number | null }[] }>(`/api/stats/users/${enc(userId)}/hourly${qs({ event })}`, signal),
    global: (signal?: AbortSignal) => get<GlobalStats>('/api/stats/global', signal),
  },
  leaderboards: {
    get: (event: string, kind: LbKind, opts: { period?: 'all' | 'weekly' | 'daily'; page?: number; size?: number; key?: string } = {}, signal?: AbortSignal) =>
      get<Leaderboard>(
        `/api/leaderboards/${enc(event)}/${kind}${qs({ period: opts.period ?? 'all', page: opts.page, size: opts.size, key: opts.key })}`,
        signal,
      ),
    dailyChallenge: (event: string, date?: string, signal?: AbortSignal, opts: { page?: number; size?: number } = {}) =>
      get<Leaderboard>(`/api/leaderboards/daily-challenge${qs({ event, date, page: opts.page, size: opts.size })}`, signal),
    userRanks: (userId: string, signal?: AbortSignal) => get<{ ranks: UserRank[] }>(`/api/leaderboards/users/${enc(userId)}/ranks`, signal),
  },
  supporters: {
    /** public Ko-fi supporters, most recent first (member = a membership payment in the last 35 days) */
    list: (signal?: AbortSignal) => get<{ supporters: { name: string; member: boolean }[] }>('/api/supporters', signal),
  },
  feedback: {
    /** The footer's feedback form (lib/feedbackForm.ts): emailed to cubr's inbox, a reply going to `email`.
     *  204; 400 a bad email or no message; 429 after 3 in 10 minutes or 10 a day from one address; 503
     *  it can't be emailed right now. */
    send: (body: { kind: string; message: string; email?: string; details?: string }) => request<void>('POST', '/api/feedback', body, { timeoutMs: 20_000 }),
  },
  race: {
    rooms: (signal?: AbortSignal) => get<{ rooms: RaceRoomSummary[] }>('/api/race/rooms', signal),
    createRoom: (body: { name: string; event: string; isPrivate?: boolean }) =>
      request<{ room: { id: string; name: string; event: string } }>('POST', '/api/race/rooms', body),
  },
  wca: {
    meta: (signal?: AbortSignal) => get<WcaMeta>('/api/wca/meta', signal),
    records: (signal?: AbortSignal) => get<{ records: WcaRecord[] }>('/api/wca/records', signal),
    rank: (p: { event: string; kind: 'single' | 'average'; value: number; country?: string | null }, signal?: AbortSignal) =>
      get<WcaRank>(`/api/wca/rank${qs(p)}`, signal),
    distribution: (event: string, kind: 'single' | 'average', buckets = 50, signal?: AbortSignal) =>
      get<WcaDistribution>(`/api/wca/distribution${qs({ event, kind, buckets })}`, signal),
    persons: (q: string, limit = 20, signal?: AbortSignal) => get<{ persons: WcaPersonSummary[] }>(`/api/wca/persons${qs({ q, limit })}`, signal),
    person: (wcaId: string, signal?: AbortSignal) => get<WcaPerson>(`/api/wca/persons/${enc(wcaId)}`, signal),
    countries: (signal?: AbortSignal) =>
      get<{ countries: { id: string; iso2: string | null; name: string; continentId: string }[] }>('/api/wca/countries', signal),
  },
  /** A service's _info endpoint (the footer shows the web app's version). */
  info: (path: string, timeoutMs = 2500) => requestRaw<ServiceInfo>('GET', path, undefined, { timeoutMs }),
};
