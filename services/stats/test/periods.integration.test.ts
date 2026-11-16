// The day and week bests behind the leaderboard's daily and weekly boards, against a real Postgres:
// periods.changed published through the outbox after every change of a person's solves, and
// GET /internal/users/:id/period-bests reading the ledger (src/routes/internal.ts, src/domain/periods.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeIntegration } from '@cubr/testkit';
import { newCuber, startStats, type Cuber, type StatsTestServer } from './harness.js';

describeIntegration('stats day and week bests', () => {
  let s: StatsTestServer;

  beforeAll(async () => {
    s = await startStats();
  });
  afterAll(async () => {
    await s?.close();
  });

  const bests = (u: Cuber, query: Record<string, string | number>, token: string | null = s.config.internalToken) =>
    s.request('GET', `/internal/users/${u.id}/period-bests?${new URLSearchParams(Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])))}`, token === null ? {} : { headers: { 'x-internal-token': token } });
  const read = async (u: Cuber, query: Record<string, string | number>) => {
    const res = await bests(u, query);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  /** periods.changed published for the user, oldest first */
  const changed = async (u: Cuber) => (await s.events('periods.changed')).filter((e) => e.data.userId === u.id).map((e) => e.data);

  describe('periods.changed', () => {
    it('is published after a new solve and after every edit, deletion and session change', async () => {
      const u = newCuber();
      const session = s.solve.session(u, '333');
      const a = s.solve.solve(u, session, 20_000, '2026-11-16T10:00:00.000Z');
      const b = s.solve.solve(u, session, 21_000, '2026-11-16T10:01:00.000Z');
      await s.feed(a.event, b.event);
      expect(await changed(u)).toEqual([
        { eventId: expect.stringMatching(/^stats-/), occurredAt: expect.any(String), userId: u.id, username: u.username, event: '333' },
        expect.objectContaining({ userId: u.id, event: '333' }),
      ]);
      await s.feed(s.solve.update(u, a.solve.id, { penalty: '+2' }));
      await s.feed(s.solve.delete(u, b.solve.id));
      await s.feed(s.solve.setPractice(u, session.id, true));
      await s.feed(s.solve.deleteSession(u, session.id));
      expect(await changed(u)).toHaveLength(6);
      const imported = s.solve.session(u, '222');
      s.solve.solve(u, imported, 5_000, '2026-11-16T11:00:00.000Z');
      await s.feed(s.solve.imported(u, ['222']));
      expect((await changed(u)).at(-1)).toMatchObject({ event: '222' });
      expect(Number((await s.pool.query('SELECT count(*) AS n FROM stats.pb_outbox')).rows[0].n)).toBe(0); // all relayed
    });

    it("isn't published for a practice session's solve, which counts on no board", async () => {
      const u = newCuber();
      const practice = s.solve.session(u, '333', { practice: true });
      await s.feed(s.solve.solve(u, practice, 15_000, '2026-11-16T10:00:00.000Z').event);
      expect(await changed(u)).toEqual([]);
    });
  });

  describe('GET /internal/users/:id/period-bests', () => {
    it('requires the internal token, and a user id, a known event and a from date', async () => {
      const u = newCuber();
      const ok = { event: '333', from: '2026-11-02T00:00:00.000Z' };
      expect((await bests(u, ok, null)).statusCode).toBe(403);
      expect((await bests(u, ok, 'wrong-token')).statusCode).toBe(403);
      expect(await read(u, ok)).toEqual({ days: {}, weeks: {} });
      expect((await bests(u, { ...ok, event: 'bogus' })).statusCode).toBe(400);
      expect((await bests(u, { ...ok, from: 'yesterday' })).statusCode).toBe(400);
      expect((await bests(u, { ...ok, minSingle: -1 })).statusCode).toBe(400);
      const res = await s.request('GET', `/internal/users/not-a-uuid/period-bests?event=333&from=2026-11-02T00:00:00.000Z`, { headers: { 'x-internal-token': s.config.internalToken } });
      expect(res.statusCode).toBe(400);
    });

    it("answers each UTC day's and ISO week's best single and ao5 from `from` on, an ao5 reaching back before it", async () => {
      const u = newCuber();
      const session = s.solve.session(u, '333');
      const solves = [
        [20_000, '2026-11-15T23:00:00.000Z'], // Sunday, week 46: before `from`, only in the first ao5
        [18_000, '2026-11-16T01:00:00.000Z'], // Monday, week 47
        [19_000, '2026-11-16T02:00:00.000Z'],
        [21_000, '2026-11-16T03:00:00.000Z'],
        [17_000, '2026-11-16T04:00:00.000Z'], // ao5 of 20 18 19 21 17 = 19.000
        [22_000, '2026-11-17T01:00:00.000Z'], // ao5 of 18 19 21 17 22 = 19.333
      ] as const;
      await s.feed(...solves.map(([t, at]) => s.solve.solve(u, session, t, at).event));
      const at = (i: number) => solves[i][1];
      expect(await read(u, { event: '333', from: '2026-11-16T00:00:00.000Z' })).toEqual({
        days: {
          '2026-11-16': { single: { valueMs: 17_000, achievedAt: at(4) }, ao5: { valueMs: 19_000, achievedAt: at(4) } },
          '2026-11-17': { single: { valueMs: 22_000, achievedAt: at(5) }, ao5: { valueMs: 19_333, achievedAt: at(5) } },
        },
        weeks: { '2026-W47': { single: { valueMs: 17_000, achievedAt: at(4) }, ao5: { valueMs: 19_000, achievedAt: at(4) } } },
      });
      // from a week earlier, Sunday's solve is a day of week 46 of its own
      const wider = await read(u, { event: '333', from: '2026-11-09T00:00:00.000Z' });
      expect(wider.days['2026-11-15']).toEqual({ single: { valueMs: 20_000, achievedAt: at(0) } });
      expect(wider.weeks['2026-W46']).toEqual({ single: { valueMs: 20_000, achievedAt: at(0) } });
    });

    it('follows a deletion, a penalty, a practice session and a deleted session', async () => {
      const u = newCuber();
      const from = { event: '333', from: '2026-11-16T00:00:00.000Z' };
      const main = s.solve.session(u, '333');
      const fast = s.solve.solve(u, main, 15_000, '2026-11-16T10:00:00.000Z');
      const slow = s.solve.solve(u, main, 17_000, '2026-11-16T10:01:00.000Z');
      const practice = s.solve.session(u, '333', { practice: true });
      await s.feed(fast.event, slow.event, s.solve.solve(u, practice, 12_000, '2026-11-16T10:02:00.000Z').event);
      expect((await read(u, from)).days['2026-11-16'].single.valueMs).toBe(15_000); // the practice 12.000 doesn't count

      await s.feed(s.solve.delete(u, fast.solve.id)); // a slip, deleted
      expect((await read(u, from)).days['2026-11-16'].single).toEqual({ valueMs: 17_000, achievedAt: slow.solve.createdAt });
      await s.feed(s.solve.update(u, slow.solve.id, { penalty: '+2' }));
      expect((await read(u, from)).weeks['2026-W47'].single.valueMs).toBe(19_000);
      await s.feed(s.solve.update(u, slow.solve.id, { penalty: 'DNF' }));
      expect(await read(u, from)).toEqual({ days: {}, weeks: {} });
      await s.feed(s.solve.setPractice(u, practice.id, false)); // practice no more: its solve counts now
      expect((await read(u, from)).days['2026-11-16'].single.valueMs).toBe(12_000);
      await s.feed(s.solve.deleteSession(u, practice.id), s.solve.deleteSession(u, main.id));
      expect(await read(u, from)).toEqual({ days: {}, weeks: {} });
    });

    it("skips values below the floors, so impossible taps don't hide the real solves", async () => {
      const u = newCuber();
      const session = s.solve.session(u, '333');
      const taps = [648, 612, 418, 481, 239].map((t, i) => s.solve.solve(u, session, t, `2026-11-16T11:10:3${i}.000Z`));
      const real = s.solve.solve(u, session, 17_382, '2026-11-16T11:18:07.253Z');
      await s.feed(...taps.map((x) => x.event), real.event);
      const from = { event: '333', from: '2026-11-16T00:00:00.000Z' };
      expect((await read(u, from)).days['2026-11-16'].single.valueMs).toBe(239);
      // every ao5 has taps in it, so there is no ao5 at all above the floor
      expect(await read(u, { ...from, minSingle: 2_510, minAverage: 3_510 })).toEqual({
        days: { '2026-11-16': { single: { valueMs: 17_382, achievedAt: real.solve.createdAt } } },
        weeks: { '2026-W47': { single: { valueMs: 17_382, achievedAt: real.solve.createdAt } } },
      });
    });

    it("follows a merge, which interleaves two sessions' solves into new ao5s", async () => {
      const u = newCuber();
      const a = s.solve.session(u, '333');
      const b = s.solve.session(u, '333');
      const at = (m: number) => `2026-11-16T12:0${m}:00.000Z`;
      await s.feed(
        ...[10_000, 30_000, 10_000].map((t, i) => s.solve.solve(u, a, t, at(i * 2)).event), // minutes 0 2 4
        ...[30_000, 10_000].map((t, i) => s.solve.solve(u, b, t, at(i * 2 + 1)).event), // minutes 1 3
      );
      const from = { event: '333', from: '2026-11-16T00:00:00.000Z' };
      expect((await read(u, from)).days['2026-11-16'].ao5).toBeUndefined(); // no session has 5 solves
      await s.feed(s.solve.merge(u, a.id, [b.id]));
      // merged in time order: 10 30 30 10 10, so an ao5 (best and worst trimmed) of (10 + 10 + 30) / 3 = 16.667
      expect((await read(u, from)).days['2026-11-16'].ao5).toEqual({ valueMs: 16_667, achievedAt: at(4) });
    });

    it('answers per event: another event of the same person is left out', async () => {
      const u = newCuber();
      await s.feed(s.solve.solve(u, s.solve.session(u, '222'), 4_000, '2026-11-16T09:00:00.000Z').event);
      expect(await read(u, { event: '333', from: '2026-11-16T00:00:00.000Z' })).toEqual({ days: {}, weeks: {} });
      expect((await read(u, { event: '222', from: '2026-11-16T00:00:00.000Z' })).days['2026-11-16'].single.valueMs).toBe(4_000);
    });
  });
});
