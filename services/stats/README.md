# stats-service

Event-driven **read model (CQRS)** for player analytics: personal bests, activity heatmap, streaks,
time-of-day profile and global counters. It never reads another service's schema — it projects the
domain events from the Redis stream `cubetype:events` into schema `stats`, and it is the authority
for personal bests (emits `pb.updated`, consumed by leaderboard).

## Routes (SPEC §9.4)
| Route | Notes |
|---|---|
| `GET /api/stats/users/:userId/summary` | totals + streaks + per-event solves/totalMs/meanMs + 6 PB kinds, and the user's `username`. Unknown user → zeros (not 404). |
| `GET /api/stats/users/:userId/activity?from=&to=` | days with solves; default = the 365 days ending today (user's tz). The response echoes `from` and `to`. |
| `GET /api/stats/users/:userId/pb-history?event=333` | PB progression, ascending (`event` defaults to 333). |
| `GET /api/stats/users/:userId/hourly?event=333` | 24 entries; `solves` = all attempts, `meanMs` over non-DNF (null if none), plus `dnfs`. No `event` = all events combined. |
| `GET /api/stats/global` | cached 10 s in Redis `cache:stats:global` (fails open, `X-Cache: hit/miss`). "today" = UTC day. |
| `GET /internal/pbs?event=&kind=` | all PB rows (+ username), so the leaderboard can rebuild its all-time boards (SPEC §9.5). |
| `GET /api/stats/_info`, `/healthz`, `/readyz` | readiness = Postgres + migrations; Redis is soft. `_info` adds consumer stats and `pbOutboxPending`. |

## Events
Consumes (group `stats`, consumer = `POD_NAME`): `user.registered`, `user.updated`, `solve.created`,
`solve.updated`, `solve.deleted`, `session.deleted`, `solves.imported`. Produces: `pb.updated`.

* **solve.created** — incremental fast path: user_totals (+raw `timeMs` = time spent cubing),
  daily_activity (day in the event's `tz`), hourly, PBs: single (effective time), ao5/ao12 from the
  payload's `rolling`, mo3/ao50/ao100 from the session's last 100 solves kept in `stats.solve_ledger`.
  All six kinds are exact and immediate. A back-dated solve (older than the session's newest) shifts
  rolling windows, so it falls back to a full recompute.
* **solve.updated / solve.deleted / session.deleted / solves.imported** — full recompute of (user, event)
  from solve-service `GET /internal/users/:id/solves?event=` (15 s timeout): ledger, daily/hourly,
  PBs (diffed → `pb.updated` for every changed/removed row, `valueMs: null` when a kind disappears),
  pb_history rebuilt by chronological replay, totals. Comment-only `solve.updated` is skipped. If
  solve-service is unreachable the handler throws → entry stays pending → retried via XAUTOCLAIM
  (`maxAttempts` 20 before the DLQ). Measured locally: 20 000 solves of one event recompute in
  ≈ 0.38 s (65 ms of it fetching); a 21 000-solve `solves.imported` is visible 0.42 s after publish.
  Malformed payloads (e.g. non-UUID ids) go straight to `cubetype:events:dlq` instead of being retried.

## Design notes (consistency)
* **One transaction per event**: `pg_advisory_xact_lock(user)` (serialises a user's events across
  replicas) → `INSERT INTO stats.processed_events … ON CONFLICT DO NOTHING` (skip duplicates) → apply.
  Recomputes fetch the solve list *under* that lock, so a concurrent incremental update can't be lost.
* **Per-solve ledger** (`stats.solve_ledger`, internal): solve.created inserts the solve id first and
  only counts it if it was new — so a re-emitted event with a new eventId, or a stale pending entry
  reclaimed after a recompute already counted the solve, never double counts. `solve.deleted` writes a
  tombstone and `session.deleted` a `stats.deleted_sessions` row so late creations are ignored.
* **pb.updated can't be lost — transactional outbox**: PB changes write their `pb.updated` payload
  (with a fresh `stats-<uuid>` eventId) to `stats.pb_outbox` in the same transaction. After commit the
  handler flushes the outbox; a 1 s background loop retries anything left (Redis down, crash between
  commit and XADD). Only one replica relays at a time (advisory lock) so order is preserved. Rows are
  deleted after XADD, so delivery is at-least-once with a stable eventId (leaderboard's ZADD is
  idempotent anyway). The source event is acked independently of Redis publishing.
* Timezone: last valid `tz` seen per user is stored (`user_totals.tz`) and used for events without
  one (session.deleted) and for "today" in streaks/activity. hourly keeps SPEC semantics
  (`solves`/`sum_ms` = non-DNF) and counts DNFs in a separate `dnfs` column. processed_events older
  than 30 days are pruned hourly (the ledger keeps solve.created idempotent beyond that).

## Env
Common vars (SPEC §4); uses `DATABASE_URL`, `REDIS_URL`, `SOLVE_URL`, `POD_NAME`.
Dev against the compose stack's Postgres and Redis (`docker compose up -d postgres redis`; recomputes
need a solve instance at `SOLVE_URL`):
`PORT=8081 DATABASE_URL=postgres://cubetype:cubetype@localhost:55433/cubetype REDIS_URL=redis://localhost:56380 SOLVE_URL=http://localhost:8083 npx tsx services/stats/src/index.ts`
