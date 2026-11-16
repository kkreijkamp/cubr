// The pb.updated relay and the hourly cleanup (src/outbox.ts) against a real Postgres and Redis:
// events go out oldest first, a row is deleted only after its XADD succeeded, one replica relays at a
// time, backlogs larger than a batch drain completely, and processed_events entries older than 30
// days are pruned.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPool, EVENT_STREAM, withTx, type Redis } from '@cubr/common';
import { describeIntegration, startTestServer, type TestServer } from '@cubr/testkit';
import type { PbKind } from '../src/domain/pbs.js';
import { migrations } from '../src/migrations.js';
import { createPbRelay, startMaintenance } from '../src/outbox.js';
import { queuePbUpdated, type PbChange } from '../src/store.js';

/** The real client, except that its `failOn`-th XADD fails (Redis went away mid-batch). */
function failingXadd(redis: Redis, failOn: number): Redis {
  let calls = 0;
  return new Proxy(redis, {
    get(target, prop) {
      if (prop === 'xadd') {
        return (...args: unknown[]) =>
          ++calls === failOn ? Promise.reject(new Error('Connection is closed.')) : (target.xadd as (...a: unknown[]) => Promise<unknown>).apply(target, args);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describeIntegration('pb.updated outbox relay', () => {
  let s: TestServer;

  beforeAll(async () => {
    s = await startTestServer({ service: 'stats', infoPrefixes: [], schemas: [{ schema: 'stats', migrations }], routes: () => {} });
  });
  afterAll(async () => {
    await s?.close();
  });
  beforeEach(async () => {
    await s.pool.query('DELETE FROM stats.pb_outbox');
    await s.redis.del(EVENT_STREAM);
  });

  const userId = randomUUID();
  const change = (kind: PbKind, valueMs: number | null): PbChange => ({
    userId, username: 'relay_test', event: '333', kind, valueMs, previousMs: null, achievedAt: valueMs === null ? null : '2026-10-01T10:00:00.000Z',
  });
  const queue = (...changes: PbChange[]) => withTx(s.pool, async (c) => {
    for (const ch of changes) await queuePbUpdated(c, ch);
  });
  const outboxIds = async () =>
    (await s.pool.query<{ event_id: string }>(`SELECT payload->>'eventId' AS event_id FROM stats.pb_outbox ORDER BY id`)).rows.map((r) => r.event_id);
  const publishedIds = async () => (await s.events()).map((e) => e.data.eventId as string);
  const relay = (redis: Redis = s.redis) => createPbRelay(s.pool, redis, s.app.log);

  it('publishes queued changes oldest first as pb.updated and empties the outbox', async () => {
    const changes = [change('single', 10_000), change('ao5', 12_000), change('single', null)];
    await queue(...changes);
    const r = relay();
    expect(await r.pending()).toBe(3);
    expect(await r.flush()).toBe(3);
    const events = await s.events();
    expect(events.map((e) => e.type)).toEqual(['pb.updated', 'pb.updated', 'pb.updated']);
    expect(events.map((e) => e.data)).toEqual(
      changes.map((ch) => ({ ...ch, eventId: expect.stringMatching(/^stats-[0-9a-f-]{36}$/), occurredAt: expect.any(String) })),
    );
    expect(await r.pending()).toBe(0);
  });

  it('deletes only the rows that reached Redis, and republishes the rest later, in order and with the same eventIds', async () => {
    await queue(change('single', 10_000), change('mo3', 11_000), change('ao5', 12_000), change('ao12', 13_000));
    const queued = await outboxIds();
    expect(await relay(failingXadd(s.redis, 3)).flush()).toBe(2);
    expect(await publishedIds()).toEqual(queued.slice(0, 2));
    expect(await outboxIds()).toEqual(queued.slice(2));
    expect(await relay().flush()).toBe(2);
    expect(await publishedIds()).toEqual(queued);
    expect(await outboxIds()).toEqual([]);
  });

  it('drains a backlog larger than one batch completely and in order', async () => {
    await s.pool.query(`INSERT INTO stats.pb_outbox (payload) SELECT jsonb_build_object('eventId', 'stats-' || i, 'n', i) FROM generate_series(1, 1203) AS i`);
    expect(await relay().flush()).toBe(1203);
    expect((await s.events()).map((e) => e.data.n)).toEqual(Array.from({ length: 1203 }, (_, i) => i + 1));
    expect(await outboxIds()).toEqual([]);
  });

  it('waits while another replica holds the relay lock, and two replicas never publish a row twice', async () => {
    await queue(change('single', 10_000), change('ao5', 12_000), change('ao12', 13_000));
    const other = await s.pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT pg_advisory_xact_lock(hashtext($1), 0)', ['cubr:stats:pb-outbox']);
      expect(await relay().flush()).toBe(0);
      expect(await outboxIds()).toHaveLength(3);
    } finally {
      await other.query('COMMIT');
      other.release();
    }
    const [a, b] = await Promise.all([relay().flush(), relay().flush()]);
    expect(a + b).toBe(3);
    const published = await publishedIds();
    expect(published).toHaveLength(3);
    expect(new Set(published).size).toBe(3);
  });

  it('keeps relaying in the background until stopped', async () => {
    const r = createPbRelay(s.pool, s.redis, s.app.log, 20);
    r.start();
    try {
      await queue(change('single', 9_000));
      await vi.waitFor(async () => expect(await publishedIds()).toHaveLength(1), { timeout: 5_000 });
      await queue(change('single', 8_000));
      await vi.waitFor(async () => expect(await publishedIds()).toHaveLength(2), { timeout: 5_000 });
    } finally {
      await r.stop();
    }
  });

  it('reports the queued count for _info, and null while Postgres is unreachable', async () => {
    await queue(change('single', 10_000), change('ao5', 12_000));
    expect(await relay().pending()).toBe(2);
    const unreachable = createPool('postgres://cubr:cubr@127.0.0.1:1/cubr', { max: 1 });
    try {
      expect(await createPbRelay(unreachable, s.redis, s.app.log).pending()).toBeNull();
    } finally {
      await unreachable.end();
    }
  });

  describe('maintenance', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('prunes de-duplication entries older than 30 days once an hour', async () => {
      const [old, recent] = [`test-${randomUUID()}`, `test-${randomUUID()}`];
      await s.pool.query(
        `INSERT INTO stats.processed_events (event_id, processed_at) VALUES ($1, now() - interval '31 days'), ($2, now() - interval '29 days')`,
        [old, recent],
      );
      const exists = async (id: string) => (await s.pool.query('SELECT 1 FROM stats.processed_events WHERE event_id = $1', [id])).rowCount;
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const stop = startMaintenance(s.pool, s.app.log);
      try {
        vi.advanceTimersByTime(3_599_000);
        expect(await exists(old)).toBe(1); // not before the hour is up
        vi.advanceTimersByTime(1_000);
        await vi.waitFor(async () => expect(await exists(old)).toBe(0));
        expect(await exists(recent)).toBe(1);
      } finally {
        stop();
      }
    });
  });
});
