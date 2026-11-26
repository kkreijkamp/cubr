import type { Kind } from './units.js';

/**
 * Where a result would rank: counts over each event's results, sorted, kept in memory per dataset version
 * (a new WCA import starts over). A count is then two binary searches instead of a range scan of up to
 * ~250k rows per request (51 ms of Postgres CPU, and a profile view makes two). The world lists are a few
 * MB in all, outside the JS heap; country lists load as asked, at most MAX_COUNTRY_LISTS of them.
 */
export const MAX_COUNTRY_LISTS = 300;

/** How many of the sorted `values` are below `x` (lower bound). */
export function countBelow(values: Int32Array, x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** How many of the sorted `values` are at or below `x` (upper bound). */
export const countAtMost = (values: Int32Array, x: number): number => countBelow(values, Math.floor(x) + 1);

export interface Counts {
  faster: number;
  notSlower: number;
  total: number;
}

export function createRankIndex(load: {
  sortedBests(kind: Kind, eventId: string): Promise<Int32Array>;
  sortedCountryBests(kind: Kind, eventId: string, countryId: string): Promise<Int32Array>;
}) {
  let version: string | null = null;
  const world = new Map<string, Promise<Int32Array>>();
  const country = new Map<string, Promise<Int32Array>>();

  /** The list under `key`, loaded once (concurrent askers share the load; a failed one is tried again). */
  function list(map: Map<string, Promise<Int32Array>>, key: string, make: () => Promise<Int32Array>, cap = Infinity): Promise<Int32Array> {
    let p = map.get(key);
    if (!p) {
      if (map.size >= cap) map.delete(map.keys().next().value!);
      p = make().catch((e: unknown) => {
        map.delete(key);
        throw e;
      });
      map.set(key, p);
    }
    return p;
  }
  function at(v: string) {
    if (v !== version) {
      version = v;
      world.clear();
      country.clear();
    }
  }
  const counts = (values: Int32Array, fasterBelow: number, slowerAbove: number): Counts => ({
    faster: countBelow(values, fasterBelow),
    notSlower: countAtMost(values, slowerAbove),
    total: values.length,
  });

  return {
    /** World counts of a raw value's thresholds (see rawThresholds), as repo.worldCounts gave them. */
    async world(v: string, kind: Kind, eventId: string, fasterBelow: number, slowerAbove: number): Promise<Counts> {
      at(v);
      return counts(await list(world, `${kind}:${eventId}`, () => load.sortedBests(kind, eventId)), fasterBelow, slowerAbove);
    },
    /** The same within one country, with the country's total. */
    async country(v: string, kind: Kind, eventId: string, countryId: string, fasterBelow: number, slowerAbove: number): Promise<Counts> {
      at(v);
      const values = await list(country, `${kind}:${eventId}:${countryId}`, () => load.sortedCountryBests(kind, eventId, countryId), MAX_COUNTRY_LISTS);
      return counts(values, fasterBelow, slowerAbove);
    },
  };
}
