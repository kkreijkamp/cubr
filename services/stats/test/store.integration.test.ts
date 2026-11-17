// stats' storage helpers (src/store.ts) and the full recompute (src/recompute.ts) against a real
// Postgres: the per-user advisory lock, duplicate detection, the user row, totals from the ledger,
// and recomputeEvent's diff of the stored PBs against the solve list (pb.updated only for real
// changes), reading a stand-in solve-service (./harness.ts).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTx } from '@cubr/common';
import { describeIntegration } from '@cubr/testkit';
import { recomputeEvent, type RecomputeDeps } from '../src/recompute.js';
import { ensureUser, lockUser, markProcessed, refreshTotals, upsertPb } from '../src/store.js';
import { newCuber, startStats, type StatsTestServer } from './harness.js';

describeIntegration('stats store and recompute', () => {
  let s: StatsTestServer;
  let deps: RecomputeDeps;

  beforeAll(async () => {
    s = await startStats();
    deps = { solveUrl: s.solve.url, internalToken: s.config.internalToken, log: s.app.log };
  });
  afterAll(async () => {
    await s?.close();
  });

  const rows = async (sql: string, params: unknown[] = []) => (await s.pool.query(sql, params)).rows;

  describe('lockUser', () => {
    it("makes a second transaction for the same user wait until the first ends, and holds up no one else's", async () => {
      const [u, v] = [randomUUID(), randomUUID()];
      const [a, b, c] = await Promise.all([s.pool.connect(), s.pool.connect(), s.pool.connect()]);
      try {
        for (const client of [a, b, c]) await client.query('BEGIN');
        const bPid = (await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await lockUser(a, u);
        let bHasLock = false;
        const bWaits = lockUser(b, u).then(() => {
          bHasLock = true;
        });
        // b is queued on the server behind a's lock
        await vi.waitFor(async () => {
          const waiting = await rows(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND pid = $1`, [bPid]);
          expect(waiting[0].n).toBe(1);
        });
        await lockUser(c, v); // another user's events go ahead
        expect(bHasLock).toBe(false);
        await a.query('COMMIT'); // transaction-scoped: released with the commit
        await bWaits;
        expect(bHasLock).toBe(true);
      } finally {
        for (const client of [a, b, c]) {
          await client.query('ROLLBACK').catch(() => {});
          client.release();
        }
      }
    });
  });

  describe('markProcessed', () => {
    it('reports an event id it has seen before', async () => {
      const id = `test-${randomUUID()}`;
      await withTx(s.pool, async (c) => {
        expect(await markProcessed(c, id)).toBe(true);
        expect(await markProcessed(c, id)).toBe(false);
      });
      expect(await withTx(s.pool, (c) => markProcessed(c, id))).toBe(false);
    });
  });

  describe('ensureUser', () => {
    it('creates the row once, and keeps the stored name and timezone when an event carries none', async () => {
      const id = randomUUID();
      await withTx(s.pool, async (c) => {
        expect(await ensureUser(c, id, null, null)).toEqual({ username: '', tz: 'UTC' });
        expect(await ensureUser(c, id, 'cuber', 'Australia/Brisbane')).toEqual({ username: 'cuber', tz: 'Australia/Brisbane' });
        expect(await ensureUser(c, id, undefined, null)).toEqual({ username: 'cuber', tz: 'Australia/Brisbane' });
        expect(await ensureUser(c, id, 'renamed', 'UTC')).toEqual({ username: 'renamed', tz: 'UTC' });
      });
      expect(await rows('SELECT username, solves FROM stats.user_totals WHERE user_id = $1', [id])).toEqual([{ username: 'renamed', solves: 0 }]);
    });
  });

  describe('refreshTotals', () => {
    it('recounts solves, time spent and the first and last solve from the ledger, leaving out deleted solves', async () => {
      const id = randomUUID();
      const session = randomUUID();
      await withTx(s.pool, async (c) => {
        await ensureUser(c, id, 'cuber', null);
        await c.query(
          `INSERT INTO stats.solve_ledger (solve_id, user_id, event, session_id, time_ms, effective_ms, created_at, deleted) VALUES
             ($1, $4, '333', $5, 10000, 10000, '2026-10-01T10:00:00Z', false),
             ($2, $4, '222', $5, 3000, NULL, '2026-10-02T10:00:00Z', false),
             ($3, $4, '333', $5, 9000, 9000, '2026-10-03T10:00:00Z', true)`,
          [randomUUID(), randomUUID(), randomUUID(), id, session],
        );
        await refreshTotals(c, id);
      });
      expect(await rows('SELECT solves, total_ms, first_solve_at, last_solve_at FROM stats.user_totals WHERE user_id = $1', [id])).toEqual([
        { solves: 2, total_ms: 13_000, first_solve_at: new Date('2026-10-01T10:00:00Z'), last_solve_at: new Date('2026-10-02T10:00:00Z') },
      ]);
    });
  });

  describe('recomputeEvent', () => {
    it('rebuilds the PBs from the solve list and queues pb.updated only for the rows that changed', async () => {
      const u = newCuber();
      const session = s.solve.session(u, '333');
      const made = [10_000, 11_000, 12_000].map((t, i) => s.solve.solve(u, session, t, `2026-10-20T10:0${i}:00.000Z`));
      // stored before: a single from a solve that is gone, the mo3 the list gives too, an ao5 it cannot support
      await withTx(s.pool, async (c) => {
        await ensureUser(c, u.id, u.username, 'UTC');
        await upsertPb(c, u.id, '333', 'single', 9_000, randomUUID(), '2026-10-19T10:00:00.000Z');
        await upsertPb(c, u.id, '333', 'mo3', 11_000, made[2].solve.id, made[2].solve.createdAt);
        await upsertPb(c, u.id, '333', 'ao5', 12_000, randomUUID(), '2026-10-19T11:00:00.000Z');
      });
      const result = await withTx(s.pool, (c) => recomputeEvent(c, deps, { userId: u.id, username: u.username, event: '333', tz: 'UTC' }));
      expect(result).toEqual({ solves: 3, pbChanges: 2, queued: 3 }); // + periods.changed
      expect(await rows('SELECT kind, value_ms, solve_id, achieved_at FROM stats.personal_bests WHERE user_id = $1 ORDER BY kind', [u.id])).toEqual([
        { kind: 'mo3', value_ms: 11_000, solve_id: made[2].solve.id, achieved_at: new Date(made[2].solve.createdAt) },
        { kind: 'single', value_ms: 10_000, solve_id: made[0].solve.id, achieved_at: new Date(made[0].solve.createdAt) },
      ]);
      const queued = (await rows(`SELECT type, payload FROM stats.pb_outbox WHERE payload->>'userId' = $1 ORDER BY id`, [u.id])).map((r) => [r.type, r.payload]);
      expect(queued).toEqual([
        ['pb.updated', expect.objectContaining({ kind: 'single', valueMs: 10_000, previousMs: 9_000, achievedAt: made[0].solve.createdAt, username: u.username, event: '333' })],
        ['pb.updated', expect.objectContaining({ kind: 'ao5', valueMs: null, previousMs: 12_000, achievedAt: null })],
        // and the leaderboard re-reads the day and week bests
        ['periods.changed', { eventId: expect.stringMatching(/^stats-/), occurredAt: expect.any(String), userId: u.id, username: u.username, event: '333' }],
      ]);
    });

    it('counts a solve the list repeats only once', async () => {
      const u = newCuber();
      const solve = s.solve.solve(u, s.solve.session(u, '333'), 10_000, '2026-10-21T10:00:00.000Z');
      s.solve.onList = (list) => [...list, ...list];
      try {
        await withTx(s.pool, async (c) => {
          await ensureUser(c, u.id, u.username, 'UTC');
          expect(await recomputeEvent(c, deps, { userId: u.id, username: u.username, event: '333', tz: 'UTC' })).toMatchObject({ solves: 1 });
          await refreshTotals(c, u.id);
        });
      } finally {
        s.solve.onList = null;
      }
      expect(await rows('SELECT solve_id FROM stats.solve_ledger WHERE user_id = $1', [u.id])).toEqual([{ solve_id: solve.solve.id }]);
      expect(await rows('SELECT solves FROM stats.user_totals WHERE user_id = $1', [u.id])).toEqual([{ solves: 1 }]);
    });

    it("touches only the recomputed event and keeps the tombstones of the event's deleted solves", async () => {
      const u = newCuber();
      const cube = s.solve.session(u, '333');
      const big = s.solve.session(u, '444');
      const deleted = s.solve.solve(u, cube, 9_000, '2026-10-22T10:00:00Z');
      await s.feed(
        deleted.event,
        s.solve.solve(u, cube, 10_000, '2026-10-22T10:01:00Z').event,
        s.solve.solve(u, big, 60_000, '2026-10-22T11:00:00Z').event,
      );
      await s.feed(s.solve.delete(u, deleted.solve.id));
      const other = async () => ({
        ledger: await rows(`SELECT solve_id, deleted FROM stats.solve_ledger WHERE user_id = $1 AND event = '444'`, [u.id]),
        days: await rows(`SELECT day, solves FROM stats.daily_activity WHERE user_id = $1 AND event = '444'`, [u.id]),
        pbs: await rows(`SELECT kind, value_ms FROM stats.personal_bests WHERE user_id = $1 AND event = '444'`, [u.id]),
      });
      const before = await other();
      await withTx(s.pool, (c) => recomputeEvent(c, deps, { userId: u.id, username: u.username, event: '333', tz: 'UTC' }));
      expect(await other()).toEqual(before);
      expect(before.pbs).toEqual([{ kind: 'single', value_ms: 60_000 }]);
      expect(await rows('SELECT deleted FROM stats.solve_ledger WHERE solve_id = $1', [deleted.solve.id])).toEqual([{ deleted: true }]);
    });

    it('fails while solve-service is unreachable, after one retry', async () => {
      const u = newCuber();
      s.solve.failWith = 503;
      try {
        await expect(withTx(s.pool, (c) => recomputeEvent(c, deps, { userId: u.id, username: u.username, event: '333', tz: 'UTC' }))).rejects.toMatchObject({
          statusCode: 503,
        });
      } finally {
        s.solve.failWith = null;
      }
      expect(s.solve.recomputes(u.id)).toHaveLength(2);
    });

    it("fails on a 404 instead of taking it for 'no solves' and wiping the event", async () => {
      const u = newCuber();
      await s.feed(s.solve.solve(u, s.solve.session(u, '333'), 10_000, '2026-10-23T10:00:00Z').event);
      const before = await rows(`SELECT kind, value_ms FROM stats.personal_bests WHERE user_id = $1 AND event = '333'`, [u.id]);
      expect(before).not.toEqual([]);
      s.solve.failWith = 404; // e.g. SOLVE_URL pointing at the gateway, which answers /internal/* with 404
      try {
        await expect(withTx(s.pool, (c) => recomputeEvent(c, deps, { userId: u.id, username: u.username, event: '333', tz: 'UTC' }))).rejects.toMatchObject({
          statusCode: 404,
        });
      } finally {
        s.solve.failWith = null;
      }
      expect(await rows(`SELECT kind, value_ms FROM stats.personal_bests WHERE user_id = $1 AND event = '333'`, [u.id])).toEqual(before);
    });
  });
});
