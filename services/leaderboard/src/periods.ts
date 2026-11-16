import { fetchJson, internalHeaders, type FetchOptions } from '@cubr/common';

// ---------------------------------------------------------------------------------------------
// A person's best single and ao5 of each UTC day and ISO week, from stats-service
// (GET /internal/users/:id/period-bests): what the daily and weekly boards are set to after a
// periods.changed. Stats reads its ledger (non-practice sessions) and leaves out values below the
// floors we pass (the anti-cheat floor), so an impossible time doesn't hide the real ones.
// ---------------------------------------------------------------------------------------------

export interface PeriodBest {
  valueMs: number;
  achievedAt: string;
}

export type PeriodValues = { single?: PeriodBest; ao5?: PeriodBest };
/** The best valid values, and under `flagged` the best ones below the floors (shown to their owner). */
export type PeriodEntry = PeriodValues & { flagged?: PeriodValues };

export interface PeriodBests {
  days: Record<string, PeriodEntry>;
  weeks: Record<string, PeriodEntry>;
}

export interface PeriodQuery {
  userId: string;
  event: string;
  /** ISO date-time: solves from then on */
  from: string;
  minSingle: number;
  minAverage: number;
}

/** A person's all-time best single / ao5 / ao12 above the floors, and the best ones below them. */
export type AllTimeValues = { single?: PeriodBest; ao5?: PeriodBest; ao12?: PeriodBest };
export type AllTimeBests = AllTimeValues & { flagged?: AllTimeValues };

export interface PeriodSource {
  bests(q: PeriodQuery): Promise<PeriodBests>;
  /** for the all-time boards while someone's PB is refused (GET /internal/users/:id/all-time-bests) */
  allTime(q: Omit<PeriodQuery, 'from'>): Promise<AllTimeBests>;
}

type Fetcher = (url: string, opts?: FetchOptions) => Promise<unknown>;

/** One {valueMs, achievedAt} or nothing; anything malformed throws. */
function best(b: unknown, where: string): PeriodBest | undefined {
  if (b === undefined || b === null) return undefined;
  const v = b as { valueMs?: unknown; achievedAt?: unknown };
  if (typeof v.valueMs !== 'number' || !Number.isInteger(v.valueMs) || v.valueMs <= 0 || typeof v.achievedAt !== 'string' || Number.isNaN(Date.parse(v.achievedAt))) {
    throw new Error(`malformed best ${where}`);
  }
  return { valueMs: v.valueMs, achievedAt: v.achievedAt };
}

/** Reads stats' all-time answer; anything malformed throws (the event is retried, nothing is wiped). */
export function parseAllTimeBests(json: unknown): AllTimeBests {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('malformed all-time-bests response');
  const values = (raw: unknown, where: string): AllTimeValues => {
    const out: AllTimeValues = {};
    if (raw === undefined || raw === null) return out;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`malformed all-time-bests ${where}`);
    for (const kind of ['single', 'ao5', 'ao12'] as const) {
      const b = best((raw as Record<string, unknown>)[kind], `${where}.${kind}`);
      if (b) out[kind] = b;
    }
    return out;
  };
  const out: AllTimeBests = values(json, 'body');
  const flagged = values((json as Record<string, unknown>).flagged, 'flagged');
  if (Object.keys(flagged).length) out.flagged = flagged;
  return out;
}

/** Reads stats' answer; anything malformed throws (the event is retried, nothing is wiped). */
export function parsePeriodBests(json: unknown): PeriodBests {
  const body = json as { days?: unknown; weeks?: unknown } | null;
  const bucket = (v: unknown, keyRe: RegExp): Record<string, PeriodEntry> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('malformed period-bests response');
    const out: Record<string, PeriodEntry> = {};
    for (const [key, entry] of Object.entries(v as Record<string, unknown>)) {
      if (!keyRe.test(key) || !entry || typeof entry !== 'object') throw new Error(`malformed period-bests entry ${key}`);
      const values = (raw: unknown, where: string): PeriodValues => {
        const v: PeriodValues = {};
        if (raw === undefined || raw === null) return v;
        if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`malformed period-bests entry ${where}`);
        for (const kind of ['single', 'ao5'] as const) {
          const b = (raw as Record<string, unknown>)[kind] as { valueMs?: unknown; achievedAt?: unknown } | undefined;
          if (b === undefined || b === null) continue;
          if (typeof b.valueMs !== 'number' || !Number.isInteger(b.valueMs) || b.valueMs <= 0 || typeof b.achievedAt !== 'string' || Number.isNaN(Date.parse(b.achievedAt))) {
            throw new Error(`malformed period-bests value ${where}.${kind}`);
          }
          v[kind] = { valueMs: b.valueMs, achievedAt: b.achievedAt };
        }
        return v;
      };
      const e: PeriodEntry = values(entry, key);
      const flagged = values((entry as Record<string, unknown>).flagged, `${key}.flagged`);
      if (Object.keys(flagged).length) e.flagged = flagged;
      out[key] = e;
    }
    return out;
  };
  return { days: bucket(body?.days, /^\d{4}-\d{2}-\d{2}$/), weeks: bucket(body?.weeks, /^\d{4}-W\d{2}$/) };
}

export function statsPeriodSource(statsUrl: string, internalToken: string, fetcher: Fetcher = fetchJson): PeriodSource {
  return {
    async bests(q) {
      const qs = new URLSearchParams({ event: q.event, from: q.from, minSingle: String(q.minSingle), minAverage: String(q.minAverage) });
      const url = `${statsUrl}/internal/users/${encodeURIComponent(q.userId)}/period-bests?${qs}`;
      return parsePeriodBests(await fetcher(url, { timeoutMs: 5000, retries: 1, headers: internalHeaders(internalToken) }));
    },
    async allTime(q) {
      const qs = new URLSearchParams({ event: q.event, minSingle: String(q.minSingle), minAverage: String(q.minAverage) });
      const url = `${statsUrl}/internal/users/${encodeURIComponent(q.userId)}/all-time-bests?${qs}`;
      return parseAllTimeBests(await fetcher(url, { timeoutMs: 10_000, retries: 1, headers: internalHeaders(internalToken) }));
    },
  };
}
