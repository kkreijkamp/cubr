// The wca service's HTTP API (src/routes, src/service.ts, src/repo.ts) against a real Postgres and
// Redis, over a tiny WCA export loaded with the importer's own SQL (./fixture.ts): records, the rank
// estimator, distributions, person search and pages, countries, the internal records for the
// leaderboard's anti-cheat, unit conversion (centiseconds to ms, FMC in moves, no multi-blind) and
// the cache headers.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EVENT_IDS } from '@cubr/cubestats';
import { describeIntegration, startTestServer, type TestServer } from '@cubr/testkit';
import { createCache } from '../src/cache.js';
import { createDataset } from '../src/dataset.js';
import { createRepo } from '../src/repo.js';
import { registerRoutes } from '../src/routes/index.js';
import { createService } from '../src/service.js';
import { fixture, importWca } from './fixture.js';

const person = (personId: string, personName: string, countryId: string, countryIso2: string) => ({ personId, personName, countryId, countryIso2 });
const ADA = person('2010AAAA01', 'Ada Fast', 'Australia', 'AU');
const BEN = person('2010BBBB01', 'Ben Steven', 'Netherlands', 'NL');

describeIntegration('wca API', () => {
  let s: TestServer;

  beforeAll(async () => {
    s = await startTestServer({
      service: 'wca',
      infoPrefixes: ['/api/wca'],
      routes: async ({ app, config, pool, redis }) => {
        await importWca(config.databaseUrl, fixture());
        const service = createService({ repo: createRepo(pool), dataset: createDataset(pool), cache: createCache(redis, app.log) });
        await registerRoutes(app, service, config.internalToken);
      },
    });
  });
  afterAll(async () => {
    await s?.close();
  });

  const get = async (url: string) => {
    const res = await s.request('GET', url);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };

  describe('meta', () => {
    it('describes the loaded export with exact row counts and the citation the WCA asks for', async () => {
      const res = await s.request('GET', '/api/wca/meta');
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      const meta = res.json();
      expect(meta).toMatchObject({
        exportDate: '2026-10-14T00:00:00.000Z',
        exportVersion: 'v2.0.2',
        counts: { persons: 10, competitions: 1, ranksSingle: 16, ranksAverage: 7, countries: 5 }, // persons = current records
        tables: expect.objectContaining({ persons: 11, persons_current: 10, events: 6, percentiles: 5 }),
        citation:
          'This information is based on competition results owned and maintained by the World Cube Association, ' +
          'published at https://worldcubeassociation.org/results as of October 14, 2026.',
      });
      expect(meta.sizeBytes).toBeGreaterThan(0);
    });
  });

  describe('records', () => {
    it("gives every cubr event's records in ms, FMC in moves, with all holders of a shared record", async () => {
      const { records } = await get('/api/wca/records');
      expect(records.map((r: { event: string }) => r.event)).toEqual(EVENT_IDS); // no multi-blind, no retired events
      const byEvent = Object.fromEntries(records.map((r: { event: string }) => [r.event, r]));
      expect(byEvent['333']).toEqual({
        event: '333',
        eventName: '3x3x3 Cube',
        unit: 'time',
        single: { value: 4_000, ...ADA, holders: [ADA, BEN] },
        average: { value: 5_000, ...ADA, holders: [ADA] },
      });
      expect(byEvent['333fm']).toMatchObject({ unit: 'moves', single: { value: 20, personId: ADA.personId }, average: { value: 24.67, personId: ADA.personId } });
      expect(byEvent['222']).toMatchObject({ single: { value: 1_500, personId: '2014JJJJ01' }, average: null });
      expect(byEvent['444']).toMatchObject({ single: null, average: null });
    });

    it('comes from the Redis cache once computed, under the dataset version', async () => {
      for (const key of await s.redis.keys('cache:wca:*:records')) await s.redis.del(key);
      expect((await s.request('GET', '/api/wca/records')).headers['x-cache']).toBe('MISS');
      await vi.waitFor(async () => expect(await s.redis.keys('cache:wca:*:records')).toEqual([expect.stringMatching(/^cache:wca:2026-10-14\.\d+:records$/)]));
      const again = await s.request('GET', '/api/wca/records');
      expect(again.headers['x-cache']).toBe('HIT');
      expect(again.headers['cache-control']).toBe('public, max-age=300');
    });
  });

  describe('rank', () => {
    it('ranks a time among everyone: 1 + the people strictly faster, beating the people strictly slower', async () => {
      const res = await s.request('GET', '/api/wca/rank?event=333&kind=single&value=12000');
      expect(res.headers['cache-control']).toBe('public, max-age=300');
      expect(res.headers['x-cache']).toBeUndefined(); // one answer per value: not kept in Redis
      expect(res.json()).toMatchObject({ event: '333', kind: 'single', value: 12_000, unit: 'time', world: { rank: 5, total: 9, percentile: 33.33 }, country: null });
    });

    it.each([
      // 12.345 s lies between 12.34 (faster) and 12.35 (slower)
      [12_345, 7, 33.33],
      [3_000, 1, 100], // faster than the world record
      [4_000, 1, 77.78], // equal to the shared world record
      [40_000, 10, 0], // slower than everyone
    ])('puts %i ms at world rank %i, faster than %d%% of people', async (value, rank, percentile) => {
      expect((await get(`/api/wca/rank?event=333&value=${value}`)).world).toEqual({ rank, total: 9, percentile });
    });

    it('puts a time in an event nobody has results in first of none, with no percentile', async () => {
      expect(await get('/api/wca/rank?event=444&value=60000&country=AU')).toMatchObject({
        world: { rank: 1, total: 0, percentile: null },
        country: { rank: 1, total: 0, percentile: null, countryId: 'Australia' },
        neighbours: [],
      });
    });

    it("ranks within a country by each person's current country, named by ISO code, WCA id or name", async () => {
      const country = async (c: string) => (await get(`/api/wca/rank?event=333&value=12000&country=${encodeURIComponent(c)}`)).country;
      expect(await country('au')).toEqual({ rank: 3, total: 3, percentile: 0, countryId: 'Australia', countryIso2: 'AU', countryName: 'Australia' });
      // Ivo's 11.00 counts for New Zealand, where he lives now, not Australia
      expect(await country('New Zealand')).toMatchObject({ rank: 2, total: 2, percentile: 50, countryId: 'New Zealand' });
      expect(await country('USA')).toMatchObject({ rank: 1, total: 2, percentile: 50, countryId: 'USA', countryIso2: 'US', countryName: 'United States' });
      expect(await country('united states')).toMatchObject({ countryId: 'USA' });
      expect(await country('Atlantis')).toBeNull();
    });

    it('lists the three people just faster and the three at or just slower, with their world ranks', async () => {
      const { neighbours } = await get('/api/wca/rank?event=333&value=12000');
      const n = (p: ReturnType<typeof person>, value: number, worldRank: number) => ({ ...p, name: p.personName, value, worldRank });
      expect(neighbours).toEqual([
        n(BEN, 4_000, 1),
        n(person('2011CCCC01', 'Cara Mid', 'Australia', 'AU'), 10_000, 3),
        n(person('2014IIII01', 'Ivo Moved', 'New Zealand', 'NZ'), 11_000, 4),
        n(person('2011DDDD01', 'Dan Mid', 'USA', 'US'), 12_000, 5),
        n(person('2012EEEE01', 'Eve Same', 'Australia', 'AU'), 12_000, 5),
        n(person('2012FFFF01', 'Finn Slow', 'New Zealand', 'NZ'), 15_000, 7),
      ]);
    });

    it('ranks FMC in moves: whole moves for singles, two decimals for averages', async () => {
      expect(await get('/api/wca/rank?event=333fm&kind=single&value=25')).toMatchObject({ unit: 'moves', value: 25, world: { rank: 2, total: 3, percentile: 33.33 } });
      const average = await get('/api/wca/rank?event=333fm&kind=average&value=24.67');
      expect(average).toMatchObject({ value: 24.67, world: { rank: 1, total: 3, percentile: 66.67 } });
      expect(average.neighbours.map((x: { value: number }) => x.value)).toEqual([24.67, 28, 31.33]);
    });

    it.each([
      ['multi-blind', 404, 'event=333mbf&value=1000'],
      ['a retired event', 404, 'event=333ft&value=1000'],
      ['an unknown event', 404, 'event=nope&value=1000'],
      ['no value', 400, 'event=333'],
      ['a value that is not a number', 400, 'event=333&value=fast'],
      ['zero', 400, 'event=333&value=0'],
      ['a fraction of a millisecond', 400, 'event=333&value=12000.5'],
      ['more than a day', 400, 'event=333&value=86400001'],
      ['more than 100 FMC moves', 400, 'event=333fm&value=101'],
      ['an unknown kind', 400, 'event=333&kind=mean&value=1000'],
    ])('answers %s with %i', async (_what, status, query) => {
      expect((await s.request('GET', `/api/wca/rank?${query}`)).statusCode).toBe(status);
    });
  });

  describe('distribution', () => {
    it('gives the percentiles and an equal-width histogram in ms that accounts for every result', async () => {
      const d = await get('/api/wca/distribution?event=333&kind=single&buckets=50');
      expect(d).toMatchObject({ event: '333', kind: 'single', unit: 'time', total: 9, min: 4_000, p10: 4_000, p25: 10_000, p50: 12_000, p75: 15_000, p90: 22_000, p99: 29_200 });
      expect(d.buckets).toHaveLength(50);
      expect(d.buckets[0].from).toBe(4_000);
      expect(new Set(d.buckets.map((b: { from: number; to: number }) => b.to - b.from))).toEqual(new Set([600]));
      expect(d.below + d.above + d.buckets.reduce((sum: number, b: { count: number }) => sum + b.count, 0)).toBe(9);
      expect(d.buckets.find((b: { from: number; to: number }) => b.from <= 12_000 && 12_000 < b.to).count).toBe(2); // Dan and Eve
    });

    it('keeps FMC averages in moves, one bucket per move', async () => {
      const d = await get('/api/wca/distribution?event=333fm&kind=average');
      expect(d).toMatchObject({ unit: 'moves', total: 3, min: 24.67, p50: 28 });
      expect(d.buckets.map((b: { from: number; to: number; count: number }) => [b.from, b.to, b.count])).toEqual([
        [24, 25, 1], [25, 26, 0], [26, 27, 0], [27, 28, 0], [28, 29, 1], [29, 30, 0], [30, 31, 0], [31, 32, 1],
      ]);
    });

    it('answers an event without results with an empty distribution', async () => {
      expect(await get('/api/wca/distribution?event=444')).toEqual({
        event: '444', kind: 'single', unit: 'time', total: 0, p10: null, p25: null, p50: null, p75: null, p90: null, p99: null, min: null, below: 0, above: 0, buckets: [],
      });
    });

    it.each([
      ['multi-blind', 404, 'event=333mbf'],
      ['no buckets', 400, 'event=333&buckets=0'],
      ['more buckets than the importer keeps', 400, 'event=333&buckets=601'],
    ])('answers %s with %i', async (_what, status, query) => {
      expect((await s.request('GET', `/api/wca/distribution?${query}`)).statusCode).toBe(status);
    });
  });

  describe('person search', () => {
    const search = async (q: string, extra = '') => (await get(`/api/wca/persons?q=${encodeURIComponent(q)}${extra}`)).persons;
    const names = async (q: string, extra = '') => (await search(q, extra)).map((p: { name: string }) => p.name);

    it('finds current names by substring from three characters on, in any case', async () => {
      expect(await search('MID')).toEqual([
        { wcaId: '2011CCCC01', name: 'Cara Mid', countryId: 'Australia', countryIso2: 'AU' },
        { wcaId: '2011DDDD01', name: 'Dan Mid', countryId: 'USA', countryIso2: 'US' },
      ]);
      expect(await search('oldname')).toEqual([]); // Ivo's earlier name
    });

    it('lists names that start with the query first', async () => {
      expect(await names('eve')).toEqual(['Eve Same', 'Ben Steven']);
    });

    it('matches only the start of names below three characters', async () => {
      expect(await names('Da')).toEqual(['Dan Mid']); // not "Ada Fast"
    });

    it('finds an exact WCA id in any case', async () => {
      expect(await search('2014iiii01')).toEqual([{ wcaId: '2014IIII01', name: 'Ivo Moved', countryId: 'New Zealand', countryIso2: 'NZ' }]);
    });

    it('matches LIKE wildcards literally', async () => {
      expect(await search('%')).toEqual([]);
      expect(await search('_')).toEqual([]);
      expect(await search('%a%')).toEqual([]);
    });

    it('returns at most `limit` people', async () => {
      expect(await names('slow', '&limit=2')).toEqual(['Finn Slow', 'Gus Slower']);
      expect((await s.request('GET', '/api/wca/persons?q=slow&limit=51')).statusCode).toBe(400);
      expect((await s.request('GET', '/api/wca/persons?q=%20')).statusCode).toBe(400);
    });
  });

  describe('person', () => {
    it('shows a person with their current country and a PB line for each cubr event they have results in', async () => {
      expect(await get('/api/wca/persons/2010aaaa01')).toEqual({
        person: { wcaId: '2010AAAA01', name: 'Ada Fast', gender: 'f', countryId: 'Australia', countryIso2: 'AU', countryName: 'Australia', continentId: '_Oceania', continentName: 'Oceania' },
        // cubr's event order; the multi-blind and retired-event results are left out
        pbs: [
          { event: '333', eventName: '3x3x3 Cube', unit: 'time', single: { value: 4_000, worldRank: 1, continentRank: 1, countryRank: 1 }, average: { value: 5_000, worldRank: 1, continentRank: 1, countryRank: 1 } },
          { event: '222', eventName: '2x2x2 Cube', unit: 'time', single: { value: 2_000, worldRank: 2, continentRank: 2, countryRank: 2 }, average: null },
          { event: '333fm', eventName: '3x3x3 Fewest Moves', unit: 'moves', single: { value: 20, worldRank: 1, continentRank: 1, countryRank: 1 }, average: { value: 24.67, worldRank: 1, continentRank: 1, countryRank: 1 } },
        ],
      });
    });

    it('uses the current record of someone who changed name and country', async () => {
      expect((await get('/api/wca/persons/2014IIII01')).person).toMatchObject({ name: 'Ivo Moved', countryId: 'New Zealand', continentName: 'Oceania' });
    });

    it('answers 404 for a WCA id nobody has, also from the cache, and 400 for a malformed one', async () => {
      for (let i = 0; i < 2; i++) {
        const res = await s.request('GET', '/api/wca/persons/1999ZZZZ99');
        expect(res.statusCode).toBe(404);
        expect(res.json().error).toEqual({ code: 'NOT_FOUND', message: 'WCA person 1999ZZZZ99 not found' });
      }
      expect((await s.request('GET', '/api/wca/persons/feliks')).statusCode).toBe(400);
    });
  });

  describe('countries', () => {
    it('lists the countries by name with their continent and number of people living there now', async () => {
      expect(await get('/api/wca/countries')).toEqual({
        countries: [
          { id: 'Australia', iso2: 'AU', name: 'Australia', continentId: '_Oceania', continentName: 'Oceania', persons: 4 },
          { id: 'China', iso2: 'CN', name: 'China', continentId: '_Asia', continentName: 'Asia', persons: 1 },
          { id: 'Netherlands', iso2: 'NL', name: 'Netherlands', continentId: '_Europe', continentName: 'Europe', persons: 1 },
          { id: 'New Zealand', iso2: 'NZ', name: 'New Zealand', continentId: '_Oceania', continentName: 'Oceania', persons: 2 },
          { id: 'USA', iso2: 'US', name: 'United States', continentId: '_North America', continentName: 'North America', persons: 2 },
        ],
      });
    });
  });

  describe('internal records', () => {
    it('need the internal token', async () => {
      expect((await s.request('GET', '/internal/records')).statusCode).toBe(403);
      expect((await s.request('GET', '/internal/records', { headers: { 'x-internal-token': 'wrong' } })).statusCode).toBe(403);
    });

    it("give each cubr event's world records in ms (FMC in moves), null where there are none", async () => {
      const res = await s.request('GET', '/internal/records', { headers: { 'x-internal-token': s.config.internalToken } });
      expect(res.statusCode).toBe(200);
      const { records } = res.json();
      expect(Object.keys(records).sort()).toEqual([...EVENT_IDS].sort()); // a map: integer-like ids sort first in JSON
      expect(records['333']).toEqual({ single: 4_000, average: 5_000 });
      expect(records['222']).toEqual({ single: 1_500, average: null });
      expect(records['333fm']).toEqual({ single: 20, average: 24.67 });
      expect(records['444']).toEqual({ single: null, average: null });
    });
  });
});
