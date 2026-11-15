import { notFound } from '@cubr/common';
import type { EventInfo } from '@cubr/cubestats';
import type { CacheFn } from './cache.js';
import type { Dataset, DatasetMeta } from './dataset.js';
import type { PercentileRow, RankedRow, Repo } from './repo.js';
import { escapeLike } from './schemas.js';
import { mergeBuckets, percentBeaten, rankFromCounts } from './stats.js';
import { KINDS, WCA_EVENTS, apiToWca, rawThresholds, supportedEvent, wcaToApi, type Kind } from './units.js';

/**
 * Use-cases behind the HTTP routes: query the repo, convert raw WCA units to API units,
 * cache the expensive / frequently requested results.
 */
const HOUR = 3600;
const EVENT_IDS = WCA_EVENTS.map((e) => e.id);

export const WCA_CITATION =
  'This information is based on competition results owned and maintained by the World Cube Association, ' +
  'published at https://worldcubeassociation.org/results as of';

function citation(exportDate: string): string {
  const d = new Date(exportDate);
  const date = d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  return `${WCA_CITATION} ${date}.`;
}

export function requireEvent(id: string): EventInfo {
  const ev = supportedEvent(id);
  if (!ev) throw notFound(`Unknown or unsupported event '${id}' (supported: ${EVENT_IDS.join(', ')})`);
  return ev;
}

function personOut(event: string, kind: Kind, r: RankedRow) {
  return {
    personId: r.personId,
    personName: r.personName,
    name: r.personName,
    countryId: r.countryId,
    countryIso2: r.countryIso2,
    value: wcaToApi(event, kind, r.best),
    worldRank: r.worldRank,
  };
}

export function createService(deps: { repo: Repo; dataset: Dataset; cache: CacheFn }) {
  const { repo, dataset, cache } = deps;

  async function percentileMap(meta: DatasetMeta) {
    const { value } = await cache(meta.cacheVersion, 'percentiles', HOUR, () => repo.percentiles(EVENT_IDS));
    const map = new Map<string, PercentileRow>();
    for (const p of value) map.set(`${p.eventId}:${p.kind}`, p);
    return map;
  }

  async function meta() {
    const m = await dataset.requireLoaded();
    const c = m.rowCounts;
    return {
      // wca.meta is a single row memoised in-process for 10 s (see dataset.ts), no Redis needed
      value: {
        exportDate: m.exportDate,
        exportVersion: m.exportVersion,
        importedAt: m.importedAt,
        counts: {
          persons: c.persons_current ?? c.persons,
          competitions: c.competitions,
          ranksSingle: c.ranks_single,
          ranksAverage: c.ranks_average,
          countries: c.countries,
        },
        tables: c, // exact row count of every table in the wca schema
        sizeBytes: m.sizeBytes,
        citation: citation(m.exportDate),
      },
    };
  }

  async function rank(q: { event: string; kind: Kind; value: number; country?: string }) {
    const meta = await dataset.requireLoaded();
    const { fasterBelow, slowerAbove } = rawThresholds(apiToWca(q.event, q.kind, q.value));
    const stats = (await percentileMap(meta)).get(`${q.event}:${q.kind}`);
    const total = stats?.total ?? 0;

    const [world, country, near] = await Promise.all([
      repo.worldCounts(q.kind, q.event, fasterBelow, slowerAbove),
      q.country ? repo.findCountry(q.country) : Promise.resolve(null),
      repo.neighbours(q.kind, q.event, fasterBelow),
    ]);

    let countryOut = null;
    if (country) {
      const cc = await repo.countryCounts(q.kind, q.event, country.id, fasterBelow, slowerAbove);
      countryOut = {
        rank: rankFromCounts(cc.faster),
        total: cc.total,
        percentile: percentBeaten(cc.total - cc.notSlower, cc.total),
        countryId: country.id,
        countryIso2: country.iso2,
        countryName: country.name,
      };
    }
    return {
      event: q.event,
      kind: q.kind,
      value: q.value,
      unit: requireEvent(q.event).unit,
      world: { rank: rankFromCounts(world.faster), total, percentile: percentBeaten(total - world.notSlower, total) },
      country: countryOut,
      neighbours: near.map((r) => personOut(q.event, q.kind, r)),
    };
  }

  async function distribution(q: { event: string; kind: Kind; buckets: number }) {
    const meta = await dataset.requireLoaded();
    return cache(meta.cacheVersion, `dist:${q.event}:${q.kind}:${q.buckets}`, HOUR, async () => {
      const p = (await percentileMap(meta)).get(`${q.event}:${q.kind}`);
      const unit = requireEvent(q.event).unit;
      if (!p) {
        return { event: q.event, kind: q.kind, unit, total: 0, p10: null, p25: null, p50: null, p75: null, p90: null, p99: null, min: null, below: 0, above: 0, buckets: [] };
      }
      const fine = await repo.distribution(q.event, q.kind);
      const conv = (raw: number) => wcaToApi(q.event, q.kind, raw);
      return {
        event: q.event,
        kind: q.kind,
        unit,
        total: p.total,
        p10: conv(p.p10),
        p25: conv(p.p25),
        p50: conv(p.p50),
        p75: conv(p.p75),
        p90: conv(p.p90),
        p99: conv(p.p99),
        min: conv(p.minBest), // = world record
        below: p.below, // results faster than buckets[0].from
        above: p.above, // results slower than the last bucket's `to`
        buckets: mergeBuckets(fine, p.lo, p.bucketWidth, q.buckets).map((b) => ({
          from: conv(b.from),
          to: conv(b.to),
          count: b.count,
        })),
      };
    });
  }

  /** Raw record holders for both kinds, grouped by event (shared by /records and /internal/records). */
  async function recordRows(meta: DatasetMeta) {
    return cache(meta.cacheVersion, 'records', HOUR, async () => {
      const [single, average] = await Promise.all([
        repo.recordHolders('single', EVENT_IDS),
        repo.recordHolders('average', EVENT_IDS),
      ]);
      return { single, average };
    });
  }

  async function records() {
    const meta = await dataset.requireLoaded();
    const { value: rows, hit } = await recordRows(meta);
    const recordFor = (event: string, kind: Kind) => {
      const holders = rows[kind].filter((r) => r.eventId === event);
      if (holders.length === 0) return null;
      const first = personOut(event, kind, holders[0]);
      return {
        value: first.value,
        personId: first.personId,
        personName: first.personName,
        countryId: first.countryId,
        countryIso2: first.countryIso2,
        // more than one entry when the record is shared
        holders: holders.map((h) => ({ personId: h.personId, personName: h.personName, countryId: h.countryId, countryIso2: h.countryIso2 })),
      };
    };
    return {
      value: {
        records: WCA_EVENTS.map((e) => ({
          event: e.id,
          eventName: e.name,
          unit: e.unit,
          single: recordFor(e.id, 'single'),
          average: recordFor(e.id, 'average'),
        })),
      },
      hit,
    };
  }

  /** GET /internal/records: { [event]: { single, average } } in ms (moves for 333fm). */
  async function internalRecords() {
    const meta = await dataset.requireLoaded();
    const stats = await percentileMap(meta);
    const out: Record<string, { single: number | null; average: number | null }> = {};
    for (const e of WCA_EVENTS) {
      const [single, average] = KINDS.map((k) => {
        const p = stats.get(`${e.id}:${k}`);
        return p ? wcaToApi(e.id, k, p.minBest) : null;
      });
      out[e.id] = { single, average };
    }
    return { records: out };
  }

  async function searchPersons(q: { q: string; limit: number }, wcaId: string | null) {
    const meta = await dataset.requireLoaded();
    const key = `search:${q.limit}:${q.q.toLowerCase()}`;
    return cache(meta.cacheVersion, key, 600, async () => {
      const like = escapeLike(q.q.toLowerCase());
      const rows = wcaId
        ? await repo.searchPersons({ wcaId, prefix: '', substring: false, limit: q.limit })
        : await repo.searchPersons({
            // < 3 characters: trigram index can't help, use the lower(name) prefix index instead
            substring: q.q.length >= 3,
            pattern: q.q.length >= 3 ? `%${like}%` : `${like}%`,
            prefix: `${like}%`,
            limit: q.limit,
          });
      return {
        persons: rows.map((r) => ({ wcaId: r.personId, name: r.personName, countryId: r.countryId, countryIso2: r.countryIso2 })),
      };
    });
  }

  async function person(wcaId: string) {
    const meta = await dataset.requireLoaded();
    const result = await cache(meta.cacheVersion, `person:${wcaId}`, HOUR, async () => {
      const [p, ranks] = await Promise.all([repo.person(wcaId), repo.personRanks(wcaId)]);
      if (!p) return null;
      const pbs = WCA_EVENTS.flatMap((e) => {
        const entry = (kind: Kind) => {
          const r = ranks.find((x) => x.eventId === e.id && x.kind === kind);
          return r
            ? { value: wcaToApi(e.id, kind, r.best), worldRank: r.worldRank, continentRank: r.continentRank, countryRank: r.countryRank }
            : null;
        };
        const single = entry('single');
        const average = entry('average');
        return single || average ? [{ event: e.id, eventName: e.name, unit: e.unit, single, average }] : [];
      });
      return { person: p, pbs };
    });
    if (!result.value) throw notFound(`WCA person ${wcaId} not found`);
    return result as { value: NonNullable<typeof result.value>; hit: boolean };
  }

  async function countries() {
    const meta = await dataset.requireLoaded();
    return cache(meta.cacheVersion, 'countries', HOUR, async () => ({ countries: await repo.countries() }));
  }

  return { meta, rank, distribution, records, internalRecords, searchPersons, person, countries };
}

export type Service = ReturnType<typeof createService>;
