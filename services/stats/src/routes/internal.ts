import { parse, requireInternal, type Pool } from '@cubr/common';
import { isEventId } from '@cubr/cubestats';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PB_KINDS, type PbKind } from '../domain/pbs.js';

const internalPbsQuery = z.object({
  event: z.string().refine(isEventId, 'unknown event').optional(),
  kind: z.enum(PB_KINDS).optional(),
});

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
}
