import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DLQ_STREAM, EVENT_STREAM, EVENT_STREAM_MAXLEN } from './events.js';
import { requireInternal } from './internal.js';
import type { Redis } from './redis.js';
import { parse } from './validate.js';

/**
 * The dead-letter stream (`cubr:events:dlq`): the entries a consumer group still couldn't handle a day
 * after the first failure (events.ts). Each service that consumes events can list its group's dead
 * letters and put them back on the event stream for its group alone, once the cause is fixed:
 * deploy/vps/dead-letters.sh calls the routes below from inside the service's container.
 */
export interface DeadLetter {
  /** the dead letter's own stream id (its time is when it was dead-lettered) */
  id: string;
  deadAt: string;
  group: string;
  type: string;
  error: string;
  attempts: number | null;
  firstFailedAt: string | null;
  data: unknown;
}

type Raw = DeadLetter & { rawData: string };

const fieldsOf = (raw: string[]) => {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < raw.length; i += 2) out[raw[i]] = raw[i + 1];
  return out;
};

async function readGroup(redis: Redis, group: string): Promise<Raw[]> {
  // one stream for every group, capped at about 10,000 entries: read whole, filtered here
  const entries = (await redis.xrange(DLQ_STREAM, '-', '+')) as [string, string[]][];
  const out: Raw[] = [];
  for (const [id, raw] of entries) {
    const f = fieldsOf(raw ?? []);
    if (f.group !== group) continue;
    let data: unknown = f.data;
    try {
      data = JSON.parse(f.data);
    } catch {
      /* kept as the string it is */
    }
    out.push({
      id,
      deadAt: new Date(Number(id.split('-')[0])).toISOString(),
      group,
      type: f.type ?? '',
      error: f.error ?? '',
      attempts: f.attempts ? Number(f.attempts) : null,
      firstFailedAt: f.firstFailedAt ?? null,
      data,
      rawData: f.data ?? '',
    });
  }
  return out;
}

/** A consumer group's dead letters, oldest first. */
export async function listDeadLetters(redis: Redis, group: string): Promise<DeadLetter[]> {
  return (await readGroup(redis, group)).map(({ rawData: _raw, ...letter }) => letter);
}

/**
 * Puts a group's dead letters (all of them, or those with the given ids) back on the event stream,
 * marked for that group alone (the other groups skip them), and removes them from the dead-letter
 * stream. Returns the ids replayed.
 */
export async function replayDeadLetters(redis: Redis, group: string, ids?: string[]): Promise<string[]> {
  const wanted = ids ? new Set(ids) : null;
  const letters = (await readGroup(redis, group)).filter((l) => !wanted || wanted.has(l.id));
  for (const l of letters) {
    const res = await redis
      .multi()
      .xadd(EVENT_STREAM, 'MAXLEN', '~', String(EVENT_STREAM_MAXLEN), '*', 'type', l.type, 'data', l.rawData, 'group', group)
      .xdel(DLQ_STREAM, l.id)
      .exec();
    const err = res?.find(([e]) => e)?.[0];
    if (err) throw err;
  }
  return letters.map((l) => l.id);
}

const replayBody = z.object({ ids: z.array(z.string().regex(/^\d+-\d+$/, 'expected a stream id')).min(1).max(10_000).optional() });

/** GET /internal/events/dead-letters and POST /internal/events/dead-letters/replay, for one consumer group. */
export function registerDeadLetterRoutes(app: FastifyInstance, deps: { redis: Redis; group: string; internalToken: string }): void {
  const { redis, group } = deps;
  const internalOnly = { preHandler: requireInternal(deps.internalToken, app.log) };
  app.get('/internal/events/dead-letters', internalOnly, async () => ({ group, deadLetters: await listDeadLetters(redis, group) }));
  app.post('/internal/events/dead-letters/replay', internalOnly, async (req) => {
    const { ids } = parse(replayBody, req.body ?? {});
    const replayed = await replayDeadLetters(redis, group, ids);
    req.log.warn({ group, count: replayed.length }, 'dead letters replayed');
    return { group, replayed };
  });
}
