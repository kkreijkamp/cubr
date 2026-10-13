import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';

/** The single domain-event stream (see docs/SPEC.md §8). */
export const EVENT_STREAM = 'cubetype:events';
export const DLQ_STREAM = 'cubetype:events:dlq';
const MAXLEN = 200_000;

export type EventData = Record<string, unknown> & { eventId: string; occurredAt: string };

export interface EventEnvelope<T extends Record<string, unknown> = Record<string, any>> {
  /** Redis stream entry id */
  id: string;
  type: string;
  data: T & { eventId: string; occurredAt: string };
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
  const id = await redis.xadd(EVENT_STREAM, 'MAXLEN', '~', String(MAXLEN), '*', 'type', type, 'data', JSON.stringify(payload));
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
  /** Pending entries idle longer than this (e.g. owned by a crashed pod) are reclaimed. */
  claimIdleMs?: number;
  /** After this many failed attempts an entry is moved to the dead-letter stream. */
  maxAttempts?: number;
  /** Where a newly created group starts: '0' = whole retained history (default), '$' = new only. */
  startFrom?: '0' | '$';
}

export interface Consumer {
  stop(): Promise<void>;
  stats(): { processed: number; failed: number; lastEventAt: string | null };
}

type RawEntry = [string, string[]];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a Redis Streams consumer-group loop: at-least-once delivery, horizontal scaling across
 * replicas (each entry goes to one consumer in the group), automatic reclaim of entries left
 * pending by dead consumers, retry with a dead-letter stream for poison messages.
 * Handlers must be idempotent.
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
  const maxAttempts = opts.maxAttempts ?? 5;
  const attemptsKey = `${EVENT_STREAM}:attempts:${opts.group}`;

  let running = true;
  let groupReady = false;
  let processed = 0;
  let failed = 0;
  let lastEventAt: string | null = null;
  let inHandler = false;
  let claimCursor = '0-0';
  let lastClaim = 0;
  const retried = new Set<string>();

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

  function parseEntry([id, fields]: RawEntry): EventEnvelope | null {
    let type = '';
    let data = '';
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i] === 'type') type = fields[i + 1];
      else if (fields[i] === 'data') data = fields[i + 1];
    }
    if (!type || !data) return null;
    try {
      return { id, type, data: JSON.parse(data) };
    } catch {
      return null;
    }
  }

  async function handleEntries(entries: RawEntry[]) {
    for (const entry of entries) {
      if (!entry || !entry[1]) continue; // deleted (trimmed) entries come back as [id, null]
      const id = entry[0];
      const evt = parseEntry(entry);
      if (!evt || (opts.types && !opts.types.includes(evt.type))) {
        await conn.xack(EVENT_STREAM, opts.group, id);
        continue;
      }
      inHandler = true;
      try {
        await opts.handler(evt);
        await conn.xack(EVENT_STREAM, opts.group, id);
        processed++;
        lastEventAt = new Date().toISOString();
        if (retried.has(id)) {
          retried.delete(id);
          await conn.hdel(attemptsKey, id);
        }
      } catch (err) {
        failed++;
        retried.add(id);
        const attempts = await conn.hincrby(attemptsKey, id, 1);
        log.warn({ err: (err as Error).message, type: evt.type, id, attempts }, 'event handler failed');
        if (attempts >= maxAttempts) {
          await conn.xadd(DLQ_STREAM, 'MAXLEN', '~', '10000', '*', 'group', opts.group, 'type', evt.type, 'data', JSON.stringify(evt.data), 'error', String((err as Error).message));
          await conn.xack(EVENT_STREAM, opts.group, id);
          await conn.hdel(attemptsKey, id);
          retried.delete(id);
          log.error({ type: evt.type, id }, 'event moved to dead-letter stream');
        }
      } finally {
        inHandler = false;
      }
    }
  }

  async function reclaimStale() {
    if (Date.now() - lastClaim < 15_000) return;
    lastClaim = Date.now();
    const res = (await conn.xautoclaim(EVENT_STREAM, opts.group, opts.consumer, claimIdleMs, claimCursor, 'COUNT', batch)) as unknown as [string, RawEntry[]];
    claimCursor = res[0] ?? '0-0';
    if (res[1]?.length) {
      log.info({ count: res[1].length }, 'reclaimed stale pending events');
      await handleEntries(res[1]);
    }
  }

  const loop = (async () => {
    let backoff = 500;
    while (running) {
      try {
        await ensureGroup();
        await reclaimStale();
        const res = (await conn.xreadgroup('GROUP', opts.group, opts.consumer, 'COUNT', batch, 'BLOCK', blockMs, 'STREAMS', EVENT_STREAM, '>')) as [string, RawEntry[]][] | null;
        if (res) for (const [, entries] of res) await handleEntries(entries);
        backoff = 500;
      } catch (err) {
        if (!running) break;
        const msg = String((err as Error).message);
        if (msg.includes('NOGROUP')) groupReady = false;
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
