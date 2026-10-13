import { notFound } from '@cubetype/common';
import type { EventInfo } from '@cubetype/cubestats';
import type { Dataset } from './dataset.js';
import type { PercentileRow, RankedRow, Repo } from './repo.js';
import { percentBeaten, rankFromCounts } from './stats.js';
import { KINDS, WCA_EVENTS, apiToWca, rawThresholds, supportedEvent, wcaToApi, type Kind } from './units.js';

/**
 * Use-cases behind the HTTP routes: query the repo and convert raw WCA units to API units.
 */
const EVENT_IDS = WCA_EVENTS.map((e) => e.id);

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

export function createService(deps: { repo: Repo; dataset: Dataset }) {
  const { repo, dataset } = deps;

  async function percentileMap() {
    const rows = await repo.percentiles(EVENT_IDS);
    const map = new Map<string, PercentileRow>();
    for (const p of rows) map.set(`${p.eventId}:${p.kind}`, p);
    return map;
  }

  async function meta() {
    const m = await dataset.requireLoaded();
    const c = m.rowCounts;
    return {
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
    };
  }

  async function rank(q: { event: string; kind: Kind; value: number; country?: string }) {
    await dataset.requireLoaded();
    const { fasterBelow, slowerAbove } = rawThresholds(apiToWca(q.event, q.kind, q.value));
    const stats = (await percentileMap()).get(`${q.event}:${q.kind}`);
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

  /** Raw record holders for both kinds, grouped by event. */
  async function recordRows() {
    const [single, average] = await Promise.all([
      repo.recordHolders('single', EVENT_IDS),
      repo.recordHolders('average', EVENT_IDS),
    ]);
    return { single, average };
  }

  async function records() {
    await dataset.requireLoaded();
    const rows = await recordRows();
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
      };
    };
    return {
      records: WCA_EVENTS.map((e) => ({
        event: e.id,
        eventName: e.name,
        unit: e.unit,
        single: recordFor(e.id, 'single'),
        average: recordFor(e.id, 'average'),
      })),
    };
  }

  /** GET /internal/records: { [event]: { single, average } } in ms (moves for 333fm). */
  async function internalRecords() {
    await dataset.requireLoaded();
    const stats = await percentileMap();
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

  return { meta, rank, records, internalRecords };
}

export type Service = ReturnType<typeof createService>;
