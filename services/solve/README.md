# solve service

The core write path of cubr: sessions and solves CRUD, csTimer bulk import/export, daily-challenge
attempts, and the **transactional outbox** that feeds the Redis event bus. Owns the Postgres schema `solve` (SPEC section 7.2),
migrated at startup. Port 8080.

## Routes (all `/api/*` require `Authorization: Bearer <jwt>`)
| Route | Notes |
|---|---|
| `GET /api/sessions` | creates a default `3x3`/`333` session on first call (per-user advisory lock -> exactly one) |
| `POST /api/sessions` `{id?, name, event, practice?, createdAt?}` | 201; same id again for this user -> 200 existing; id owned by someone else -> 409. `createdAt` (future clamped to now) keeps a cleared session's replacement in its place |
| `PATCH /api/sessions/:id` `{name?, practice?}` / `DELETE /api/sessions/:id` | rename emits `session.renamed`; marking a session as practice (or no longer) emits `session.updated` - its solves then count for no PB and no leaderboard; delete cascades solves, emits `session.deleted` |
| `POST /api/sessions/:id/merge` `{sourceIds}` | moves every solve of 1-50 source sessions into `:id` and deletes the sources in **one transaction**; only sessions of the same event (409 otherwise); emits `sessions.merged` |
| `GET /api/sessions/:id/solves` | ascending; capped at the **latest** 50 000 (`truncated: true` when cut) |
| `POST /api/solves` | idempotent on `id` (`ON CONFLICT DO NOTHING`): retry -> 200, no second event; id of another user -> 409. Returns `{solve, rolling:{ao5,ao12}}` |
| `PATCH /api/solves/:id` `{penalty?, comment?}` / `DELETE /api/solves/:id` | emit `solve.updated` / `solve.deleted`; a changed solve is returned with the session's `rolling` |
| `POST /api/sessions/import` | <= 100 000 solves, body <= 25 MB; one transaction, `unnest()` batches of 2000, one `solves.imported` event. 100k solves take ~1.3 s locally. 10 imports/h per user (checked onRequest, before the body is read); at most 250 000 solves per account (advisory lock per account, then a count) |
| `GET /api/solves/export` | `{exportedAt, sessions:[Session & {solves}]}`, streamed: one `REPEATABLE READ READ ONLY` transaction, keyset pages of 2000 solves per session (`created_at::text`, id), so memory stays flat (200k solves fine under the 192 MB production heap). 10 exports/h per user |
| `GET /api/solves/daily?date=` | the user's daily solves per event + the official ao5 (from the recorded attempts) |
| `GET /api/solves/daily/history?event=` | every day the user attempted that event's daily challenge, oldest first: `{date, attempts, ao5}` (ao5 from the recorded attempts, -1 = DNF, null until all five exist). Read by the daily page's "your results" calendar |
| `GET /api/solves/_info`, `/api/sessions/_info` | info incl. `outbox: {backlog, published, lastPublishedAt, lastError, healthy}` |
| `GET /internal/users/:userId/solves?event=` | **service-to-service only**: not routed by the gateway/Ingress and requires `X-Internal-Token` (403 otherwise): `{solves:[{id, sessionId, timeMs, penalty, createdAt, practice?}]}` ordered by session, time (stats recompute; `practice: true` marks a practice session's solves) |
| `GET /internal/users/:userId/sessions` | same protection: `{sessions:[{id, name, event, practice}]}` (read models backfill session names) |

Users only ever see their own rows; foreign ids return 404. A solve always gets the event of its session.
`X-Timezone` (valid IANA name, else `UTC`) is copied into events as `tz`. Tokens revoked by logout are rejected
(Redis lookup via common's `makeAuth`; fails open while Redis is down).

## Events consumed
Group `solve`: only `user.deleted` (from auth) - deletes the account's sessions, solves, daily attempts and its
events still waiting in the outbox (`src/purge.ts`).

## Events produced (stream `cubr:events`, `eventId = solve-<outboxId>`)
`solve.created` (with `rolling` = session's current ao5/ao12 incl. this solve, `sessionName` and `practice`), `solve.updated`,
`solve.deleted`, `session.deleted`, `session.renamed`, `session.updated`, `sessions.merged`, `solves.imported`, `daily.completed`, `daily.updated`. Each is inserted into `solve.outbox` **in the same
transaction** as the data change. A relay loop in every replica claims up to 500 unpublished rows every 250 ms
(`FOR UPDATE SKIP LOCKED`, so replicas never double-claim), XADDs each batch in id order, and marks the rows published.
Published rows older than 1 day are deleted every 10 min.

Session names travel with the events (`solve.created.sessionName`; `session.renamed {userId, username, sessionId, event,
name}`), so read models can label sessions without calling this service; `GET /internal/users/:userId/sessions` backfills
names for sessions they only learned about through a bulk import. A merge locks all involved session rows in id order
(concurrent merges can't deadlock), and `sessions.merged` makes stats recompute the event's PBs - interleaving two sessions
changes the within-session ao5/ao12 windows - which the leaderboard follows via `pb.updated`.

**Why Redis is not a readiness dependency:** with the outbox, a Redis outage only delays events. Solves keep being
accepted (rows wait in `solve.outbox`; the relay pings Redis first, backs off up to 5 s, and drains the backlog once
Redis returns, which shows up as `outbox.backlog` in `_info`). Readiness gates on Postgres + migrations only. Delivery is
at-least-once: consumers dedupe on `eventId`.

## Daily challenge
`POST /api/solves` with `daily: {date, index 0..4}` -> `source: 'daily'`. Session event must be a daily event
(`333 222 444 pyram skewb`); date must be UTC yesterday/today/tomorrow (i.e. "today" somewhere on Earth). Each attempt is
also recorded in `solve.daily_attempts` (one row per index, migration `002_daily_attempts`): an index
that was attempted before -> 409 `daily attempt already recorded`, even if its solve has been deleted since, so a known
scramble can't be redone. When all 5 attempts exist, `daily.completed` (ao5 + times, computed from the attempts) is queued
in the same transaction (advisory lock per user/date/event prevents a race). A penalty marked after the solve (`PATCH`
ok / +2 / DNF) also changes the attempt while the day is still open, and a finished day's ao5 is re-sent as
`daily.updated`. Deleting a daily solve, or re-penalising it after the day has closed, changes neither the result nor the
ao5 reported by `GET /api/solves/daily` and `GET /api/solves/daily/history`.

## Choices worth knowing
- `id` and `scramble`/`penalty` on `POST /api/solves` are optional (server generates the id; defaults `''`/`OK`). `source` may be
  `timer|manual|race|daily|import|seed`.
- `createdAt` more than 5 min in the future (a device clock running fast) is clamped to the server time instead of
  rejecting the solve; unparseable timestamps -> 400. The import clamps such timestamps the same way per solve.
- `rolling` is computed inside the transaction while the session row is locked (`FOR NO KEY UPDATE`), so concurrent
  solves in one session each see all earlier ones. ao5/ao12 use the WCA trimming rules from `@cubr/cubestats`
  (ms, `-1` = DNF, `null` = not enough solves).
- No-op PATCHes (same values) emit nothing.
- Empty bodies sent with `Content-Type: application/json` (for example a DELETE from a fetch wrapper) are accepted.
- The relay, the readiness check and the backlog count use short client-side Postgres query timeouts (`queryWithTimeout` /
  `pingPostgres` from `@cubr/common`, 1.5-10 s) on top of the pool's defaults: a connection to a DB that vanished without a TCP reset (dead pod IP during a
  failover, or a frozen VM) must not stall the relay, and frequent probes must not pile up pool clients - a timed-out
  client is released with its error, so the pool drops it.

## Env / run
Standard vars (SPEC section 4): `PORT DATABASE_URL REDIS_URL JWT_SECRET INTERNAL_API_TOKEN APP_VERSION POD_NAME NODE_NAME LOG_LEVEL`.
`INTERNAL_API_TOKEN` is the shared secret callers of `/internal/*` send as `X-Internal-Token`; while it is unset (local
development) the internal routes accept any call and log one warning at startup.
```
docker compose up -d postgres redis
PORT=8083 DATABASE_URL=postgres://cubr:cubr@localhost:55433/cubr REDIS_URL=redis://localhost:56380 npm run dev -w services/solve
npx vitest run services/solve        # unit tests: mapping, rolling, schemas, import chunking
docker build -f services/solve/Dockerfile -t cubr/solve:dev .
```
