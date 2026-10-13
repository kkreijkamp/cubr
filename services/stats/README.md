# stats-service

Event-driven **read model (CQRS)** for player analytics: personal bests, activity heatmap, streaks,
time-of-day profile and global counters. It never reads another service's schema — it projects the
domain events from the Redis stream `cubetype:events` into schema `stats`, and it is the authority
for personal bests (emits `pb.updated`, consumed by leaderboard).

## Routes (SPEC §9.4)
| Route | Notes |
|---|---|
| `GET /api/stats/users/:userId/summary` | totals + streaks + per-event solves/totalMs/meanMs + 6 PB kinds, and the user's `username`. Unknown user → zeros (not 404). |
| `GET /api/stats/users/:userId/activity?from=&to=` | days with solves; default = the 365 days ending today (UTC). The response echoes `from` and `to`. |
| `GET /api/stats/users/:userId/pb-history?event=333` | PB progression, ascending (`event` defaults to 333). |
| `GET /api/stats/users/:userId/hourly?event=333` | 24 entries; `solves` = non-DNF solves, `meanMs` over them (null if none). No `event` = all events combined. |
| `GET /api/stats/global` | cached 10 s in Redis `cache:stats:global` (fails open, `X-Cache: hit/miss`). "today" = UTC day. |
| `GET /internal/pbs?event=&kind=` | all PB rows (+ username), so the leaderboard can rebuild its all-time boards (SPEC §9.5). |
| `GET /api/stats/_info`, `/healthz`, `/readyz` | readiness = Postgres + migrations; Redis is soft. `_info` adds consumer stats. |

## Events
Consumes (group `stats`, consumer = `POD_NAME`): `user.registered`, `user.updated`, `solve.created`.
Produces: `pb.updated`.

* **user.registered / user.updated** — keep the username (shown in summaries, sent with `pb.updated`)
  and the registration time.
* **solve.created** — user_totals (+raw `timeMs` = time spent cubing), daily_activity and hourly
  (day and hour in the event's `tz`), PBs: single (effective time) and ao5/ao12 from the payload's
  `rolling` (solve-service computes them over the session). Every improvement is appended to
  `pb_history` and announced as `pb.updated` once the transaction has committed.

## Design notes (consistency)
* **One transaction per event**: `pg_advisory_xact_lock(user)` (serialises a user's events across
  replicas) → `INSERT INTO stats.processed_events … ON CONFLICT DO NOTHING` (skip duplicates) → apply.
  Redelivered or reclaimed stream entries are therefore applied exactly once.
* Malformed payloads (e.g. non-UUID ids) go straight to `cubetype:events:dlq` instead of being retried.
* Days for the heatmap and streaks are bucketed in the timezone the client sent with the solve
  (`X-Timezone` → event `tz`); "today" for streaks is the UTC date, and a day ahead of it still
  counts as today.

## Env
Common vars (SPEC §4); uses `DATABASE_URL`, `REDIS_URL`, `POD_NAME`.
Dev against the compose stack's Postgres and Redis (`docker compose up -d postgres redis`):
`PORT=8081 DATABASE_URL=postgres://cubetype:cubetype@localhost:55433/cubetype REDIS_URL=redis://localhost:56380 npx tsx services/stats/src/index.ts`
