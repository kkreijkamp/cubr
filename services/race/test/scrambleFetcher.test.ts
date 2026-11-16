// makeScrambleFetcher against a stand-in scramble-service on a local port: rounds take their
// scramble from the service (with the internal token), fall back to a local random-move scramble
// when it fails, and skip it for a cooldown afterwards (the small circuit breaker).
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeScrambleFetcher } from '../src/scramble.js';

const TOKEN = 'race-internal-token-0123456789';

describe('makeScrambleFetcher', () => {
  let server: Server;
  let baseUrl: string;
  let requests: { url: string; headers: IncomingHttpHeaders }[] = [];
  /** what the stand-in service answers next */
  let answer: { status: number; body: string } = { status: 200, body: '{}' };
  const log = { warn: vi.fn() } as unknown as FastifyBaseLogger;

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push({ url: req.url ?? '', headers: req.headers });
      res.writeHead(answer.status, { 'content-type': 'application/json' }).end(answer.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    requests = [];
    answer = { status: 200, body: JSON.stringify({ scrambles: ["  R U R' U'  "] }) };
  });

  it('asks scramble-service for one scramble of the event, with the internal token, and trims it', async () => {
    const fetcher = makeScrambleFetcher(baseUrl, log, 15_000, TOKEN);
    expect(await fetcher.get('333oh')).toEqual({ scramble: "R U R' U'", source: 'scramble-service' });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/api/scrambles/333oh?count=1');
    expect(requests[0].headers['x-internal-token']).toBe(TOKEN);
  });

  it('sends no internal token header when none is configured', async () => {
    await makeScrambleFetcher(baseUrl, log).get('222');
    expect(requests[0].headers).not.toHaveProperty('x-internal-token');
  });

  it.each([
    ['an empty list', 200, { scrambles: [] }],
    ['a number', 200, { scrambles: [42] }],
    ['a blank scramble', 200, { scrambles: ['   '] }],
    ['an absurdly long scramble', 200, { scrambles: ['R '.repeat(1001)] }],
    ['no scrambles field', 200, { event: '333' }],
    ['not JSON', 200, 'R U R'],
    ['a 404', 404, { error: { code: 'NOT_FOUND', message: 'Unknown event' } }],
    ['a 503', 503, { error: { code: 'UNAVAILABLE', message: 'busy' } }],
  ])('falls back to a local scramble when the service answers %s', async (_what, status, body) => {
    answer = { status, body: typeof body === 'string' ? body : JSON.stringify(body) };
    const res = await makeScrambleFetcher(baseUrl, log, 15_000, TOKEN).get('333');
    expect(res.source).toBe('fallback');
    expect(res.scramble.split(' ')).toHaveLength(25); // a 3x3 random-move scramble
  });

  it('falls back when the service is unreachable', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const res = await makeScrambleFetcher(url, log).get('sq1');
    expect(res.source).toBe('fallback');
    expect(res.scramble.match(/\//g)).toHaveLength(12);
  });

  describe('after a failure', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('skips the service for the cooldown, then tries it again', async () => {
      const fetcher = makeScrambleFetcher(baseUrl, log, 15_000, TOKEN);
      answer = { status: 500, body: '{}' };
      expect((await fetcher.get('333')).source).toBe('fallback');
      const asked = requests.length; // the first attempt and its retry
      expect(asked).toBe(2);

      answer = { status: 200, body: JSON.stringify({ scrambles: ['F2 B2'] }) };
      vi.setSystemTime(Date.now() + 14_000);
      expect((await fetcher.get('333')).source).toBe('fallback'); // still cooling down: no request at all
      expect(requests).toHaveLength(asked);

      vi.setSystemTime(Date.now() + 1_000);
      expect(await fetcher.get('333')).toEqual({ scramble: 'F2 B2', source: 'scramble-service' });
      expect(requests).toHaveLength(asked + 1);
    });
  });
});
