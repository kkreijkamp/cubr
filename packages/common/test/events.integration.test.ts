// publishEvent / consumeEvents against a real Redis (@cubr/testkit): the domain-event stream,
// consumer groups, acknowledgements, the types filter, retries and the dead-letter stream,
// replicas sharing a group, taking over a dead consumer's entries, and stop().
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestRedis, describeIntegration } from '@cubr/testkit';
import { DLQ_STREAM, EVENT_STREAM, consumeEvents, publishEvent, type Consumer, type ConsumerOptions, type EventEnvelope } from '../src/events.js';
import type { Redis } from '../src/redis.js';

const attemptsKey = (group: string) => `${EVENT_STREAM}:attempts:${group}`;
/** vi.waitFor with room for a busy CI machine (the consumers poll Redis every 50 ms). */
const settle = <T>(check: () => T | Promise<T>): Promise<T> => vi.waitFor(check, { timeout: 4000, interval: 10 });
/** Stream entry fields [k1, v1, k2, v2...] as an object. */
const fields = (raw: string[]) => Object.fromEntries(raw.flatMap((v, i) => (i % 2 ? [] : [[v, raw[i + 1]]])));

describeIntegration('domain event stream', () => {
  let redis: Redis;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
  const consumers: Consumer[] = [];

  /** A consumer that polls every 50 ms (so the tests react fast); stopped after each test. */
  function consume(opts: Partial<ConsumerOptions> & Pick<ConsumerOptions, 'group' | 'handler'>): Consumer {
    const c = consumeEvents(redis, { consumer: `${opts.group}-1`, log, blockMs: 50, ...opts });
    consumers.push(c);
    return c;
  }
  async function pending(group: string): Promise<number> {
    const [count] = (await redis.xpending(EVENT_STREAM, group)) as [number];
    return count;
  }
  async function group(name: string): Promise<Record<string, unknown> | undefined> {
    const raw = (await redis.xinfo('GROUPS', EVENT_STREAM).catch(() => [])) as unknown[][];
    return raw.map((g) => fields(g as string[])).find((g) => g.name === name);
  }

  beforeAll(async () => {
    redis = await createTestRedis();
  });
  beforeEach(async () => {
    const leftovers = await redis.keys(`${EVENT_STREAM}*`);
    if (leftovers.length) await redis.del(...leftovers);
  });
  afterEach(async () => {
    await Promise.all(consumers.splice(0).map((c) => c.stop()));
    vi.useRealTimers();
  });
  afterAll(() => {
    redis?.disconnect();
  });

  it('appends an event with its type and JSON data, adding an eventId and occurredAt unless given', async () => {
    const first = await publishEvent(redis, 'solve.created', { userId: 'u1', timeMs: 9120 });
    const second = await publishEvent(redis, 'user.deleted', { userId: 'u2', eventId: 'auth-fixed', occurredAt: '2026-01-02T03:04:05.000Z' });
    const entries = await redis.xrange(EVENT_STREAM, '-', '+');
    expect(entries.map(([id]) => id)).toEqual([first, second]);
    expect(entries[0][1].filter((_, i) => i % 2 === 0)).toEqual(['type', 'data']);
    const a = fields(entries[0][1]);
    expect(a.type).toBe('solve.created');
    const data = JSON.parse(a.data);
    expect(data).toEqual({ userId: 'u1', timeMs: 9120, eventId: expect.stringMatching(/^evt-[0-9a-f-]{36}$/), occurredAt: expect.any(String) });
    expect(Math.abs(Date.parse(data.occurredAt) - Date.now())).toBeLessThan(60_000);
    expect(JSON.parse(fields(entries[1][1]).data)).toEqual({ userId: 'u2', eventId: 'auth-fixed', occurredAt: '2026-01-02T03:04:05.000Z' });
  });

  it('starts a new group at the retained history by default, or at new events only; each group sees every event', async () => {
    await publishEvent(redis, 'old', { n: 1 });
    await publishEvent(redis, 'old', { n: 2 });
    const all: EventEnvelope[] = [];
    const fresh: EventEnvelope[] = [];
    consume({ group: 'history', handler: async (e) => void all.push(e) });
    consume({ group: 'fresh', startFrom: '$', handler: async (e) => void fresh.push(e) });
    await settle(async () => expect(await group('fresh')).toBeDefined());

    await publishEvent(redis, 'new', { n: 3 });
    await settle(() => expect(all.map((e) => e.data.n)).toEqual([1, 2, 3]));
    await settle(() => expect(fresh.map((e) => e.data.n)).toEqual([3]));
    expect(all[0]).toEqual({ id: expect.stringMatching(/^\d+-\d+$/), type: 'old', data: expect.objectContaining({ n: 1, eventId: expect.any(String) }) });
  });

  it('acknowledges handled events, and acknowledges without handling the types it does not want', async () => {
    const seen: string[] = [];
    const c = consume({ group: 'filter', types: ['solve.created'], handler: async (e) => void seen.push(e.type) });
    await publishEvent(redis, 'solve.created', { n: 1 });
    await publishEvent(redis, 'user.updated', { n: 2 });
    const last = await publishEvent(redis, 'solve.created', { n: 3 });
    await settle(async () => {
      expect(seen).toEqual(['solve.created', 'solve.created']);
      expect((await group('filter'))?.['last-delivered-id']).toBe(last);
      expect(await pending('filter')).toBe(0);
    });
    expect(c.stats()).toEqual({ processed: 2, failed: 0, lastEventAt: expect.any(String) });
  });

  it('skips, and acknowledges, entries that are not valid events', async () => {
    const seen: string[] = [];
    consume({ group: 'robust', handler: async (e) => void seen.push(e.type) });
    await redis.xadd(EVENT_STREAM, '*', 'type', 'no.data');
    await redis.xadd(EVENT_STREAM, '*', 'type', 'bad.json', 'data', '{nope');
    await redis.xadd(EVENT_STREAM, '*', 'data', '{}');
    await publishEvent(redis, 'fine', {});
    await settle(async () => {
      expect(seen).toEqual(['fine']);
      expect(await pending('robust')).toBe(0);
    });
  });

  it('retries a failing event and moves it to the dead-letter stream after the last attempt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); // the reclaim pass that retries runs at most every 15 s
    const tries: string[] = [];
    const c = consume({
      group: 'poison',
      maxAttempts: 3,
      claimIdleMs: 0,
      handler: async (e) => {
        tries.push(e.id);
        throw new Error(`cannot handle ${e.type}`);
      },
    });
    const id = await publishEvent(redis, 'bad.event', { userId: 'u9' });
    await settle(async () => expect(await redis.hget(attemptsKey('poison'), id)).toBe('1'));
    expect(await pending('poison')).toBe(1); // not acknowledged, so it can be retried

    for (const n of [2, 3]) {
      vi.setSystemTime(Date.now() + 15_001);
      await settle(() => expect(tries).toHaveLength(n));
    }
    await settle(async () => expect(await pending('poison')).toBe(0));
    const dlq = await redis.xrange(DLQ_STREAM, '-', '+');
    expect(dlq).toHaveLength(1);
    const dead = fields(dlq[0][1]);
    expect(dead).toEqual({ group: 'poison', type: 'bad.event', data: expect.any(String), error: 'cannot handle bad.event' });
    expect(JSON.parse(dead.data)).toMatchObject({ userId: 'u9' });
    expect(await redis.hexists(attemptsKey('poison'), id)).toBe(0);
    expect(tries).toEqual([id, id, id]);
    expect(c.stats()).toMatchObject({ processed: 0, failed: 3 });
  });

  it('forgets the failed attempts of an event once a retry succeeds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let failNext = true;
    const handled: string[] = [];
    consume({
      group: 'flaky',
      claimIdleMs: 0,
      handler: async (e) => {
        if (failNext) {
          failNext = false;
          throw new Error('database down');
        }
        handled.push(e.id);
      },
    });
    const id = await publishEvent(redis, 'job', {});
    await settle(async () => expect(await redis.hget(attemptsKey('flaky'), id)).toBe('1'));
    vi.setSystemTime(Date.now() + 15_001);
    await settle(() => expect(handled).toEqual([id]));
    await settle(async () => {
      expect(await pending('flaky')).toBe(0);
      expect(await redis.hexists(attemptsKey('flaky'), id)).toBe(0);
    });
    expect(await redis.exists(DLQ_STREAM)).toBe(0);
  });

  it('gives each event to one consumer of a group, so replicas share the work', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const got: Record<string, number[]> = { 'pod-1': [], 'pod-2': [] };
    for (const consumer of Object.keys(got)) {
      consume({
        group: 'shared',
        consumer,
        batchSize: 1,
        handler: async (e) => {
          got[consumer].push(e.data.n);
          await gate;
        },
      });
    }
    const total = () => got['pod-1'].length + got['pod-2'].length;
    await publishEvent(redis, 'job', { n: 1 });
    await settle(() => expect(total()).toBe(1));
    await publishEvent(redis, 'job', { n: 2 }); // the consumer holding n=1 is busy, so the other one takes it
    await settle(() => expect(total()).toBe(2));
    expect(got['pod-1']).toHaveLength(1);
    expect(got['pod-2']).toHaveLength(1);

    release();
    for (let n = 3; n <= 12; n++) await publishEvent(redis, 'job', { n });
    await settle(async () => {
      expect([...got['pod-1'], ...got['pod-2']].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      expect(await pending('shared')).toBe(0);
    });
  });

  it('takes over the events a dead consumer left pending once they have been idle long enough', async () => {
    await redis.xgroup('CREATE', EVENT_STREAM, 'rescue', '$', 'MKSTREAM');
    const lost = await publishEvent(redis, 'job', { n: 1 });
    const inProgress = await publishEvent(redis, 'job', { n: 2 });
    await redis.xreadgroup('GROUP', 'rescue', 'dead-pod', 'COUNT', 10, 'STREAMS', EVENT_STREAM, '>');
    await redis.xclaim(EVENT_STREAM, 'rescue', 'dead-pod', 0, lost, 'IDLE', 120_000); // untouched for 2 minutes
    await redis.xclaim(EVENT_STREAM, 'rescue', 'busy-pod', 0, inProgress, 'IDLE', 1_000); // a live pod is on it

    const handled: string[] = [];
    consume({ group: 'rescue', consumer: 'new-pod', handler: async (e) => void handled.push(e.id) }); // reclaims after 60 s idle
    await settle(() => expect(handled).toEqual([lost]));
    const left = (await redis.xpending(EVENT_STREAM, 'rescue', '-', '+', 10)) as [string, string][];
    expect(left.map(([id, consumer]) => [id, consumer])).toEqual([[inProgress, 'busy-pod']]);
  });

  it('re-creates its group after Redis lost the stream, and carries on', async () => {
    const seen: number[] = [];
    consume({ group: 'phoenix', handler: async (e) => void seen.push(e.data.n) });
    await publishEvent(redis, 'job', { n: 1 });
    await settle(() => expect(seen).toEqual([1]));
    await redis.del(EVENT_STREAM); // stream and group gone, e.g. a restart without persistence
    await publishEvent(redis, 'job', { n: 2 });
    await vi.waitFor(() => expect(seen).toEqual([1, 2]), { timeout: 5000, interval: 50 });
  });

  it('stops once the event in hand is handled and acknowledged, and reads nothing after', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const handled: number[] = [];
    const c = consumeEvents(redis, {
      group: 'stopper',
      consumer: 'stopper-1',
      log,
      blockMs: 50,
      handler: async (e) => {
        await gate;
        handled.push(e.data.n);
      },
    });
    const first = await publishEvent(redis, 'job', { n: 1 });
    await settle(async () => expect(await pending('stopper')).toBe(1)); // inside the handler
    const stopping = c.stop();
    release();
    await stopping;
    expect(handled).toEqual([1]);
    expect(await pending('stopper')).toBe(0);

    await publishEvent(redis, 'job', { n: 2 });
    expect((await group('stopper'))?.['last-delivered-id']).toBe(first);
    expect(handled).toEqual([1]);
  });
});
