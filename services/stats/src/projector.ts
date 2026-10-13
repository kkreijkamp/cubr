import {
  DLQ_STREAM, newEventId, publishEvent, withTx, type EventEnvelope, type Pool, type PoolClient, type Redis,
} from '@cubetype/common';
import { effectiveMs } from '@cubetype/cubestats';
import type { FastifyBaseLogger } from 'fastify';
import type { ZodType, ZodTypeDef } from 'zod';
import { makeBucketer, validTz } from './domain/buckets.js';
import { isImprovement, rollingFromPayload, type PbKind } from './domain/pbs.js';
import { solveCreatedSchema, userEventSchema, type SolveCreated } from './eventSchemas.js';
import { ensureUser, loadPbs, lockUser, markProcessed, upsertPb, type PbChange } from './store.js';

export interface ProjectorDeps {
  pool: Pool;
  redis: Redis;
  log: FastifyBaseLogger;
}

/**
 * Event handler for the `stats` consumer group. Every event is applied in ONE transaction that
 * takes the per-user lock and records the event id in processed_events (duplicate deliveries are
 * skipped); the resulting pb.updated events are published once that transaction has committed.
 */
export function createProjector(deps: ProjectorDeps) {
  const { pool, redis, log } = deps;

  /**
   * Runs `fn` in the per-user, de-duplicated transaction; `fn` returns the personal bests it
   * changed, which are announced as pb.updated after commit.
   */
  async function inUserTx(eventId: string, userId: string, fn: (c: PoolClient) => Promise<PbChange[] | void>): Promise<void> {
    const changes = await withTx(pool, async (c) => {
      await lockUser(c, userId);
      if (!(await markProcessed(c, eventId))) {
        log.debug({ eventId }, 'duplicate event skipped');
        return [];
      }
      return (await fn(c)) ?? [];
    });
    for (const change of changes) {
      await publishEvent(redis, 'pb.updated', { eventId: newEventId('stats'), ...change });
    }
  }

  /** Validates a payload; malformed (non-retriable) events go straight to the dead-letter stream. */
  async function payload<T>(schema: ZodType<T, ZodTypeDef, unknown>, evt: EventEnvelope): Promise<T | null> {
    const res = schema.safeParse(evt.data);
    if (res.success) return res.data;
    const issue = res.error.issues[0];
    const error = `invalid payload: ${issue.path.join('.')}: ${issue.message}`;
    log.error({ type: evt.type, id: evt.id, error }, 'malformed event moved to dead-letter stream');
    await redis.xadd(DLQ_STREAM, 'MAXLEN', '~', '10000', '*', 'group', 'stats', 'type', evt.type, 'data', JSON.stringify(evt.data), 'error', error);
    return null;
  }

  // ---- user.registered / user.updated: keep the display name; counters untouched
  async function onUser(evt: EventEnvelope) {
    const d = await payload(userEventSchema, evt);
    if (!d) return;
    await inUserTx(d.eventId, d.userId, async (c) => {
      await ensureUser(c, d.userId, d.username);
      if (d.createdAt) {
        await c.query('UPDATE stats.user_totals SET registered_at = LEAST(registered_at, $2) WHERE user_id = $1', [d.userId, d.createdAt]);
      }
    });
  }

  // ---- solve.created: totals, activity, time of day and personal bests
  async function onSolveCreated(evt: EventEnvelope) {
    const d = await payload(solveCreatedSchema, evt);
    if (!d) return;
    await inUserTx(d.eventId, d.userId, (c) => applySolveCreated(c, d));
  }

  async function applySolveCreated(c: PoolClient, d: SolveCreated): Promise<PbChange[]> {
    const user = await ensureUser(c, d.userId, d.username);
    const eff = effectiveMs(d);
    const effDb = Number.isFinite(eff) ? eff : null;

    // aggregates (raw timeMs = time spent cubing; hourly mean uses effective times of non-DNF solves),
    // days and hours in the timezone the solve was made in
    const at = new Date(d.createdAt);
    const { day, hour } = makeBucketer(validTz(d.tz) ?? 'UTC')(at);
    await c.query(
      `UPDATE stats.user_totals
          SET solves = solves + 1, total_ms = total_ms + $2,
              first_solve_at = LEAST(first_solve_at, $3), last_solve_at = GREATEST(last_solve_at, $3)
        WHERE user_id = $1`,
      [d.userId, d.timeMs, d.createdAt],
    );
    await c.query(
      `INSERT INTO stats.daily_activity (user_id, day, event, solves, total_ms) VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT (user_id, day, event) DO UPDATE
         SET solves = stats.daily_activity.solves + 1, total_ms = stats.daily_activity.total_ms + EXCLUDED.total_ms`,
      [d.userId, day, d.event, d.timeMs],
    );
    await c.query(
      `INSERT INTO stats.hourly (user_id, event, hour, solves, sum_ms) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, event, hour) DO UPDATE
         SET solves = stats.hourly.solves + EXCLUDED.solves, sum_ms = stats.hourly.sum_ms + EXCLUDED.sum_ms`,
      [d.userId, d.event, hour, effDb === null ? 0 : 1, effDb ?? 0],
    );

    // PB candidates: single from this solve; ao5/ao12 from the payload's rolling values (computed
    // by solve-service over the session, including this solve)
    const candidates: Partial<Record<PbKind, number | null>> = {
      single: effDb,
      ao5: rollingFromPayload(d.rolling?.ao5),
      ao12: rollingFromPayload(d.rolling?.ao12),
    };

    const current = await loadPbs(c, d.userId, d.event);
    const achievedAt = at.toISOString();
    const changes: PbChange[] = [];
    for (const [kind, value] of Object.entries(candidates) as [PbKind, number | null][]) {
      const prev = current.get(kind);
      if (!isImprovement(value, prev?.value_ms)) continue;
      const valueMs = value as number;
      await upsertPb(c, d.userId, d.event, kind, valueMs, d.solveId, achievedAt);
      await c.query(
        'INSERT INTO stats.pb_history (user_id, event, kind, value_ms, achieved_at) VALUES ($1, $2, $3, $4, $5)',
        [d.userId, d.event, kind, valueMs, achievedAt],
      );
      changes.push({
        userId: d.userId, username: user.username, event: d.event, kind,
        valueMs, previousMs: prev?.value_ms ?? null, achievedAt,
      });
    }
    return changes;
  }

  return async function handle(evt: EventEnvelope): Promise<void> {
    switch (evt.type) {
      case 'user.registered':
      case 'user.updated':
        return onUser(evt);
      case 'solve.created':
        return onSolveCreated(evt);
      default:
        return;
    }
  };
}
