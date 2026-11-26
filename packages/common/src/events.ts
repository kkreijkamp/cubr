import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';

/** The single domain-event stream (see docs/SPEC.md section 8). */
export const EVENT_STREAM = 'cubr:events';
export const DLQ_STREAM = 'cubr:events:dlq';
export const EVENT_STREAM_MAXLEN = 200_000;

export type EventData = Record<string, unknown> & { eventId: string; occurredAt: string };

export interface EventEnvelope<T extends Record<string, unknown> = Record<string, any>> {
  /** Redis stream entry id */
  id: string;
  type: string;
  data: T & { eventId: string; occurredAt: string };
  /** Set on a replayed dead letter (deadLetters.ts): only this consumer group handles it. */
  group?: string;
}

export function newEventId(service: string): string {
  return `${service}-${randomUUID()}`;
}

/** Appends a domain event to the stream. `data.eventId` defaults to a fresh id. */
export async function publishEvent(
  redis: Redis,
  type: string,
  data: Record<string, unknown>,
): Promise<string> {
  const payload = {
    ...data,
    eventId: (data.eventId as string | undefined) ?? newEventId('evt'),
    occurredAt: (data.occurredAt as string | undefined) ?? new Date().toISOString(),
  };
  const id = await redis.xadd(EVENT_STREAM, 'MAXLEN', '~', String(EVENT_STREAM_MAXLEN), '*', 'type', type, 'data', JSON.stringify(payload));
  return id as string;
}

export interface ConsumerOptions {
  /** Consumer group name, e.g. 'stats'. All replicas of a service share one group. */
  group: string;
  /** Unique consumer name per replica (use the pod name). */
  consumer: string;
  handler: (evt: EventEnvelope) => Promise<void>;
  /** Only these event types reach the handler; other entries are acknowledged and skipped. */
  types?: string[];
  log: FastifyBaseLogger;
  batchSize?: number;
  blockMs?: number;
  /** Pending entries idle longer than this (owned by a crashed pod, or waiting for a retry) are reclaimed. */
  claimIdleMs?: number;
  /** A failed entry is tried again after this long, doubling with each failure up to maxRetryMs. */
  retryMs?: number;
  maxRetryMs?: number;
  /** An entry moves to the dead-letter stream once it has failed this many times... */
  maxAttempts?: number;
  /** ...and its first failure is at least this old, so an outage of a dependency doesn't dead-letter it. */
  deadLetterAfterMs?: number;
  /** Where a newly created group starts: '0' = whole retained history (default), '$' = new only. */
  startFrom?: '0' | '$';
}

export interface Consumer {
  stop(): Promise<void>;
  stats(): { processed: number; failed: number; lastEventAt: string | null };
}

type RawEntry = [string, string[] | null];

/** Where a failing entry stands: failures so far, the first one's time and when the next try is due (ms). */
interface RetryState {
  n: number;
  first: number;
  next: number;
}

/** The hash key holding a group's retry states, one field per pending entry that failed. */
export const retryStateKey = (group: string) => `${EVENT_STREAM}:attempts:${group}`;

function readRetryState(raw: string | null | undefined, now: number): RetryState | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return { n: Number(raw), first: now, next: 0 }; // a bare count, from before v1.6.27
  try {
    const v = JSON.parse(raw) as Partial<RetryState>;
    return typeof v.n === 'number' && typeof v.first === 'number' && typeof v.next === 'number' ? (v as RetryState) : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a Redis Streams consumer-group loop: at-least-once delivery, horizontal scaling across
 * replicas (each entry goes to one consumer in the group), automatic reclaim of entries left
 * pending by dead consumers, retries spaced out per entry, and a dead-letter stream for what still
 * fails a day later (deadLetters.ts lists and replays it). Handlers must be idempotent.
 */
export function consumeEvents(redis: Redis, opts: ConsumerOptions): Consumer {
  const conn = redis.duplicate(); // blocking XREADGROUP needs a dedicated connection
  const log = opts.log;
  let lastConnErr = 0;
  conn.on('error', (err) => {
    // the loop below already backs off; just avoid an unhandled-error flood while Redis is down
    if (Date.now() - lastConnErr > 10_000) {
      lastConnErr = Date.now();
      log.warn({ err: err.message, group: opts.group }, 'event consumer redis connection error');
    }
  });
  const batch = opts.batchSize ?? 50;
  const blockMs = opts.blockMs ?? 5000;
  const claimIdleMs = opts.claimIdleMs ?? 60_000;
  const retryMs = opts.retryMs ?? claimIdleMs;
  const maxRetryMs = opts.maxRetryMs ?? 10 * 60_000;
  const maxAttempts = opts.maxAttempts ?? 5;
  const deadLetterAfterMs = opts.deadLetterAfterMs ?? 24 * 60 * 60_000;
  const attemptsKey = retryStateKey(opts.group);

  let running = true;
  let groupReady = false;
  let processed = 0;
  let failed = 0;
  let lastEventAt: string | null = null;
  let inHandler = false;
  let claimCursor = '0-0';
  let lastClaim = 0;
  /** a backlog of pending entries is being worked through: reclaim again straight away */
  let draining = false;

  async function ensureGroup() {
    if (groupReady) return;
    try {
      await conn.xgroup('CREATE', EVENT_STREAM, opts.group, opts.startFrom ?? '0', 'MKSTREAM');
      log.info({ group: opts.group }, 'created consumer group');
    } catch (err) {
      if (!String((err as Error).message).includes('BUSYGROUP')) throw err;
    }
    groupReady = true;
  }

  function parseEntry(id: string, fields: string[]): EventEnvelope | null {
    let type = '';
    let data = '';
    let group: string | undefined;
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i] === 'type') type = fields[i + 1];
      else if (fields[i] === 'data') data = fields[i + 1];
      else if (fields[i] === 'group') group = fields[i + 1];
    }
    if (!type || !data) return null;
    try {
      return { id, type, data: JSON.parse(data), ...(group ? { group } : {}) };
    } catch {
      return null;
    }
  }

  /** A failure: the entry waits for its next try, or moves to the dead-letter stream once it's due to. */
  async function recordFailure(evt: EventEnvelope, state: RetryState | null, err: Error) {
    const now = Date.now();
    const n = (state?.n ?? 0) + 1;
    const first = state?.first ?? now;
    if (n >= maxAttempts && now - first >= deadLetterAfterMs) {
      await conn
        .multi()
        .xadd(DLQ_STREAM, 'MAXLEN', '~', '10000', '*', 'group', opts.group, 'type', evt.type, 'data', JSON.stringify(evt.data), 'error', err.message, 'attempts', String(n), 'firstFailedAt', new Date(first).toISOString())
        .xack(EVENT_STREAM, opts.group, evt.id)
        .hdel(attemptsKey, evt.id)
        .exec();
      log.error({ err: err.message, type: evt.type, id: evt.id, attempts: n }, 'event moved to dead-letter stream');
      return;
    }
    const delay = Math.min(retryMs * 2 ** (n - 1), maxRetryMs);
    await conn.hset(attemptsKey, evt.id, JSON.stringify({ n, first, next: now + delay }));
    log.warn({ err: err.message, type: evt.type, id: evt.id, attempts: n, retryInMs: delay }, 'event handler failed');
  }

  /** Handles entries in order; `reclaimed` ones may be retries, whose state says whether they're due. */
  async function handleEntries(entries: RawEntry[], reclaimed = false): Promise<{ ok: number; failed: number }> {
    const result = { ok: 0, failed: 0 };
    const states = new Map<string, RetryState>();
    if (reclaimed) {
      const ids = entries.filter((e) => e?.[1]).map((e) => e[0]);
      const raw = ids.length ? await conn.hmget(attemptsKey, ...ids) : [];
      const now = Date.now();
      ids.forEach((id, i) => {
        const state = readRetryState(raw[i], now);
        if (state) states.set(id, state);
      });
    }
    for (const entry of entries) {
      if (!running) break; // stopping: the rest stays pending, for whoever reads next
      if (!entry) continue;
      const [id, fields] = entry;
      if (!fields) continue; // trimmed from the stream (Redis 6 returns [id, null])
      const evt = parseEntry(id, fields);
      if (!evt) {
        log.warn({ id, group: opts.group }, 'malformed event entry acknowledged and skipped');
        await conn.xack(EVENT_STREAM, opts.group, id);
        continue;
      }
      if ((evt.group && evt.group !== opts.group) || (opts.types && !opts.types.includes(evt.type))) {
        await conn.xack(EVENT_STREAM, opts.group, id);
        continue;
      }
      const state = states.get(id) ?? null;
      if (state && state.next > Date.now()) continue; // its next try isn't due: it stays pending
      inHandler = true;
      try {
        await opts.handler(evt);
        await conn.xack(EVENT_STREAM, opts.group, id);
        processed++;
        result.ok++;
        lastEventAt = new Date().toISOString();
        // whichever replica succeeds clears the retry state, not only the one that saw the failure
        if (state) await conn.hdel(attemptsKey, id);
      } catch (err) {
        failed++;
        result.failed++;
        await recordFailure(evt, state, err as Error);
      } finally {
        inHandler = false;
      }
    }
    return result;
  }

  async function reclaimStale() {
    if (!draining && Date.now() - lastClaim < 15_000) return;
    lastClaim = Date.now();
    const res = (await conn.xautoclaim(EVENT_STREAM, opts.group, opts.consumer, claimIdleMs, claimCursor, 'COUNT', batch)) as unknown as [
      string,
      RawEntry[],
      string[]?,
    ];
    claimCursor = res[0] ?? '0-0';
    // entries trimmed from the stream while pending: Redis 7 drops them from the group, their retry state goes too
    if (res[2]?.length) await conn.hdel(attemptsKey, ...res[2]);
    const r = await handleEntries(res[1] ?? [], true);
    if (r.ok || r.failed) log.info({ ok: r.ok, failed: r.failed }, 'handled reclaimed pending events');
    // a backlog (after an outage, or a crashed replica's) drains batch after batch while the handler succeeds
    draining = running && r.ok > 0 && r.failed === 0 && claimCursor !== '0-0';
  }

  const loop = (async () => {
    let backoff = 500;
    while (running) {
      try {
        await ensureGroup();
        await reclaimStale();
        if (!running) break;
        // while draining, new entries are read without waiting, so the backlog keeps moving
        const res = (
          draining
            ? await conn.xreadgroup('GROUP', opts.group, opts.consumer, 'COUNT', batch, 'STREAMS', EVENT_STREAM, '>')
            : await conn.xreadgroup('GROUP', opts.group, opts.consumer, 'COUNT', batch, 'BLOCK', blockMs, 'STREAMS', EVENT_STREAM, '>')
        ) as [string, RawEntry[]][] | null;
        if (res) for (const [, entries] of res) await handleEntries(entries);
        backoff = 500;
      } catch (err) {
        if (!running) break;
        const msg = String((err as Error).message);
        if (msg.includes('NOGROUP')) groupReady = false;
        draining = false;
        log.warn({ err: msg }, `event consumer error, retrying in ${backoff}ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 5000);
      }
    }
  })();

  return {
    async stop() {
      running = false;
      const deadline = Date.now() + 5000;
      while (inHandler && Date.now() < deadline) await sleep(50);
      conn.disconnect();
      await Promise.race([loop, sleep(1000)]);
    },
    stats: () => ({ processed, failed, lastEventAt }),
  };
}
