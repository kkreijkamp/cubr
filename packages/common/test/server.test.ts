import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { PG_PING_TIMEOUT_MS, pingPostgres, type Pool } from '../src/db.js';
import { createServer, type ServerOptions } from '../src/server.js';

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
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not-ready', deps: { postgres: 'down', redis: 'ok' } });
  });

  it('answers _info within the deadline when the checks and the extra fields both hang', async () => {
    // before: checks (2 s) and then info() (unbounded) ran one after the other
    const app = build({ checks: { postgres: never }, info: never });
    const t0 = Date.now();
    const res = await app.inject({ url: '/api/test/_info' });
    expect(Date.now() - t0).toBeLessThan(2500);
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
