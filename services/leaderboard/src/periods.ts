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

export type PeriodEntry = { single?: PeriodBest; ao5?: PeriodBest };

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

export interface PeriodSource {
  bests(q: PeriodQuery): Promise<PeriodBests>;
}

type Fetcher = (url: string, opts?: FetchOptions) => Promise<unknown>;

/** Reads stats' answer; anything malformed throws (the event is retried, nothing is wiped). */
export function parsePeriodBests(json: unknown): PeriodBests {
  const body = json as { days?: unknown; weeks?: unknown } | null;
  const bucket = (v: unknown, keyRe: RegExp): Record<string, PeriodEntry> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('malformed period-bests response');
    const out: Record<string, PeriodEntry> = {};
    for (const [key, entry] of Object.entries(v as Record<string, unknown>)) {
      if (!keyRe.test(key) || !entry || typeof entry !== 'object') throw new Error(`malformed period-bests entry ${key}`);
      const e: PeriodEntry = {};
      for (const kind of ['single', 'ao5'] as const) {
        const b = (entry as Record<string, unknown>)[kind] as { valueMs?: unknown; achievedAt?: unknown } | undefined;
        if (b === undefined || b === null) continue;
        if (typeof b.valueMs !== 'number' || !Number.isInteger(b.valueMs) || b.valueMs <= 0 || typeof b.achievedAt !== 'string' || Number.isNaN(Date.parse(b.achievedAt))) {
          throw new Error(`malformed period-bests value ${key}.${kind}`);
        }
        e[kind] = { valueMs: b.valueMs, achievedAt: b.achievedAt };
      }
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
  };
}
