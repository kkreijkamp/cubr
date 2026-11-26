// publishEvent / consumeEvents against a real Redis (@cubr/testkit): the domain-event stream,
// consumer groups, acknowledgements, the types filter, retries spaced out per entry and the
// dead-letter stream, replicas sharing a group, taking over a dead consumer's entries, draining a
// backlog, replayed dead letters, and stop().
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestRedis, describeIntegration } from '@cubr/testkit';
import { DLQ_STREAM, EVENT_STREAM, consumeEvents, publishEvent, type Consumer, type ConsumerOptions, type EventEnvelope } from '../src/events.js';
import type { Redis } from '../src/redis.js';

const attemptsKey = (group: string) => `${EVENT_STREAM}:attempts:${group}`;
/** fake Date: a reclaim pass (the retries) runs at most every 15 s */
const nextPass = () => vi.setSystemTime(Date.now() + 15_001);
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
  /** The retry state of a failed entry: failures, first failure and next try (ms). */
  async function retry(group: string, id: string): Promise<{ n: number; first: number; next: number } | null> {
    const raw = await redis.hget(attemptsKey(group), id);
    return raw ? JSON.parse(raw) : null;
  }
  /** How many times the group's pending entry has been delivered (each reclaim counts). */
  async function deliveries(group: string, id: string): Promise<number> {
    const rows = (await redis.xpending(EVENT_STREAM, group, id, id, 1)) as [string, string, number, number][];
    return rows[0]?.[3] ?? 0;
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

  it('skips, acknowledges and logs entries that are not valid events', async () => {
    const seen: string[] = [];
    consume({ group: 'robust', handler: async (e) => void seen.push(e.type) });
    const noData = await redis.xadd(EVENT_STREAM, '*', 'type', 'no.data');
    await redis.xadd(EVENT_STREAM, '*', 'type', 'bad.json', 'data', '{nope');
    await redis.xadd(EVENT_STREAM, '*', 'data', '{}');
    await publishEvent(redis, 'fine', {});
    await settle(async () => {
      expect(seen).toEqual(['fine']);
      expect(await pending('robust')).toBe(0);
    });
    expect(log.warn).toHaveBeenCalledWith({ id: noData, group: 'robust' }, 'malformed event entry acknowledged and skipped');
  });

  it('retries a failing event and moves it to the dead-letter stream after the last attempt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const tries: string[] = [];
    const c = consume({
      group: 'poison',
      maxAttempts: 3,
      claimIdleMs: 0,
      retryMs: 0,
      deadLetterAfterMs: 0,
      handler: async (e) => {
        tries.push(e.id);
        throw new Error(`cannot handle ${e.type}`);
      },
    });
    const id = await publishEvent(redis, 'bad.event', { userId: 'u9' });
    await settle(async () => expect(await retry('poison', id)).toMatchObject({ n: 1 }));
    expect(await pending('poison')).toBe(1); // not acknowledged, so it can be retried

    for (const n of [2, 3]) {
      nextPass();
      await settle(() => expect(tries).toHaveLength(n));
    }
    await settle(async () => expect(await pending('poison')).toBe(0));
    const dlq = await redis.xrange(DLQ_STREAM, '-', '+');
    expect(dlq).toHaveLength(1);
    const dead = fields(dlq[0][1]);
    expect(dead).toEqual({
      group: 'poison',
      type: 'bad.event',
      data: expect.any(String),
      error: 'cannot handle bad.event',
      attempts: '3',
      firstFailedAt: expect.any(String),
    });
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
      retryMs: 0,
      handler: async (e) => {
        if (failNext) {
          failNext = false;
          throw new Error('database down');
        }
        handled.push(e.id);
      },
    });
    const id = await publishEvent(redis, 'job', {});
    await settle(async () => expect(await retry('flaky', id)).toMatchObject({ n: 1 }));
    nextPass();
    await settle(() => expect(handled).toEqual([id]));
    await settle(async () => {
      expect(await pending('flaky')).toBe(0);
      expect(await redis.hexists(attemptsKey('flaky'), id)).toBe(0);
    });
    expect(await redis.exists(DLQ_STREAM)).toBe(0);
  });

  it('spaces out the retries of a failing event, doubling, and dead-letters it only once the first failure is old enough', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); // (settle moves the fake clock 10 ms per check, so times are read, not fixed)
    const tries: number[] = [];
    consume({
      group: 'patient',
      claimIdleMs: 0,
      retryMs: 20_000,
      maxRetryMs: 40_000,
      maxAttempts: 2,
      deadLetterAfterMs: 50_000,
      handler: async () => {
        tries.push(Date.now());
        throw new Error('stats is down');
      },
    });
    const id = await publishEvent(redis, 'job', {});
    await settle(async () => expect(await retry('patient', id)).toMatchObject({ n: 1 }));
    expect(await retry('patient', id)).toEqual({ n: 1, first: tries[0], next: tries[0] + 20_000 });
    /** a pass that reclaims the entry and leaves it: its next try isn't due */
    const passWithoutTry = async (delivered: number) => {
      const before = tries.length;
      nextPass();
      await settle(async () => expect(await deliveries('patient', id)).toBe(delivered));
      await new Promise((r) => setTimeout(r, 100)); // (real time) a try would have happened by now
      expect(tries).toHaveLength(before);
    };
    await passWithoutTry(2); // 15 s
    nextPass(); // 30 s: due; two failures, but the first only 30 s ago, so it waits twice as long (40 s, the cap)
    await settle(async () => expect(await retry('patient', id)).toMatchObject({ n: 2 }));
    expect(await retry('patient', id)).toEqual({ n: 2, first: tries[0], next: tries[1] + 40_000 });
    expect(tries[1] - tries[0]).toBeGreaterThanOrEqual(20_000);
    await passWithoutTry(4); // 45 s
    await passWithoutTry(5); // 60 s
    expect(await redis.exists(DLQ_STREAM)).toBe(0);
    nextPass(); // 75 s: due, fails a third time, and the first failure is over 50 s old
    await settle(async () => expect(await pending('patient')).toBe(0));
    expect(tries).toHaveLength(3);
    expect(tries[2] - tries[1]).toBeGreaterThanOrEqual(40_000);
    const dlq = await redis.xrange(DLQ_STREAM, '-', '+');
    expect(dlq.map(([, f]) => fields(f))).toEqual([
      expect.objectContaining({ group: 'patient', attempts: '3', firstFailedAt: new Date(tries[0]).toISOString() }),
    ]);
    expect(await redis.hexists(attemptsKey('patient'), id)).toBe(0);
  });

  it('clears the retry state of an event whichever replica handles it in the end', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const failing = consume({ group: 'relay', consumer: 'pod-a', claimIdleMs: 0, retryMs: 0, handler: async () => Promise.reject(new Error('down')) });
    const id = await publishEvent(redis, 'job', {});
    await settle(async () => expect(await retry('relay', id)).toMatchObject({ n: 1 }));
    await failing.stop();
    const handled: string[] = [];
    consume({ group: 'relay', consumer: 'pod-b', claimIdleMs: 0, retryMs: 0, handler: async (e) => void handled.push(e.id) });
    await settle(() => expect(handled).toEqual([id]));
    await settle(async () => {
      expect(await pending('relay')).toBe(0);
      expect(await redis.hexists(attemptsKey('relay'), id)).toBe(0);
    });
  });

  it('drains a backlog of pending events batch after batch, not one batch per pass', async () => {
    await redis.xgroup('CREATE', EVENT_STREAM, 'backlog', '$', 'MKSTREAM');
    for (let n = 1; n <= 7; n++) await publishEvent(redis, 'job', { n });
    await redis.xreadgroup('GROUP', 'backlog', 'dead-pod', 'COUNT', 10, 'STREAMS', EVENT_STREAM, '>'); // a replica that died with them
    const handled: number[] = [];
    consume({ group: 'backlog', consumer: 'new-pod', claimIdleMs: 0, batchSize: 2, handler: async (e) => void handled.push(e.data.n) });
    // real time: the next pass would be 15 s away, past settle's 4 s
    await settle(async () => {
      expect([...handled].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(await pending('backlog')).toBe(0);
    });
  });

  it('leaves a replayed dead letter to the group it is for', async () => {
    const mine: string[] = [];
    const theirs: string[] = [];
    consume({ group: 'mine', handler: async (e) => void mine.push(e.type) });
    consume({ group: 'theirs', handler: async (e) => void theirs.push(e.type) });
    await settle(async () => expect(await group('theirs')).toBeDefined());
    await redis.xadd(EVENT_STREAM, '*', 'type', 'replayed', 'data', JSON.stringify({ eventId: 'e1', occurredAt: '2026-11-26T00:00:00.000Z' }), 'group', 'mine');
    await publishEvent(redis, 'everyone', {});
    await settle(async () => {
      expect(mine).toEqual(['replayed', 'everyone']);
      expect(theirs).toEqual(['everyone']);
      expect(await pending('theirs')).toBe(0);
    });
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

  it('stops between the entries of a batch: the rest stays pending, for whoever reads next', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const handled: number[] = [];
    await redis.xgroup('CREATE', EVENT_STREAM, 'halt', '$', 'MKSTREAM');
    for (let n = 1; n <= 3; n++) await publishEvent(redis, 'job', { n });
    const c = consumeEvents(redis, {
      group: 'halt',
      consumer: 'halt-1',
      log,
      blockMs: 50,
      handler: async (e) => {
        if (e.data.n === 1) await gate;
        handled.push(e.data.n);
      },
    });
    await settle(async () => expect(await pending('halt')).toBe(3)); // one batch, the first entry in the handler
    const stopping = c.stop();
    release();
    await stopping;
    expect(handled).toEqual([1]);
    expect(await pending('halt')).toBe(2);
  });
});
