# wca service

Read-only API over the **official WCA results export** (loaded into schema `wca` by
[`jobs/wca-import`](../../jobs/wca-import/README.md)): world records, a "where would my time
rank?" estimator, result distributions for charts, and person lookup.

> This information is based on competition results owned and maintained by the World Cube
> Association, published at https://worldcubeassociation.org/results as of October 14, 2026.
> (Show this citation with the date of the loaded export wherever WCA data is displayed.)

## Routes (SPEC §9.7)
| Route | Notes |
|---|---|
| `GET /api/wca/meta` | export date/version and `counts` |
| `GET /api/wca/records` | WR single/average per event with holder |
| `GET /api/wca/rank?event=333&kind=single&value=12000&country=AU` | world/country rank, percentile, 3+3 neighbours |
| `GET /api/wca/distribution?event=333&kind=single&buckets=50` | p10…p99, `min` (= WR), histogram `buckets`, `below`/`above` |
| `GET /api/wca/persons?q=feliks&limit=20` | name substring (trigram index) or exact WCA id; `limit` ≤ 50 |
| `GET /api/wca/persons/:wcaId` | person + PBs with world/continent/country rank for every event |
| `GET /api/wca/_info` | standard info + `dataLoaded` and the loaded export's date/row counts |
| `GET /internal/records` | `{records:{[event]:{single, average}}}` for leaderboard anti-cheat (not public) |

**Units.** WCA centiseconds × 10 → `value` in **ms** for timed events; 333fm in **moves**
(`unit: "moves"`; averages are stored ×100 in the export and divided here, e.g. `24.67`).
The `value` query parameter of `/rank` uses the same units (integer ms, or moves for 333fm).
Only the 16 cubetype events are served (333mbf and retired events → 404).

**Response details.** Every object with `countryId` also has `countryIso2` (for flag emojis);
neighbours carry `personName` as well as `name`; rank, distribution, records and person PBs carry
the event's `unit`; the country block of a rank also has `countryIso2` and `countryName`;
distributions also report `p99`, `min`, `below` and `above`; a person also has
`countryIso2/countryName/continentId/continentName`.

**Definitions.** rank = 1 + number of people strictly faster (ties share a rank);
percentile = % of people strictly slower (2 decimals); a country filter accepts ISO2 (`AU`) or a
WCA country id (`Australia`) and ranks by each person's *current* country; an unknown country
gives `country: null`. Histogram buckets are equal-width `[from, to)` between ~p0.5 and ~p99.

## Behaviour
- **Before the first import** every data route returns 503 `UNAVAILABLE` "WCA data not loaded yet";
  `_info` shows `dataLoaded: false`. Readiness gates on Postgres only (the service must be ready before
  the import Job runs). No migrations: the importer owns the schema.
- World rank = two counts on the `(event_id, best)` index (index-only scan); country rank = hash join
  of `persons(country_id)` with that event's ranks.
- Errors: zod validation → 400, unknown event/person → 404, malformed WCA id → 400.

## Env
Standard (`PORT`, `DATABASE_URL`, `LOG_LEVEL`, …). No service-specific variables.

## Local run
```
docker compose up -d postgres            # then load the export: docker compose --profile jobs run --rm wca-import
PORT=8081 DATABASE_URL=postgres://cubetype:cubetype@localhost:55433/cubetype \
  npx tsx services/wca/src/index.ts
curl 'localhost:8081/api/wca/rank?event=333&kind=single&value=12000&country=AU'
```
