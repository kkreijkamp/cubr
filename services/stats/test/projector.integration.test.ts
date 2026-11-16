// The stats projector (src/projector.ts) against a real Postgres and Redis: every consumed event
// type, the incremental solve.created path checked against a full recompute, idempotency and
// tombstones, account deletion, dead-lettering, and recomputes that read a stand-in solve-service
// over HTTP (./harness.ts).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DLQ_STREAM, withTx } from '@cubr/common';
import { describeIntegration } from '@cubr/testkit';
import { computePbs, PB_KINDS } from '../src/domain/pbs.js';
import { USER_TABLES } from '../src/projector.js';
import { CACHE_KEY } from '../src/routes/global.js';
import { queuePbUpdated } from '../src/store.js';
import { envelope, newCuber, republished, startStats, type Cuber, type StatsTestServer } from './harness.js';

describeIntegration('stats projector', () => {
  let s: StatsTestServer;

  beforeAll(async () => {
    s = await startStats();
  });
  afterAll(async () => {
    await s?.close();
  });

  const rows = async (sql: string, params: unknown[] = []) => (await s.pool.query(sql, params)).rows;
  const count = async (sql: string, params: unknown[]) => Number((await rows(sql, params))[0].n);
  const totals = async (u: Cuber) =>
    (await rows('SELECT username, tz, solves, total_ms FROM stats.user_totals WHERE user_id = $1', [u.id]))[0] as
      | { username: string; tz: string; solves: number; total_ms: number }
      | undefined;
  /** The user's PB values for one event, by kind. */
  const pbs = async (u: Cuber, event = '333') =>
    Object.fromEntries((await rows('SELECT kind, value_ms FROM stats.personal_bests WHERE user_id = $1 AND event = $2', [u.id, event])).map((r) => [r.kind, r.value_ms]));
  /** pb.updated events published for the user, oldest first. */
  const pbEvents = async (u: Cuber) => (await s.events('pb.updated')).filter((e) => e.data.userId === u.id).map((e) => e.data);
  const history = async (u: Cuber) => (await s.request('GET', `/api/stats/users/${u.id}/pb-history`)).json().history;

  describe('solve.created', () => {
    it('publishes pb.updated through the outbox for each kind a solve improves, with the value it beat', async () => {
      const u = newCuber();
      const session = s.solve.session(u, '333');
      const first = s.solve.solve(u, session, 12_000, '2026-10-01T10:00:00.000Z');
      const faster = s.solve.solve(u, session, 11_000, '2026-10-01T10:01:00.000Z');
      const slower = s.solve.solve(u, session, 13_000, '2026-10-01T10:02:00.000Z');
      await s.feed(first.event, faster.event, slower.event);
      const common = { eventId: expect.stringMatching(/^stats-[0-9a-f-]{36}$/), occurredAt: expect.any(String), userId: u.id, username: u.username, event: '333' };
      expect(await pbEvents(u)).toEqual([
        { ...common, kind: 'single', valueMs: 12_000, previousMs: null, achievedAt: first.solve.createdAt },
        { ...common, kind: 'single', valueMs: 11_000, previousMs: 12_000, achievedAt: faster.solve.createdAt },
        { ...common, kind: 'mo3', valueMs: 12_000, previousMs: null, achievedAt: slower.solve.createdAt },
      ]);
      expect(await count(`SELECT count(*) AS n FROM stats.pb_outbox WHERE payload->>'userId' = $1`, [u.id])).toBe(0);
    });

    it('counts a solve once, whether its event is delivered twice or published again under a new id', async () => {
      const u = newCuber();
      const { event } = s.solve.solve(u, s.solve.session(u, '333'), 10_000, '2026-10-02T10:00:00Z');
      await s.feed(event, event, republished(event));
      expect(await totals(u)).toMatchObject({ solves: 1, total_ms: 10_000 });
      expect(await count('SELECT sum(solves) AS n FROM stats.daily_activity WHERE user_id = $1', [u.id])).toBe(1);
      expect(await count('SELECT sum(solves) AS n FROM stats.hourly WHERE user_id = $1', [u.id])).toBe(1);
      expect(await pbEvents(u)).toHaveLength(1);
    });

    it("takes ao5 from the payload's rolling values, and from the session's ledger when a publisher left them out", async () => {
      const u = newCuber();
      const session = s.solve.session(u, '333');
      const made = [10_000, 11_000, 12_000, 13_000].map((t, i) => s.solve.solve(u, session, t, `2026-10-03T10:0${i}:00Z`));
      // solve-service's ao5 for the session wins over what the ledger would give (12 000)
      const fifth = s.solve.solve(u, session, 14_000, '2026-10-03T10:05:00Z', 'OK', { rolling: { ao5: 11_500, ao12: null } });
      await s.feed(...made.map((m) => m.event), fifth.event);
      expect((await pbs(u)).ao5).toBe(11_500);

      const v = newCuber();
      const vSession = s.solve.session(v, '333');
      const bare = [10_000, 11_000, 12_000, 13_000, 14_000].map((t, i) => s.solve.solve(v, vSession, t, `2026-10-03T10:0${i}:00Z`, 'OK', { rolling: null }));
      await s.feed(...bare.map((m) => m.event));
      expect(await pbs(v)).toMatchObject({ mo3: 11_000, ao5: 12_000 });
    });

    it("counts a practice session's solves as cubing, but never as a personal best", async () => {
      const u = newCuber();
      const practice = s.solve.session(u, '333', { practice: true });
      await s.feed(...[9_000, 9_100, 9_200].map((t, i) => s.solve.solve(u, practice, t, `2026-10-04T10:0${i}:00Z`).event));
      expect(await totals(u)).toMatchObject({ solves: 3, total_ms: 27_300 });
      expect(await count('SELECT sum(solves) AS n FROM stats.daily_activity WHERE user_id = $1', [u.id])).toBe(3);
      expect(await pbs(u)).toEqual({});
      expect(await pbEvents(u)).toEqual([]);
      expect(await rows('SELECT practice FROM stats.sessions WHERE session_id = $1', [practice.id])).toEqual([{ practice: true }]);
    });

    it('ignores a solve.created that arrives after its session was deleted', async () => {
      const u = newCuber();
      const session = s.solve.session(u, '333');
      const late = s.solve.solve(u, session, 10_000, '2026-10-05T10:00:00Z');
      await s.feed(s.solve.deleteSession(u, session.id), late.event);
      expect(await totals(u)).toMatchObject({ solves: 0 });
      expect(await count('SELECT count(*) AS n FROM stats.solve_ledger WHERE user_id = $1', [u.id])).toBe(0);
    });

    it('rebuilds the event from solve-service when a solve is back-dated into its session', async () => {
      const u = newCuber();
      const session = s.solve.session(u, '333');
      const b = s.solve.solve(u, session, 11_000, '2026-10-06T10:01:00.000Z');
      const c = s.solve.solve(u, session, 12_000, '2026-10-06T10:02:00.000Z');
      const a = s.solve.solve(u, session, 10_000, '2026-10-06T10:00:00.000Z'); // typed in later, dated earlier
      await s.feed(b.event, c.event);
      expect(s.solve.recomputes(u.id)).toEqual([]);
      await s.feed(a.event);
      expect(s.solve.requests.filter((r) => r.path.includes(u.id))).toEqual([
        { path: `/internal/users/${u.id}/solves?event=333`, token: s.config.internalToken },
      ]);
      // the mo3 needs the back-dated solve, so only the rebuild can find it
      expect(await pbs(u)).toEqual({ single: 10_000, mo3: 11_000 });
      expect((await pbEvents(u)).map((e) => [e.kind, e.valueMs, e.previousMs, e.achievedAt])).toEqual([
        ['single', 11_000, null, b.solve.createdAt],
        ['single', 10_000, 11_000, a.solve.createdAt],
        ['mo3', 11_000, null, c.solve.createdAt],
      ]);
      expect(await totals(u)).toMatchObject({ solves: 3, total_ms: 33_000 });
    });

    it('builds the same read model solve by solve as a full recompute builds from the solve list', async () => {
      const u = newCuber('Europe/Berlin');
      const a = s.solve.session(u, '333', { name: 'A' });
      const b = s.solve.session(u, '333', { name: 'B' });
      const start = Date.parse('2026-03-28T20:00:00Z'); // across the change to daylight saving time in Berlin
      const made = Array.from({ length: 165 }, (_, i) =>
        s.solve.solve(
          u,
          i % 3 === 2 ? b : a,
          9_000 + ((i * 7_919) % 4_000),
          new Date(start + i * 17 * 60_000),
          i % 41 === 7 ? 'DNF' : i % 11 === 3 ? '+2' : 'OK',
        ),
      );
      await s.feed(...made.map((m) => m.event));
      const snapshot = async () => ({
        totals: await rows('SELECT solves, total_ms, first_solve_at, last_solve_at FROM stats.user_totals WHERE user_id = $1', [u.id]),
        pbs: await rows('SELECT kind, value_ms, solve_id, achieved_at FROM stats.personal_bests WHERE user_id = $1 ORDER BY kind', [u.id]),
        history: await rows('SELECT kind, value_ms, achieved_at FROM stats.pb_history WHERE user_id = $1 ORDER BY achieved_at, id', [u.id]),
        days: await rows('SELECT day, event, solves, total_ms FROM stats.daily_activity WHERE user_id = $1 ORDER BY day, event', [u.id]),
        hours: await rows('SELECT event, hour, solves, sum_ms, dnfs FROM stats.hourly WHERE user_id = $1 ORDER BY event, hour', [u.id]),
      });
      const incremental = await snapshot();
      expect(incremental.pbs.map((r) => r.kind).sort()).toEqual([...PB_KINDS].sort()); // every kind is compared
      expect(s.solve.recomputes(u.id)).toEqual([]);
      const published = (await pbEvents(u)).length;

      await s.feed(s.solve.imported(u, ['333']));
      expect(s.solve.recomputes(u.id)).toHaveLength(1);
      expect(await snapshot()).toEqual(incremental);
      expect(await pbEvents(u)).toHaveLength(published); // nothing changed, so nothing to tell leaderboard
    });
  });

  describe('solve.updated and solve.deleted', () => {
    it('skips the recompute for a comment-only edit, and recomputes when the time or penalty changed', async () => {
      const u = newCuber();
      const session = s.solve.session(u, '333');
      const best = s.solve.solve(u, session, 9_000, '2026-10-07T10:00:00.000Z');
      const next = s.solve.solve(u, session, 9_500, '2026-10-07T10:01:00.000Z');
      await s.feed(best.event, next.event);
      await s.feed(s.solve.update(u, best.solve.id));
      expect(s.solve.recomputes(u.id)).toEqual([]);
      await s.feed(s.solve.update(u, best.solve.id, { penalty: 'DNF' }));
      expect(s.solve.recomputes(u.id)).toHaveLength(1);
      expect(await pbs(u)).toEqual({ single: 9_500 });
      expect((await pbEvents(u)).at(-1)).toMatchObject({ kind: 'single', valueMs: 9_500, previousMs: 9_000, achievedAt: next.solve.createdAt });
      expect(await history(u)).toEqual([{ kind: 'single', valueMs: 9_500, achievedAt: next.solve.createdAt }]);
      const series = (await s.request('GET', `/api/stats/users/${u.id}/solves`)).json().solves;
      expect(series.map((r: unknown[]) => r[2])).toEqual([null, 9_500]); // the DNF shows as one
    });

    it('takes a deleted solve and the PB it held away, and never counts it again', async () => {
      const u = newCuber();
      const only = s.solve.solve(u, s.solve.session(u, '333'), 10_000, '2026-10-08T10:00:00.000Z');
      await s.feed(only.event);
      await s.feed(s.solve.delete(u, only.solve.id));
      expect(await totals(u)).toMatchObject({ solves: 0, total_ms: 0 });
      expect(await pbs(u)).toEqual({});
      expect((await pbEvents(u)).at(-1)).toMatchObject({ kind: 'single', valueMs: null, previousMs: 10_000, achievedAt: null });
      expect(await count('SELECT count(*) AS n FROM stats.daily_activity WHERE user_id = $1', [u.id])).toBe(0);
      expect(await count('SELECT count(*) AS n FROM stats.hourly WHERE user_id = $1', [u.id])).toBe(0);
      // a late copy of its solve.created (stream redelivery, outbox replay) stays out
      await s.feed(republished(only.event));
      expect(await totals(u)).toMatchObject({ solves: 0 });
      expect((await s.request('GET', `/api/stats/users/${u.id}/solves`)).json().total).toBe(0);
    });
  });

  describe('sessions', () => {
    it("session.deleted takes the session's solves and name away and ignores late solves for it", async () => {
      const u = newCuber();
      const keep = s.solve.session(u, '333', { name: 'Keep' });
      const gone = s.solve.session(u, '333', { name: 'Gone' });
      await s.feed(
        s.solve.solve(u, keep, 12_000, '2026-10-09T10:00:00Z').event,
        s.solve.solve(u, gone, 9_000, '2026-10-09T10:05:00Z').event,
      );
      const late = s.solve.solve(u, gone, 8_000, '2026-10-09T10:06:00Z'); // still on its way when the session goes
      await s.feed(s.solve.deleteSession(u, gone.id), late.event);
      expect(await pbs(u)).toEqual({ single: 12_000 });
      expect(await totals(u)).toMatchObject({ solves: 1, total_ms: 12_000 });
      expect(await count('SELECT count(*) AS n FROM stats.sessions WHERE session_id = $1', [gone.id])).toBe(0);
      expect(await count('SELECT count(*) AS n FROM stats.deleted_sessions WHERE session_id = $1', [gone.id])).toBe(1);
    });

    it('session.renamed renames the session for the history chart without a recompute', async () => {
      const u = newCuber();
      const session = s.solve.session(u, '333', { name: 'Old name' });
      await s.feed(s.solve.solve(u, session, 10_000, '2026-10-10T10:00:00Z').event);
      await s.feed(s.solve.rename(u, session.id, 'New name'));
      expect(s.solve.recomputes(u.id)).toEqual([]);
      expect((await s.request('GET', `/api/stats/users/${u.id}/solves`)).json().sessions).toEqual([expect.objectContaining({ id: session.id, name: 'New name' })]);
    });

    it("session.updated takes a session's solves out of the PBs when it becomes practice, and back when it stops", async () => {
      const u = newCuber();
      const normal = s.solve.session(u, '333');
      const fast = s.solve.session(u, '333');
      const slow = s.solve.solve(u, normal, 11_000, '2026-10-11T10:00:00.000Z');
      const quick = s.solve.solve(u, fast, 9_000, '2026-10-11T10:05:00.000Z');
      await s.feed(slow.event, quick.event);
      expect(await pbs(u)).toEqual({ single: 9_000 });

      await s.feed(s.solve.setPractice(u, fast.id, true));
      expect(await pbs(u)).toEqual({ single: 11_000 });
      expect((await pbEvents(u)).at(-1)).toMatchObject({ kind: 'single', valueMs: 11_000, previousMs: 9_000 });
      expect(await history(u)).toEqual([{ kind: 'single', valueMs: 11_000, achievedAt: slow.solve.createdAt }]);
      expect(await rows('SELECT practice FROM stats.sessions WHERE session_id = $1', [fast.id])).toEqual([{ practice: true }]);
      expect(await totals(u)).toMatchObject({ solves: 2 }); // still time spent cubing

      await s.feed(s.solve.setPractice(u, fast.id, false));
      expect(await pbs(u)).toEqual({ single: 9_000 });
      expect((await pbEvents(u)).at(-1)).toMatchObject({ kind: 'single', valueMs: 9_000, previousMs: 11_000 });
      expect(await history(u)).toHaveLength(2);
    });

    it('sessions.merged tombstones the merged-away sessions and recomputes the merged one', async () => {
      const u = newCuber();
      const target = s.solve.session(u, '333', { name: 'Target' });
      const source = s.solve.session(u, '333', { name: 'Source' });
      const fromSource = s.solve.solve(u, source, 11_000, '2026-10-12T10:01:00.000Z');
      await s.feed(
        s.solve.solve(u, target, 10_000, '2026-10-12T10:00:00.000Z').event,
        fromSource.event,
        s.solve.solve(u, target, 12_000, '2026-10-12T10:02:00.000Z').event,
      );
      expect((await pbs(u)).mo3).toBeUndefined(); // no session has three solves yet
      await s.feed(s.solve.merge(u, target.id, [source.id]));
      expect(await pbs(u)).toEqual({ single: 10_000, mo3: 11_000 });
      expect(await count('SELECT count(*) AS n FROM stats.sessions WHERE session_id = $1', [source.id])).toBe(0);
      expect(await count('SELECT count(*) AS n FROM stats.deleted_sessions WHERE session_id = $1', [source.id])).toBe(1);
      // a late solve for the merged-away session stays out
      await s.feed(envelope('solve.created', { ...fromSource.event.data, eventId: `test-${randomUUID()}`, solveId: randomUUID(), createdAt: '2026-10-12T10:03:00.000Z' }));
      expect(await totals(u)).toMatchObject({ solves: 3 });
      expect((await s.request('GET', `/api/stats/users/${u.id}/solves`)).json().sessions.map((x: { id: string }) => x.id)).toEqual([target.id]);
    });
  });

  describe('solves.imported', () => {
    it('recomputes each imported event once', async () => {
      const u = newCuber();
      s.solve.solve(u, s.solve.session(u, '333'), 10_000, '2026-01-01T10:00:00Z');
      s.solve.solve(u, s.solve.session(u, '444'), 60_000, '2026-01-01T11:00:00Z');
      await s.feed(s.solve.imported(u, ['333', '444', '333']));
      expect(s.solve.recomputes(u.id)).toEqual([`/internal/users/${u.id}/solves?event=333`, `/internal/users/${u.id}/solves?event=444`]);
      expect(await pbs(u, '333')).toEqual({ single: 10_000 });
      expect(await pbs(u, '444')).toEqual({ single: 60_000 });
      expect(await totals(u)).toMatchObject({ solves: 2, total_ms: 70_000 });
    });

    it('recomputes every event the user has when the import does not say which', async () => {
      const u = newCuber();
      const cube = s.solve.session(u, '333');
      await s.feed(
        s.solve.solve(u, cube, 10_000, '2026-01-02T10:00:00Z').event,
        s.solve.solve(u, s.solve.session(u, 'pyram'), 5_000, '2026-01-02T10:05:00Z').event,
      );
      s.solve.solve(u, cube, 9_000, '2026-01-02T10:10:00Z'); // came in with the import
      await s.feed(s.solve.imported(u, null));
      expect(s.solve.recomputes(u.id).sort()).toEqual([`/internal/users/${u.id}/solves?event=333`, `/internal/users/${u.id}/solves?event=pyram`]);
      expect(await pbs(u, '333')).toEqual({ single: 9_000 });
      expect(await totals(u)).toMatchObject({ solves: 3 });
    });
  });

  describe('user events', () => {
    it('keep the newest username and the earliest registration time, and leave the counters alone', async () => {
      const u = newCuber();
      await s.feed(
        envelope('user.registered', { userId: u.id, username: u.username, createdAt: '2026-01-01T00:00:00.000Z' }),
        envelope('user.updated', { userId: u.id, username: 'renamed_cuber', createdAt: null }), // a private profile sends no createdAt
      );
      expect(await rows('SELECT username, solves, total_ms, registered_at FROM stats.user_totals WHERE user_id = $1', [u.id])).toEqual([
        { username: 'renamed_cuber', solves: 0, total_ms: 0, registered_at: new Date('2026-01-01T00:00:00.000Z') },
      ]);
    });

    it('keep the last valid timezone when an event carries none or a bogus one, and bucket by it', async () => {
      const u = newCuber('Australia/Brisbane');
      const session = s.solve.session(u, '333');
      await s.feed(
        s.solve.solve(u, session, 10_000, '2026-10-18T10:00:00Z').event,
        s.solve.solve(u, session, 11_000, '2026-10-18T10:01:00Z', 'OK', { tz: 'Not/AZone' }).event,
        s.solve.solve(u, session, 12_000, '2026-10-18T10:02:00Z', 'OK', { tz: null }).event,
      );
      expect(await totals(u)).toMatchObject({ tz: 'Australia/Brisbane', solves: 3 });
      // 20:00-20:02 in Brisbane
      expect(await rows('SELECT hour, solves FROM stats.hourly WHERE user_id = $1', [u.id])).toEqual([{ hour: 20, solves: 3 }]);
    });
  });

  describe('user.deleted', () => {
    it('removes every row of the account and its queued pb.updated, then ignores later events for it', async () => {
      const u = newCuber();
      const other = newCuber();
      const mine = s.solve.session(u, '333', { name: 'Mine' });
      const gone = s.solve.session(u, '333');
      await s.feed(
        envelope('user.registered', { userId: u.id, username: u.username }),
        ...[10_000, 11_000, 12_000].map((t, i) => s.solve.solve(u, mine, t, `2026-10-13T10:0${i}:00Z`).event),
        s.solve.solve(u, gone, 9_000, '2026-10-13T11:00:00Z').event,
        s.solve.deleteSession(u, gone.id),
        s.solve.solve(other, s.solve.session(other, '333'), 10_000, '2026-10-13T10:00:00Z').event,
      );
      // a pb.updated still waiting in the outbox (Redis was down, say)
      await withTx(s.pool, (c) =>
        queuePbUpdated(c, { userId: u.id, username: u.username, event: '333', kind: 'single', valueMs: 10_000, previousMs: null, achievedAt: '2026-10-13T10:00:00.000Z' }),
      );
      await s.redis.set(CACHE_KEY, '{"users":1}');
      for (const table of USER_TABLES) {
        expect(await count(`SELECT count(*) AS n FROM stats.${table} WHERE user_id = $1`, [u.id]), `${table} before`).toBeGreaterThan(0);
      }

      await s.feed(envelope('user.deleted', { userId: u.id, username: u.username }));
      for (const table of USER_TABLES) {
        expect(await count(`SELECT count(*) AS n FROM stats.${table} WHERE user_id = $1`, [u.id]), table).toBe(0);
      }
      expect(await count(`SELECT count(*) AS n FROM stats.pb_outbox WHERE payload->>'userId' = $1`, [u.id])).toBe(0);
      expect(await count('SELECT count(*) AS n FROM stats.deleted_users WHERE user_id = $1', [u.id])).toBe(1);
      expect(await s.redis.exists(CACHE_KEY)).toBe(0);

      // events still on their way for the account bring nothing back
      await s.feed(
        s.solve.solve(u, mine, 8_000, '2026-10-13T12:00:00Z').event,
        envelope('user.updated', { userId: u.id, username: u.username }),
        s.solve.imported(u, ['333']),
      );
      for (const table of USER_TABLES) {
        expect(await count(`SELECT count(*) AS n FROM stats.${table} WHERE user_id = $1`, [u.id]), `${table} after`).toBe(0);
      }
      expect(await totals(other)).toMatchObject({ solves: 1 });
    });
  });

  describe('failures', () => {
    it('moves an event with a malformed payload to the dead-letter stream instead of failing on it', async () => {
      const u = newCuber();
      const { event } = s.solve.solve(u, s.solve.session(u, '333'), 10_000, '2026-10-14T10:00:00Z');
      await expect(s.handle(envelope('solve.created', { ...event.data, solveId: 'not-a-uuid' }))).resolves.toBeUndefined();
      const dead = (await s.redis.xrange(DLQ_STREAM, '-', '+')).map(([, f]) => {
        const fields: Record<string, string> = {};
        for (let i = 0; i < f.length; i += 2) fields[f[i]] = f[i + 1];
        return fields;
      });
      const entry = dead.find((d) => (JSON.parse(d.data) as { userId?: string }).userId === u.id);
      expect(entry).toMatchObject({ group: 'stats', type: 'solve.created', error: expect.stringContaining('solveId') });
      expect(await totals(u)).toBeUndefined();
    });

    it('fails an event while solve-service is unreachable without recording any of it, so the retry applies it in full', async () => {
      const u = newCuber();
      const solve = s.solve.solve(u, s.solve.session(u, '333'), 10_000, '2026-10-15T10:00:00Z');
      await s.feed(solve.event);
      const deleted = s.solve.delete(u, solve.solve.id);
      s.solve.failWith = 503;
      try {
        await expect(s.handle(deleted)).rejects.toThrow();
      } finally {
        s.solve.failWith = null;
      }
      expect(await count('SELECT count(*) AS n FROM stats.processed_events WHERE event_id = $1', [deleted.data.eventId])).toBe(0);
      expect(await rows('SELECT deleted FROM stats.solve_ledger WHERE solve_id = $1', [solve.solve.id])).toEqual([{ deleted: false }]);
      expect(await totals(u)).toMatchObject({ solves: 1 });
      await s.feed(deleted); // the consumer's retry
      expect(await totals(u)).toMatchObject({ solves: 0 });
      expect(await pbs(u)).toEqual({});
    });
  });

  describe('concurrency', () => {
    it("applies one user's events one at a time when several handlers run at once", async () => {
      const u = newCuber();
      const session = s.solve.session(u, '333');
      const start = Date.parse('2026-10-16T10:00:00Z');
      const made = Array.from({ length: 12 }, (_, i) => s.solve.solve(u, session, 10_000 + ((i * 3_331) % 2_000), new Date(start + i * 60_000)));
      await Promise.all(made.map((m) => s.handle(m.event)));
      expect(await totals(u)).toMatchObject({ solves: 12, total_ms: made.reduce((n, m) => n + m.solve.timeMs, 0) });
      expect(await count('SELECT sum(solves) AS n FROM stats.daily_activity WHERE user_id = $1', [u.id])).toBe(12);
      const expected = computePbs(s.solve.list(u.id, '333'));
      expect(await rows('SELECT kind, value_ms, solve_id FROM stats.personal_bests WHERE user_id = $1 ORDER BY kind', [u.id])).toEqual(
        Object.entries(expected)
          .map(([kind, pb]) => ({ kind, value_ms: pb.valueMs, solve_id: pb.solveId }))
          .sort((x, y) => x.kind.localeCompare(y.kind)),
      );
    });
  });
});
