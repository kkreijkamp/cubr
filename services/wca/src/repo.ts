import type { Pool } from '@cubr/common';
import type { Kind } from './units.js';

/**
 * All SQL against the `wca` schema (loaded by jobs/wca-import). Values are raw WCA units here;
 * routes convert them. Table names are picked from this fixed map (never from user input),
 * everything else is a $n parameter.
 */
const RANKS: Record<Kind, string> = { single: 'wca.ranks_single', average: 'wca.ranks_average' };

export interface CountryRow {
  id: string;
  iso2: string | null;
  name: string;
  continentId: string;
}

export interface PersonRef {
  personId: string;
  personName: string;
  countryId: string;
  countryIso2: string | null;
}

export interface RankedRow extends PersonRef {
  best: number;
  worldRank: number;
}

export interface PercentileRow {
  eventId: string;
  kind: Kind;
  total: number;
  minBest: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p99: number;
  lo: number;
  bucketWidth: number;
  bucketCount: number;
  below: number;
  above: number;
}

// Shared projection: person + country of a ranks row (sub_id = 1 is the person's current record).
const PERSON_JOIN = `
  JOIN wca.persons p ON p.wca_id = r.person_id AND p.sub_id = 1
  JOIN wca.countries c ON c.id = p.country_id`;
const PERSON_COLS = `r.person_id AS "personId", p.name AS "personName", p.country_id AS "countryId", c.iso2 AS "countryIso2"`;

export function createRepo(pool: Pool) {
  /** ISO2 ("AU", case-insensitive) or WCA country id ("Australia") -> country, or null. */
  async function findCountry(input: string): Promise<CountryRow | null> {
    const { rows } = await pool.query<CountryRow>(
      `SELECT id, iso2, name, continent_id AS "continentId" FROM wca.countries
       WHERE iso2 = upper($1) OR id = $1 OR lower(name) = lower($1)
       ORDER BY (iso2 = upper($1)) DESC LIMIT 1`,
      [input],
    );
    return rows[0] ?? null;
  }

  /**
   * Counts for the world rank of a value: how many people are strictly faster (best < fasterBelow)
   * and how many are not slower (best <= slowerAbove). Both come from one range scan of the
   * (event_id, best) index.
   */
  async function worldCounts(kind: Kind, eventId: string, fasterBelow: number, slowerAbove: number) {
    const { rows } = await pool.query<{ faster: number; notSlower: number }>(
      `SELECT count(*) FILTER (WHERE best < $2) AS faster, count(*) AS "notSlower"
       FROM ${RANKS[kind]} WHERE event_id = $1 AND best <= $3`,
      [eventId, fasterBelow, slowerAbove],
    );
    return rows[0];
  }

  /** Same counts within one country (current country of each person) plus the country total. */
  async function countryCounts(kind: Kind, eventId: string, countryId: string, fasterBelow: number, slowerAbove: number) {
    const { rows } = await pool.query<{ faster: number; notSlower: number; total: number }>(
      `SELECT count(*) FILTER (WHERE r.best < $3) AS faster,
              count(*) FILTER (WHERE r.best <= $4) AS "notSlower",
              count(*) AS total
       FROM wca.persons p
       JOIN ${RANKS[kind]} r ON r.person_id = p.wca_id AND r.event_id = $1
       WHERE p.country_id = $2 AND p.sub_id = 1`,
      [eventId, countryId, fasterBelow, slowerAbove],
    );
    return rows[0];
  }

  /** The 3 people just faster than the value and the 3 at or just slower, ordered by result. */
  async function neighbours(kind: Kind, eventId: string, fasterBelow: number, n = 3): Promise<RankedRow[]> {
    const { rows } = await pool.query<RankedRow>(
      `(SELECT r.best, r.world_rank AS "worldRank", ${PERSON_COLS}
        FROM ${RANKS[kind]} r ${PERSON_JOIN}
        WHERE r.event_id = $1 AND r.best < $2 ORDER BY r.best DESC, r.person_id DESC LIMIT $3)
       UNION ALL
       (SELECT r.best, r.world_rank, ${PERSON_COLS}
        FROM ${RANKS[kind]} r ${PERSON_JOIN}
        WHERE r.event_id = $1 AND r.best >= $2 ORDER BY r.best, r.person_id LIMIT $3)`,
      [eventId, fasterBelow, n],
    );
    return rows.sort((a, b) => a.best - b.best || a.personId.localeCompare(b.personId));
  }

  /** Precomputed per-event statistics (see jobs/wca-import/sql/03_distribution.sql). */
  async function percentiles(eventIds: string[]): Promise<PercentileRow[]> {
    const { rows } = await pool.query<PercentileRow>(
      `SELECT event_id AS "eventId", kind, total, min_best AS "minBest", p10, p25, p50, p75, p90, p99,
              lo, bucket_width AS "bucketWidth", bucket_count AS "bucketCount", below, above
       FROM wca.percentiles WHERE event_id = ANY($1)`,
      [eventIds],
    );
    return rows;
  }

  /** Fine histogram counts, bucket 1..n in order. */
  async function distribution(eventId: string, kind: Kind): Promise<number[]> {
    const { rows } = await pool.query<{ count: number }>(
      'SELECT count FROM wca.distribution WHERE event_id = $1 AND kind = $2 ORDER BY bucket',
      [eventId, kind],
    );
    return rows.map((r) => r.count);
  }

  /** Record holders: every person whose best equals the precomputed minimum (ties included). */
  async function recordHolders(kind: Kind, eventIds: string[]): Promise<(RankedRow & { eventId: string })[]> {
    const { rows } = await pool.query<RankedRow & { eventId: string }>(
      `SELECT r.event_id AS "eventId", r.best, r.world_rank AS "worldRank", ${PERSON_COLS}
       FROM wca.percentiles pc
       JOIN ${RANKS[kind]} r ON r.event_id = pc.event_id AND r.best = pc.min_best
       ${PERSON_JOIN}
       WHERE pc.kind = $1 AND pc.event_id = ANY($2)
       ORDER BY r.event_id, r.person_id`,
      [kind, eventIds],
    );
    return rows;
  }

  /**
   * Person search: exact WCA id, or name match. Short queries use the lower(name) prefix index,
   * longer ones a substring ILIKE served by the pg_trgm GIN index. Prefix matches rank first.
   */
  async function searchPersons(opts: { wcaId?: string; pattern?: string; prefix: string; substring: boolean; limit: number }) {
    if (opts.wcaId) {
      const { rows } = await pool.query<PersonRef>(
        `SELECT p.wca_id AS "personId", p.name AS "personName", p.country_id AS "countryId", c.iso2 AS "countryIso2"
         FROM wca.persons p JOIN wca.countries c ON c.id = p.country_id
         WHERE p.wca_id = $1 AND p.sub_id = 1`,
        [opts.wcaId],
      );
      return rows;
    }
    const where = opts.substring ? 'p.name ILIKE $1' : 'lower(p.name) LIKE $1';
    const { rows } = await pool.query<PersonRef>(
      `SELECT p.wca_id AS "personId", p.name AS "personName", p.country_id AS "countryId", c.iso2 AS "countryIso2"
       FROM wca.persons p JOIN wca.countries c ON c.id = p.country_id
       WHERE p.sub_id = 1 AND ${where}
       ORDER BY (lower(p.name) LIKE $2) DESC, p.name, p.wca_id
       LIMIT $3`,
      [opts.pattern, opts.prefix, opts.limit],
    );
    return rows;
  }

  async function person(wcaId: string) {
    const { rows } = await pool.query<{
      wcaId: string; name: string; gender: string | null; countryId: string; countryIso2: string | null;
      countryName: string; continentId: string; continentName: string;
    }>(
      `SELECT p.wca_id AS "wcaId", p.name, p.gender, p.country_id AS "countryId", c.iso2 AS "countryIso2",
              c.name AS "countryName", c.continent_id AS "continentId", ct.name AS "continentName"
       FROM wca.persons p
       JOIN wca.countries c ON c.id = p.country_id
       JOIN wca.continents ct ON ct.id = c.continent_id
       WHERE p.wca_id = $1 AND p.sub_id = 1`,
      [wcaId],
    );
    return rows[0] ?? null;
  }

  /** All personal records of one person (both kinds) via the (person_id, event_id) primary keys. */
  async function personRanks(wcaId: string) {
    const { rows } = await pool.query<{
      kind: Kind; eventId: string; best: number; worldRank: number; continentRank: number; countryRank: number;
    }>(
      `SELECT 'single' AS kind, event_id AS "eventId", best, world_rank AS "worldRank",
              continent_rank AS "continentRank", country_rank AS "countryRank"
       FROM wca.ranks_single WHERE person_id = $1
       UNION ALL
       SELECT 'average', event_id, best, world_rank, continent_rank, country_rank
       FROM wca.ranks_average WHERE person_id = $1`,
      [wcaId],
    );
    return rows;
  }

  async function countries() {
    const { rows } = await pool.query<CountryRow & { continentName: string; persons: number }>(
      `SELECT c.id, c.iso2, c.name, c.continent_id AS "continentId", ct.name AS "continentName",
              coalesce(pc.n, 0) AS persons
       FROM wca.countries c
       JOIN wca.continents ct ON ct.id = c.continent_id
       LEFT JOIN (SELECT country_id, count(*) AS n FROM wca.persons WHERE sub_id = 1 GROUP BY country_id) pc
              ON pc.country_id = c.id
       ORDER BY c.name`,
    );
    return rows;
  }

  return {
    findCountry, worldCounts, countryCounts, neighbours, percentiles, distribution, recordHolders,
    searchPersons, person, personRanks, countries,
  };
}

export type Repo = ReturnType<typeof createRepo>;
