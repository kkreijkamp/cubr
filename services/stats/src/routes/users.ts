import { badRequest, dayKey, parse, type Pool } from '@cubetype/common';
import { EVENT_IDS, isEventId } from '@cubetype/cubestats';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PB_KINDS, type PbKind } from '../domain/pbs.js';
import { addDays, computeStreaks, dayNumber, dayString } from '../domain/streaks.js';

const userParams = z.object({ userId: z.string().uuid('userId must be a UUID') });

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((s) => dayString(dayNumber(s)) === s, 'invalid date');

const eventParam = z.string().refine(isEventId, 'unknown event');

const activityQuery = z.object({ from: dateStr.optional(), to: dateStr.optional() });
const pbHistoryQuery = z.object({ event: eventParam.default('333') });
const hourlyQuery = z.object({ event: eventParam.optional() });

type PB = { valueMs: number; solveId: string | null; achievedAt: string };

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function registerUserRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  // Profile summary. Unknown users get zeros (a brand-new account has a clean profile, not a 404).
  app.get('/api/stats/users/:userId/summary', async (req) => {
    const { userId } = parse(userParams, req.params);
    const [totals, days, daily, hourly, pbs] = await Promise.all([
      pool.query<{ username: string; solves: number; total_ms: number; first_solve_at: Date | null; last_solve_at: Date | null }>(
        'SELECT username, solves, total_ms, first_solve_at, last_solve_at FROM stats.user_totals WHERE user_id = $1',
        [userId],
      ),
      pool.query<{ day: string }>('SELECT DISTINCT day FROM stats.daily_activity WHERE user_id = $1', [userId]),
      pool.query<{ event: string; solves: number; total_ms: number }>(
        `SELECT event, sum(solves)::int AS solves, sum(total_ms)::bigint AS total_ms
           FROM stats.daily_activity WHERE user_id = $1 GROUP BY event`,
        [userId],
      ),
      pool.query<{ event: string; solves: number; sum_ms: number }>(
        `SELECT event, sum(solves)::int AS solves, sum(sum_ms)::bigint AS sum_ms
           FROM stats.hourly WHERE user_id = $1 GROUP BY event`,
        [userId],
      ),
      pool.query<{ event: string; kind: PbKind; value_ms: number; solve_id: string | null; achieved_at: Date }>(
        'SELECT event, kind, value_ms, solve_id, achieved_at FROM stats.personal_bests WHERE user_id = $1',
        [userId],
      ),
    ]);
    const t = totals.rows[0];
    // days are bucketed in the user's timezone; a day "ahead" of the UTC date still counts as today
    const today = dayKey(new Date(), 'UTC');
    const streaks = computeStreaks(days.rows.map((r) => r.day), today);

    type EventLine = { event: string; solves: number; totalMs: number; meanMs: number | null; pbs: Record<PbKind, PB | null> };
    const byEvent = new Map<string, EventLine>();
    const line = (event: string): EventLine => {
      let l = byEvent.get(event);
      if (!l) {
        const empty = Object.fromEntries(PB_KINDS.map((k) => [k, null])) as Record<PbKind, PB | null>;
        byEvent.set(event, (l = { event, solves: 0, totalMs: 0, meanMs: null, pbs: empty }));
      }
      return l;
    };
    for (const r of daily.rows) Object.assign(line(r.event), { solves: r.solves, totalMs: r.total_ms });
    for (const r of hourly.rows) line(r.event).meanMs = r.solves > 0 ? Math.round(r.sum_ms / r.solves) : null;
    for (const r of pbs.rows) {
      line(r.event).pbs[r.kind] = { valueMs: r.value_ms, solveId: r.solve_id, achievedAt: r.achieved_at.toISOString() };
    }
    const order = (e: string) => (EVENT_IDS.indexOf(e) + 1 || 999);
    const events = [...byEvent.values()].sort((a, b) => b.solves - a.solves || order(a.event) - order(b.event));

    return {
      userId,
      username: t?.username || null,
      totals: {
        solves: t?.solves ?? 0,
        totalMs: t?.total_ms ?? 0,
        firstSolveAt: iso(t?.first_solve_at ?? null),
        lastSolveAt: iso(t?.last_solve_at ?? null),
        ...streaks,
      },
      events,
    };
  });

  // Heatmap data: only days with solves, default the last 365 days.
  app.get('/api/stats/users/:userId/activity', async (req) => {
    const { userId } = parse(userParams, req.params);
    const q = parse(activityQuery, req.query);
    const to = q.to ?? (q.from ? addDays(q.from, 364) : dayKey(new Date(), 'UTC'));
    const from = q.from ?? addDays(to, -364);
    if (from > to) throw badRequest('from must not be after to');
    const { rows } = await pool.query<{ day: string; solves: number; total_ms: number }>(
      `SELECT day, sum(solves)::int AS solves, sum(total_ms)::bigint AS total_ms
         FROM stats.daily_activity WHERE user_id = $1 AND day BETWEEN $2 AND $3
        GROUP BY day ORDER BY day`,
      [userId, from, to],
    );
    return { from, to, days: rows.map((r) => ({ date: r.day, solves: r.solves, totalMs: r.total_ms })) };
  });

  // PB progression for one event (default 333), oldest first.
  app.get('/api/stats/users/:userId/pb-history', async (req) => {
    const { userId } = parse(userParams, req.params);
    const { event } = parse(pbHistoryQuery, req.query);
    const { rows } = await pool.query<{ kind: PbKind; value_ms: number; achieved_at: Date }>(
      `SELECT kind, value_ms, achieved_at FROM stats.pb_history
        WHERE user_id = $1 AND event = $2 ORDER BY achieved_at, id`,
      [userId, event],
    );
    return { event, history: rows.map((r) => ({ kind: r.kind, valueMs: r.value_ms, achievedAt: r.achieved_at.toISOString() })) };
  });

  // Time-of-day profile: 24 entries; `solves` = non-DNF solves, meanMs over them.
  // Without ?event= all events are combined.
  app.get('/api/stats/users/:userId/hourly', async (req) => {
    const { userId } = parse(userParams, req.params);
    const { event } = parse(hourlyQuery, req.query);
    const { rows } = await pool.query<{ hour: number; solves: number; sum_ms: number }>(
      `SELECT hour, sum(solves)::int AS solves, sum(sum_ms)::bigint AS sum_ms
         FROM stats.hourly WHERE user_id = $1 AND ($2::text IS NULL OR event = $2)
        GROUP BY hour`,
      [userId, event ?? null],
    );
    const byHour = new Map(rows.map((r) => [r.hour, r]));
    const hours = Array.from({ length: 24 }, (_, hour) => {
      const r = byHour.get(hour);
      return {
        hour,
        solves: r?.solves ?? 0,
        meanMs: r && r.solves > 0 ? Math.round(r.sum_ms / r.solves) : null,
      };
    });
    return { event: event ?? null, hours };
  });
}
