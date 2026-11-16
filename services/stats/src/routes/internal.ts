import { parse, requireInternal, type Pool } from '@cubr/common';
import { isEventId } from '@cubr/cubestats';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PB_KINDS, type PbKind } from '../domain/pbs.js';
import { allTimeBests, periodBests, type PeriodSolve } from '../domain/periods.js';

const internalPbsQuery = z.object({
  event: z.string().refine(isEventId, 'unknown event').optional(),
  kind: z.enum(PB_KINDS).optional(),
});

const periodBestsParams = z.object({ userId: z.string().uuid() });
const allTimeBestsQuery = z.object({
  event: z.string().refine(isEventId, 'unknown event'),
  minSingle: z.coerce.number().int().min(0).max(86_400_000).default(0),
  minAverage: z.coerce.number().int().min(0).max(86_400_000).default(0),
});
const periodBestsQuery = z.object({
  event: z.string().refine(isEventId, 'unknown event'),
  /** solves from this moment on count (the leaderboard sends the Monday of its oldest live week) */
  from: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'from: an ISO date-time'),
  /** anti-cheat floors in ms: values below them are skipped */
  minSingle: z.coerce.number().int().min(0).max(86_400_000).default(0),
  minAverage: z.coerce.number().int().min(0).max(86_400_000).default(0),
});

/** The window that ends at a solve after `from` can reach this many solves back. */
const AO5_LOOKBACK = 4;

export async function registerInternalRoutes(app: FastifyInstance, pool: Pool, internalToken: string): Promise<void> {
  // Service-to-service (not routed by the Ingress, callers send X-Internal-Token): all PB rows,
  // used by leaderboard to rebuild its all-time boards after a Redis loss.
  app.get('/internal/pbs', { preHandler: requireInternal(internalToken, app.log) }, async (req) => {
    const { event, kind } = parse(internalPbsQuery, req.query);
    const { rows } = await pool.query<{
      user_id: string; username: string; event: string; kind: PbKind; value_ms: number; solve_id: string | null; achieved_at: Date;
    }>(
      `SELECT p.user_id, coalesce(u.username, '') AS username, p.event, p.kind, p.value_ms, p.solve_id, p.achieved_at
         FROM stats.personal_bests p LEFT JOIN stats.user_totals u ON u.user_id = p.user_id
        WHERE ($1::text IS NULL OR p.event = $1) AND ($2::text IS NULL OR p.kind = $2)
        ORDER BY p.event, p.kind, p.value_ms, p.achieved_at`,
      [event ?? null, kind ?? null],
    );
    return {
      pbs: rows.map((r) => ({
        userId: r.user_id,
        username: r.username,
        event: r.event,
        kind: r.kind,
        valueMs: r.value_ms,
        solveId: r.solve_id,
        achievedAt: r.achieved_at.toISOString(),
      })),
    };
  });

  // The best single and ao5 of each UTC day and ISO week since `from` (non-practice sessions only,
  // values below the floors skipped), for the leaderboard's daily and weekly boards: it asks after
  // every periods.changed. From the ledger, so it is exact once this service has applied a change.
  app.get('/internal/users/:userId/period-bests', { preHandler: requireInternal(internalToken, app.log) }, async (req) => {
    const { userId } = parse(periodBestsParams, req.params);
    const { event, from, minSingle, minAverage } = parse(periodBestsQuery, req.query);
    const since = new Date(from);
    type Row = { session_id: string; effective_ms: number | null; created_at: Date; seq: string };
    const recent = await pool.query<Row>(
      `SELECT l.session_id, l.effective_ms, l.created_at, l.seq
         FROM stats.solve_ledger l
         LEFT JOIN stats.sessions s ON s.session_id = l.session_id
        WHERE l.user_id = $1 AND l.event = $2 AND NOT l.deleted AND l.created_at >= $3
          AND NOT coalesce(s.practice, false)
        ORDER BY l.session_id, l.created_at, l.seq`,
      [userId, event, since],
    );
    const sessionIds = [...new Set(recent.rows.map((r) => r.session_id))];
    // each session's last solves before `from`, for the ao5 windows that start before it
    const earlier = sessionIds.length
      ? await pool.query<Row>(
          `SELECT p.session_id, p.effective_ms, p.created_at, p.seq
             FROM unnest($1::uuid[]) AS sid(id)
             CROSS JOIN LATERAL (
               SELECT l.session_id, l.effective_ms, l.created_at, l.seq FROM stats.solve_ledger l
                WHERE l.session_id = sid.id AND NOT l.deleted AND l.created_at < $2
                ORDER BY l.created_at DESC, l.seq DESC LIMIT ${AO5_LOOKBACK}) p`,
          [sessionIds, since],
        )
      : { rows: [] as Row[] };
    const bySession = new Map<string, Row[]>(sessionIds.map((id) => [id, []]));
    for (const r of [...earlier.rows, ...recent.rows]) bySession.get(r.session_id)!.push(r);
    const order = (a: Row, b: Row) => a.created_at.getTime() - b.created_at.getTime() || Number(BigInt(a.seq) - BigInt(b.seq));
    const sessions: PeriodSolve[][] = [...bySession.values()].map((rows) =>
      rows.sort(order).map((r) => ({ effectiveMs: r.effective_ms, createdAt: r.created_at })),
    );
    return periodBests(sessions, since, { single: minSingle, average: minAverage });
  });

  // A person's all-time best single, ao5 and ao12 at or above the floors (non-practice sessions), for
  // the leaderboard's all-time boards while their PB is an impossible time: it asks only for people
  // with a refused PB, so this reads all their solves of the event.
  app.get('/internal/users/:userId/all-time-bests', { preHandler: requireInternal(internalToken, app.log) }, async (req) => {
    const { userId } = parse(periodBestsParams, req.params);
    const { event, minSingle, minAverage } = parse(allTimeBestsQuery, req.query);
    const { rows } = await pool.query<{ session_id: string; effective_ms: number | null; created_at: Date }>(
      `SELECT l.session_id, l.effective_ms, l.created_at
         FROM stats.solve_ledger l
         LEFT JOIN stats.sessions s ON s.session_id = l.session_id
        WHERE l.user_id = $1 AND l.event = $2 AND NOT l.deleted AND NOT coalesce(s.practice, false)
        ORDER BY l.session_id, l.created_at, l.seq`,
      [userId, event],
    );
    const sessions = new Map<string, PeriodSolve[]>();
    for (const r of rows) {
      const list = sessions.get(r.session_id) ?? [];
      list.push({ effectiveMs: r.effective_ms, createdAt: r.created_at });
      sessions.set(r.session_id, list);
    }
    return allTimeBests([...sessions.values()], { single: minSingle, average: minAverage });
  });
}
