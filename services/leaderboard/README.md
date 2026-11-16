# leaderboard service

Global all-time / weekly / daily and daily-challenge leaderboards kept in Redis sorted sets
(SPEC section 7.6, section 8, section 9.5). No Postgres: the boards are a derived read model, rebuildable from stats.
Readiness gates on Redis. Fastify on :8080.

| Route | Notes |
|---|---|
| `GET /api/leaderboards/:event/:kind?period=all\|weekly\|daily&page=1&size=50[&key=]` | kind in single, ao5, ao12 (weekly/daily: single, ao5). `key` views a past board (`YYYY-MM-DD` / `YYYY-Www`). `me` filled when a valid token is sent |
| `GET /api/leaderboards/daily-challenge?date=&event=333` | kind `ao5`, period `challenge`; date defaults to today (UTC); event in daily-challenge events |
| `GET /api/leaderboards/users/:userId/ranks` | every all-time board the user is on: `{event, kind, period:'all', rank, total, valueMs}` |
| `GET /api/leaderboards/_info` | info + consumer stats, rebuild status, anti-cheat floor source |

**Events consumed** (group `leaderboard`, consumer = pod name): `pb.updated` -> all-time boards (exact
ZADD, ZREM when null/-1; stale events are dropped via a per-user occurredAt guard in `<board>:ts`);
`solve.created` -> daily + weekly boards for the single and rolling ao5 (`ZADD LT`, DNF and practice-session solves skipped,
and so is a solve older than the user's last `periods.changed` write on that board: it may have been deleted since);
`periods.changed` (stats: the user's solves for an event changed) -> asks stats for the user's best single and ao5 of each
live day and week (`GET stats /internal/users/:id/period-bests`, with the anti-cheat floors, so an impossible time
doesn't hide the real ones) and sets their entry on every live daily and weekly board exactly, or removes it
(`src/periods.ts`; the time guard in `<board>:ts`, as for `pb.updated`). If stats can't answer, the event is retried;
`daily.completed` / `daily.updated` -> `lb:dc:<date>:<event>` (exact like `pb.updated`: the latest result wins, so a
penalty marked after the solve can make it worse, and a DNF ao5 removes the entry); `user.*` and every payload with a
`username` -> `lb:users`;
`user.deleted` -> the user leaves every board (SCAN `lb:*`: ZREM / HDEL `:at` `:ts`), `lb:users` and `lb:flagged`, and
goes into `lb:deleted-users`, so later events for them are ignored.
Score + achievedAt (`<board>:at` hash) are written atomically by small Lua scripts (`src/scripts.ts`).

Decisions / simplifications:
- Daily/weekly boards are global, so buckets are UTC days / ISO weeks of the solve's `createdAt`
  (not the solver's timezone). TTLs: daily 3 d, weekly 15 d (refreshed on each write); solves older
  than that are ignored. Daily-challenge boards have no TTL (history).
- Rank = position + 1: equal times do not share a rank (ties ordered by userId).
- Weekly/daily boards take each `solve.created` straight away (keep-best), and follow edits, deletions,
  merges, imports and practice sessions through `periods.changed`, which stats publishes after applying
  any change (also after each new solve, so a race between the two can't leave a stale entry).
  Live boards are the UTC days of the last 3 days and ISO weeks of the last 15; older ones are left as
  they were. An exact write gives a key a TTL only if it has none, so re-reading an old day doesn't
  extend it.
- 333fm has no boards (move counts, not times); its routes return an empty board.
- Unknown users in `lb:users` are shown as `username: "unknown"`.
- **Anti-cheat:** values strictly below the WCA world record (`GET wca /internal/records`, cached 1 h,
  ao5/ao12 use the WR average; fallback table in `src/floors.ts` when wca is down) are not ranked but
  pushed to `lb:flagged` (LPUSH + LTRIM 1000).
- **Rebuild:** every 60 s (first check at startup, in the background) if `lb:meta:built` is missing,
  take `SET lb:rebuild-lock <pod> NX EX 120`, read `GET stats /internal/pbs?kind=` for single/ao5/ao12,
  pipeline upserts into the all-time boards + `lb:users`, then set `lb:meta:built`. Stats unreachable ->
  exponential backoff up to 30 s; existing boards keep serving meanwhile. Upsert only (does not delete
  entries stats no longer has).

Env: `PORT`, `REDIS_URL`, `JWT_SECRET`, `STATS_URL`, `WCA_URL`, `INTERNAL_API_TOKEN` (sent to the stats and wca
`/internal` routes), `POD_NAME`, `NODE_NAME`, `APP_VERSION`, `LOG_LEVEL`.

Dev against the compose stack's Redis (`docker compose up -d redis`; without stats and wca instances at
`STATS_URL`/`WCA_URL` the rebuild keeps retrying and the anti-cheat uses its fallback table):
`PORT=8081 REDIS_URL=redis://localhost:56380 npx tsx services/leaderboard/src/index.ts`
Tests: `npx vitest run services/leaderboard`.
