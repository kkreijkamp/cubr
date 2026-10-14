import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request } from '../api';

const respond = (body: string, init: ResponseInit = {}) => vi.fn(async () => new Response(body, init));

// a fetch that never answers but honours its abort signal, like the real one
const hanging = vi.fn(
  (_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }),
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request', () => {
  it('returns the parsed JSON body', async () => {
    vi.stubGlobal('fetch', respond('{"ok":true}', { status: 200 }));
    await expect(request('GET', '/api/x')).resolves.toEqual({ ok: true });
  });

  it('turns the error envelope into an ApiError', async () => {
    vi.stubGlobal('fetch', respond('{"error":{"code":"NOT_FOUND","message":"no such user"}}', { status: 404 }));
    await expect(request('GET', '/api/x')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'no such user' });
  });

  it('rejects a 2xx body that is not JSON (e.g. the SPA index.html)', async () => {
    vi.stubGlobal('fetch', respond('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(request('GET', '/api/nope')).rejects.toMatchObject({ status: 200, code: 'BAD_RESPONSE' });
  });

  it('reports network failures as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const err = await request('GET', '/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'NETWORK', isUnavailable: true });
  });

  it('reports a timeout as a timeout', async () => {
    vi.stubGlobal('fetch', hanging);
    const err = await request('GET', '/api/x', undefined, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'TIMEOUT', isUnavailable: true });
  });

  it('keeps the timeout when the caller passes its own signal', async () => {
    vi.stubGlobal('fetch', hanging);
    const ctrl = new AbortController();
    const err = await request('GET', '/api/x', undefined, { signal: ctrl.signal, timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'TIMEOUT' });
  });

  it('combines the signals without AbortSignal.any too (older browsers)', async () => {
    vi.stubGlobal('fetch', hanging);
    const any = AbortSignal.any;
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true, writable: true });
    try {
      const err = await request('GET', '/api/x', undefined, { signal: new AbortController().signal, timeoutMs: 20 }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'TIMEOUT' });
    } finally {
      Object.defineProperty(AbortSignal, 'any', { value: any, configurable: true, writable: true });
    }
  });

  it('passes an abort by the caller through unchanged', async () => {
    vi.stubGlobal('fetch', hanging);
    const ctrl = new AbortController();
    const pending = request('GET', '/api/x', undefined, { signal: ctrl.signal, timeoutMs: 5000 }).catch((e: unknown) => e);
    ctrl.abort();
    const err = await pending;
    expect(err).not.toBeInstanceOf(ApiError);
    expect((err as Error).name).toBe('AbortError');
  });
});
