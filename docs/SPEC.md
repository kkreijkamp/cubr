# cubetype — system specification

> cubetype = csTimer's speedcubing functionality + Monkeytype's polish, delivered as a
> cloud-native microservice application on Kubernetes (GKE). INFS3208 Type I project.

This document describes the design of cubetype: the repository layout, the services and what each
of them owns, the database schemas, the domain events and the HTTP contracts between the services
and the web client. The contracts come first: every service is built and tested on its own against
them, and this document changes together with the code whenever a contract changes.

---

## 1. Repository layout

```
cubetype/
  package.json                # npm workspaces: packages/*, services/*, jobs/*
  tsconfig.base.json
  docker-compose.yml          # full local stack: Postgres, Redis, all services, web, gateway
  packages/
    common/                   # @cubetype/common  (server bootstrap, db, redis, auth, events, http)
    cubestats/                # @cubetype/cubestats (WCA averaging, formatting, events, csTimer import) — used by web AND services
  services/
    auth/  scramble/  solve/  stats/  leaderboard/  race/  wca/
  jobs/
    wca-import/               # K8s Job/CronJob: loads the WCA public export into Postgres (schema wca)
    seed/                     # K8s Job: creates synthetic users + ~100k solves through the public APIs
  web/                        # React 18 + Vite + TypeScript SPA, served by nginx (own package.json, not a workspace)
  deploy/
    gateway/nginx.conf        # local reverse proxy mimicking the K8s Ingress routes
    k8s/                      # Kubernetes manifests (kustomize)
  scripts/
    build-service.mjs         # esbuild bundler: node scripts/build-service.mjs services/auth
    commands.sh               # every deploy/demo command, each with a comment (marking requirement)
  docs/                       # this specification and the project proposal
```

Each service folder: `src/index.ts` (entry), `src/routes/*.ts`, `src/migrations.ts` (if it owns a
schema), `Dockerfile`, `package.json` (name `@cubetype/<svc>`), `README.md` (short), and
`test/*.test.ts` (vitest, for the pure logic).

The web app has its own `package.json` and lockfile. It uses `@cubetype/cubestats` straight from
`packages/cubestats/src` (Vite alias + TypeScript path), so averages are computed by the same code
in the browser and in the services.

## 2. Tech stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 22, TypeScript 5 (strict), ESM (`"type": "module"`) |
| HTTP | Fastify 5 |
| Validation | zod 3 |
| Postgres | `pg` 8 (raw SQL, parameterised queries only), PostgreSQL 17 |
| Redis | `ioredis` 5, Redis 7 |
| Auth | `jose` (HS256 JWT), `bcryptjs` (cost 10) |
| Realtime | `socket.io` 4 + `@socket.io/redis-adapter` (race service only) |
| Scrambles | `cubing` (cubing.js) `randomScrambleForEvent` (scramble service only) |
| Tests | vitest |
| Bundling | esbuild → single `dist/index.mjs` per service (pure-JS deps only; no native modules) |
| Frontend | React 18, react-router 6, Vite 6, chart.js 4, cubing.js `<twisty-player>` |

All services listen on **port 8080** inside their container. Logging via Fastify's built-in pino
logger (JSON to stdout). No pino transports (they break bundling).

## 3. Service catalogue

| Service | K8s/compose DNS name | Public route prefixes (Ingress) | Owns schema | Purpose |
|---|---|---|---|---|
| web | `web` | `/` | – | nginx serving the SPA |
| auth | `auth` | `/api/auth`, `/api/users` | `auth` | accounts, JWT, settings, profiles |
| scramble | `scramble` | `/api/scrambles` | `scramble` | WCA random-state scrambles (CPU-bound, pooled in Redis), daily challenge |
| solve | `solve` | `/api/sessions`, `/api/solves` | `solve` | sessions & solves CRUD, csTimer import/export, transactional outbox → events |
| stats | `stats` | `/api/stats` | `stats` | event-driven read model: PBs, activity heatmap, streaks, time-of-day, global stats |
| leaderboard | `leaderboard` | `/api/leaderboards` | – (Redis only) | global/weekly/daily leaderboards in Redis sorted sets, rebuildable |
| race | `race` | `/api/race`, `/socket.io` | – (Redis only) | real-time multiplayer race rooms (WebSockets, scales via Redis adapter) |
| wca | `wca` | `/api/wca` | `wca` | official WCA results data: records, rank/percentile estimator, distributions, person lookup |
| postgres | `postgres` (compose) / `pg-rw` (K8s CloudNativePG) | – | – | source of truth |
| redis | `redis` | – | – | event bus (Streams), cache, leaderboards, scramble pool, race state, rate limits |

`/internal/*` routes exist only for service-to-service calls; they are NOT routed by the
Ingress/gateway and must never be reachable publicly.

## 4. Environment variables (all services)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | |
| `SERVICE_NAME` | from code | |
| `APP_VERSION` | `dev` | baked in at image build via `--build-arg APP_VERSION` |
| `POD_NAME` | `os.hostname()` | K8s downward API |
| `NODE_NAME` | `local` | K8s downward API (spec.nodeName) |
| `DATABASE_URL` | `postgres://cubetype:cubetype@postgres:5432/cubetype` | |
| `REDIS_URL` | `redis://redis:6379` | |
| `JWT_SECRET` | `dev-secret-change-me` | shared by all services (K8s Secret) |
| `AUTH_URL` `SCRAMBLE_URL` `SOLVE_URL` `STATS_URL` `LEADERBOARD_URL` `WCA_URL` `RACE_URL` | `http://<name>:8080` | internal base URLs |
| `LOG_LEVEL` | `info` | |

## 5. Cross-cutting conventions

- **JSON everywhere.** Errors: HTTP status + `{ "error": { "code": "BAD_REQUEST"|"UNAUTHORIZED"|"FORBIDDEN"|"NOT_FOUND"|"CONFLICT"|"RATE_LIMITED"|"UNAVAILABLE"|"INTERNAL", "message": "human readable" } }`. Use `HttpError` from `@cubetype/common`. zod failures → 400 BAD_REQUEST with the first issue as message.
- **Auth:** `Authorization: Bearer <jwt>`. JWT HS256, issuer `cubetype`, claims `{ sub: userId, username, jti }`, TTL 30 days. Verify with `requireAuth` / `optionalAuth` from common (also checks Redis `auth:revoked:<jti>`; fails open if Redis is down).
- **Times are integer milliseconds.** In averages/PBs JSON: a number = ms, `-1` = DNF, `null` = not available. Raw solves have `timeMs` (without penalty) + `penalty` ∈ `"OK" | "+2" | "DNF"`.
- **Timestamps** ISO-8601 strings in JSON, `timestamptz` in Postgres.
- **IDs** are UUID strings. Solve and session ids MAY be generated by the client (`crypto.randomUUID()`), which makes writes idempotent (safe retries).
- **Every response** carries `X-Served-By: <POD_NAME>` and `X-Service: <name>@<version>` (common does this).
- **Health:** `GET /healthz` (liveness: process alive, no dependency checks) → `{status:"ok"}`; `GET /readyz` (readiness: Postgres/Redis reachable as applicable) → 200 `{status:"ready"}` or 503. `GET <prefix>/_info` for each public prefix of the service (e.g. `/api/solves/_info`, `/api/sessions/_info`) → `{service, version, pod, node, startedAt, uptimeSec, deps:{postgres?:"ok"|"down", redis?:"ok"|"down"}}`; web serves `/_info`. The frontend status page polls these to visualise load balancing, scaling and rolling updates.
- **Timezone:** the web client sends `X-Timezone: <IANA tz>` on every API call; solve-service copies it into events as `tz` (default `UTC`), stats uses it for day bucketing.
- **Graceful shutdown:** on SIGTERM stop accepting, wait for in-flight requests, close pools (common `start()` does this). K8s adds a `preStop` sleep.
- **Migrations:** each service that owns a schema runs its own idempotent SQL migrations at startup via `migrate()` from common (uses a Postgres advisory lock so concurrent replicas don't race; records applied ids in `<schema>.schema_migrations`).
- **Pagination params:** `page` (1-based) and `size` (max 100) where relevant.
- **Validation limits:** `timeMs` 1…86 400 000; scramble ≤ 2 000 chars; comment ≤ 500 chars; session name 1…40 chars; username `^[a-zA-Z0-9_]{3,20}$`; password 8…128 chars.

## 6. WCA events

Supported event ids (WCA ids): `333, 222, 444, 555, 666, 777, 333oh, 333bf, 333fm, 444bf, 555bf, clock, minx, pyram, skewb, sq1`.
Event metadata (names, cubing.js puzzle ids, inspection, default scramble count) lives in
`@cubetype/cubestats` `EVENTS`. `333oh` scrambles like `333`; `333bf/444bf/555bf` use the cubing.js
bld scramblers (orientation-randomised); `333fm` uses `333fm` scrambler.

## 7. Database design (PostgreSQL, schema-per-service)

One Postgres database `cubetype`; each service owns one schema and never reads another
service's schema (communication is via HTTP or events). UUID default `gen_random_uuid()`.

### 7.1 `auth` schema (auth-service)
```sql
CREATE TABLE auth.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL,
  email         text NOT NULL,
  password_hash text NOT NULL,
  display_name  text,
  bio           text,
  country       char(2),            -- ISO 3166-1 alpha-2, nullable
  wca_id        text,               -- e.g. 2015ABCD01, nullable
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX users_username_lower ON auth.users (lower(username));
CREATE UNIQUE INDEX users_email_lower ON auth.users (lower(email));
CREATE TABLE auth.user_settings (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  settings   jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- profile pictures (migration 002): browser-resized ≤ 300 KB images; users.avatar_version is a
-- content hash that makes each picture URL unique (immutable, cacheable forever)
ALTER TABLE auth.users ADD COLUMN avatar_version text;
CREATE TABLE auth.avatars (
  user_id      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('image/webp','image/jpeg','image/png')),
  bytes        bytea NOT NULL,
  version      text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

### 7.2 `solve` schema (solve-service)
```sql
CREATE TABLE solve.sessions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL,
  name       text NOT NULL,
  event      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON solve.sessions (user_id, created_at);
CREATE TABLE solve.solves (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL,
  session_id  uuid NOT NULL REFERENCES solve.sessions(id) ON DELETE CASCADE,
  event       text NOT NULL,
  time_ms     integer NOT NULL CHECK (time_ms > 0),
  penalty     text NOT NULL DEFAULT 'OK' CHECK (penalty IN ('OK','+2','DNF')),
  scramble    text NOT NULL,
  comment     text,
  source      text NOT NULL DEFAULT 'timer' CHECK (source IN ('timer','manual','import','race','daily','seed')),
  daily_date  date,                 -- set for daily-challenge solves
  daily_index smallint,             -- 0..4
  created_at  timestamptz NOT NULL DEFAULT now(),   -- when the solve happened
  inserted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX solves_session_time ON solve.solves (session_id, created_at);
CREATE INDEX solves_user_event_time ON solve.solves (user_id, event, created_at);
CREATE UNIQUE INDEX solves_daily_unique ON solve.solves (user_id, daily_date, event, daily_index) WHERE daily_date IS NOT NULL;
CREATE TABLE solve.outbox (           -- transactional outbox: events are written in the same
  id           bigserial PRIMARY KEY,  -- transaction as the solve, then relayed to Redis Streams
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished ON solve.outbox (id) WHERE published_at IS NULL;
```

### 7.3 `stats` schema (stats-service, read model built from events)
```sql
CREATE TABLE stats.user_totals (
  user_id uuid PRIMARY KEY, username text NOT NULL,
  solves integer NOT NULL DEFAULT 0, total_ms bigint NOT NULL DEFAULT 0,
  first_solve_at timestamptz, last_solve_at timestamptz,
  registered_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE stats.personal_bests (
  user_id uuid NOT NULL, event text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('single','mo3','ao5','ao12','ao50','ao100')),
  value_ms integer NOT NULL, solve_id uuid, achieved_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, event, kind)
);
CREATE TABLE stats.pb_history (
  id bigserial PRIMARY KEY, user_id uuid NOT NULL, event text NOT NULL, kind text NOT NULL,
  value_ms integer NOT NULL, achieved_at timestamptz NOT NULL
);
CREATE INDEX pb_history_user ON stats.pb_history (user_id, event, achieved_at);
CREATE TABLE stats.daily_activity (
  user_id uuid NOT NULL, day date NOT NULL, event text NOT NULL,
  solves integer NOT NULL DEFAULT 0, total_ms bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, event)
);
CREATE TABLE stats.hourly (
  user_id uuid NOT NULL, event text NOT NULL, hour smallint NOT NULL,
  solves integer NOT NULL DEFAULT 0, sum_ms bigint NOT NULL DEFAULT 0,   -- non-DNF only
  PRIMARY KEY (user_id, event, hour)
);
CREATE TABLE stats.processed_events (event_id text PRIMARY KEY, processed_at timestamptz NOT NULL DEFAULT now());
```

### 7.4 `scramble` schema (scramble-service)
```sql
CREATE TABLE scramble.daily_challenges (
  day date NOT NULL, event text NOT NULL, scrambles text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (day, event)
);
```

### 7.5 `wca` schema (loaded by jobs/wca-import, read by wca-service)
Mirrors the official WCA public export (persons, countries, continents, events, competitions,
ranks_single, ranks_average, plus a `meta` table with export date/version and row counts).
Exact columns follow the export's TSV headers. The importer loads into a staging schema
`wca_staging` then atomically swaps it in (zero-downtime refresh).
Indexes: `ranks_single(event_id, best)`, `ranks_average(event_id, best)`, `persons(wca_id)`,
trigram/lower index on person name for search.

### 7.6 Redis keyspace
| Key | Type | Owner | Purpose |
|---|---|---|---|
| `cubetype:events` | Stream (MAXLEN ~200000) | solve/auth/stats publish | domain event bus, consumer groups `stats`, `leaderboard` |
| `cubetype:events:dlq` | Stream | consumers | dead letters: entries a consumer group could not handle |
| `auth:revoked:<jti>` | string, TTL = token remaining life | auth | logout / revocation |
| `rl:<scope>:<key>` | counter, TTL | any | rate limiting |
| `scramble:pool:<event>` | list | scramble | pre-generated scrambles |
| `lb:<event>:<kind>:all` | zset (score=ms, member=userId) | leaderboard | all-time boards |
| `lb:<event>:<kind>:w:<isoWeek>` / `:d:<YYYY-MM-DD>` | zset, TTL 15d/3d | leaderboard | weekly/daily boards |
| `lb:dc:<YYYY-MM-DD>:<event>` | zset | leaderboard | daily-challenge ao5 board |
| `lb:users` | hash userId → JSON {username,country,avatarUrl} | leaderboard | display info |
| `lb:flagged` | list | leaderboard | results rejected by the anti-cheat check |
| `lb:meta:built` | string | leaderboard | marks boards as rebuilt after Redis loss |
| `race:room:<id>` etc. | hash/json | race | room state (shared across replicas) |
| `cache:stats:global` | string JSON, TTL 10 s | stats | global counters |
| `cache:wca:*` | string JSON, TTL | wca | cache-aside for expensive queries |

## 8. Domain events (Redis Stream `cubetype:events`)

Each stream entry has fields `type` and `data` (JSON string). Every `data` contains `eventId`
(globally unique string — solve outbox uses `solve-<outboxId>`, others use `<svc>-<uuid>`) and
`occurredAt` (ISO). Consumers use consumer groups, ack after successful handling, reclaim stale
pending entries (XAUTOCLAIM, idle > 60 s), and are idempotent (stats keeps `processed_events`).
An entry that still fails after 5 attempts is moved to `cubetype:events:dlq`.
Use `publishEvent()` / `consumeEvents()` from common.

| type | publisher | data fields (besides eventId, occurredAt) |
|---|---|---|
| `user.registered` | auth | `userId, username, displayName, country, wcaId, createdAt, avatarUrl` |
| `user.updated` | auth | same as above |
| `solve.created` | solve | `userId, username, event, sessionId, solveId, timeMs, penalty, effectiveMs (int or null=DNF), createdAt, tz, source, rolling: {ao5, ao12}` (rolling = session's current ao5/ao12 *including* this solve; ms, -1 DNF, null n/a); daily-challenge solves also carry `dailyDate, dailyIndex` |
| `solve.updated` | solve | same fields as created (new values) |
| `solve.deleted` | solve | `userId, username, event, sessionId, solveId, timeMs, penalty, createdAt, tz, source` |
| `session.deleted` | solve | `userId, username, sessionId, event, tz` |
| `solves.imported` | solve | `userId, username, events: string[], count, tz` (bulk import: consumers recompute that user's events) |
| `daily.completed` | solve | `userId, username, date, event, ao5 (ms or -1), times: number[], tz` |
| `pb.updated` | stats | `userId, username, event, kind, valueMs (int or null if no longer exists), previousMs, achievedAt` |

## 9. HTTP API contracts

The shapes below are the contract between the services and the web client: every listed field is
always present. Responses may carry additional fields; clients ignore fields they don't know.

```ts
type PublicUser = { id: string; username: string; displayName: string|null; bio: string|null; country: string|null; wcaId: string|null; createdAt: string; avatarUrl: string|null /* '/api/users/<id>/avatar?v=<version>' */ };
type PrivateUser = PublicUser & { email: string };
type Session = { id: string; name: string; event: string; createdAt: string; updatedAt: string; solveCount: number };
type Solve = { id: string; sessionId: string; event: string; timeMs: number; penalty: 'OK'|'+2'|'DNF'; scramble: string; comment: string|null; source: string; createdAt: string; dailyDate?: string|null; dailyIndex?: number|null };
type PB = { valueMs: number; solveId: string|null; achievedAt: string };
```

### 9.1 auth (`/api/auth`, `/api/users`)
| Method & path | Auth | Body / query | Response |
|---|---|---|---|
| POST `/api/auth/register` | – | `{username, email, password}` | 201 `{token, user: PrivateUser}`; 409 CONFLICT (username/email taken); 429 after 20 registrations/h/IP |
| POST `/api/auth/login` | – | `{login, password}` (login = username or email) | 200 `{token, user: PrivateUser}`; 401; 429 after 10 attempts/min/IP |
| POST `/api/auth/logout` | req | – | 204 (revokes jti) |
| GET `/api/auth/me` | req | – | `{user: PrivateUser, settings: object}` |
| PATCH `/api/auth/me` | req | `{displayName?, bio?, country?, wcaId?}` (null clears) | `{user: PrivateUser}` |
| PUT `/api/auth/me/settings` | req | `{settings: object}` (≤ 16 KB JSON) | `{settings}` |
| PUT `/api/auth/me/avatar` | req | raw image body, `Content-Type: image/webp\|image/jpeg\|image/png`, ≤ 300 KB (magic bytes must match) | `{user: PrivateUser}`; 400, 413, 429 (10/h) (+ `user.updated`) |
| DELETE `/api/auth/me/avatar` | req | – | `{user: PrivateUser}` (+ `user.updated`) |
| GET `/api/users/:idOrUsername/avatar` | – | `?v=` version | image bytes (immutable cache when `v` matches, ETag/304); 404 |
| GET `/api/users/:username` | – | – | `{user: PublicUser}`; 404 |
| GET `/api/users?ids=a,b,c` | – | ≤ 100 ids | `{users: PublicUser[]}` |
| GET `/api/auth/_info` | – | – | info |

### 9.2 scramble (`/api/scrambles`)
| Method & path | Response |
|---|---|
| GET `/api/scrambles/events` | `{events: [{id, name, puzzle}]}` |
| GET `/api/scrambles/daily?date=YYYY-MM-DD` (default today, UTC) | `{date, events: {"333": string[5], "222": [...], "444": [...], "pyram": [...], "skewb": [...]}}` (generated once, persisted, identical for everyone) |
| GET `/api/scrambles/:event?count=1..25&fresh=0/1` | `{event, scrambles: string[], source: "pool"|"generated"}`; `fresh=1` bypasses the pool (used for load tests / HPA demo); 404 unknown event |
| GET `/api/scrambles/_info` | info |

Pool: keep `scramble:pool:<event>` topped up (333/222/pyram/skewb: 200; 444/sq1/clock/minx/333oh/333bf/333fm: 50; 555–777/444bf/555bf: 20) by a background loop in every replica (check LLEN, generate up to the target, `LTRIM` to cap).

### 9.3 solve (`/api/sessions`, `/api/solves`) — all routes require auth
| Method & path | Body / query | Response |
|---|---|---|
| GET `/api/sessions` | – | `{sessions: Session[]}` (created_at asc). If the user has none, create a default "3x3" session (event 333) first. |
| POST `/api/sessions` | `{id?, name, event}` | 201 `{session}` (idempotent on id) |
| PATCH `/api/sessions/:id` | `{name}` | `{session}` |
| DELETE `/api/sessions/:id` | – | 204 (+ `session.deleted`) |
| GET `/api/sessions/:id/solves` | – | `{solves: Solve[], truncated: boolean}` all solves, created_at asc (capped at the latest 50 000) |
| POST `/api/solves` | `{id, sessionId, timeMs, penalty, scramble, comment?, source?, createdAt?, daily?: {date, index}}` | 201 `{solve, rolling: {ao5, ao12}}`; if `id` already exists for this user → 200 same shape (idempotent). `daily` solves: event must match session, 409 if that index already done; once all five indexes are recorded, emit `daily.completed`. |
| PATCH `/api/solves/:id` | `{penalty?, comment?}` | `{solve}` (+ `solve.updated`) |
| DELETE `/api/solves/:id` | – | 204 (+ `solve.deleted`) |
| POST `/api/sessions/import` | `{sessions: [{name, event, solves: [{timeMs, penalty, scramble, comment?, createdAt}]}]}` (≤ 1 000 sessions, ≤ 100 000 solves, body ≤ 25 MB) | `{imported: {sessions, solves}}` (+ one `solves.imported`) — bulk insert in batches inside a transaction |
| GET `/api/solves/export` | – | `{exportedAt, sessions: [Session & {solves: Solve[]}]}` |
| GET `/api/solves/daily?date=` | – | `{date, events: {"333": {solves: Solve[], ao5: number|-1|null}, ...}}` (only events with ≥1 solve) |
| GET `/api/solves/_info` | – | info |
| GET `/internal/users/:userId/solves?event=` | – | `{solves: [{id, sessionId, timeMs, penalty, createdAt}]}` ordered by session_id, created_at (for stats recompute) |

Outbox relay: every 250 ms each replica claims unpublished rows (`FOR UPDATE SKIP LOCKED`, LIMIT 500),
XADDs them, sets `published_at`. If Redis is down, solves still succeed and events are delivered later.

### 9.4 stats (`/api/stats`)
| Method & path | Response |
|---|---|
| GET `/api/stats/users/:userId/summary` | `{userId, totals: {solves, totalMs, firstSolveAt, lastSolveAt, activeDays, currentStreak, longestStreak}, events: [{event, solves, totalMs, meanMs, pbs: {single: PB|null, mo3: PB|null, ao5: PB|null, ao12: PB|null, ao50: PB|null, ao100: PB|null}}]}` |
| GET `/api/stats/users/:userId/activity?from=&to=` (default last 365 days) | `{days: [{date: "YYYY-MM-DD", solves, totalMs}]}` (only days with solves) |
| GET `/api/stats/users/:userId/pb-history?event=333` | `{history: [{kind, valueMs, achievedAt}]}` asc |
| GET `/api/stats/users/:userId/hourly?event=333` | `{hours: [{hour, solves, meanMs}]}` 24 entries |
| GET `/api/stats/global` | `{users, solves, totalMs, solvesToday, activeUsersToday}` (cache 10 s) |
| GET `/api/stats/_info` | info |
| GET `/internal/pbs?event=&kind=` | `{pbs: [{userId, username, event, kind, valueMs, achievedAt}]}` |

Streak = consecutive days (in the user's tz as bucketed) with ≥ 1 solve, ending today or yesterday.
PB rules: single = best effective time; mo3/aoN = best rolling value within a single session
(chronological), using `@cubetype/cubestats`. On `solve.created` compare incrementally (single +
rolling ao5/ao12 from the payload; recompute others cheaply if needed). On `solve.updated`,
`solve.deleted`, `session.deleted`, `solves.imported`: recompute that user's PBs for the affected
event(s) from `GET solve /internal/users/:id/solves` and rebuild that user's daily_activity/hourly
rows for the event. Emit `pb.updated` whenever a PB row changes (improves, worsens or disappears).

### 9.5 leaderboard (`/api/leaderboards`)
| Method & path | Response |
|---|---|
| GET `/api/leaderboards/:event/:kind?period=all|weekly|daily&page=1&size=50&key=` | `{event, kind, period, periodKey, total, page, size, entries: [{rank, userId, username, country, avatarUrl, valueMs, achievedAt}], me: {rank, valueMs}|null}` — kind ∈ single, ao5, ao12 (weekly/daily: single, ao5). `key` (optional) selects a past daily/weekly board (`YYYY-MM-DD` / `YYYY-Www`). `me` filled when a valid token is sent. |
| GET `/api/leaderboards/daily-challenge?date=&event=333` | same shape, kind `"ao5"`, period `"challenge"` |
| GET `/api/leaderboards/users/:userId/ranks` | `{ranks: [{event, kind, period:"all", rank, total, valueMs}]}` |
| GET `/api/leaderboards/_info` | info |

Sources: all-time boards from `pb.updated` (ZADD exact value; ZREM when valueMs is null or -1).
Weekly/daily boards from `solve.created` (single = effectiveMs, ao5 = rolling.ao5, `ZADD LT`, skip DNF).
Daily-challenge board from `daily.completed`. Display info (username, country, avatar URL) from `user.*` events and usernames in payloads.
Anti-cheat: ignore values below the WCA world record for that event/kind (fetch `GET wca /internal/records`, cache 1 h, fallback hard-coded floors e.g. 333 single 3000 ms) — store rejected entries in `lb:flagged`.
Rebuild: a background loop checks for `lb:meta:built`; when it is missing (Redis lost its data), one
replica acquires `SET lb:rebuild-lock NX EX 120`, rebuilds the all-time boards from
`GET stats /internal/pbs`, then sets `lb:meta:built`.

### 9.6 race (`/api/race`, Socket.IO at `/socket.io`)
REST: GET `/api/race/rooms` → `{rooms: [{id, name, event, players, status, createdAt}]}` (public rooms, most recently active first);
POST `/api/race/rooms` (optional auth) `{name, event, isPrivate?}` → 201 `{room: {id, name, event, isPrivate}}`;
GET `/api/race/_info` → info.

Socket.IO (client uses `transports: ["websocket"]` so no sticky sessions are needed; the Redis
adapter fans out broadcasts across all race pods; all room state lives in Redis so any pod can
serve any player). Handshake `auth: {token?, name?}` (guests choose a nickname).

client → server (with ack callbacks `{ok:true,...}|{ok:false,error}`):
- `room:join {roomId}` → ack `{ok, room: RoomState, playerId}`
- `room:leave {}`
- `round:next {}` (host only; fetches 1 scramble from scramble-service, starts round n+1)
- `player:status {status: "idle"|"inspecting"|"solving"|"done"}`
- `player:result {round, timeMs, penalty}`
- `chat:send {text}` (≤ 200 chars)

server → client: `room:state RoomState` (full state after every change), `chat:message {playerId, name, text, at}`.

```ts
type RoomState = { id; name; event; hostId: string /*playerId*/; status: "lobby"|"running"|"finished";
  round: { n: number; scramble: string; startedAt: string } | null;
  players: { id: string; name: string; userId: string|null; status: string; connected: boolean }[];
  results: Record<string /*round n*/, Record<string /*playerId*/, { timeMs: number; penalty: string }>>;
  standings: { playerId: string; name: string; wins: number; solves: number; meanMs: number|null; ao5: number|null }[];
  createdAt: string };
```
playerId = userId for logged-in users, else a stable guest id derived from the socket handshake
(`guest-<random>`; client stores it in localStorage and sends it as `auth.guestId`). Rooms expire
after 2 h without activity. Host leaves → oldest connected player becomes host.

### 9.7 wca (`/api/wca`) — values converted to ms (WCA centiseconds × 10); 333fm kept as moves (`unit:"moves"`, averages ×100 in export → divide); 333mbf excluded
| Method & path | Response |
|---|---|
| GET `/api/wca/meta` | `{exportDate, exportVersion, counts: {persons, competitions, ranksSingle, ranksAverage, countries}}` |
| GET `/api/wca/records` | `{records: [{event, eventName, unit, single: {value, personId, personName, countryId}|null, average: {...}|null}]}` |
| GET `/api/wca/rank?event=333&kind=single|average&value=12345&country=AU` | `{event, kind, value, world: {rank, total, percentile}, country: {rank, total, percentile, countryId}|null, neighbours: [{personId, name, countryId, value, worldRank}]}` — rank = 1 + number of people strictly faster; percentile = % of people you beat; neighbours = 3 just faster + 3 just slower |
| GET `/api/wca/distribution?event=333&kind=single&buckets=50` | `{event, kind, total, p10, p25, p50, p75, p90, buckets: [{from, to, count}]}` (log-ish or trimmed to p99) |
| GET `/api/wca/persons?q=&limit=20` | `{persons: [{wcaId, name, countryId}]}` |
| GET `/api/wca/persons/:wcaId` | `{person: {wcaId, name, countryId, gender}, pbs: [{event, single: {value, worldRank, continentRank, countryRank}|null, average: {...}|null}]}` |
| GET `/api/wca/_info` | info (deps include postgres and whether wca data is loaded) |
| GET `/internal/records` | `{records: {[event]: {single: number|null, average: number|null}}}` (ms) |

Expensive queries are cached in Redis (`cache:wca:*`, TTL 1 h). If the wca schema is empty
(import not yet run) return 503 UNAVAILABLE with message "WCA data not loaded yet".

## 10. Frontend (web) overview

React SPA, routes: `/` timer, `/leaderboards`, `/daily`, `/race`, `/race/:roomId`,
`/profile/:username`, `/account`, `/settings`, `/wca`, `/status`, `/about`, `/login`.
Guest mode works fully offline in localStorage; logged-in users sync to solve-service with an
optimistic local store + retry queue (idempotent ids). Monkeytype-style theme system via CSS
custom properties, command palette (Esc / Ctrl+K), focus mode while timing, toasts.
The design system and the page layouts are described in `docs/FRONTEND.md`.

## 11. Kubernetes overview (deploy/k8s)

Namespace `cubetype`. One Deployment + ClusterIP Service per microservice (2+ replicas,
rolling update maxSurge 1 / maxUnavailable 0, readiness/liveness probes on /readyz /healthz,
resource requests/limits, topology spread across nodes, PDB minAvailable 1, preStop sleep),
HPA (CPU) for scramble, solve, web, race. PostgreSQL via CloudNativePG Cluster `pg` (primary +
replica, automatic failover). Redis StatefulSet with PVC. GKE Ingress (external Application
Load Balancer) with BackendConfig (WebSocket timeout for race). wca-import CronJob (weekly) and
seed Job. Images in Artifact Registry `australia-southeast1-docker.pkg.dev/<project>/cubetype/<svc>:<version>`.
