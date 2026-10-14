import type { FastifyBaseLogger } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { internalHeaders, internalTokenMatches, requireInternal } from '../src/internal.js';
import { createServer } from '../src/server.js';

const TOKEN = 'test-internal-token-0123456789';

function makeApp(token: string, log?: FastifyBaseLogger) {
  const { app } = createServer({ ...loadConfig('test'), logLevel: 'silent' }, { infoPrefixes: [] });
  app.get('/internal/ping', { preHandler: requireInternal(token, log) }, async () => ({ ok: true }));
  return app;
}

describe('requireInternal', () => {
  const apps: ReturnType<typeof makeApp>[] = [];
  const build = (token: string, log?: FastifyBaseLogger) => {
    const app = makeApp(token, log);
    apps.push(app);
    return app;
  };
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('accepts the configured token', async () => {
    const res = await build(TOKEN).inject({ url: '/internal/ping', headers: { 'x-internal-token': TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('rejects a missing or wrong token with 403 FORBIDDEN', async () => {
    const app = build(TOKEN);
    const missing = await app.inject({ url: '/internal/ping' });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
    const wrong = await app.inject({ url: '/internal/ping', headers: { 'x-internal-token': TOKEN.replace(/9$/, '8') } });
    expect(wrong.statusCode).toBe(403);
    const short = await app.inject({ url: '/internal/ping', headers: { 'x-internal-token': 'test' } });
    expect(short.statusCode).toBe(403);
  });

  it('allows every call and warns once when no token is configured', async () => {
    const warn = vi.fn();
    const log = { warn } as unknown as FastifyBaseLogger;
    const app = build('', log);
    requireInternal('', log);
    expect(warn).toHaveBeenCalledTimes(1);
    const res = await app.inject({ url: '/internal/ping' });
    expect(res.statusCode).toBe(200);
  });
});

describe('internal token helpers', () => {
  it('compares tokens exactly', () => {
    expect(internalTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(internalTokenMatches(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(internalTokenMatches(TOKEN, [TOKEN])).toBe(false);
    expect(internalTokenMatches(TOKEN, undefined)).toBe(false);
    expect(internalTokenMatches('', '')).toBe(false);
  });

  it('builds headers only when a token is configured', () => {
    expect(internalHeaders(TOKEN)).toEqual({ 'x-internal-token': TOKEN });
    expect(internalHeaders('')).toEqual({});
  });
});
