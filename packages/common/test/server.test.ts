import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { PG_PING_TIMEOUT_MS, pingPostgres, type Pool } from '../src/db.js';
import { createServer, SECURITY_HEADERS, type ServerOptions } from '../src/server.js';

const never = () => new Promise<never>(() => {});

describe('readiness and _info deadlines', () => {
  const apps: ReturnType<typeof createServer>['app'][] = [];
  const build = (opts: Omit<ServerOptions, 'infoPrefixes'>) => {
    const { app } = createServer({ ...loadConfig('test'), logLevel: 'silent' }, { infoPrefixes: ['/api/test'], ...opts });
    apps.push(app);
    return app;
  };
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('reports a hanging check as down instead of hanging the probe', async () => {
    const app = build({ checks: { postgres: never, redis: async () => 'PONG' } });
    const t0 = Date.now();
    const res = await app.inject({ url: '/readyz' });
    expect(Date.now() - t0).toBeLessThan(4000); // the 2 s deadline, not the never-answering check (room for a loaded CI runner)
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not-ready', deps: { postgres: 'down', redis: 'ok' } });
  });

  it('answers _info within the deadline when the checks and the extra fields both hang', async () => {
    // before: checks (2 s) and then info() (unbounded) ran one after the other
    const app = build({ checks: { postgres: never }, info: never });
    const t0 = Date.now();
    const res = await app.inject({ url: '/api/test/_info' });
    expect(Date.now() - t0).toBeLessThan(4000); // the 2 s deadline, not the never-answering check (room for a loaded CI runner)
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ service: 'test', deps: { postgres: 'down' } });
  });

  it('merges the extra fields when they answer in time', async () => {
    const app = build({ checks: { postgres: async () => 1 }, info: async () => ({ backlog: 3 }) });
    const res = await app.inject({ url: '/api/test/_info' });
    expect(res.json()).toMatchObject({ deps: { postgres: 'ok' }, backlog: 3 });
  });

  it('leaves the extra fields out when they throw', async () => {
    const app = build({ info: () => Promise.reject(new Error('relation does not exist')) });
    const res = await app.inject({ url: '/api/test/_info' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ service: 'test', deps: {} });
  });
});

describe('pingPostgres', () => {
  it('sends select 1 with a client-side timeout that expires before the check deadline', async () => {
    const query = vi.fn(async () => ({ rows: [{ '?column?': 1 }] }));
    await pingPostgres({ query } as unknown as Pool);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ text: 'select 1', query_timeout: PG_PING_TIMEOUT_MS }));
    expect(PG_PING_TIMEOUT_MS).toBeLessThan(2000);
  });
});

describe('security headers', () => {
  const { app } = createServer({ ...loadConfig('test'), logLevel: 'silent' }, { infoPrefixes: ['/api/test'] });
  app.get('/api/test/thing', async () => ({ ok: true }));
  app.get('/api/test/boom', async () => {
    throw new Error('kaboom');
  });
  app.get('/api/test/picture', async (_req, reply) => reply.header('Content-Security-Policy', "default-src 'none'; sandbox").send('png'));
  afterAll(() => app.close());

  it('go on every answer: data, errors and unknown routes alike', async () => {
    for (const url of ['/api/test/thing', '/api/test/boom', '/api/test/nope', '/healthz', '/api/test/_info']) {
      const res = await app.inject({ url });
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers[name.toLowerCase()], `${url}: ${name}`).toBe(value);
    }
  });

  it("leave a route's own stricter value alone (the avatars' sandbox)", async () => {
    const res = await app.inject({ url: '/api/test/picture' });
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('let nothing the API sends run as a page, be framed or be sniffed', () => {
    expect(SECURITY_HEADERS['Content-Security-Policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
  });

  it("don't say which container or version answered (that's in _info and the logs)", async () => {
    const res = await app.inject({ url: '/api/test/thing' });
    expect(res.headers['x-served-by']).toBeUndefined();
    expect(res.headers['x-service']).toBeUndefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
    const info = await app.inject({ url: '/api/test/_info' });
    expect(info.json()).toMatchObject({ service: 'test', pod: expect.any(String), version: expect.any(String) });
  });
});
