// A tiny WCA export, loaded the way jobs/wca-import loads the real one: with the importer's own SQL
// files, into a staging schema that is then swapped in as `wca`. 01 creates the tables; 02 adds the
// keys, foreign keys and indexes (without its 100k-row size check and its VACUUM, which cannot run in
// a multi-statement query); 03 derives percentiles and the histogram; 04 writes meta (the psql
// variables filled in here); 05 swaps the schemas.
//
// The people, centiseconds (moves for 333fm, x100 for its averages):
//   333 single   Ada 400, Ben 400 (shared WR), Cara 1000, Ivo 1100, Dan 1200, Eve 1200, Finn 1500, Gus 2000, Hana 3000
//   333 average  Ada 500, Cara 1200, Dan 1400, Finn 1800
//   222 single   Jo 150, Ada 200 (no averages)
//   333fm        singles Ada 20, Cara 25, Dan 30; averages Ada 2467, Cara 2800, Dan 3133
//   333mbf / 333ft (multi-blind, retired): one result each, never served
// Ivo moved from Australia (sub_id 2, "Ivo Oldname") to New Zealand (sub_id 1, current).
import { readFileSync } from 'node:fs';
import pg from 'pg';

type Row = (string | number | null)[];

export interface WcaExport {
  exportDate: string;
  exportVersion: string;
  continents: Row[];
  countries: Row[];
  events: Row[];
  persons: Row[];
  competitions: Row[];
  ranksSingle: Row[];
  ranksAverage: Row[];
}

/** A fresh copy of the fixture export (tests may add rows for a later export). */
export function fixture(over: Partial<Pick<WcaExport, 'exportDate' | 'exportVersion'>> = {}): WcaExport {
  return {
    exportDate: '2026-10-14T00:00:00Z',
    exportVersion: 'v2.0.2',
    ...over,
    // id, name, record_name
    continents: [['_Oceania', 'Oceania', 'OcR'], ['_Europe', 'Europe', 'ER'], ['_North America', 'North America', 'NAR'], ['_Asia', 'Asia', 'AsR']],
    // id, iso2, name, continent_id
    countries: [
      ['Australia', 'AU', 'Australia', '_Oceania'],
      ['New Zealand', 'NZ', 'New Zealand', '_Oceania'],
      ['USA', 'US', 'United States', '_North America'],
      ['Netherlands', 'NL', 'Netherlands', '_Europe'],
      ['China', 'CN', 'China', '_Asia'],
    ],
    // id, format, name, rank
    events: [
      ['333', 'time', '3x3x3 Cube', 10],
      ['222', 'time', '2x2x2 Cube', 20],
      ['444', 'time', '4x4x4 Cube', 30],
      ['333fm', 'number', '3x3x3 Fewest Moves', 70],
      ['333mbf', 'multi', '3x3x3 Multi-Blind', 160],
      ['333ft', 'time', '3x3x3 With Feet', 996],
    ],
    // name, gender, wca_id, sub_id, country_id
    persons: [
      ['Ada Fast', 'f', '2010AAAA01', 1, 'Australia'],
      ['Ben Steven', 'm', '2010BBBB01', 1, 'Netherlands'],
      ['Cara Mid', 'f', '2011CCCC01', 1, 'Australia'],
      ['Dan Mid', 'm', '2011DDDD01', 1, 'USA'],
      ['Eve Same', 'f', '2012EEEE01', 1, 'Australia'],
      ['Finn Slow', 'm', '2012FFFF01', 1, 'New Zealand'],
      ['Gus Slower', 'm', '2013GGGG01', 1, 'USA'],
      ['Hana Slowest', 'f', '2013HHHH01', 1, 'China'],
      ['Ivo Moved', 'm', '2014IIII01', 1, 'New Zealand'],
      ['Ivo Oldname', 'm', '2014IIII01', 2, 'Australia'],
      ['Jo Twoonly', 'o', '2014JJJJ01', 1, 'Australia'],
    ],
    // id, name, city_name, country_id, cancelled, year, month, day, end_year, end_month, end_day, latitude, longitude
    competitions: [['ExampleOpen2026', 'Example Open 2026', 'Brisbane', 'Australia', 0, 2026, 10, 3, 2026, 10, 4, -27470000, 153020000]],
    // best, person_id, event_id, world_rank, continent_rank, country_rank
    ranksSingle: [
      [400, '2010AAAA01', '333', 1, 1, 1],
      [400, '2010BBBB01', '333', 1, 1, 1],
      [1000, '2011CCCC01', '333', 3, 2, 2],
      [1100, '2014IIII01', '333', 4, 3, 1],
      [1200, '2011DDDD01', '333', 5, 1, 1],
      [1200, '2012EEEE01', '333', 5, 4, 3],
      [1500, '2012FFFF01', '333', 7, 5, 2],
      [2000, '2013GGGG01', '333', 8, 2, 2],
      [3000, '2013HHHH01', '333', 9, 1, 1],
      [150, '2014JJJJ01', '222', 1, 1, 1],
      [200, '2010AAAA01', '222', 2, 2, 2],
      [20, '2010AAAA01', '333fm', 1, 1, 1],
      [25, '2011CCCC01', '333fm', 2, 2, 2],
      [30, '2011DDDD01', '333fm', 3, 1, 1],
      [970360001, '2010AAAA01', '333mbf', 1, 1, 1],
      [3000, '2010AAAA01', '333ft', 1, 1, 1],
    ],
    ranksAverage: [
      [500, '2010AAAA01', '333', 1, 1, 1],
      [1200, '2011CCCC01', '333', 2, 2, 2],
      [1400, '2011DDDD01', '333', 3, 1, 1],
      [1800, '2012FFFF01', '333', 4, 3, 1],
      [2467, '2010AAAA01', '333fm', 1, 1, 1],
      [2800, '2011CCCC01', '333fm', 2, 2, 2],
      [3133, '2011DDDD01', '333fm', 3, 1, 1],
    ],
  };
}

const importerSql = (file: string) => readFileSync(new URL(`../../../jobs/wca-import/sql/${file}`, import.meta.url), 'utf8');

/** 02 without the size check (a fixture is tiny) and without VACUUM. */
function keysAndIndexes(): string {
  const sql = importerSql('02_keys_indexes.sql');
  const withoutCheck = sql.replace(/DO \$\$\s*DECLARE\s+n_persons[\s\S]*?END \$\$;/, '');
  const withoutVacuum = withoutCheck.replace(/^VACUUM\b[\s\S]*?;/m, '');
  if (withoutCheck === sql || withoutVacuum === withoutCheck) throw new Error('02_keys_indexes.sql changed: update the fixture loader');
  return withoutVacuum;
}

const literal = (v: string) => `'${v.replace(/'/g, "''")}'`;

async function insert(c: pg.Client, table: string, columns: string[], rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const values = rows.map((r, i) => `(${r.map((_, j) => `$${i * columns.length + j + 1}`).join(', ')})`).join(', ');
  await c.query(`INSERT INTO wca_staging.${table} (${columns.join(', ')}) VALUES ${values}`, rows.flat());
}

/** Loads `data` into wca_staging and swaps it in as schema `wca`, as the import job does. */
export async function importWca(databaseUrl: string, data: WcaExport): Promise<void> {
  // its own connection: 03 leaves temporary objects behind on the session
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    await c.query(importerSql('01_staging_tables.sql'));
    const rankColumns = ['best', 'person_id', 'event_id', 'world_rank', 'continent_rank', 'country_rank'];
    await insert(c, 'continents', ['id', 'name', 'record_name'], data.continents);
    await insert(c, 'countries', ['id', 'iso2', 'name', 'continent_id'], data.countries);
    await insert(c, 'events', ['id', 'format', 'name', 'rank'], data.events);
    await insert(c, 'persons', ['name', 'gender', 'wca_id', 'sub_id', 'country_id'], data.persons);
    await insert(c, 'competitions', [
      'id', 'name', 'city_name', 'country_id', 'cancelled', 'year', 'month', 'day', 'end_year', 'end_month', 'end_day', 'latitude_microdegrees', 'longitude_microdegrees',
    ], data.competitions);
    await insert(c, 'ranks_single', rankColumns, data.ranksSingle);
    await insert(c, 'ranks_average', rankColumns, data.ranksAverage);
    await c.query(keysAndIndexes());
    await c.query(importerSql('03_distribution.sql'));
    const vars: Record<string, string> = { export_date: data.exportDate, export_version: data.exportVersion, source: 'test fixture', load_seconds: '0.1' };
    await c.query(importerSql('04_meta.sql').replace(/:'(export_date|export_version|source|load_seconds)'/g, (_, name: string) => literal(vars[name])));
    await c.query(importerSql('05_swap.sql'));
  } finally {
    await c.end();
  }
}
