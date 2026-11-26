import { fetchJson, internalHeaders, type PoolClient } from '@cubr/common';
import { effectiveMs } from '@cubr/cubestats';
import type { FastifyBaseLogger } from 'fastify';
import { bucketSolves } from './domain/buckets.js';
import { computePbs, PB_KINDS, replayHistory, type ListSolve } from './domain/pbs.js';
import { loadPbs, queuePbUpdated, queuePeriodsChanged, upsertPb } from './store.js';

export interface RecomputeDeps {
  solveUrl: string;
  /** solves per page from solve-service (SOLVE_PAGE; smaller in tests) */
  pageSize?: number;
  /** sent as X-Internal-Token to solve-service's /internal routes */
  internalToken: string;
  log: FastifyBaseLogger;
}

/**
 * All of a user's solves for one event from solve-service (ordered by session, created_at).
 * Throws on any failure (-> the stream entry stays pending and is retried). That includes a 404:
 * solve-service answers an unknown user with an empty list, so a 404 means the request went
 * somewhere else (e.g. SOLVE_URL pointing at the gateway, which answers /internal/* with 404),
 * and treating it as "no solves" would wipe the user's stats for the event.
 */
export async function fetchSolveList(deps: RecomputeDeps, userId: string, event: string): Promise<ListSolve[]> {
  // In pages, kept as they come: the whole list as one answer, read through the schema (which copies
  // every solve), ran a 192 MB heap out at 200k solves; this way the 250k cap fits (measured 2026-11-26).
  const out: ListSolve[] = [];
  const sessions = new Map<string, string>();
  let after: string | null = null;
  do {
    const url: string =
      `${deps.solveUrl}/internal/users/${encodeURIComponent(userId)}/solves?event=${encodeURIComponent(event)}&limit=${deps.pageSize ?? SOLVE_PAGE}` +
      (after ? `&after=${encodeURIComponent(after)}` : '');
    const body = await fetchJson<unknown>(url, { timeoutMs: 15_000, retries: 1, headers: internalHeaders(deps.internalToken) });
    after = readSolvePage(body, out, sessions);
  } while (after);
  return out;
}

/** Solves per page from solve-service (its INTERNAL_SOLVES_PAGE). */
export const SOLVE_PAGE = 50_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENALTIES = new Set(['OK', '+2', 'DNF']);

/**
 * Checks one page of solve-service's list (the same rules as solveListSchema) and appends its solves to
 * `out` as they are, without copies; every solve of a session shares one copy of its id (`sessions`).
 * Returns the next page's cursor, null after the last (or from a solve-service that answers in one go).
 */
export function readSolvePage(body: unknown, out: ListSolve[], sessions: Map<string, string>): string | null {
  const page = body as { solves?: unknown; next?: unknown } | null;
  if (!page || !Array.isArray(page.solves)) throw new Error('solve list: no solves array');
  for (const s of page.solves as Record<string, unknown>[]) {
    if (
      !s ||
      typeof s.id !== 'string' ||
      !UUID.test(s.id) ||
      typeof s.sessionId !== 'string' ||
      !UUID.test(s.sessionId) ||
      !Number.isInteger(s.timeMs) ||
      (s.timeMs as number) <= 0 ||
      !PENALTIES.has(s.penalty as string) ||
      typeof s.createdAt !== 'string' ||
      Number.isNaN(Date.parse(s.createdAt)) ||
      (s.practice !== undefined && typeof s.practice !== 'boolean')
    )
      throw new Error(`solve list: a malformed solve (${JSON.stringify(s).slice(0, 200)})`);
    const sid = sessions.get(s.sessionId) ?? (sessions.set(s.sessionId, s.sessionId), s.sessionId);
    s.sessionId = sid;
    out.push(s as unknown as ListSolve);
  }
  if (page.next !== undefined && page.next !== null && typeof page.next !== 'string') throw new Error('solve list: a malformed cursor');
  return (page.next as string | null | undefined) || null;
}

/** Ledger rows per INSERT in a recompute. */
const LEDGER_BATCH = 20_000;

export interface RecomputeArgs {
  userId: string;
  username: string;
  event: string;
  tz: string;
}

/**
 * Full rebuild of one (user, event) from the authoritative solve list: solve ledger,
 * daily_activity, hourly, personal_bests (+ pb.updated for every changed row), pb_history
 * (chronological replay) and a periods.changed for the leaderboard's day and week boards. Runs
 * inside the caller's transaction, under the per-user lock.
 * user_totals is refreshed by the caller once all events are done.
 */
export async function recomputeEvent(c: PoolClient, deps: RecomputeDeps, args: RecomputeArgs): Promise<{ solves: number; pbChanges: number; queued: number }> {
  const { userId, username, event, tz } = args;
  const started = Date.now();
  const fetched = await fetchSolveList(deps, userId, event);
  // defensive de-duplication by solve id (keeps the first occurrence)
  const seen = new Set<string>();
  const solves = fetched.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  const fetchedAt = Date.now();

  // 1. solve ledger for this event = exactly the current list
  await c.query('DELETE FROM stats.solve_ledger WHERE user_id = $1 AND event = $2 AND NOT deleted', [userId, event]);
  // in batches: one statement's parameters for 250k solves are tens of MB of text
  for (let i = 0; i < solves.length; i += LEDGER_BATCH) {
    const part = solves.slice(i, i + LEDGER_BATCH);
    await c.query(
      `INSERT INTO stats.solve_ledger (solve_id, user_id, event, session_id, time_ms, effective_ms, created_at)
       SELECT u.id, $1, $2, u.sid, u.t, u.e, u.c
         FROM unnest($3::uuid[], $4::uuid[], $5::int[], $6::int[], $7::timestamptz[]) WITH ORDINALITY AS u(id, sid, t, e, c, ord)
        ORDER BY u.ord
       ON CONFLICT (solve_id) DO UPDATE
         SET user_id = EXCLUDED.user_id, event = EXCLUDED.event, session_id = EXCLUDED.session_id,
             time_ms = EXCLUDED.time_ms, effective_ms = EXCLUDED.effective_ms,
             created_at = EXCLUDED.created_at, deleted = false`,
      [
        userId,
        event,
        part.map((s) => s.id),
        part.map((s) => s.sessionId),
        part.map((s) => s.timeMs),
        part.map((s) => {
          const e = effectiveMs(s);
          return Number.isFinite(e) ? e : null;
        }),
        part.map((s) => s.createdAt),
      ],
    );
  }

  // 1b. which of the listed sessions are practice ones (the profile chart's PB line leaves them out)
  const listed = [...new Set(solves.map((s) => s.sessionId))];
  if (listed.length) {
    const practice = [...new Set(solves.filter((s) => s.practice).map((s) => s.sessionId))];
    await c.query(
      `UPDATE stats.sessions SET practice = (session_id = ANY($3::uuid[])), updated_at = now()
        WHERE user_id = $1 AND session_id = ANY($2::uuid[]) AND practice <> (session_id = ANY($3::uuid[]))`,
      [userId, listed, practice],
    );
  }

  // 2. daily_activity + hourly, bucketed in the user's timezone
  const { days, hours } = bucketSolves(solves, tz);
  await c.query('DELETE FROM stats.daily_activity WHERE user_id = $1 AND event = $2', [userId, event]);
  if (days.length) {
    await c.query(
      `INSERT INTO stats.daily_activity (user_id, day, event, solves, total_ms)
       SELECT $1, u.d, $2, u.n, u.t FROM unnest($3::date[], $4::int[], $5::bigint[]) AS u(d, n, t)`,
      [userId, event, days.map((d) => d.day), days.map((d) => d.solves), days.map((d) => d.totalMs)],
    );
  }
  await c.query('DELETE FROM stats.hourly WHERE user_id = $1 AND event = $2', [userId, event]);
  if (hours.length) {
    await c.query(
      `INSERT INTO stats.hourly (user_id, event, hour, solves, sum_ms, dnfs)
       SELECT $1, $2, u.h, u.n, u.s, u.x FROM unnest($3::smallint[], $4::int[], $5::bigint[], $6::int[]) AS u(h, n, s, x)`,
      [userId, event, hours.map((h) => h.hour), hours.map((h) => h.solves), hours.map((h) => h.sumMs), hours.map((h) => h.dnfs)],
    );
  }

  // 3. personal bests (practice sessions left out): diff against the stored rows, emit pb.updated
  //    for every change
  const next = computePbs(solves);
  const prev = await loadPbs(c, userId, event);
  let pbChanges = 0;
  for (const kind of PB_KINDS) {
    const o = prev.get(kind);
    const n = next[kind];
    if (!o && !n) continue;
    if (o && !n) {
      await c.query('DELETE FROM stats.personal_bests WHERE user_id = $1 AND event = $2 AND kind = $3', [userId, event, kind]);
      await queuePbUpdated(c, { userId, username, event, kind, valueMs: null, previousMs: o.value_ms, achievedAt: null });
      pbChanges++;
      continue;
    }
    if (!n) continue;
    const valueChanged = !o || o.value_ms !== n.valueMs || o.achieved_at.getTime() !== Date.parse(n.achievedAt);
    if (valueChanged || o.solve_id !== n.solveId) {
      await upsertPb(c, userId, event, kind, n.valueMs, n.solveId, n.achievedAt);
    }
    if (valueChanged) {
      await queuePbUpdated(c, {
        userId,
        username,
        event,
        kind,
        valueMs: n.valueMs,
        previousMs: o ? o.value_ms : null,
        achievedAt: n.achievedAt,
      });
      pbChanges++;
    }
  }

  // 4. PB progression rebuilt by replaying the solves chronologically
  const history = replayHistory(solves);
  await c.query('DELETE FROM stats.pb_history WHERE user_id = $1 AND event = $2', [userId, event]);
  if (history.length) {
    await c.query(
      `INSERT INTO stats.pb_history (user_id, event, kind, value_ms, achieved_at)
       SELECT $1, $2, u.k, u.v, u.a FROM unnest($3::text[], $4::int[], $5::timestamptz[]) WITH ORDINALITY AS u(k, v, a, ord)
        ORDER BY u.ord`,
      [userId, event, history.map((h) => h.kind), history.map((h) => h.valueMs), history.map((h) => h.achievedAt)],
    );
  }

  // 5. the day and week bests may have changed too (a deleted solve, a penalty, a session gone...)
  await queuePeriodsChanged(c, { userId, username, event });

  deps.log.info(
    { userId, event, solves: solves.length, pbChanges, history: history.length, fetchMs: fetchedAt - started, totalMs: Date.now() - started },
    'recomputed user event',
  );
  // queued = outbox rows (the caller flushes the outbox when there are any)
  return { solves: solves.length, pbChanges, queued: pbChanges + 1 };
}
