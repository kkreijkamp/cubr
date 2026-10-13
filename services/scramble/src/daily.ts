import type { FastifyBaseLogger } from 'fastify';
import { HttpError, unavailable, type Pool } from '@cubetype/common';
import { DAILY_EVENTS } from '@cubetype/cubestats';
import type { ScrambleGenerator } from './generator.js';
import { errorMessage } from './util.js';

export const DAILY_SCRAMBLES = 5;
const CACHE_TTL_MS = 60_000;

export interface DailyResponse {
  date: string;
  events: Record<string, string[]>;
}

/**
 * Daily challenge: 5 scrambles per DAILY_EVENTS event, generated once and persisted so every user
 * (and every replica) sees the same set. The first request of a day generates missing rows and
 * inserts them with ON CONFLICT DO NOTHING, then re-reads — if two replicas race, the first insert
 * wins and both return the winner's scrambles.
 */
export class DailyChallenges {
  private readonly cache = new Map<string, { body: DailyResponse; expires: number }>();
  private readonly inflight = new Map<string, Promise<DailyResponse>>();

  constructor(
    private readonly deps: {
      pool: Pool;
      generator: ScrambleGenerator;
      isMigrated: () => boolean;
      log: FastifyBaseLogger;
    },
  ) {}

  async get(date: string): Promise<DailyResponse> {
    const hit = this.cache.get(date);
    if (hit && hit.expires > Date.now()) return hit.body;

    // concurrent requests on this replica share one load
    let load = this.inflight.get(date);
    if (!load) {
      load = this.load(date).finally(() => this.inflight.delete(date));
      this.inflight.set(date, load);
    }
    try {
      const body = await load;
      this.remember(date, body);
      return body;
    } catch (err) {
      if (err instanceof HttpError && err.statusCode < 500) throw err;
      if (hit) {
        // DB hiccup: the persisted set never changes, so a stale copy is still correct
        this.deps.log.warn({ date, err: errorMessage(err) }, 'serving cached daily challenge');
        return hit.body;
      }
      if (err instanceof HttpError) throw err;
      this.deps.log.warn({ date, err: errorMessage(err) }, 'daily challenge unavailable');
      throw unavailable('Daily challenge unavailable: database not reachable');
    }
  }

  private async load(date: string): Promise<DailyResponse> {
    if (!this.deps.isMigrated()) throw unavailable('Daily challenge unavailable: database not ready');
    let rows = await this.select(date);
    const missing = DAILY_EVENTS.filter((event) => !rows.has(event));
    if (missing.length > 0) {
      for (const event of missing) {
        const scrambles = await this.deps.generator.generateMany(event, DAILY_SCRAMBLES, 'request');
        await this.deps.pool.query(
          `insert into scramble.daily_challenges (day, event, scrambles) values ($1, $2, $3)
           on conflict (day, event) do nothing`,
          [date, event, scrambles],
        );
      }
      this.deps.log.info({ date, events: missing }, 'generated daily challenge scrambles');
      rows = await this.select(date);
    }
    const events: Record<string, string[]> = {};
    for (const event of DAILY_EVENTS) {
      const scrambles = rows.get(event);
      if (!scrambles) throw new Error(`daily challenge row missing for ${event}`);
      events[event] = scrambles;
    }
    return { date, events };
  }

  private async select(date: string): Promise<Map<string, string[]>> {
    const { rows } = await this.deps.pool.query<{ event: string; scrambles: string[] }>(
      'select event, scrambles from scramble.daily_challenges where day = $1 and event = any($2)',
      [date, DAILY_EVENTS],
    );
    return new Map(rows.map((r) => [r.event, r.scrambles]));
  }

  private remember(date: string, body: DailyResponse) {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      // keep expired entries a little longer as a fallback for DB outages, but bound the map
      if (entry.expires < now - 3600_000) this.cache.delete(key);
    }
    this.cache.set(date, { body, expires: now + CACHE_TTL_MS });
  }
}
