# cubr - system specification

> cubr = csTimer's speedcubing functionality + Monkeytype's polish, delivered as a
> cloud-native microservice application: one VM behind Cloudflare in production, Kubernetes
> (GKE) manifests for scaling out.

This document describes the design of cubr: the repository layout, the services and what each
of them owns, the database schemas, the domain events and the HTTP contracts between the services
and the web client. The contracts come first: every service is built and tested on its own against
them, and this document changes together with the code whenever a contract changes. The deployment
is covered in `deploy/README.md`.

---

## 1. Repository layout

```
cubr/
  package.json                # npm workspaces: packages/*, services/*, jobs/*
  tsconfig.base.json          # strict TypeScript settings shared by all workspaces
  vitest.config.ts            # unit tests of packages, services and jobs
  docker-compose.yml          # full local stack: Postgres, Redis, all services, web, gateway (+ "jobs" profile)
  cloudbuild.yaml             # Cloud Build: all images in parallel
  .github/workflows/ci.yml    # typecheck, tests, bundles, web build and kustomize render on every push
  packages/
    common/                   # @cubr/common  (server bootstrap, db, redis, auth, events, http, internal calls)
    cubestats/                # @cubr/cubestats (WCA averaging, formatting, events, solve import/export) - used by web AND services
  services/
    auth/  scramble/  solve/  stats/  leaderboard/  race/  wca/
  jobs/
    wca-import/               # K8s CronJob/Job: loads the WCA public export into Postgres (schema wca)
    seed/                     # K8s Job: creates synthetic users + ~100k solves through the public APIs
  web/                        # React 18 + Vite + TypeScript SPA, served by nginx (own package.json, not a workspace)
  deploy/
    gateway/nginx.conf        # compose gateway mimicking the K8s Ingress routes
    k8s/                      # Kubernetes manifests (kustomize): base/, overlays/gke/, jobs/seed/
  scripts/
    build-service.mjs         # esbuild bundler: node scripts/build-service.mjs services/auth
    smoke.mjs                 # end-to-end check through any entry point: node scripts/smoke.mjs <baseUrl>
    commands.sh               # every GKE command, each with a comment
  docs/                       # SPEC.md (this file)
```

Each service folder: `src/index.ts` (entry), `src/routes/*.ts`, `src/migrations.ts` (if it owns a
schema), `Dockerfile`, `package.json` (name `@cubr/<svc>`), `README.md` (short), and
`test/*.test.ts` (vitest, for the pure logic).

The web app has its own `package.json` and lockfile. It uses `@cubr/cubestats` straight from
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
| Bundling | esbuild -> single `dist/index.mjs` per service (pure-JS deps only; no native modules; cubing.js stays external in the scramble image) |
| Frontend | React 18, react-router 6, Vite 6, chart.js 4, socket.io-client 4, cubing.js `<twisty-player>` |
| Deployment | Docker multi-stage images, Kubernetes + kustomize, CloudNativePG operator, GKE with Ingress, Cloud Build + Artifact Registry |

All services listen on **port 8080** inside their container. Logging via Fastify's built-in pino
logger (JSON to stdout). No pino transports (they break bundling).

## 3. Service catalogue

| Service | K8s/compose DNS name | Public route prefixes (Ingress) | Owns schema | Purpose |
|---|---|---|---|---|
| web | `web` | `/` | - | nginx serving the SPA |
| auth | `auth` | `/api/auth`, `/api/users`, `/api/supporters`, `/api/errors` | `auth` | accounts, JWT, settings, profiles, profile pictures, Ko-fi supporters, front-end error reports |
| scramble | `scramble` | `/api/scrambles` | `scramble` | WCA random-state scrambles (CPU-bound, pooled in Redis), daily challenge |
| solve | `solve` | `/api/sessions`, `/api/solves` | `solve` | sessions & solves CRUD, csTimer import/export, transactional outbox -> events |
| stats | `stats` | `/api/stats` | `stats` | event-driven read model: PBs, activity heatmap, streaks, time-of-day, global stats |
| leaderboard | `leaderboard` | `/api/leaderboards` | - (Redis only) | global/weekly/daily leaderboards in Redis sorted sets, rebuildable |
| race | `race` | `/api/race`, `/socket.io` | - (Redis only) | real-time multiplayer race rooms (WebSockets, scales via Redis adapter) |
| wca | `wca` | `/api/wca` | `wca` (filled by wca-import) | official WCA results data: records, rank/percentile estimator, distributions, person lookup |
| postgres | `postgres` (compose) / `pg-rw` (K8s CloudNativePG) | - | - | source of truth |
| redis | `redis` | - | - | event bus (Streams), cache, leaderboards, scramble pool, race state, rate limits |

Jobs: `wca-import` (weekly CronJob, also a compose one-shot) owns the `wca` schema and reloads it
from the official export; `seed` (Job) creates demo users and solves through the public APIs.

`/internal/*` routes exist only for service-to-service calls; they are NOT routed by the
Ingress/gateway and must never be reachable publicly. They also require the shared
`X-Internal-Token` (section 4), so other workloads inside the cluster cannot call them either. Requests for
unknown `/api/*` or `/internal/*` paths that reach the web nginx (the Ingress default backend) get a
JSON 404 instead of the SPA's `index.html`.

## 4. Environment variables (all services)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | |
| `SERVICE_NAME` | from code | |
| `APP_VERSION` | `dev` | baked in at image build via `--build-arg APP_VERSION` |
| `POD_NAME` | `os.hostname()` | K8s downward API |
| `NODE_NAME` | `local` | K8s downward API (spec.nodeName) |
| `DATABASE_URL` | `postgres://cubr:cubr@postgres:5432/cubr` | |
| `REDIS_URL` | `redis://redis:6379` | |
| `JWT_SECRET` | `dev-secret-change-me` | shared by all services (K8s Secret) |
| `AUTH_URL` `SCRAMBLE_URL` `SOLVE_URL` `STATS_URL` `LEADERBOARD_URL` `WCA_URL` `RACE_URL` | `http://<name>:8080` | internal base URLs |
| `LOG_LEVEL` | `info` | |
| `INTERNAL_API_TOKEN` | empty | shared secret for service-to-service calls (K8s Secret): `/internal/*` routes require it in `X-Internal-Token` (403 otherwise) and callers send it; auth also exempts such callers (the seed job) from its per-IP rate limits. Empty = not enforced, with a warning at startup (local development). |
| `TRUST_PROXY_HOPS` | `1` | proxies in front of the service whose `X-Forwarded-For` entries are trusted when deriving the client IP (rate limits): 1 behind the compose/kind gateway, 2 behind the Google load balancer. Entries a client adds itself are never trusted. |

Compose sets these in its `x-service-env` block; Kubernetes in the `cubr-config` ConfigMap and
the `cubr-secrets` Secret (plus CloudNativePG's `pg-app` Secret for `DATABASE_URL`).
Service-specific variables (e.g. scramble's `SCRAMBLE_WORKERS`, the seed job's `SEED_USERS`) are
documented in the service READMEs.

## 5. Cross-cutting conventions

- **JSON everywhere.** Errors: HTTP status + `{ "error": { "code": "BAD_REQUEST"|"UNAUTHORIZED"|"FORBIDDEN"|"NOT_FOUND"|"CONFLICT"|"RATE_LIMITED"|"UNAVAILABLE"|"INTERNAL", "message": "human readable" } }`. Use `HttpError` from `@cubr/common`. zod failures -> 400 BAD_REQUEST with the first issue as message; a body over the size limit -> 413 `PAYLOAD_TOO_LARGE`.
- **Auth:** `Authorization: Bearer <jwt>`. JWT HS256, issuer `cubr`, claims `{ sub: userId, username, jti }`, TTL 30 days. Verify with `requireAuth` / `optionalAuth` from common (also checks Redis `auth:revoked:<jti>`; fails open if Redis is down).
- **Internal calls:** `/internal/*` routes are guarded by `requireInternal(config.internalToken)` from common (constant-time comparison of `X-Internal-Token`, 403 FORBIDDEN on mismatch); callers add `internalHeaders(config.internalToken)` to their requests.
- **Rate limits:** `rateLimit()` from common, a fixed window per key (`INCR` + `EXPIRE ... NX` in one `MULTI`); it fails open while Redis is down, so an outage never locks users out.
- **Times are integer milliseconds.** In averages/PBs JSON: a number = ms, `-1` = DNF, `null` = not available. Raw solves have `timeMs` (without penalty) + `penalty` in `"OK" | "+2" | "DNF"`.
- **Timestamps** ISO-8601 strings in JSON, `timestamptz` in Postgres.
- **IDs** are UUID strings. Solve and session ids MAY be generated by the client (`crypto.randomUUID()`), which makes writes idempotent (safe retries).
- **Every response** carries the API's security headers (`SECURITY_HEADERS` in common): `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` (nothing the API sends may run as a page or be framed), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin` and `Strict-Transport-Security`, plus `X-Robots-Tag: noindex` (search engines may fetch the API to render pages, but never list it). Which pod and version answered is in `<prefix>/_info` and the logs, never in a header (until v1.4.10 every response said `X-Served-By` and `X-Service`, and the gateway added `X-Upstream`, an internal address).
- **Health:** `GET /healthz` (liveness: process alive, no dependency checks) -> `{status:"ok"}`; `GET /readyz` (readiness: Postgres/Redis reachable as applicable) -> 200 `{status:"ready"}` or 503. `GET <prefix>/_info` for each public prefix of the service (e.g. `/api/solves/_info`, `/api/sessions/_info`) -> `{service, version, pod, node, startedAt, uptimeSec, deps:{postgres?:"ok"|"down", redis?:"ok"|"down"}}` plus service-specific details; web serves a static `/_info` from nginx (`startedAt`/`uptimeSec` null, empty `deps`). The frontend status page polls these to visualise load balancing, scaling and rolling updates.
- **Timezone:** the web client sends `X-Timezone: <IANA tz>` on every API call; solve-service copies it into events as `tz` (default `UTC`), stats uses it for day bucketing.
- **Graceful shutdown:** on SIGTERM stop accepting, wait for in-flight requests, close pools (common `start()` does this). K8s adds a `preStop` sleep.
- **Migrations:** each service that owns a schema runs its own idempotent SQL migrations at startup via `migrate()` from common (uses a Postgres advisory lock so concurrent replicas don't race; records applied ids in `<schema>.schema_migrations`).
- **Pagination params:** `page` (1-based) and `size` (max 100) where relevant.
- **Validation limits:** `timeMs` 1...86 400 000; scramble <= 2 000 chars; comment <= 500 chars; session name 1...40 chars; username `^[a-zA-Z0-9_]{3,20}$`; password 8...128 chars.

## 6. WCA events

Supported event ids (WCA ids): `333, 222, 444, 555, 666, 777, 333oh, 333bf, 333fm, 444bf, 555bf, clock, minx, pyram, skewb, sq1`.
Event metadata (names, cubing.js puzzle ids, inspection, default scramble count) lives in
`@cubr/cubestats` `EVENTS`. `333oh` scrambles like `333`; `333bf/444bf/555bf` use the cubing.js
bld scramblers (orientation-randomised); `333fm` uses `333fm` scrambler. The daily challenge uses
`333, 222, 444, pyram, skewb` (`DAILY_EVENTS`).

## 7. Database design (PostgreSQL, schema-per-service)

One Postgres database `cubr`; each service owns one schema and never reads another
service's schema (communication is via HTTP or events). UUID default `gen_random_uuid()`.

### 7.1 `auth` schema (auth-service)
```sql
CREATE TABLE auth.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL,
  email         text NOT NULL,
  password_hash text,               -- null: made with Google, Apple or GitHub (migration 006)
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
-- profile pictures (migration 002): browser-resized <= 300 KB images; users.avatar_version is a
-- content hash that makes each picture URL unique (immutable, cacheable forever)
ALTER TABLE auth.users ADD COLUMN avatar_version text;
-- private profile (migration 004): strangers see only username + picture; mirrored to auth:private-users
ALTER TABLE auth.users ADD COLUMN profile_private boolean NOT NULL DEFAULT false;
-- email confirmation (migration 008): set when a link sent to the address is opened (sign-up, a change,
-- a used reset link) or a provider vouches for it (made with Google/Apple/GitHub, or one connected with
-- the same email). Password-reset links only go to a confirmed address, or to an account made before
-- 008 (predates_email_confirmation, set for every account that existed then), so nobody was locked out.
ALTER TABLE auth.users ADD COLUMN email_verified_at timestamptz;
ALTER TABLE auth.users ADD COLUMN predates_email_confirmation boolean NOT NULL DEFAULT false;
CREATE TABLE auth.avatars (
  user_id      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('image/webp','image/jpeg','image/png')),
  bytes        bytea NOT NULL,
  version      text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- password-reset links (migration 003): only the SHA-256 of the token; a row is deleted when used,
-- together with every other row of the user
-- Ko-fi supporters (migration 005): one row per Ko-fi message; hidden = removed from the about page by hand
CREATE TABLE auth.supporters (
  message_id text PRIMARY KEY, kind text NOT NULL, name text, is_public boolean NOT NULL,
  is_subscription boolean NOT NULL DEFAULT false, tier text, received_at timestamptz NOT NULL,
  hidden boolean NOT NULL DEFAULT false
);
CREATE TABLE auth.password_resets (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- an address waiting for its confirmation link (migration 007): one per user, SHA-256 of the token only.
-- new_email = the current email: confirming the account's own address (sign-up, or sent again);
-- otherwise a change of address. A new request replaces it; confirming deletes it (and, for a change,
-- the user's password-reset links)
CREATE TABLE auth.email_changes (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  new_email  text NOT NULL,
  expires_at timestamptz NOT NULL,             -- created_at + 7 days (own address) or 60 min (a change)
  created_at timestamptz NOT NULL DEFAULT now()
);
-- sign-in with Google, Apple or GitHub (migration 006): one row per connected provider account;
-- subject = the provider's stable user id, email = the verified address it gave
CREATE TABLE auth.user_identities (
  provider     text NOT NULL CHECK (provider IN ('google','apple','github')),
  subject      text NOT NULL,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  PRIMARY KEY (provider, subject)
);
CREATE UNIQUE INDEX user_identities_user_provider ON auth.user_identities (user_id, provider);
```

### 7.2 `solve` schema (solve-service)
```sql
CREATE TABLE solve.sessions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL,
  name       text NOT NULL,
  event      text NOT NULL,
  practice   boolean NOT NULL DEFAULT false,  -- migration 003: its solves count for no PB / leaderboard
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
-- daily-challenge attempts (migration 002): one row per attempted scramble, as submitted. The row
-- outlives the solve, so a deleted attempt can't be redone on the now-known scramble.
CREATE TABLE solve.daily_attempts (
  user_id     uuid NOT NULL,
  daily_date  date NOT NULL,
  event       text NOT NULL,
  daily_index smallint NOT NULL,
  solve_id    uuid NOT NULL,
  time_ms     integer NOT NULL,
  penalty     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, daily_date, event, daily_index)
);
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
Later migrations add the bookkeeping that keeps the read model exact (details in
`services/stats/README.md`): `002_ledger_outbox` - `solve_ledger` (one row per solve: idempotent
projection, tombstones for deleted solves, the tail for incremental mo3/ao50/ao100),
`deleted_sessions`, `pb_outbox` (transactional outbox for `pb.updated`), `user_totals.tz` (last
timezone seen) and `hourly.dnfs`; `003_session_names` - `sessions` (display name per session for
the history chart); `004_deleted_users` - `deleted_users` (tombstones of deleted accounts: their rows
are gone and later events for them are ignored); `005_practice_sessions` - `sessions.practice` (the
history chart's PB line leaves practice sessions out); `006_ledger_created_at` - an index for "solves
today"; `007_outbox_type` - `pb_outbox.type` (the outbox also publishes `periods.changed`).

### 7.4 `scramble` schema (scramble-service)
```sql
CREATE TABLE scramble.daily_challenges (
  day date NOT NULL, event text NOT NULL, scrambles text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (day, event)
);
```

### 7.5 `wca` schema (loaded by jobs/wca-import, read by wca-service)
Mirrors the official WCA public export (persons, countries, continents, events, competitions,
ranks_single, ranks_average) plus derived tables: `percentiles` (per event/kind: total, world
record, p10...p99), `distribution` (fine histogram buckets) and `meta` (export date/version, import
time, row count per table, size). Exact columns follow the export's TSV headers (see
`jobs/wca-import/README.md`). The importer loads into a staging schema `wca_staging` then atomically
swaps it in (zero-downtime refresh).
Indexes: `ranks_single(event_id, best)`, `ranks_average(event_id, best)`, `persons(wca_id)`,
trigram/lower index on person name for search.

### 7.6 Redis keyspace
| Key | Type | Owner | Purpose |
|---|---|---|---|
| `cubr:events` | Stream (MAXLEN ~200000) | solve/auth/stats publish | domain event bus, consumer groups `stats`, `leaderboard`, `solve` (user.deleted only) |
| `cubr:events:dlq` | Stream | consumers | dead letters: entries a consumer group could not handle |
| `auth:revoked:<jti>` | string, TTL = token remaining life | auth | logout / revocation |
| `auth:revoked-user:<userId>` | string (unix seconds), TTL 30 d | auth | account deleted: every token issued at or before then is revoked |
| `auth:oauth:flow:<state>` / `:login:<code>` / `:signup:<id>` | string JSON, TTL 10 min / 2 min / 15 min | auth | sign-in with a provider: the flow (provider, PKCE verifier, nonce, mode, next), a one-time login code, a new account waiting for its username; each read once (GETDEL, the sign-up when it completes) |
| `auth:private-users` | set of user ids | auth (stats, leaderboard read) | private profiles; added/removed in the same transaction as the flag (503 + rollback if Redis can't take it), re-added from Postgres at auth start-up and every 10 min (adds only); readers fail closed |
| `rl:<scope>:<key>` | counter, TTL | any | rate limiting |
| `scramble:pool:<event>` | list | scramble | pre-generated scrambles |
| `lb:<event>:<kind>:all` | zset (score=ms, member=userId) | leaderboard | all-time boards |
| `lb:<event>:<kind>:w:<isoWeek>` / `:d:<YYYY-MM-DD>` | zset, TTL 15d/3d | leaderboard | weekly/daily boards |
| `lb:dc:<YYYY-MM-DD>:<event>` | zset | leaderboard | daily-challenge ao5 board |
| `<board>:at` / `<board>:ts` | hash userId -> ISO / ms | leaderboard | achievedAt per entry / last applied event time (drops stale events) |
| `<board>:flagged` | hash userId -> JSON {valueMs, floorMs, achievedAt} | leaderboard | the user's best value the anti-cheat refused on that board (the API tells them why they aren't listed); expires with the board |
| `lb:users` | hash userId -> JSON {username,country,avatarUrl} | leaderboard | display info |
| `lb:flagged` | list | leaderboard | results rejected by the anti-cheat check |
| `lb:meta:built` / `lb:rebuild-lock` | string | leaderboard | marks boards as rebuilt after Redis loss / one rebuilding replica |
| `lb:deleted-users` | set | leaderboard | deleted accounts: removed from every board, later events for them ignored |
| `race:room:<id>` (+ `:conns`, `:chat`) | string JSON, hash, list | race | room state, connected sockets per pod, last 50 chat messages (shared across replicas) |
| `race:rooms`, `race:pods`, `race:lock:<id>` | zset, zset, string | race | public lobby, pod heartbeats, per-room lock |
| `cache:stats:global` | string JSON, TTL 10 s | stats | global counters |
| `cache:wca:<exportDate>.<importedAt>:*` | string JSON, TTL | wca | cache-aside for expensive queries (the dataset version in the key invalidates it on re-import) |

## 8. Domain events (Redis Stream `cubr:events`)

Each stream entry has fields `type` and `data` (JSON string). Every `data` contains `eventId`
(globally unique string - solve outbox uses `solve-<outboxId>`, others use `<svc>-<uuid>`) and
`occurredAt` (ISO). Consumers use consumer groups, ack after successful handling, reclaim stale
pending entries (XAUTOCLAIM, idle > 60 s), and are idempotent (stats keeps `processed_events`).
An entry that still fails after 5 attempts (20 for stats, whose recomputes depend on solve) is moved
to `cubr:events:dlq`. Use `publishEvent()` / `consumeEvents()` from common.

| type | publisher | data fields (besides eventId, occurredAt) |
|---|---|---|
| `user.registered` | auth | `userId, username, displayName, country, wcaId, createdAt, avatarUrl` |
| `user.updated` | auth | same as above; also sent when the profile turns private or public. Payloads carry the stranger's view: a private profile sends null displayName, country, wcaId and createdAt |
| `user.deleted` | auth | `userId, username` - the account is gone: solve deletes its sessions, solves and daily attempts; stats and leaderboard delete its rows and ignore later events for it (tombstones) |
| `solve.created` | solve | `userId, username, event, sessionId, sessionName, practice, solveId, timeMs, penalty, effectiveMs (int or null=DNF), createdAt, tz, source, rolling: {ao5, ao12}` (rolling = session's current ao5/ao12 *including* this solve; ms, -1 DNF, null n/a; `practice` = the session is a practice one: stats counts the solve but never as a PB, leaderboard skips it); daily-challenge solves also carry `dailyDate, dailyIndex` |
| `solve.updated` | solve | same fields as created (new values) |
| `solve.deleted` | solve | `userId, username, event, sessionId, solveId, timeMs, penalty, createdAt, tz, source` |
| `session.deleted` | solve | `userId, username, sessionId, event, tz` |
| `session.renamed` | solve | `userId, username, sessionId, event, name` (stats keeps session display names) |
| `session.updated` | solve | `userId, username, sessionId, event, name, practice, tz` - the session became a practice one or stopped being one (stats recomputes the event's PBs; the all-time boards follow via `pb.updated`) |
| `sessions.merged` | solve | `userId, username, event, targetId, sourceIds, solves, tz` (stats tombstones the sources and recomputes the event) |
| `solves.imported` | solve | `userId, username, events: string[], count, tz` (bulk import: consumers recompute that user's events) |
| `daily.completed` | solve | `userId, username, date, event, ao5 (ms or -1), times: number[], tz` (the five attempts, once the fifth is in) |
| `daily.updated` | solve | same as `daily.completed` - the day's result again after a penalty change on one of its attempts while the challenge is open |
| `pb.updated` | stats | `userId, username, event, kind, valueMs (int or null if no longer exists), previousMs, achievedAt` |
| `periods.changed` | stats | `userId, username, event` - the user's solves for the event changed (a new one, or one edited, deleted, merged or imported, or its session deleted or marked practice), published after stats applied it: leaderboard re-reads the user's best of each live day and week (`GET stats /internal/users/:id/period-bests`) |

## 9. HTTP API contracts

The shapes below are the contract between the services and the web client: every listed field is
always present. Responses may carry additional fields; clients ignore fields they don't know.

```ts
type PublicUser = { id: string; username: string; displayName: string|null; bio: string|null; country: string|null; wcaId: string|null; createdAt: string; avatarUrl: string|null /* '/api/users/<id>/avatar?v=<version>' */ };
type PrivateUser = PublicUser & {
  email: string;
  hasPassword: boolean;   // false: made with a provider, no password yet
  emailVerified: boolean; // the email is confirmed (users.email_verified_at): reset links can go to it
};
type Session = { id: string; name: string; event: string; createdAt: string; updatedAt: string; solveCount: number };
type Solve = { id: string; sessionId: string; event: string; timeMs: number; penalty: 'OK'|'+2'|'DNF'; scramble: string; comment: string|null; source: string; createdAt: string; dailyDate?: string|null; dailyIndex?: number|null };
type PB = { valueMs: number; solveId: string|null; achievedAt: string };
```

### 9.1 auth (`/api/auth`, `/api/users`, `/api/supporters`, `/api/errors`)
| Method & path | Auth | Body / query | Response |
|---|---|---|---|
| POST `/api/auth/register` | - | `{username, email, password}` | 201 `{token, user: PrivateUser}` (`emailVerified: false`); the address gets a link `<PUBLIC_URL>/confirm-email#<token>` that confirms it (valid 7 days, single use; emailed after the reply, and dropped if the email fails; none for internal-token callers, the seed job); 409 CONFLICT (username/email taken); 429 after 20 registrations/h/IP |
| POST `/api/auth/login` | - | `{login, password}` (login = username or email) | 200 `{token, user: PrivateUser}`; 401 (also for an account without a password, after the same dummy bcrypt compare); 429 after 10 attempts/min/IP. In production Cloudflare also blocks more than 5 in 10 s per IP for 10 s at the edge (429, same error envelope, `RATE_LIMITED`) |
| POST `/api/auth/logout` | req | - | 204 (revokes jti) |
| POST `/api/auth/password/forgot` | - | `{email}` | 202 `{ok: true}` for every address, answered before the lookup (no account enumeration by reply or timing); an account with that email gets a link `<PUBLIC_URL>/reset#<token>` (32 random bytes, valid 60 min, single use) through Resend, only if the address is confirmed or the account predates confirmation (an unconfirmed address may be a typo or someone else's); 429 after 10/h/IP; at most 3 links/h per account |
| POST `/api/auth/me/email/confirmation` | req | - | 202 `{ok: true, email}`: a new link to the account's current email that confirms it (valid 7 days; replaces a pending link or change); 400 already confirmed; 429 after 3/h or 5/day per account; 503 the email couldn't be sent (nothing pending) |
| POST `/api/auth/me/email` | req | `{email, password?}` (password required when the account has one) | 202 `{ok: true, email}`: the new address gets a link `<PUBLIC_URL>/confirm-email#<token>` (32 random bytes, valid 60 min, single use; replaces a pending change); nothing changes until it's opened; 400 same as the current email; 403 wrong password, or (no password: made with a provider) no sign-in in the last 10 min (token `iat`); 409 another account uses it; 429 after 5/h per account; 503 the email couldn't be sent (nothing pending) |
| POST `/api/auth/email/confirm` | - | `{token}` | 200 `{email, changed}`: the address is confirmed (`email_verified_at`) and the user's pending links are deleted. `changed: false`: it was the account's own address. `changed: true`: the email changes too, the user's password-reset links are deleted, and the old address gets a notice with the new one masked (`j***@example.com`) if it was confirmed (an unconfirmed one may be a stranger's); sessions carry on; 400 invalid/expired/used link; 409 another account took the address meanwhile (nothing changes, the link stays); 429 after 20/h/IP |
| POST `/api/auth/password/reset` | - | `{token, password}` (password: 8-128 chars) | 200 `{token, user: PrivateUser}`: new password set, the address confirmed (the link reached it), the user's other reset links deleted, every older token revoked (per-user revocation; the new token is issued after it); 400 invalid/expired/used link; 503 if the revocation can't be stored (nothing changes) |
| POST `/api/auth/me/password` | req | `{password?, newPassword}` (password: the current one, required when the account has one; newPassword: 8-128 chars) | 200 `{token, user: PrivateUser}`: the new password set, the user's reset links deleted, every older token revoked (this one's too; the new token is issued after it), and the account's email told ("Your cubr password was changed") if it's confirmed or predates confirming. An account without a password (made with a provider) sets its first this way. 400 the same as the current password; 403 wrong password, or (no password) no sign-in in the last 10 min (token `iat`); 429 after 5/h per account; 503 if the revocation can't be stored (nothing changes) |
| GET `/api/auth/me` | req | - | `{user: PrivateUser, settings: object}` |
| PATCH `/api/auth/me` | req | `{displayName?, bio?, country?, wcaId?, private?}` (null clears; `private: true` = private profile) | `{user: PrivateUser}` (+ `user.updated`); 503 if the private flag can't be mirrored to Redis (nothing changes) |
| PUT `/api/auth/me/settings` | req | `{settings: object}` (<= 16 KB JSON) | `{settings}` |
| PUT `/api/auth/me/avatar` | req | raw image body, `Content-Type: image/webp\|image/jpeg\|image/png`, <= 300 KB (magic bytes must match) | `{user: PrivateUser}`; 400, 413, 429 (10/h) (+ `user.updated`) |
| DELETE `/api/auth/me/avatar` | req | - | `{user: PrivateUser}` (+ `user.updated`) |
| DELETE `/api/auth/me` | req | `{password}`, or `{confirm: username}` (case-insensitive) for an account without a password | 204: the account is deleted and every token of it revoked (+ `user.deleted`, which makes the other services delete its data; its provider identities cascade); 403 wrong password or username; 429 after 5 tries/10 min; 503 when Redis can't take the revocation or the event (then nothing is deleted) |
| GET `/api/auth/oauth/providers` | - | - | `{providers: ('google'\|'apple'\|'github')[]}`: the providers whose keys are set (none = no buttons); cached 5 min |
| POST `/api/auth/oauth/:provider/start` | opt (req for `link`) | `{mode?: 'signin'\|'link', next?}` | `{url}`: the provider's sign-in page (authorization code + PKCE S256, `state`, OIDC `nonce`); sets the `cubr_oauth` cookie = state (HttpOnly, Secure, SameSite=None, Path=/api/auth/oauth, 10 min); 404 provider not set up; 401 `link` without a token; 429 after 30/10 min/IP; 503 Redis down |
| GET or POST `/api/auth/oauth/:provider/callback` | `cubr_oauth` cookie | the provider's `code` + `state` (Apple: form POST, with `user` = the name the first time) | 303 to the web app, the result in the URL fragment: `/login/sso#code=<one-time code>&next=` (a connected account; the cookie becomes the code, 2 min), `#signup=<id>&next=` (a new account; the cookie becomes the id, 15 min), `/account#linked=<provider>` (mode `link`), or `#error=<cancelled\|expired\|failed\|no_email\|email_taken\|linked_elsewhere\|already_linked\|busy>&provider=`. The state must exist (single use), be for this provider and match the cookie; ID tokens (Google RS256, Apple ES256) are checked against the provider's JWKS (issuer, audience, nonce, expiry); only a verified email counts (GitHub: the primary verified one, from its API) and a new account needs one (`no_email`). A provider email that an account already has is never linked automatically (`email_taken`). Connecting or signing in with a provider whose email is the account's confirms the account's email; 60/10 min/IP |
| POST `/api/auth/oauth/exchange` | `cubr_oauth` cookie | `{code}` | `{token, user: PrivateUser}` (`last_login_at` set); 404 code not this browser's, expired or used (not 401: the web app signs out on a 401, and a link mustn't sign anyone out); 429 after 30/10 min/IP |
| GET `/api/auth/oauth/signup/:id` | `cubr_oauth` cookie | - | `{provider, email, username}`: the new account, with a free username suggested from the provider's (null if none); 404 expired or not this browser's |
| POST `/api/auth/oauth/signup` | `cubr_oauth` cookie | `{id, username}` | 201 `{token, user: PrivateUser}`: the account (no password, its email confirmed: the provider verified it) and its identity in one transaction (+ `user.registered`); 409 username taken (the sign-up is kept for another try), email taken, or already created; 404 expired; counts toward register's 20/h/IP |
| GET `/api/auth/me/sign-in` | req | - | `{password: boolean, providers: [...] /* set up on the server */, identities: [{provider, email, createdAt}]}` |
| DELETE `/api/auth/me/identities/:provider` | req | - | 204 disconnected; 409 it's the only way in (no password, no other provider); 404 not connected |
| GET `/api/users/:idOrUsername/avatar` | - | `?v=` version | image bytes (immutable cache when `v` matches, ETag/304); 404 |
| GET `/api/users/:username` | opt | - | `{user: PublicUser}` (`private: true` and only id, username, avatarUrl for a private profile unless the token is its owner's; displayName, bio, country, wcaId, createdAt null); 404 |
| GET `/api/users?ids=a,b,c` | opt | <= 100 ids | `{users: PublicUser[]}` (private profiles as above) |
| POST `/api/supporters/kofi` | Ko-fi verification token in the payload | form-encoded `data` = Ko-fi's payment JSON (body <= 64 KB) | 200 `{ok: true}` (a repeated `message_id` is ignored); 400 not Ko-fi JSON; 403 wrong token (constant-time check against `KOFI_VERIFICATION_TOKEN`); 503 token not configured; 60/min/IP. Stores only message_id, type, the name if `is_public`, subscription flag, tier and time - never email, amount, message or payment ids |
| GET `/api/supporters` | - | - | `{supporters: [{name, member}]}`: public, not hidden, one per name (case-insensitive), most recent first, <= 200; member = a subscription payment in the last 35 days; cached 60 s |
| POST `/api/errors` | - | JSON `{kind: 'error' or 'unhandledrejection', message, stack?, source?, route, build?, browser?, installed?}`, no other fields, body <= 16 KB (10.5) | 204, logged once as `client error` (warn), scrubbed again (emails, tokens, query strings, usernames in paths, long ids), nothing stored; 400 anything else; 413 over 16 KB; 429 after 30 per 10 min per IP; past 600 an hour in total, accepted and dropped unlogged. Never logged with an IP: the route logs no request lines and the gateway doesn't log it |
| GET `/api/auth/_info`, `/api/users/_info` | - | - | info |

An account made with a provider has no password: it signs in with the provider, and "forgot password?"
(a reset link to its email) gives it one. Connecting a provider to an existing account happens only
signed in (mode `link`, from the account page), so owning an email at a provider never takes over a cubr
account. Each provider is configured by environment variables on the auth service (services/auth/README.md);
the redirect URI to register with it is `<PUBLIC_URL>/api/auth/oauth/<provider>/callback`.

**Emails** (password resets, email confirmations, and the notices after an email or password change) go
through Resend from `cubr <no-reply@cubr.dev>`, with replies to `hello@cubr.dev`, each in plain text
and HTML. The HTML is one page for all of them (`page()` in services/auth/src/mail.ts): the "cubr"
wordmark, the message, a button with its address printed under it, and the small print, in white cross,
or white cross dark in mail apps that follow dark mode. Each email carries its own `X-Entity-Ref-ID`,
so Gmail doesn't fold a second reset link into the first one's thread. Without `RESEND_API_KEY` they
are logged instead; mail to reserved domains (`example.com`, `.test`...) is never sent.

Rate limits are per client IP; callers that present `INTERNAL_API_TOKEN` (section 4) are exempt. Redis is
a soft dependency: while it is down, rate limits and revocation checks fail open, `user.*` events
are skipped, and only logout answers 503 (the revocation could not be stored).

### 9.2 scramble (`/api/scrambles`)
| Method & path | Response |
|---|---|
| GET `/api/scrambles/events` | `{events: [{id, name, short, puzzle}]}` |
| GET `/api/scrambles/daily?date=YYYY-MM-DD` (default today, UTC; the last 30 days) | `{date, events: {"333": string[5], "222": [...], "444": [...], "pyram": [...], "skewb": [...]}}` (generated once, persisted, identical for everyone); 400 for future dates; 503 while Postgres is unreachable and nothing is cached |
| GET `/api/scrambles/:event?count=1..25&fresh=0/1` | `{event, scrambles: string[], source: "pool"\|"generated"}`; `fresh=1` bypasses the pool (load tests / HPA demo), honoured only with `X-Internal-Token`, which also skips the limits; per IP otherwise: 120 requests/min and 60 newly generated scrambles/min (weighted by count; past it the pool's scrambles are returned, or 429 if there are none); 404 unknown event; 503 when generation times out or the queue is full |
| GET `/api/scrambles/_info` | info (+ warm-up, generator queue, pool sizes) |

Pool: keep `scramble:pool:<event>` topped up (333/222/pyram/skewb: 200; 444/sq1/clock/minx/333oh/333bf/333fm: 50; 555-777/444bf/555bf: 20) by a background loop in every replica (check LLEN, generate up to the target, `LTRIM` to cap). The loop only uses idle CPU; requests that find the pool short generate the rest on the fly.

### 9.3 solve (`/api/sessions`, `/api/solves`) - all routes require auth
| Method & path | Body / query | Response |
|---|---|---|
| GET `/api/sessions` | - | `{sessions: Session[]}` (created_at asc; `Session = {id, name, event, practice, createdAt, updatedAt, solveCount}`). If the user has none, create a default "3x3" session (event 333) first. |
| POST `/api/sessions` | `{id?, name, event, practice?, createdAt?}` | 201 `{session}` (idempotent on id: same id again -> 200; an id of another user -> 409). `createdAt` (ISO 8601, future values clamped to now) lets the empty session that replaces a cleared one keep its place in the list. |
| PATCH `/api/sessions/:id` | `{name?, practice?}` (at least one) | `{session}` (+ `session.renamed` for a name, `session.updated` when `practice` changes). A practice session's solves count for no personal best and no leaderboard; its own session stats are unchanged. |
| DELETE `/api/sessions/:id` | - | 204 (+ `session.deleted`) |
| POST `/api/sessions/:id/merge` | `{sourceIds: uuid[]}` (1-50, != `:id`) | `{session, merged: {sessions, solves}}` - moves all solves of the source sessions into `:id` and deletes the sources in one transaction; 404 unknown session, 409 different event (+ `sessions.merged`). The merged solves take the target's `practice`. |
| GET `/api/sessions/:id/solves` | - | `{solves: Solve[], truncated: boolean}` all solves, created_at asc (capped at the latest 50 000) |
| POST `/api/solves` | `{id, sessionId, timeMs, penalty, scramble, comment?, source?, createdAt?, daily?: {date, index}}` | 201 `{solve, rolling: {ao5, ao12}}`; if `id` already exists for this user -> 200 same shape (idempotent). A `createdAt` in the future (fast device clock) is clamped to the server time. `daily` solves: see below. |
| PATCH `/api/solves/:id` | `{penalty?, comment?}` | `{solve}` (+ `solve.updated`) |
| DELETE `/api/solves/:id` | - | 204 (+ `solve.deleted`) |
| POST `/api/sessions/import` | `{sessions: [{name, event, practice?, solves: [{timeMs, penalty, scramble, comment?, createdAt}]}]}` (<= 1 000 sessions, <= 100 000 solves, body <= 25 MB) | `{imported: {sessions, solves}}` (+ one `solves.imported`) - bulk insert in batches inside a transaction; 10 imports/h per user (429, checked before the body is read); an account holds at most 250 000 solves (400 if the import would pass it; one import per account at a time) |
| GET `/api/solves/export` | - | `{exportedAt, sessions: [Session & {solves: Solve[]}]}`, streamed from one read-only snapshot in pages of 2 000 solves (memory stays flat; 200k solves = 52 MB in ~2.5 s locally); 10 exports/h per user (429) |
| GET `/api/solves/daily?date=` | - | `{date, events: {"333": {solves: Solve[], ao5: number\|-1\|null}, ...}}` (only events with >=1 attempt; ao5 = the official result of the five attempts: times as submitted, penalties as last set while the day was open) |
| GET `/api/solves/_info`, `/api/sessions/_info` | - | info (+ outbox backlog and relay state) |
| GET `/internal/users/:userId/solves?event=` | - | `{solves: [{id, sessionId, timeMs, penalty, createdAt, practice?}]}` ordered by session_id, created_at (for stats recompute; `practice: true` on a practice session's solves) |
| GET `/internal/users/:userId/sessions` | - | `{sessions: [{id, name, event, practice}]}` (stats backfills session display names) |

Daily challenge: a `daily: {date, index 0..4}` solve gets `source: 'daily'`; its session's event must
be a daily-challenge event and `date` the UTC date of yesterday, today or tomorrow (today somewhere
on Earth). Each index can be attempted once: the attempt is recorded in `solve.daily_attempts` in the
same transaction, and a second attempt for that index -> 409, even after the first solve was deleted
(a retry with the same solve id stays idempotent). Once all five attempts exist, `daily.completed`
is emitted with the ao5 of the attempts. A penalty marked after the solve (`PATCH` ok / +2 / DNF on a
daily solve) also changes its attempt while the day is still open (same window), and a finished
day's result is re-sent as `daily.updated`. Deletes, and penalty changes after the day has closed,
change neither the result nor the board.

Outbox relay: every 250 ms each replica claims unpublished rows (`FOR UPDATE SKIP LOCKED`, LIMIT 500),
XADDs them, sets `published_at`. If Redis is down, solves still succeed and events are delivered later.
Published rows older than a day are deleted.

### 9.4 stats (`/api/stats`)
| Method & path | Response |
|---|---|
| (all `/api/stats/users/:userId/*`) | optional token; 403 `This profile is private` for a private profile unless the token is its owner's |
| GET `/api/stats/users/:userId/summary` | `{userId, username, totals: {solves, totalMs, firstSolveAt, lastSolveAt, activeDays, currentStreak, longestStreak, activeYears: number[] (newest first)}, events: [{event, solves, totalMs, meanMs, pbs: {single: PB\|null, mo3: PB\|null, ao5: PB\|null, ao12: PB\|null, ao50: PB\|null, ao100: PB\|null}}]}` (unknown user -> zeros) |
| GET `/api/stats/users/:userId/activity?from=&to=&event=` (default the 365 days ending today in the user's tz, all events) | `{from, to, days: [{date: "YYYY-MM-DD", solves, totalMs}]}` (only days with solves; `event` counts that event's solves only) |
| GET `/api/stats/users/:userId/pb-history?event=333` | `{history: [{kind, valueMs, achievedAt}]}` asc |
| GET `/api/stats/users/:userId/hourly?event=333` | `{hours: [{hour, solves, dnfs, meanMs}]}` 24 entries; `solves` counts every attempt, `meanMs` is the mean of the non-DNF ones (null if none); no `event` = all events |
| GET `/api/stats/users/:userId/solves?event=333&limit=20000` | `{event, total, truncated, sessions: [{id, name\|null, practice?, solves, firstAt, lastAt}], solves: [[unixSeconds, timeMs, effectiveMs \| null, sessionIndex], ...]}` - chronological solve series (newest `limit`, max 50 000) from the read model, for the profile history chart (session filter) |
| GET `/api/stats/global` | `{users, solves, totalMs, solvesToday, activeUsersToday}` ("today" = UTC day; cached 10 s) |
| GET `/api/stats/_info` | info |
| GET `/internal/pbs?event=&kind=` | `{pbs: [{userId, username, event, kind, valueMs, achievedAt}]}` |
| GET `/internal/users/:userId/all-time-bests?event=&minSingle=&minAverage=` | `{single?, ao5?, ao12?, flagged?: {single?, ao5?, ao12?}}`, each `{valueMs, achievedAt}`: the user's all-time best values that may rank (non-practice sessions; a single at or above `minSingle`, an average at or above `minAverage` with no single below `minSingle` in it), and the lowest ones that may not under `flagged`. For the leaderboard while a user's PB is refused. Internal token. |
| GET `/internal/users/:userId/period-bests?event=&from=&minSingle=&minAverage=` | `{days: {"YYYY-MM-DD": {single?, ao5?}}, weeks: {"YYYY-Www": {single?, ao5?}}}`, each `{valueMs, achievedAt}`: the best single and rolling ao5 (within a session, ending at a solve done that UTC day / ISO week, `from` on) of the user's non-practice sessions, from the ledger; values below the floors (the leaderboard sends its anti-cheat floors), and averages containing a single below the single floor, are left out, and the lowest of those come under `flagged: {single?, ao5?}` per day / week. Internal token. |

Streak = consecutive days (in the user's tz as bucketed) with >= 1 solve, ending today or yesterday.
PB rules: single = best effective time; mo3/aoN = best rolling value within a single session
(chronological), using `@cubr/cubestats`; practice sessions never count. On `solve.created`
compare incrementally (single + rolling ao5/ao12 from the payload; recompute others cheaply if
needed; a `practice` solve only updates the counters). On `solve.updated`, `solve.deleted`,
`session.deleted`, `session.updated`, `sessions.merged`, `solves.imported`: recompute that user's
PBs for the affected event(s) from `GET solve /internal/users/:id/solves` and rebuild that user's
daily_activity/hourly rows for the event. Emit `pb.updated` whenever a PB row changes (improves,
worsens or disappears).

### 9.5 leaderboard (`/api/leaderboards`)
| Method & path | Response |
|---|---|
| GET `/api/leaderboards/:event/:kind?period=all\|weekly\|daily&page=1&size=50&key=` | `{event, kind, period, periodKey, total, page, size, entries: [{rank, userId, username, country, avatarUrl, valueMs, achievedAt}], me: {rank, valueMs}\|null, flagged: {valueMs, floorMs, achievedAt}\|null}` - kind in single, ao5, ao12 (weekly/daily: single, ao5). `key` (optional) selects a past daily/weekly board (`YYYY-MM-DD` / `YYYY-Www`). `me` filled when a valid token is sent; `flagged` = the caller's own best time on this board that the anti-cheat refused (only to them), so the page can say why they aren't listed. |
| GET `/api/leaderboards/daily-challenge?date=&event=333&page=1&size=50` | same shape, kind `"ao5"`, period `"challenge"` |
| GET `/api/leaderboards/users/:userId/ranks` | `{ranks: [{event, kind, period:"all", rank, total, valueMs}]}`; optional token, 403 for a private profile unless it's the owner's (the boards themselves still list them) |
| GET `/api/leaderboards/_info` | info (+ consumer, rebuild and anti-cheat status) |

Sources: all-time boards from `pb.updated` (ZADD exact value; ZREM when valueMs is null or -1). A PB the
anti-cheat refuses (an impossible time, usually a mis-tap) doesn't hide the user's real solves: the leaderboard
asks stats for their best single / ao5 / ao12 above the floors (`GET stats /internal/users/:id/all-time-bests`)
and ranks those, and asks again after every `periods.changed` while a refused PB stands (a real solve slower
than the impossible PB is no new PB). An average containing an impossible single never ranks.
Weekly/daily boards from `solve.created` (single = effectiveMs, ao5 = rolling.ao5, `ZADD LT`, skip DNF),
bucketed by the UTC day / ISO week of `createdAt`. After `periods.changed` the user's entries on
every live daily and weekly board (the UTC days of the last 3 days, the ISO weeks of the last 15) are
set to stats' best of that day / week, or removed, so edits, deletions, merges and practice sessions
show there too. Those exact writes record their event time in `<board>:ts`; a keep-best write from a
`solve.created` older than that is ignored (that solve may have been deleted since).
Daily-challenge board from `daily.completed` / `daily.updated` (exact value, the latest result wins; ZREM for a DNF ao5). Display info (username, country, avatar URL) from `user.*` events and usernames in payloads.
Board writes are small Lua scripts (score and achievedAt change atomically); exact writes (all-time and daily-challenge boards, and daily/weekly ones after `periods.changed`) drop events older than the last one applied for that user.
Rank = position + 1 (equal values don't share a rank). 333fm has no boards (results are move counts).
Anti-cheat: ignore values below the WCA world record for that event/kind (fetch `GET wca /internal/records`, cache 1 h, fallback hard-coded floors about a quarter below the records, e.g. 333 single 1800 ms) - store rejected entries in `lb:flagged` (the admin's list), and the user's lowest refused value per board in `<board>:flagged` (set and cleared with the user's entry, by the same scripts and time guard; from stats' `flagged` values after `periods.changed`), which the board API returns to that user.
Rebuild: a background loop checks for `lb:meta:built` every 60 s; when it is missing (Redis lost its
data), one replica acquires `SET lb:rebuild-lock NX EX 120`, rebuilds the all-time boards from
`GET stats /internal/pbs`, then sets `lb:meta:built`.

### 9.6 race (`/api/race`, Socket.IO at `/socket.io`)
REST: GET `/api/race/rooms` -> `{rooms: [{id, name, event, players, status, createdAt}]}` (public rooms, most recently active first, <= 50; `players` = connected players);
POST `/api/race/rooms` (optional auth) `{name, event, isPrivate?}` -> 201 `{room: {id, name, event, isPrivate}}` (20 rooms/min per user or IP);
DELETE `/api/race/rooms/:id` (auth) -> 204: only the account that created the room, and only while nobody is connected; 401, 403 not the creator (or a guest's room), 404, 409 somebody is in it (otherwise a room leaves the lobby after 10 empty minutes and expires 2 h after its last change);
GET `/api/race/_info` -> info.

Socket.IO (client uses `transports: ["websocket"]` so no sticky sessions are needed; the Redis
adapter fans out broadcasts across all race pods; all room state lives in Redis so any pod can
serve any player). Handshake `auth: {token?, name?, guestId?}` (guests choose a nickname).

client -> server (with ack callbacks `{ok:true,...}|{ok:false,error,code}`):
- `room:join {roomId}` -> ack `{ok, room: RoomState, playerId, name, servedBy, chat}` (`servedBy` = the pod holding this socket, `chat` = last 50 messages)
- `room:leave {}`
- `round:next {}` (host only; fetches 1 scramble from scramble-service, falling back to a local random-move scramble, and starts round n+1) -> ack `{ok, round}`
- `player:status {status: "idle"|"inspecting"|"solving"|"done"}`
- `player:result {round, timeMs, penalty}` (current round only, once per player)
- `chat:send {text}` (<= 200 chars, 5 per 10 s)

server -> client: `room:state RoomState` (full state after every change), `chat:message {playerId, name, text, at}`.

```ts
type RoomState = { id; name; event; isPrivate: boolean; rev: number /* +1 per saved change; ignore a lower rev */;
  hostId: string|null /*playerId*/; status: "lobby"|"running"|"finished";
  round: { n: number; scramble: string; scrambleSource: "scramble-service"|"fallback"; startedAt: string } | null;
  players: { id: string; name: string; userId: string|null; status: string; connected: boolean; pods: string[] }[];
  results: Record<string /*round n*/, Record<string /*playerId*/, { timeMs: number; penalty: string }>>;
  standings: { playerId: string; name: string; wins: number; solves: number; meanMs: number|null; ao5: number|null }[];
  createdAt: string };
```
playerId = userId for logged-in users, else a stable guest id derived from the socket handshake
(`guest-<random>`; client stores it in localStorage and sends it as `auth.guestId`). Rooms expire
after 2 h without activity and hold at most 16 players. Host leaves -> oldest connected player
becomes host. Socket.IO does not keep room membership across reconnects, so the client re-emits
`room:join` on every `connect`.

### 9.7 wca (`/api/wca`) - values converted to ms (WCA centiseconds x 10); 333fm kept as moves (`unit:"moves"`, averages x100 in export -> divide); 333mbf excluded
| Method & path | Response |
|---|---|
| GET `/api/wca/meta` | `{exportDate, exportVersion, counts: {persons, competitions, ranksSingle, ranksAverage, countries}, tables, sizeBytes, citation}` (`citation` = the WCA attribution text to show next to the data) |
| GET `/api/wca/records` | `{records: [{event, eventName, unit, single: {value, personId, personName, countryId, holders}\|null, average: {...}\|null}]}` (`holders` lists ties) |
| GET `/api/wca/rank?event=333&kind=single\|average&value=12345&country=AU` | `{event, kind, value, world: {rank, total, percentile}, country: {rank, total, percentile, countryId}\|null, neighbours: [{personId, name, countryId, value, worldRank}]}` - rank = 1 + number of people strictly faster; percentile = % of people you beat; neighbours = 3 just faster + 3 just slower |
| GET `/api/wca/distribution?event=333&kind=single&buckets=50` | `{event, kind, total, p10, p25, p50, p75, p90, p99, min, buckets: [{from, to, count}], below, above}` (equal-width buckets between ~p0.5 and ~p99; `below`/`above` count the results outside them) |
| GET `/api/wca/persons?q=&limit=20` | `{persons: [{wcaId, name, countryId}]}` (name substring or exact WCA id; `limit` <= 50) |
| GET `/api/wca/persons/:wcaId` | `{person: {wcaId, name, countryId, gender}, pbs: [{event, single: {value, worldRank, continentRank, countryRank}\|null, average: {...}\|null}]}` |
| GET `/api/wca/countries` | `{countries: [{id, iso2, name, continentId, continentName, persons}]}` |
| GET `/api/wca/_info` | info (deps include postgres and whether wca data is loaded) |
| GET `/internal/records` | `{records: {[event]: {single: number\|null, average: number\|null}}}` (ms) |

Objects with a `countryId` also carry `countryIso2` (for flags). Expensive queries are cached in
Redis (`cache:wca:<dataset version>:*`, TTL 1 h, searches 10 min); a re-import changes the version
and so invalidates everything at once. If the wca schema is empty (import not yet run) return 503
UNAVAILABLE with message "WCA data not loaded yet".

## 10. Frontend (web) overview

React SPA, routes: `/` timer, `/leaderboards`, `/daily`, `/race`, `/race/:roomId`,
`/profile/:username`, `/account`, `/settings`, `/wca`, `/about`, `/login`, `/login/sso` (back from
Google, Apple or GitHub: signs in, or asks a new account for its username), `/reset`, `/confirm-email`
(the link to a new email address), `/terms`, `/privacy`. Guest mode works fully offline in localStorage; logged-in users sync to solve-service
with an optimistic local store + retry queue (idempotent ids). Monkeytype-style theme system via CSS
custom properties, command palette (Esc / Ctrl+K), focus mode while timing, toasts.

**Changing the password.** The account page's "password" row opens a dialog (`ChangePasswordModal`):
the current password, then the new one, with a show button. An account made with a provider sets its
first instead, after a fresh sign-in (the dialog offers one, as changing the email does).
- **For password managers:** `/.well-known/change-password` (W3C's well-known URL for changing
  passwords) redirects to `/account#change-password`, which opens the dialog. A signed-out visitor
  signs in first and comes back to it. The fields say which password is which (`autocomplete`), and a
  hidden username field says whose.
- **Other tabs stay signed in:** a change or a reset revokes every older token. A tab that hears through
  `localStorage` of a new token for the same account switches to it (`lib/api.ts`). A 401 never
  deletes a newer token another tab stored; the tab carries on with that one instead (`lib/auth.tsx`).

Hover styles apply only where something can hover: the build wraps every `:hover` selector in
`@media (hover: hover)` (`web/plugins/hoverMedia.ts`, a PostCSS step in `vite.config.ts`), so a tap
on a touch screen no longer leaves a button, row or link in its hover colour until the next tap.
Selectors in the same list that don't use `:hover` (`.x:hover, .x.active`) stay for touch screens
too. The profile's event donut previews an event under a mouse or keyboard focus only, not on a tap.

On touch screens the timer pages (the timer, the daily challenge, a race) have no selectable text, so
a long press meant to start the timer can't select the scramble or the averages; fields stay
selectable, and the scramble has its copy button. The touch timer's surface takes in the line under
the time (the hint, then the averages), where a thumb aimed a little low lands. A press on a button
there (the last solve's +2 and dnf) is that button's, not a start (`useTimerEngine` skips controls).
Double-tap zoom is off page-wide (`touch-action: manipulation`), so two quick taps don't zoom;
pinch zoom still works.

Touch screens get fingertip-sized controls (`@media (hover: none) and (pointer: coarse)`: global.css's
touch block, then each component's own).
- **Buttons and fields:** at least 44 px tall (Apple's minimum; WCAG 2.5.8 asks for 24 px), and
  buttons are as wide. The menus, the command palette, the stats cells and the solve list's rows are
  44 px too. `SolveList` sets its row height from the same media query, since it positions its rows
  itself.
- **The header:** its icons are full height and as wide as fits (30-32 px on 320-390 px phones).
- **Controls inside a line of text:** links, the leaderboard's names, the profile's ranks and range,
  and the login links grow into the space around them (padding with the same negative margin), so
  nothing moves.
- **Under 44 px on purpose:**
  - links inside prose (WCAG's inline exception);
  - the profile's donut legend, 36 px, a list of pickers kept beside the donut;
  - the keyboard-binding keys, which only matter with a keyboard.
- **Text and heights:** fields keep 16 px text, so iOS doesn't zoom into them. Short pages fit a
  phone's screen with its browser bars showing (`100svh`), and the timer's menus scroll within what's
  visible (`100dvh`).

The screen stays on while timing (the Screen Wake Lock API, `web/src/lib/wakeLock.ts`, held by
`TimerDisplay` for every input, races and the daily challenge included). It holds from the press,
or the start of inspection, until five minutes after the solve stops: long enough to read the time
and scramble the next one. That matters most with a Stackmat, smart cube or Bluetooth timer, which
never touch the screen, so the device counts as idle all along. Leaving the timer lets go at once.
The browser drops the lock while the page is hidden; it's taken again when the page shows. Where
the browser lacks the API (iOS before 16.4, or before 18.4 in a home-screen app; Firefox before
126), the screen sleeps as before.

### 10.1 Installable app and offline (PWA)

- **Manifest** `web/public/manifest.webmanifest`: standalone display, white cross colours (and
  white cross dark's in `color_scheme_dark`, the spec's dark colours since April 2026; no browser
  reads them yet, November 2026, so Android's splash screen stays white in dark mode), icons
  (any 192/512, maskable 192/512, monochrome 512), shortcuts (daily challenge, race, leaderboards),
  wide and narrow screenshots for Chrome's install dialog, `launch_handler: focus-existing` (a
  shortcut focuses the open window and `lib/pwa.ts` takes it to the shortcut's page). iOS:
  `apple-touch-icon.png` (180 px, opaque) and the apple meta tags in `index.html`. The images are
  drawn by `web/scripts/pwa-assets.mjs`.
- **iOS launch images** (`pwa-assets.mjs launch`): what an iPhone or iPad shows while cubr opens
  from the home screen, instead of a blank white screen.
  - The app icon's cube, 96 points across, centred, in the favicon's colours for each mode: on
    white cross's white in light mode, on white cross dark's `#1d2024` with a light centre in dark
    mode.
  - One per screen size, orientation and mode: 26 sizes, from the iPhone SE to the iPhone 18 Pro
    Max, the iPhone Air and every current iPad, so 104 images. The iPhone Duo's two sizes assume 3x,
    since Apple doesn't publish it.
  - `public/launch/` (dark ones end in `-dark`), linked from `index.html` by
    `apple-touch-startup-image` tags whose media queries give the screen in points, the pixel ratio,
    the orientation and `prefers-color-scheme`. The script writes the tags between markers. iOS uses
    an image only if it is exactly that size; the tests check every tag against its file, and each
    image's background against its mode's theme.
  - iOS picks the light or dark image for the mode the device is in when cubr is added to the home
    screen, and keeps it when the mode changes later (WebKit bug 259328, open since 2023): removing
    cubr and adding it again picks again. Untested on a device: whether iOS shows white between a
    dark launch image and the first paint.
  - iOS reads the image when the app is added to the home screen: an existing install needs
    re-adding to get it. The images aren't precached.
- **Link previews** (chat apps, social sites): `index.html` has Open Graph tags and
  `twitter:card summary_large_image`, the same for every page, since crawlers don't run the app.
  They give the title "cubr", the description "a minimalist speedcubing timer" (also the search
  engines' description), and `https://cubr.dev/og.png`: the header's logo centred on white,
  1200 x 630 and opaque (`pwa-assets.mjs og`). There's no `og:url`, so a link shared from any page
  leads back to that page.
- **Service worker** `/sw.js`, from `web/src/sw/sw.ts`, built after the app by
  `web/plugins/serviceWorker.ts`:
  - It precaches the whole build (about 2.4 MB) except source maps, the `.woff` font fallbacks,
    the icons, the screenshots, the iOS launch images and the files for other sites (the link
    preview image, `robots.txt`, `sitemap.xml`, `/.well-known/`), in the cache `cubr-app-<version>`.
    The version is a hash of the cached files' names and contents, so a release that doesn't change
    the web app ships the same `sw.js`, and browsers see no update.
  - Requests (`web/src/sw/policy.ts`):
    - navigations: the cached `index.html`;
    - `/assets/*`: cache first;
    - other same-origin GETs: network first, falling back to the cache;
    - never touched: anything but GET, other origins, `/api/*`, `/internal/*`, `/socket.io`,
      `/.well-known/*` (the server's answers for other programs, such as the redirect password
      managers follow), `/_info`, `/healthz`, `/readyz` and `/sw.js`.
  - Installing copies unchanged hashed files from the previous version's cache. Activating keeps
    the current and the previous cache (tabs still on the old version can load its chunks),
    deletes older ones, and takes over open pages.
  - An update waits. The page shows an "update ready" notice (`lib/pwa.ts`), and the update
    applies when the notice is clicked or on the next click on a link inside the app (that page
    then loads fresh); it never reloads by itself. Browsers check `sw.js` on every page load; the
    app also checks when an installed app comes back to the front, and every 30 minutes.
  - Kill switch: `VITE_SW=off` builds `src/sw/off.ts` as `sw.js`, which removes the worker and
    its caches and reloads open pages, and an app that registers no worker.
- **Offline**: the app opens without a connection. The timer uses scrambles made on the device;
  signed-in users stay signed in as the cached user, and their writes wait in the retry queue.
  Pages that need the server (leaderboards, races, profiles, WCA) show their error state. An
  installed app asks for persistent storage, so the browser keeps guest solves when space runs low.
- **Serving** (`web/nginx/default.conf.template`): `sw.js` and the manifest go out with
  `Cache-Control: no-cache` (Cloudflare respects it), the manifest as `application/manifest+json`,
  and a missing icon is a 404.
- **Settings > app**: the install button (or how to install on Safari and Firefox), whether the
  app works offline yet, and "check now" for updates. The command palette has the same actions.

### 10.2 Serving: security headers, crawlers and 404s

The web container's nginx (`web/nginx/default.conf.template`) serves the app and the site's files;
`web/src/__tests__/site.test.ts` checks its routes, headers and files against the app.

- **Security headers** on every response, set once at server level (no location may use
  `add_header`, or nginx drops the inherited ones there):
  - `Content-Security-Policy`:
    - `script-src 'self'` plus the hash of the inline theme script in `index.html`, and Cloudflare
      Web Analytics' beacon (10.3);
    - `style-src 'self'` with `style-src-attr 'unsafe-inline'` (inline style attributes only, for
      cubing.js's puzzle drawings; injected `<style>` elements are refused);
    - images from self, `data:` and `blob:`;
    - `connect-src 'self' wss://<host> https://cloudflareinsights.com` (the beacon's reports),
      `worker-src 'self'`;
    - `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'`.
    - No `blob:` or `data:` scripts: the stackmat input's AudioWorklet is a file of its own
      (`stackmat.worklet.js?url&no-inline`).
  - `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
    `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin`,
    `Strict-Transport-Security: max-age=63072000; includeSubDomains`.
  - `Permissions-Policy`: the microphone (stackmat timers), Bluetooth (smart cubes and timers), full
    screen, screen wake lock and passkeys for cubr itself; camera, location, payment, USB, serial,
    HID, MIDI, sensors, screen capture and the Topics API off.
  - `Cache-Control` by status and path: a year (`immutable`) for hashed `/assets/*`, an hour for the
    crawler files, `no-store` for `/_info` and the probes, and `no-cache` for everything else,
    errors included.
  - The gateway adds nothing to proxied responses (it would duplicate these), only to its own
    errors.
- **The site's name and logo for search engines:** `index.html` carries one JSON-LD block (a data block,
  which the CSP doesn't cover):
  - a `WebSite` (`https://cubr.dev/`, name `cubr`, alternate name `cubr.dev`, the page's description);
  - its publisher, an `Organization` named `cubr`, with the logo `/icons/icon-maskable-512.png` (512 px,
    opaque, the cube clear of a round crop) and `sameAs` the GitHub repository and the Ko-fi page.
  - `structuredData.test.ts` checks it against the files and `lib/links.ts`. The Schema Markup
    Validator finds no errors or warnings.
- **One address per page.** Search engines split a page's ranking between its addresses, so:
  - **nginx** (`map $cubr_canonical`) sends a page asked for with capitals or a trailing slash to its
    plain lowercase address: 301, query kept (`/About/?x=1` -> `/about?x=1`). A username and a room id
    keep their case. The canonical forms are listed first and never redirect, and every target is
    one of them, so nothing loops (`site.test.ts`).
  - **the app** adds `<link rel="canonical" href="https://cubr.dev/...">` to each page search engines
    may list (`lib/canonical.ts`): the path itself; the home page without a query; a profile with
    its name as stored; a board with only its event, kind and period (the default board is plain
    `/leaderboards`, as in the sitemap). Pages with `noindex` get none.
- **Real 404s.** The app's routes (section 10, case-insensitive, optional trailing slash) get
  `index.html` with 200. Usernames and room ids must look like `USERNAME_RE` and `ROOM_ID_RE`.
  Everything else is a file of the build or a 404 whose body is still `index.html`, so people see
  the app's not-found page and crawlers see the status. A well-formed name nobody has (a missing
  profile) still answers 200; its view adds `<meta name="robots" content="noindex">`, as does the
  not-found page (`lib/useNoIndex.ts`).
- **Crawlers.**
  - `robots.txt` lets them fetch everything but `/internal/`, and names `sitemap.xml` (the public
    pages: timer, daily, leaderboards, race, WCA, about, terms, privacy). The API stays crawlable on
    purpose: Google renders pages without whatever robots.txt blocks, and the leaderboards, profiles,
    the daily board and About load their content from it. API answers say `X-Robots-Tag: noindex`
    (`ROBOTS_HEADERS` in common), so they never show up in results.
  - Personal and short-lived pages answer `X-Robots-Tag: noindex`: `/account`, `/settings`,
    `/login*`, `/reset` and `/race/<id>`. They aren't blocked in robots.txt, or crawlers couldn't
    see the tag.
- **security.txt** (RFC 9116) at `/.well-known/security.txt`: contact `hello@cubr.dev`, the policy
  in `SECURITY.md`. `/security.txt` redirects to it. Its `Expires` must stay under a year ahead; a
  test fails 30 days before it passes.
- **`/.well-known/change-password`** redirects (302) to `/account#change-password`, the
  change-password dialog (section 10). Other unknown `/.well-known/` paths are 404s, which browsers
  check before they trust the redirect.
- Redirects are relative (`absolute_redirect off`): behind the gateway and Cloudflare, nginx would
  build them with the wrong scheme and port.

### 10.3 Analytics (Cloudflare Web Analytics)

- **What:** page views, referrers, browsers, countries and loading speed (Core Web Vitals), as totals
  in Cloudflare's dashboard (Analytics & Logs > Web Analytics > cubr.dev). There are no cookies or
  browser storage for it, per Cloudflare. The privacy policy describes it.
- **How:**
  - `web/src/lib/analytics.ts` adds Cloudflare's beacon (`static.cloudflareinsights.com/beacon.min.js`
    with cubr.dev's site token) when the app starts.
  - **Only on cubr.dev:** the local stack and previews are never measured.
  - **Never when the browser sends Global Privacy Control or Do Not Track.**
  - **Never twice:** not if the page already has the beacon.
  - The beacon follows the router's page changes itself and reports to `cloudflareinsights.com`.
- **Why the app adds it:** Cloudflare can inject the beacon into the pages it serves ("automatic setup",
  which Cloudflare switched on by default when the zone was created). But the offline app opens from
  its cached `index.html`, which never passes through Cloudflare. Automatic setup should be off, so the
  app's rules (no Global Privacy Control, no Do Not Track) hold for every page. The CSP allows both
  ways: the script host, and the injected beacon's same-origin `/cdn-cgi/rum`.

### 10.4 Themes, light and dark mode

- **Themes** (`web/src/lib/themes.ts`): 11 cube-inspired palettes of ten CSS custom properties.
  White cross is the default; white cross dark is its dark twin (the logo's ink background, the same
  green, white text).
- **Following the device** (`web/src/lib/settings.ts`):
  - `autoSwitchTheme` (on by default) shows `themeLight` while the device is in light mode and
    `themeDark` in dark mode (`prefers-color-scheme`), switching live when the mode changes. With it
    off, `theme` is shown.
  - Picking a theme while following sets the light or the dark one, by its own colours. Turning
    following off keeps the theme on screen; turning it on makes the theme in use the light or the
    dark one.
  - Settings saved before 1.4.14 have no `autoSwitchTheme`: the default theme starts following the
    device, any other theme stays as picked. The same rule applies to an account's settings at
    sign-in.
- **The browser's own parts:**
  - each theme sets `color-scheme` (light or dark), so scrollbars, dropdown lists and pickers match;
  - `index.html` has `<meta name="color-scheme" content="light dark">` and two `theme-color` tags
    (light and dark mode). The app sets both to the theme in use.
  - The favicon is the theme in use (a data URL). `public/favicon.svg`, used before the app starts,
    switches to white cross dark in dark mode.
- **No flash at first paint:**
  - the stylesheet's `:root` defaults are white cross, with white cross dark under
    `@media (prefers-color-scheme: dark)`;
  - the app stores the theme's colours in `cubr.themeColors`: one set, or a light and a dark set
    while following the device;
  - the inline script in `index.html` (allowed by its CSP hash) applies them before the first paint,
    picking by the device's mode.

### 10.5 Front-end error reports

- **What:** an uncaught error or unhandled promise rejection in the app (`web/src/lib/errorReports.ts`,
  production builds only) goes to POST `/api/errors` (auth, 9.1), which logs it as `client error`
  at warn level. Nothing is stored. To read them on the VM: `$C logs auth | grep '"client error"'`.
- **What a report holds:**
  - the kind, the message, the stack and the throw's file:line:column;
  - the route's pattern (`/profile/:username`; any other path is `(other)`), never the address;
  - the running code's entry file (`index-<hash>.js`), which names the exact build even in a tab
    that's older than the server;
  - a coarse browser (`Safari 18 on iOS`), never the user agent string;
  - whether it's the installed app.
- **Nothing personal:**
  - emails, tokens, query strings and fragments, usernames and room ids in paths, and long ids are
    taken out in the browser, and again by the server;
  - an odd rejection (not an Error or a string) is sent as its type only;
  - no account, and no IP address: the auth route logs no request lines, and the gateway's
    `location = /api/errors` has its access log off. The address is used only for the rate limit,
    whose Redis counter expires within 10 minutes.
- **Limits:**
  - in the browser: each distinct error once, at most 5 per page load;
  - on the server: 30 per 10 minutes per IP (429), then a total of 600 an hour, past which reports
    are accepted and dropped.
- **Skipped as noise:**
  - cross-origin "Script error.", errors from other sites' scripts and browser extensions;
  - a new release's missing chunks (`lib/chunkReload.ts` reloads instead);
  - aborted requests and ResizeObserver's loop warning.
- **Sending:** `navigator.sendBeacon` (it survives the page closing), else `fetch` with `keepalive`.
  The CSP's `connect-src 'self'` covers it. The privacy policy describes it.

## 11. Kubernetes overview (deploy/k8s)

Namespace `cubr`. One Deployment + ClusterIP Service per microservice (2+ replicas,
rolling update maxSurge 1 / maxUnavailable 0, readiness/liveness probes on /readyz /healthz,
resource requests/limits, topology spread across nodes, PDB minAvailable 1, preStop sleep),
HPA (CPU) for scramble, solve, web, race; HPA-managed Deployments don't set `replicas`. Pods run as
non-root with a read-only root filesystem, no privilege escalation, all capabilities dropped and no
service account token. PostgreSQL via CloudNativePG Cluster `pg` (primary + replicas, automatic
failover; `pg-rw` follows the primary). Redis StatefulSet with PVC. wca-import CronJob (weekly) and
seed Job. Overlays: `local` (kind, local images, an nginx gateway on a NodePort instead of the
Ingress) and `gke` (GKE Ingress = external Application Load Balancer with container-native load
balancing, BackendConfigs with `/readyz` health checks and a 1 h timeout for the race WebSockets,
three Postgres instances, `TRUST_PROXY_HOPS=2`). The Ingress serves plain HTTP on a reserved static
IP; TLS with a Google-managed certificate is possible future work. Images in Artifact Registry
`australia-southeast1-docker.pkg.dev/<project>/cubr/<svc>:<version>`. Details and the demo
runbook: `deploy/README.md`.
