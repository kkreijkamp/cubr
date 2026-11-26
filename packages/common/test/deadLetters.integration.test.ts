// listDeadLetters / replayDeadLetters / registerDeadLetterRoutes against a real Redis (@cubr/testkit):
// one group's dead letters listed, put back on the event stream for that group alone, and the routes
// deploy/vps/dead-letters.sh calls (internal token only).
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestRedis, describeIntegration } from '@cubr/testkit';
import { loadConfig } from '../src/config.js';
import { listDeadLetters, registerDeadLetterRoutes, replayDeadLetters } from '../src/deadLetters.js';
import { DLQ_STREAM, EVENT_STREAM, consumeEvents } from '../src/events.js';
import type { Redis } from '../src/redis.js';
import { createServer } from '../src/server.js';

const TOKEN = 'test-internal-token-0123456789';
const fields = (raw: string[]) => Object.fromEntries(raw.flatMap((v, i) => (i % 2 ? [] : [[v, raw[i + 1]]])));
const data = (eventId: string) => ({ eventId, occurredAt: '2026-11-26T00:00:00.000Z' });

describeIntegration('dead letters', () => {
  let redis: Redis;
  /** A dead letter as the consumer writes it (events.ts recordFailure). */
  const dead = (group: string, type: string, eventId: string, extra: string[] = []) =>
    redis.xadd(DLQ_STREAM, '*', 'group', group, 'type', type, 'data', JSON.stringify(data(eventId)), 'error', `cannot handle ${type}`, ...extra) as Promise<string>;

  beforeAll(async () => {
    redis = await createTestRedis();
  });
  beforeEach(async () => {
    const leftovers = await redis.keys(`${EVENT_STREAM}*`);
    if (leftovers.length) await redis.del(...leftovers);
  });
  afterAll(() => {
    redis?.disconnect();
  });

  it("lists one group's dead letters, oldest first", async () => {
    const a = await dead('stats', 'solve.created', 'e1', ['attempts', '7', 'firstFailedAt', '2026-11-25T00:00:00.000Z']);
    await dead('leaderboard', 'solve.created', 'e2');
    const b = await dead('stats', 'solve.deleted', 'e3'); // written before v1.6.27: no attempts or first failure
    expect(await listDeadLetters(redis, 'stats')).toEqual([
      {
        id: a,
        deadAt: new Date(Number(a.split('-')[0])).toISOString(),
        group: 'stats',
        type: 'solve.created',
        error: 'cannot handle solve.created',
        attempts: 7,
        firstFailedAt: '2026-11-25T00:00:00.000Z',
        data: data('e1'),
      },
      expect.objectContaining({ id: b, type: 'solve.deleted', attempts: null, firstFailedAt: null, data: data('e3') }),
    ]);
  });

  it("puts a group's dead letters back for that group alone, by id or all, and removes them", async () => {
    const a = await dead('stats', 'solve.created', 'e1');
    const other = await dead('leaderboard', 'solve.created', 'e2');
    const b = await dead('stats', 'solve.deleted', 'e3');
    expect(await replayDeadLetters(redis, 'stats', [b])).toEqual([b]);
    expect((await listDeadLetters(redis, 'stats')).map((l) => l.id)).toEqual([a]);
    expect(await replayDeadLetters(redis, 'stats')).toEqual([a]);
    expect(await listDeadLetters(redis, 'stats')).toEqual([]);
    expect((await listDeadLetters(redis, 'leaderboard')).map((l) => l.id)).toEqual([other]);
    expect((await redis.xrange(EVENT_STREAM, '-', '+')).map(([, f]) => fields(f))).toEqual([
      { type: 'solve.deleted', data: JSON.stringify(data('e3')), group: 'stats' },
      { type: 'solve.created', data: JSON.stringify(data('e1')), group: 'stats' },
    ]);
  });

  it("hands a replayed dead letter to its group's consumer, and to no other", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
    const seen: Record<string, string[]> = { stats: [], leaderboard: [] };
    for (const group of Object.keys(seen)) await redis.xgroup('CREATE', EVENT_STREAM, group, '$', 'MKSTREAM');
    const consumers = Object.keys(seen).map((group) =>
      consumeEvents(redis, { group, consumer: `${group}-1`, log, blockMs: 50, handler: async (e) => void seen[group].push(e.data.eventId) }),
    );
    try {
      await dead('stats', 'solve.created', 'e1');
      await replayDeadLetters(redis, 'stats');
      await vi.waitFor(() => expect(seen.stats).toEqual(['e1']), { timeout: 4000, interval: 10 });
      await vi.waitFor(async () => expect(((await redis.xpending(EVENT_STREAM, 'leaderboard')) as [number])[0]).toBe(0), { timeout: 4000, interval: 10 });
      expect(seen.leaderboard).toEqual([]);
    } finally {
      await Promise.all(consumers.map((c) => c.stop()));
    }
  });

  it('lists and replays over the internal routes, with the internal token only', async () => {
    const { app } = createServer({ ...loadConfig('test'), logLevel: 'silent' }, { infoPrefixes: [] });
    registerDeadLetterRoutes(app, { redis, group: 'stats', internalToken: TOKEN });
    try {
      const id = await dead('stats', 'solve.created', 'e1');
      const replay = '/internal/events/dead-letters/replay';
      expect((await app.inject({ url: '/internal/events/dead-letters' })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: replay, payload: {} })).statusCode).toBe(403);
      const headers = { 'x-internal-token': TOKEN };
      const list = await app.inject({ url: '/internal/events/dead-letters', headers });
      expect(list.json()).toEqual({ group: 'stats', deadLetters: [expect.objectContaining({ id, type: 'solve.created', data: data('e1') })] });
      expect((await app.inject({ method: 'POST', url: replay, headers, payload: { ids: ['e1'] } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: replay, headers, payload: { ids: [id] } })).json()).toEqual({ group: 'stats', replayed: [id] });
      expect(await redis.xlen(DLQ_STREAM)).toBe(0);
      expect((await app.inject({ method: 'POST', url: replay, headers })).json()).toEqual({ group: 'stats', replayed: [] }); // no body: all (none left)
    } finally {
      await app.close();
    }
  });
});
