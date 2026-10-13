# solve service

The core write path of cubetype: sessions and solves CRUD and the **transactional outbox** that feeds the
Redis event bus. Owns the Postgres schema `solve` (SPEC §7.2), migrated at startup. Port 8080.

## Routes (all `/api/*` require `Authorization: Bearer <jwt>`)
| Route | Notes |
|---|---|
| `GET /api/sessions` | creates a default `3x3`/`333` session on first call (per-user advisory lock → exactly one) |
| `POST /api/sessions` `{id?, name, event}` | 201; same id again for this user → 200 existing; id owned by someone else → 409 |
| `PATCH /api/sessions/:id` `{name}` / `DELETE /api/sessions/:id` | delete cascades solves, emits `session.deleted` |
| `GET /api/sessions/:id/solves` | `{solves}` ascending by `createdAt` |
| `POST /api/solves` | idempotent on `id` (`ON CONFLICT DO NOTHING`): retry → 200, no second event; id of another user → 409. Returns `{solve, rolling:{ao5,ao12}}` |
| `PATCH /api/solves/:id` `{penalty?, comment?}` / `DELETE /api/solves/:id` | emit `solve.updated` / `solve.deleted`; a changed solve is returned with the session's `rolling` |
| `GET /api/solves/_info`, `/api/sessions/_info` | info incl. `outbox: {backlog, published, lastPublishedAt, lastError, healthy}` |
| `GET /internal/users/:userId/solves?event=` | **no auth, not routed by the gateway**: `{solves:[{id, sessionId, timeMs, penalty, createdAt}]}` ordered by session, time (stats recompute) |

Users only ever see their own rows; foreign ids return 404. A solve always gets the event of its session.
`X-Timezone` (valid IANA name, else `UTC`) is copied into events as `tz`. Tokens revoked by logout are rejected
(Redis lookup via common's `makeAuth`; fails open while Redis is down).

## Events produced (stream `cubetype:events`, `eventId = solve-<outboxId>`)
`solve.created` (with `rolling` = session's current ao5/ao12 incl. this solve), `solve.updated`, `solve.deleted`,
`session.deleted`. Each is inserted into `solve.outbox` **in the same
transaction** as the data change. A relay loop in every replica claims up to 500 unpublished rows every 250 ms
(`FOR UPDATE SKIP LOCKED`, so replicas never double-claim), XADDs each batch in id order, and marks the rows published.
Published rows older than 1 day are deleted every 10 min.

**Why Redis is not a readiness dependency:** with the outbox, a Redis outage only delays events. Solves keep being
accepted (rows wait in `solve.outbox`; the relay pings Redis first, backs off up to 5 s, and drains the backlog once
Redis returns, which shows up as `outbox.backlog` in `_info`). Readiness gates on Postgres + migrations only. Delivery is
at-least-once: consumers dedupe on `eventId`.

## Choices worth knowing
- `id` and `scramble`/`penalty` on `POST /api/solves` are optional (server generates the id; defaults `''`/`OK`). `source` may be
  `timer|manual|race|import|seed`.
- `createdAt` more than 5 min in the future (a device clock running fast) is clamped to the server time instead of
  rejecting the solve; unparseable timestamps → 400.
- `rolling` is computed inside the transaction while the session row is locked (`FOR NO KEY UPDATE`), so concurrent
  solves in one session each see all earlier ones. ao5/ao12 use the WCA trimming rules from `@cubetype/cubestats`
  (ms, `-1` = DNF, `null` = not enough solves).
- No-op PATCHes (same values) emit nothing.
- Empty bodies sent with `Content-Type: application/json` (for example a DELETE from a fetch wrapper) are accepted.

## Env / run
Standard vars (SPEC §4): `PORT DATABASE_URL REDIS_URL JWT_SECRET APP_VERSION POD_NAME NODE_NAME LOG_LEVEL`.
```
docker compose up -d postgres redis
PORT=8083 DATABASE_URL=postgres://cubetype:cubetype@localhost:55433/cubetype REDIS_URL=redis://localhost:56380 npm run dev -w services/solve
npx vitest run services/solve        # unit tests: mapping, rolling, schemas
docker build -f services/solve/Dockerfile -t cubetype/solve:dev .
```
