// Thin typed client for every cubetype microservice. All calls are same-origin paths that the
// Ingress (cloud) or gateway (local) routes to the right service — see docs/SPEC.md §3.
import type {
  PrivateUser,
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

export const api = {
  auth: {
    register: (body: { username: string; email: string; password: string }) =>
      request<{ token: string; user: PrivateUser }>('POST', '/api/auth/register', body),
    login: (body: { login: string; password: string }) => request<{ token: string; user: PrivateUser }>('POST', '/api/auth/login', body),
    logout: () => request<void>('POST', '/api/auth/logout'),
    me: (signal?: AbortSignal) => get<{ user: PrivateUser; settings: Record<string, unknown> }>('/api/auth/me', signal),
  },
  scrambles: {
    get: (event: string, count = 1) => get<{ event: string; scrambles: string[]; source: string }>(`/api/scrambles/${enc(event)}${qs({ count })}`),
  },
};
