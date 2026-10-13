# leaderboard service

Global all-time / weekly / daily leaderboards kept in Redis sorted sets
(SPEC §7.6, §8, §9.5). No Postgres: the boards are a derived read model of the domain events.
Readiness gates on Redis. Fastify on :8080.

| Route | Notes |
|---|---|
| `GET /api/leaderboards/:event/:kind?period=all\|weekly\|daily&page=1&size=50` | kind ∈ single, ao5, ao12 (weekly/daily: single, ao5). `me` filled when a valid token is sent |
| `GET /api/leaderboards/users/:userId/ranks` | every all-time board the user is on: `{event, kind, period:'all', rank, total, valueMs}` |
| `GET /api/leaderboards/_info` | info + consumer stats |

**Events consumed** (group `leaderboard`, consumer = pod name): `pb.updated` → all-time boards (exact
ZADD, ZREM when null/-1); `solve.created` → daily + weekly boards for the single and rolling ao5
(`ZADD LT`, DNF skipped); `user.*` and every payload with a `username` → `lb:users`.

Decisions / simplifications:
- Daily/weekly boards are global, so buckets are UTC days / ISO weeks of the solve's `createdAt`
  (not the solver's timezone). TTLs: daily 3 d, weekly 15 d (refreshed on each write); solves older
  than that are ignored.
- Rank = position + 1: equal times do not share a rank (ties ordered by userId).
- Weekly/daily boards only use `solve.created`; later edits (`solve.updated/deleted`) are not applied.
- 333fm has no boards (move counts, not times); its routes return an empty board.
- Unknown users in `lb:users` are shown as `username: "unknown"`.

Env: `PORT`, `REDIS_URL`, `JWT_SECRET`, `POD_NAME`, `NODE_NAME`, `APP_VERSION`, `LOG_LEVEL`.

Dev against the compose stack's Redis (`docker compose up -d redis`):
`PORT=8081 REDIS_URL=redis://localhost:56380 npx tsx services/leaderboard/src/index.ts`
Tests: `npx vitest run services/leaderboard`.
