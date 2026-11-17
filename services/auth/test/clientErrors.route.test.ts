// What POST /api/errors writes to the log: the scrubbed report, and nothing that ties it to the visitor
// (no request lines, which carry the IP address). A bare Fastify app with a capturing logger and an
// in-memory stand-in for the Redis rate limit; the real stack is in api.integration.test.ts.
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Deps } from '../src/routes/index.js';
import { registerClientErrorRoutes } from '../src/routes/clientErrors.js';

/** Just enough of ioredis for rateLimit(): MULTI INCRBY EXPIRE EXEC, counted in memory. */
function fakeRedis() {
  const counts = new Map<string, number>();
  return {
    multi() {
      let key = '';
      let by = 0;
      const chain = {
        incrby(k: string, n: number) {
          key = k;
          by = n;
          return chain;
        },
        expire() {
          return chain;
        },
        async exec() {
          counts.set(key, (counts.get(key) ?? 0) + by);
          return [[null, counts.get(key)]];
        },
      };
      return chain;
    },
  };
}

async function app() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      for (const line of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(line));
      done();
    },
  });
  const a = Fastify({ logger: { level: 'info', stream }, trustProxy: true });
  await registerClientErrorRoutes(a, { config: { logLevel: 'info' }, redis: fakeRedis() } as unknown as Deps);
  await a.ready();
  return { a, lines };
}

const IP = '203.0.113.77';
const report = {
  kind: 'error',
  message: 'boom for jo@example.com',
  stack: 'Error: boom\n    at x (https://cubr.dev/assets/index-D3oOLUDV.js:1:2)',
  source: 'https://cubr.dev/assets/index-D3oOLUDV.js:1:2',
  route: '/profile/:username',
  build: 'index-D3oOLUDV.js',
  browser: 'Firefox 145 on Windows',
  installed: false,
};

describe('POST /api/errors logging', () => {
  it('logs one "client error" line with the scrubbed report, and no request lines or IP address', async () => {
    const { a, lines } = await app();
    const res = await a.inject({ method: 'POST', url: '/api/errors', payload: report, headers: { 'x-forwarded-for': IP } });
    expect(res.statusCode).toBe(204);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 40, msg: 'client error', clientError: { ...report, message: 'boom for <email>' } });
    expect(JSON.stringify(lines)).not.toContain(IP);
    expect(JSON.stringify(lines)).not.toContain('incoming request');
    await a.close();
  });

  it('logs nothing for a refused report', async () => {
    const { a, lines } = await app();
    expect((await a.inject({ method: 'POST', url: '/api/errors', payload: { ...report, kind: 'nope' }, headers: { 'x-forwarded-for': IP } })).statusCode).toBe(400);
    expect(lines).toHaveLength(0);
    await a.close();
  });

  it('stops one address after 30 reports in 10 minutes', async () => {
    const { a, lines } = await app();
    const post = () => a.inject({ method: 'POST', url: '/api/errors', payload: report, headers: { 'x-forwarded-for': IP } });
    for (let i = 0; i < 30; i++) expect((await post()).statusCode).toBe(204);
    expect((await post()).statusCode).toBe(429);
    expect(lines).toHaveLength(30);
    // another address still gets through
    expect((await a.inject({ method: 'POST', url: '/api/errors', payload: report, headers: { 'x-forwarded-for': '198.51.100.9' } })).statusCode).toBe(204);
    await a.close();
  });
});
