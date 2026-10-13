import { fetchJson, type FetchOptions } from '@cubetype/common';
import type { FastifyBaseLogger } from 'fastify';
import type { Kind } from './keys.js';

// ---------------------------------------------------------------------------------------------
// Anti-cheat floors: nobody beats the WCA world record on a phone timer. Values strictly below
// the WR for that event/kind are rejected (and logged to lb:flagged) instead of being ranked.
// WRs come from wca-service (GET /internal/records, cached 1 h); if it is unavailable we use a
// hard-coded table slightly below the real records.
// ---------------------------------------------------------------------------------------------

export interface Floor {
  single: number;
  average: number;
}

/** Fallback floors in ms (a little under the WCA records, so legit times are never rejected). */
export const FALLBACK_FLOORS: Record<string, Floor> = {
  '333': { single: 3000, average: 3500 },
  '222': { single: 400, average: 800 },
  '444': { single: 15000, average: 18000 },
  '555': { single: 30000, average: 35000 },
  '666': { single: 60000, average: 65000 },
  '777': { single: 90000, average: 100000 },
  '333oh': { single: 5500, average: 8000 },
  '333bf': { single: 11000, average: 14000 },
  pyram: { single: 700, average: 1000 },
  skewb: { single: 800, average: 1300 },
  clock: { single: 1500, average: 2000 },
  minx: { single: 23000, average: 26000 },
  sq1: { single: 3000, average: 4500 },
  '444bf': { single: 50000, average: 60000 },
  '555bf': { single: 120000, average: 140000 },
};

export type WcaRecords = Record<string, { single: number | null; average: number | null }>;

/** WR used as the floor for an event/kind (ao5/ao12 use the WCA average), or null if none. */
export function floorFor(event: string, kind: Kind, records: WcaRecords | null | undefined): number | null {
  const field = kind === 'single' ? 'single' : 'average';
  const wr = records?.[event]?.[field];
  if (typeof wr === 'number' && Number.isFinite(wr) && wr > 0) return wr;
  return FALLBACK_FLOORS[event]?.[field] ?? null;
}

/** Strictly below the floor = rejected. */
export const isBelowFloor = (valueMs: number, floor: number | null): boolean => floor !== null && valueMs < floor;

/** Validates the wca-service response `{records: {[event]: {single, average}}}`. */
export function parseRecords(json: unknown): WcaRecords | null {
  const recs = (json as { records?: unknown } | null)?.records;
  if (!recs || typeof recs !== 'object' || Array.isArray(recs)) return null;
  const out: WcaRecords = {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  for (const [event, r] of Object.entries(recs as Record<string, unknown>)) {
    if (!r || typeof r !== 'object') continue;
    const { single, average } = r as { single?: unknown; average?: unknown };
    out[event] = { single: num(single), average: num(average) };
  }
  return out;
}

export interface FloorSource {
  floor(event: string, kind: Kind): Promise<number | null>;
}

type Fetcher = (url: string, opts?: FetchOptions) => Promise<unknown>;

/** In-memory cache of the WCA records with 1 h TTL; failed fetches are retried after `retryMs`. */
export class FloorProvider implements FloorSource {
  private records: WcaRecords | null = null;
  private fetchedAt = 0;
  private retryAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly wcaUrl: string,
    private readonly log: FastifyBaseLogger,
    private readonly ttlMs = 3_600_000,
    private readonly retryMs = 60_000,
    private readonly fetcher: Fetcher = fetchJson,
  ) {}

  /** 'wca' once records were loaded at least once, else 'fallback'. */
  get source(): 'wca' | 'fallback' {
    return this.records ? 'wca' : 'fallback';
  }

  async floor(event: string, kind: Kind): Promise<number | null> {
    await this.ensureFresh();
    return floorFor(event, kind, this.records);
  }

  private async ensureFresh(): Promise<void> {
    const now = Date.now();
    if (now - this.fetchedAt < this.ttlMs || now < this.retryAt) return;
    if (!this.inflight) this.inflight = this.refresh().finally(() => (this.inflight = null));
    // The first load is awaited (bounded by a 2 s timeout); later refreshes run in the background
    // while the previous records keep being used.
    if (!this.records) await this.inflight;
  }

  private async refresh(): Promise<void> {
    try {
      const recs = parseRecords(await this.fetcher(`${this.wcaUrl}/internal/records`, { timeoutMs: 2000, retries: 0 }));
      if (!recs) throw new Error('malformed /internal/records response');
      this.records = recs;
      this.fetchedAt = Date.now();
      this.log.info({ events: Object.keys(recs).length }, 'anti-cheat: loaded WCA records');
    } catch (err) {
      this.retryAt = Date.now() + this.retryMs;
      this.log.warn(
        { err: (err as Error).message },
        `anti-cheat: WCA records unavailable, using ${this.records ? 'cached records' : 'fallback floors'}`,
      );
    }
  }
}
