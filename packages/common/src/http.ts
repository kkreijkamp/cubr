import { HttpError, unavailable } from './errors.js';

export interface FetchOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** retries on network errors / 5xx (not on 4xx) */
  retries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Service-to-service JSON call with timeout + retry/backoff. 4xx responses are re-thrown as HttpError. */
export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
        headers: {
          ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...opts.headers,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (res.status >= 500) throw new Error(`upstream status ${res.status}`);
      if (!res.ok) {
        throw new HttpError(res.status, json?.error?.code ?? 'INTERNAL', json?.error?.message ?? `upstream status ${res.status}`);
      }
      return json as T;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      lastErr = err;
      if (attempt < retries) await sleep(150 * 2 ** attempt);
    }
  }
  throw unavailable(`${new URL(url).host} unavailable: ${(lastErr as Error)?.message ?? 'unknown error'}`);
}
