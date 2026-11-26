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
  vitest.config.ts            # unit tests of packages, services, jobs and the Cloudflare Worker
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
    vps/                      # production: compose.prod.yml, release.sh, deploy.sh, backups (README = runbook)
    cloudflare/down-page/     # the Worker that shows "back in a moment" while the server is down (deploy.sh)
  scripts/
    build-service.mjs         # esbuild bundler: node scripts/build-service.mjs services/auth
    smoke.mjs                 # end-to-end check through any entry point: node scripts/smoke.mjs <baseUrl>
    test-email.ts             # sends the reset email as cubr.dev does, e.g. to mail-tester.com
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
| auth | `auth` | `/api/auth`, `/api/users`, `/api/supporters`, `/api/errors`, `/api/feedback` | `auth` | accounts, JWT, settings, profiles, profile pictures, Ko-fi supporters, front-end error reports, the feedback form |
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
| `JWT_SECRET_PREVIOUS` | (empty) | the key before a rotation: tokens it signed still verify until they expire (30 days; the runbook's "Rotating keys"); new tokens use `JWT_SECRET` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | (empty) | solve: the daily reminders' Web Push key pair (`deploy/vps/vapid-keys.mjs` makes one; deploy.sh does on the VM the first time). Empty = no reminders (the key route answers null, turning them on 503) |
| `VAPID_SUBJECT` | `mailto:hello@cubr.dev` | solve: the contact the push services see with each reminder |
| `AUTH_URL` `SCRAMBLE_URL` `SOLVE_URL` `STATS_URL` `LEADERBOARD_URL` `WCA_URL` `RACE_URL` | `http://<name>:8080` | internal base URLs |
| `LOG_LEVEL` | `info` | |
| `INTERNAL_API_TOKEN` | empty | shared secret for service-to-service calls (K8s Secret): `/internal/*` routes require it in `X-Internal-Token` (403 otherwise) and callers send it; auth also exempts such callers (the seed job) from its per-IP rate limits. Empty = not enforced, with a warning at startup (local development). |
| `TRUST_PROXY_HOPS` | `1` | proxies in front of the service whose `X-Forwarded-For` entries are trusted when deriving the client IP (rate limits): 1 behind the compose/kind gateway, 2 behind the Google load balancer. Entries a client adds itself are never trusted. |

Compose sets these in its `x-service-env` block; Kubernetes in the `cubr-config` ConfigMap and
the `cubr-secrets` Secret (plus CloudNativePG's `pg-app` Secret for `DATABASE_URL`).
Service-specific variables (e.g. scramble's `SCRAMBLE_WORKERS`, the seed job's `SEED_USERS`) are
documented in the service READMEs.

## 5. Cross-cutting conventions

- **JSON everywhere.** Errors: HTTP status + `{ "error": { "code": "BAD_REQUEST"|"UNAUTHORIZED"|"FORBIDDEN"|"NOT_FOUND"|"CONFLICT"|"RATE_LIMITED"|"UNAVAILABLE"|"INTERNAL", "message": "human readable" } }`. Use `HttpError` from `@cubr/common`. zod failures -> 400 BAD_REQUEST with the first issue as message; a body over the size limit -> 413 `PAYLOAD_TOO_LARGE`. The gateway limits each visitor (the real address, from `CF-Connecting-IP`) on every `/api/` route to 30 requests a second with bursts of 300, and answers past it with 429 `RATE_LIMITED` and `Retry-After: 1` (the race's websocket and the web app's files aren't limited there); the per-route limits below come on top.
- **Auth:** `Authorization: Bearer <jwt>`. JWT HS256, issuer `cubr`, claims `{ sub: userId, username, jti }`, TTL 30 days. Verify with `requireAuth` / `optionalAuth` from common (also checks Redis `auth:revoked:<jti>`; fails open if Redis is down).
- **Internal calls:** `/internal/*` routes are guarded by `requireInternal(config.internalToken)` from common (constant-time comparison of `X-Internal-Token`, 403 FORBIDDEN on mismatch); callers add `internalHeaders(config.internalToken)` to their requests.
- **Rate limits:** `rateLimit()` from common, a fixed window per key (`INCR` + `EXPIRE ... NX` in one `MULTI`); it fails open while Redis is down, so an outage never locks users out.
- **Times are integer milliseconds.** In averages/PBs JSON: a number = ms, `-1` = DNF, `null` = not available. Raw solves have `timeMs` (without penalty) + `penalty` in `"OK" | "+2" | "DNF"`.
- **Display:** singles are truncated to the chosen precision (`formatTime`), averages and means rounded, x.xx5 up (`formatAverage`, WCA 9f1). An average is whole milliseconds wherever it is stored or ranked (the mean rounded once, to the ms), and every page formats it with `formatAverage` (`formatResult` picks by kind), so it reads the same everywhere.
- **Timestamps** ISO-8601 strings in JSON, `timestamptz` in Postgres.
- **IDs** are UUID strings. Solve and session ids MAY be generated by the client (`crypto.randomUUID()`), which makes writes idempotent (safe retries).
- **Every response** carries the API's security headers (`SECURITY_HEADERS` in common): `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` (nothing the API sends may run as a page or be framed), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin` and `Strict-Transport-Security`, plus `X-Robots-Tag: noindex` (search engines may fetch the API to render pages, but never list it). Which pod and version answered is in `<prefix>/_info` and the logs, never in a header (until v1.4.10 every response said `X-Served-By` and `X-Service`, and the gateway added `X-Upstream`, an internal address).
- **Health:** `GET /healthz` (liveness: process alive, no dependency checks) -> `{status:"ok"}`; `GET /readyz` (readiness: Postgres/Redis reachable as applicable) -> 200 `{status:"ready"}` or 503. `GET <prefix>/_info` for each public prefix of the service (e.g. `/api/solves/_info`, `/api/sessions/_info`) -> `{service, version, pod, node, startedAt, uptimeSec, deps:{postgres?:"ok"|"down", redis?:"ok"|"down"}}` plus service-specific details; web serves a static `/_info` from nginx (`startedAt`/`uptimeSec` null, empty `deps`). The frontend status page polls these to visualise load balancing, scaling and rolling updates.
- **Timezone:** the web client sends `X-Timezone: <IANA tz>` on every API call; solve-service copies it into events as `tz` (default `UTC`), stats uses it for day bucketing.
- **Graceful shutdown:** on SIGTERM stop accepting, wait for in-flight requests, close pools (common `start()` does this). K8s adds a `preStop` sleep.
- **Migrations:** each service that owns a schema runs its own idempotent SQL migrations at startup via `migrate()` from common (uses a Postgres advisory lock so concurrent replicas don't race; records applied ids in `<schema>.schema_migrations`).
- **Pagination params:** `page` (1-based) and `size` (max 100) where relevant.
- **Validation limits:** `timeMs` 1...86 400 000; scramble <= 2 000 chars; comment <= 500 chars; session name 1...40 chars; username `^[a-zA-Z0-9_]{3,20}$`; password 8...128 chars.

## 6. Events and scramble types

WCA events (WCA ids, `EVENTS`, `kind: 'wca'`): `333, 222, 444, 555, 666, 777, 333oh, 333bf, 333fm, 444bf, 555bf, clock, minx, pyram, skewb, sq1, fto`.
FTO is official from 2 January 2027 (WCA, June 2026). Event metadata (names, cubing.js puzzle ids,
inspection) lives in `@cubr/cubestats` `EVENTS`. `333oh` scrambles like `333`; `333bf/444bf/555bf`
use the cubing.js bld scramblers (orientation-randomised); `333fm` uses `333fm` scrambler. The daily
challenge uses `333, 222, 444, pyram, skewb` (`DAILY_EVENTS`). Leaderboards and races are for the
WCA events only (`isWcaEvent`).

Other events (`OTHER_EVENTS`, `kind: 'other'`, 45): csTimer's other puzzles and relays (its "other"
and "special" groups without the jokes). A csTimer group of different puzzles (LxMxN, Cmetrick,
Helicopter, Siamese, Square, Bandaged, Relays) is split into one event per puzzle; the relays
(2-4 to 2-7, Mini Guildford, 3x3 relay of 5) use WCA scrambles (`RELAY_PARTS`). `puzzle` is null
where cubing.js has no puzzle of its own: the preview is csTimer's drawing redrawn as a cubr net, in
3D the model cubing.js builds from the puzzle's geometry where it can, or a relay's puzzles' own
previews (section 10). They count for personal bests like any event; they have no leaderboards.

Scramble types (`SCRAMBLE_TYPES`, scrambleTypes.ts): csTimer's second scramble menu per event, with
csTimer's ids (`pll`, `222eg1`, `444m`...). The first is the event's default: the only one whose
solves count for personal bests and leaderboards. A session made for any other type (its
`scramble` field) is always a practice session. `pending` types (three: `mgms2l`, `pyrtop`,
`skbll`) are listed but not scrambled: csTimer added them after the version of its scramblers cubr
uses. How each is made (services/scramble/src/kinds.ts): a WCA event's default from the pool /
cubing.js; the 3x3 and 2x2 practice types from a random state with pinned pieces (csTimer's
masks, practice.ts) solved by cubing.js and given backwards; csTimer's random-move types from its
move tables (cubestats randomMoves.ts, also the web app's offline fallback); relays, cuboids and
mirror blocks from WCA scrambles; and everything else from csTimer's own scramblers, kilominx, redi
cube and master pyraminx random state included (cubing.js's kilominx needed about 800 MB of tables and
14 s, more than production's 192 MB heaps allow; csTimer's makes one in under half a second), npm
`cstimer_module` (GPL-3.0, by csTimer's
author, pinned to 0.1.5 in package.json and the Dockerfile), at csTimer's default lengths
(`CSTIMER_LENGTHS`). The 3x3 move subsets (`2gen`, `roux`, `half`...) come from csTimer too, random
state within the subgroup (offline, the web app makes them as random moves). The module runs in a
worker thread of its own (cstimer.ts: one request at a time, the scramble timeout per request, a
runaway scrambler's thread killed and replaced, at most `SCRAMBLE_MAX_QUEUE` waiting, and a thread
idle for 10 minutes stopped, giving back the tables its scramblers built). cubing.js keeps every
table in its one search worker, under production's 192 MB heap cap: the warm-up list
(`WARMUP_EVENTS`) is what has to fit there together, and CI's "Scramble image" job runs the image
under that cap through its warm-up.

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
-- profile pictures (migration 002): uploads (the browser crops them to 256x256) are decoded and stored
-- again as a 256x256 WebP made from their pixels alone (no EXIF or other metadata; services/auth/src/
-- avatarImage.ts); rows from before v1.5.15 keep the browser's bytes. users.avatar_version is a
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
  scramble   text,                            -- migration 005: a practice scramble type (always practice); NULL = the default
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
-- when each official daily attempt started (migration 006): a second start of it is a DNF
CREATE TABLE solve.daily_starts (
  user_id uuid NOT NULL, daily_date date NOT NULL, event text NOT NULL, daily_index smallint NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, daily_date, event, daily_index)
);-- daily-challenge reminders (migration 007): one row per browser that turned them on (its Web Push
-- subscription), the minute of its local day it wants one, and the local day it last got one. Once a
-- minute the solve service (one instance, a Redis lock) sends those due, unless the person already has an
-- attempt or a started one at today's challenge (UTC's day, any event); at most 3 h late; the push
-- service's 404/410 deletes the row, other failures give up for the day. Deleted with the account.
CREATE TABLE solve.push_subscriptions (
  endpoint text PRIMARY KEY, user_id uuid NOT NULL, p256dh text NOT NULL, auth text NOT NULL,
  remind_minute smallint NOT NULL DEFAULT 600, tz text NOT NULL, last_day date,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
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
| `cubr:events:attempts:<group>` | Hash | consumers | retry state of a group's failed pending entries: failures, first failure, next try |
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
pending entries (XAUTOCLAIM, idle > 60 s; a backlog drains batch after batch while handling
succeeds), stop between entries when shutting down, and are idempotent (stats keeps
`processed_events`). A failed entry is retried on its own schedule: a minute after the first failure,
doubling to at most 10 minutes (its state is in `cubr:events:attempts:<group>`, cleared by whichever
replica handles it). It moves to `cubr:events:dlq` only once it has failed 5 times and its first
failure is a day old, so an outage of a dependency (stats behind solve, the leaderboard behind stats)
loses nothing. A dead letter keeps its group, type, data, error, attempts and first failure.
`deploy/vps/dead-letters.sh` lists a service's dead letters and replays them, through that service's
`/internal/events/dead-letters` routes: a replayed entry carries a `group` field, and the other groups
acknowledge it without handling it. Use `publishEvent()` / `consumeEvents()` from common.

| type | publisher | data fields (besides eventId, occurredAt) |
|---|---|---|
| `user.registered` | auth | `userId, username, displayName, country, wcaId, createdAt, avatarUrl` |
| `user.updated` | auth | same as above; also sent when the profile turns private or public. Payloads carry the stranger's view: a private profile sends null displayName, country, wcaId and createdAt |
| `user.deleted` | auth | `userId, username` - the account is gone: solve deletes its sessions, solves and daily attempts; stats and leaderboard delete its rows and ignore later events for it (tombstones) |
| `solve.created` | solve | `userId, username, event, sessionId, sessionName, practice, solveId, timeMs, penalty, effectiveMs (int or null=DNF), createdAt, tz, source, rolling: {ao5, ao12}` (rolling = the session's ao5/ao12 over its solves up to and *including* this one: the current ones for the newest solve, the window ending at it for a back-dated one; ms, -1 DNF, null n/a; `practice` = the session is a practice one: stats counts the solve but never as a PB, leaderboard skips it); daily-challenge solves also carry `dailyDate, dailyIndex` |
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
  emailReleased?: true;   // never confirmed within 7 days and taken by another account: it has none (email is a placeholder)
};
type Session = { id: string; name: string; event: string; createdAt: string; updatedAt: string; solveCount: number };
type Solve = { id: string; sessionId: string; event: string; timeMs: number; penalty: 'OK'|'+2'|'DNF'; scramble: string; comment: string|null; source: string; createdAt: string; dailyDate?: string|null; dailyIndex?: number|null };
type PB = { valueMs: number; solveId: string|null; achievedAt: string };
```

### 9.1 auth (`/api/auth`, `/api/users`, `/api/supporters`, `/api/errors`, `/api/feedback`)
| Method & path | Auth | Body / query | Response |
|---|---|---|---|
| POST `/api/auth/register` | - | `{username, email, password}` | 201 `{token, user: PrivateUser}` (`emailVerified: false`); the address gets a link `<PUBLIC_URL>/confirm-email#<token>` that confirms it (valid 7 days, single use; emailed after the reply, and dropped if the email fails; none for internal-token callers, the seed job); 409 CONFLICT (username taken, or an email another account holds: see "Unconfirmed addresses" below); 429 after 20 registrations/h/IP |
| POST `/api/auth/login` | - | `{login, password}` (login = username or email) | 200 `{token, user: PrivateUser}`; 401 (also for an account without a password, after the same dummy bcrypt compare); 429 after 10 attempts/min/IP. In production Cloudflare also blocks more than 5 in 10 s per IP for 10 s at the edge (429, same error envelope, `RATE_LIMITED`) |
| POST `/api/auth/logout` | req | - | 204 (revokes jti) |
| POST `/api/auth/logout/everywhere` | req | - | 200 `{token, user}`: every token issued so far is revoked (every other browser and device signs out) and this session carries on with the fresh token; 5 an hour |
| POST `/api/auth/password/forgot` | - | `{email}` | 202 `{ok: true}` for every address, answered before the lookup (no account enumeration by reply or timing); an account with that email gets a link `<PUBLIC_URL>/reset#<token>` (32 random bytes, valid 60 min, single use) through Resend, only if the address is confirmed or the account predates confirmation (an unconfirmed address may be a typo or someone else's); 429 after 10/h/IP; at most 3 links/h per account |
| POST `/api/auth/me/email/confirmation` | req | - | 202 `{ok: true, email}`: a new link to the account's current email that confirms it (valid 7 days; replaces a pending link or change); 400 already confirmed, or the account has no email (`emailReleased`); 429 after 3/h or 5/day per account; 503 the email couldn't be sent (nothing pending) |
| POST `/api/auth/me/email` | req | `{email, password?}` (password required when the account has one) | 202 `{ok: true, email}`: the new address gets a link `<PUBLIC_URL>/confirm-email#<token>` (32 random bytes, valid 60 min, single use; replaces a pending change); nothing changes until it's opened; 400 same as the current email; 403 wrong password, or (no password: made with a provider) no sign-in in the last 10 min (token `iat`); 409 another account holds it (one left unconfirmed past its 7 days doesn't count, and is freed when the change is confirmed); 429 after 5/h per account; 503 the email couldn't be sent (nothing pending) |
| POST `/api/auth/email/confirm` | - | `{token}` | 200 `{email, changed}`: the address is confirmed (`email_verified_at`) and the user's pending links are deleted. `changed: false`: it was the account's own address. `changed: true`: the email changes too, the user's password-reset links are deleted, and the old address gets a notice with the new one masked (`j***@example.com`) if it was confirmed (an unconfirmed one may be a stranger's); sessions carry on; 400 invalid/expired/used link; 409 another account took the address meanwhile (nothing changes, the link stays); 429 after 20/h/IP |
| POST `/api/auth/password/reset` | - | `{token, password}` (password: 8-128 chars) | 200 `{token, user: PrivateUser}`: new password set, the address confirmed (the link reached it), the user's other reset links deleted, every older token revoked (per-user revocation; the new token is issued after it); 400 invalid/expired/used link; 503 if the revocation can't be stored (nothing changes) |
| POST `/api/auth/me/password` | req | `{password?, newPassword}` (password: the current one, required when the account has one; newPassword: 8-128 chars) | 200 `{token, user: PrivateUser}`: the new password set, the user's reset links deleted, every older token revoked (this one's too; the new token is issued after it), and the account's email told ("Your cubr password was changed") if it's confirmed or predates confirming. An account without a password (made with a provider) sets its first this way. 400 the same as the current password; 403 wrong password, or (no password) no sign-in in the last 10 min (token `iat`); 429 after 5/h per account; 503 if the revocation can't be stored (nothing changes) |
| GET `/api/auth/me` | req | - | `{user: PrivateUser, settings: object}` |
| PATCH `/api/auth/me` | req | `{displayName?, bio?, country?, wcaId?, private?}` (null clears; `private: true` = private profile) | `{user: PrivateUser}` (+ `user.updated`); 503 if the private flag can't be mirrored to Redis (nothing changes) |
| PUT `/api/auth/me/settings` | req | `{settings: object}` (<= 16 KB JSON) | `{settings}` |
| PUT `/api/auth/me/avatar` | req | raw image body, `Content-Type: image/webp\|image/jpeg\|image/png`, <= 300 KB (magic bytes must match), <= 2048 px a side | `{user: PrivateUser}`; stored as a fresh 256x256 WebP: turned upright by its EXIF orientation, cropped to the centre, first frame only, no metadata. 400 (not a decodable PNG, JPEG or WebP, or over 2048 px), 413, 415, 429 (10/h) (+ `user.updated`) |
| DELETE `/api/auth/me/avatar` | req | - | `{user: PrivateUser}` (+ `user.updated`) |
| DELETE `/api/auth/me` | req | `{password}`, or `{confirm: username}` (case-insensitive) for an account without a password | 204: the account is deleted and every token of it revoked (+ `user.deleted`, which makes the other services delete its data; its provider identities cascade); 403 wrong password or username; 429 after 5 tries/10 min; 503 when Redis can't take the revocation or the event (then nothing is deleted) |
| GET `/api/auth/oauth/providers` | - | - | `{providers: ('google'\|'apple'\|'github')[]}`: the providers whose keys are set (none = no buttons); cached 5 min |
| POST `/api/auth/oauth/:provider/start` | opt (req for `link`) | `{mode?: 'signin'\|'link', next?}` | `{url}`: the provider's sign-in page (authorization code + PKCE S256, `state`, OIDC `nonce`); sets the `cubr_oauth` cookie = state (HttpOnly, Secure, SameSite=None, Path=/api/auth/oauth, 10 min); 404 provider not set up; 401 `link` without a token; 429 after 30/10 min/IP; 503 Redis down |
| GET or POST `/api/auth/oauth/:provider/callback` | `cubr_oauth` cookie | the provider's `code` + `state` (Apple: form POST, with `user` = the name the first time) | 303 to the web app, the result in the URL fragment: `/login/sso#code=<one-time code>&next=` (a connected account; the cookie becomes the code, 2 min), `#signup=<id>&next=` (a new account; the cookie becomes the id, 15 min), `/account#linked=<provider>` (mode `link`), or `#error=<cancelled\|expired\|failed\|no_email\|email_taken\|linked_elsewhere\|already_linked\|busy>&provider=`. The state must exist (single use), be for this provider and match the cookie; ID tokens (Google RS256, Apple ES256) are checked against the provider's JWKS (issuer, audience, nonce, expiry); only a verified email counts (GitHub: the primary verified one, from its API) and a new account needs one (`no_email`). A provider email that an account already has is never linked automatically (`email_taken`); one an account left unconfirmed past its 7 days doesn't block a new account, which takes it (below). Connecting or signing in with a provider whose email is the account's confirms the account's email; 60/10 min/IP |
| POST `/api/auth/oauth/exchange` | `cubr_oauth` cookie | `{code}` | `{token, user: PrivateUser}` (`last_login_at` set); 404 code not this browser's, expired or used (not 401: the web app signs out on a 401, and a link mustn't sign anyone out); 429 after 30/10 min/IP |
| GET `/api/auth/oauth/signup/:id` | `cubr_oauth` cookie | - | `{provider, email, username}`: the new account, with a free username suggested from the provider's (null if none); 404 expired or not this browser's |
| POST `/api/auth/oauth/signup` | `cubr_oauth` cookie | `{id, username}` | 201 `{token, user: PrivateUser}`: the account (no password, its email confirmed: the provider verified it) and its identity in one transaction (+ `user.registered`); 409 username taken (the sign-up is kept for another try), email taken, or already created; 404 expired; counts toward register's 20/h/IP |
| GET `/api/auth/me/sign-in` | req | - | `{password: boolean, providers: [...] /* set up on the server */, identities: [{provider, email, createdAt}]}` |
| DELETE `/api/auth/me/identities/:provider` | req | - | 204 disconnected; 409 it's the only way in (no password, no other provider); 404 not connected. Connecting or disconnecting one tells the account's email ("GitHub was connected to your cubr account") if it's confirmed or predates confirming. |
| GET `/api/users/:idOrUsername/avatar` | - | `?v=` version | image bytes (immutable cache when `v` matches, ETag/304); 404 |
| GET `/api/users/:username` | opt | - | `{user: PublicUser}` (`private: true` and only id, username, avatarUrl for a private profile unless the token is its owner's; displayName, bio, country, wcaId, createdAt null); 404 |
| GET `/api/users?ids=a,b,c` | opt | <= 100 ids | `{users: PublicUser[]}` (private profiles as above) |
| POST `/api/supporters/kofi` | Ko-fi verification token in the payload | form-encoded `data` = Ko-fi's payment JSON (body <= 64 KB) | 200 `{ok: true}` (a repeated `message_id` is ignored); 400 not Ko-fi JSON; 403 wrong token (constant-time check against `KOFI_VERIFICATION_TOKEN`); 503 token not configured; 60/min/IP. Stores only message_id, type, the name if `is_public`, subscription flag, tier and time - never email, amount, message or payment ids |
| GET `/api/supporters` | - | - | `{supporters: [{name, member}]}`: public, not hidden, one per name (case-insensitive), most recent first, <= 200; member = a subscription payment in the last 35 days; cached 60 s |
| POST `/api/errors` | - | JSON `{kind: 'error' or 'unhandledrejection', message, stack?, source?, route, build?, browser?, installed?}`, no other fields, body <= 16 KB (10.5) | 204, logged once as `client error` (warn), scrubbed again (emails, tokens, query strings, usernames in paths, long ids), nothing stored; 400 anything else; 413 over 16 KB; 429 after 30 per 10 min per IP; past 600 an hour in total, accepted and dropped unlogged. Never logged with an IP: the route logs no request lines and the gateway doesn't log it |
| POST `/api/feedback` | - | JSON `{kind: 'bug' or 'idea' or 'question' or 'account' or 'other', message, email?, details?}` (message: 1-5,000 characters once trimmed, line breaks kept, other control characters taken out; email: for a reply, `''` = none; details: the app's line, <= 300 characters, put on one line), no other fields, body <= 32 KB (10.6) | 204: emailed through Resend to the contact inbox (`MAIL_REPLY_TO`, hello@cubr.dev), subject `cubr feedback (<type>): <first line>`, with reply-to the sender's address if given; nothing stored, not linked to an account (a token is ignored); 400 anything else; 413 over 32 KB; 429 after 3 per 10 min or 10 a day per IP; 503 past 25 emails a day from everyone together, while Redis can't count them (this cap fails closed), or when Resend refuses. Never logged with an IP: the route logs no request lines and the gateway doesn't log it; the log says `feedback sent` with the type, or why not |
| GET `/api/auth/_info`, `/api/users/_info` | - | - | info |

**Unconfirmed addresses** (`services/auth/src/unconfirmed.ts`, decided 2026-11-26): an account holds its
address while it's confirmed, from before confirmation existed (`predates_email_confirmation`), set in
the last 7 days (the sign-up's link) or with a link that confirms it still open. One left unconfirmed
past that stops counting: a sign-up, a sign-up with a provider or a confirmed change of email takes it,
in the same transaction (the holder's row locked). The old account keeps working, by username, with a
placeholder address on the reserved `.invalid` domain (`released-<id>@cubr.invalid`, never mailed) and
`emailReleased: true`; the account page asks it to add an email. Reset links never went to it (they
only go to a confirmed address).

An account made with a provider has no password: it signs in with the provider, and "forgot password?"
(a reset link to its email) gives it one. Connecting a provider to an existing account happens only
signed in (mode `link`, from the account page), so owning an email at a provider never takes over a cubr
account. Each provider is configured by environment variables on the auth service (services/auth/README.md);
the redirect URI to register with it is `<PUBLIC_URL>/api/auth/oauth/<provider>/callback`.

**Emails** (password resets, email confirmations, the notices after an email or password change, and the
feedback form's messages to `hello@cubr.dev`, answered to the sender) go
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
| GET `/api/scrambles/events` | `{events: [{id, name, short, puzzle, kind, types: [{id, label, pending?}]}]}` (every event, WCA first; `types[0]` is the default) |
| GET `/api/scrambles/:event/image?scramble=&type=` | csTimer's SVG drawing of the scramble, for any event and type (the web app asks for it where cubing.js can't draw the puzzle, `puzzle: null`, or can't read the scramble: csTimer's own notation, such as the gigaminx's or megaminx carrot); relays are drawn as a grid of their puzzles. `image/svg+xml`, `cache-control: public, max-age=86400`, its own CSP (`default-src 'none'; style-src 'unsafe-inline'`); refused (404) if it holds anything that could run or load something, or if csTimer can't draw it (cuboids, siamese, cmetrick, clock's concise notation...); counts as a request against the per-IP limit |
| GET `/api/scrambles/daily?date=YYYY-MM-DD` (default today, UTC; the last 30 days) | `{date, events: {"333": string[5], "222": [...], "444": [...], "pyram": [...], "skewb": [...]}}` (generated once, persisted, identical for everyone); 400 for future dates; 503 while Postgres is unreachable and nothing is cached |
| GET `/api/scrambles/:event?count=1..25&fresh=0/1&type=` | `{event, scrambles: string[], source: "pool"\|"generated"}`; `type` = a scramble type (section 6; default when omitted): a WCA event's default comes from the pool, everything else is made on request (`{event, type, scrambles, source: "generated"}`, counted against the generation budget), 404 for a type the event doesn't have or a pending one; `fresh=1` bypasses the pool (load tests / HPA demo), honoured only with `X-Internal-Token`, which also skips the limits; per IP otherwise: 120 requests/min and 60 newly generated scrambles/min (weighted by count; past it the pool's scrambles are returned, or 429 if there are none); 404 unknown event; 503 when generation times out or the queue is full |
| GET `/api/scrambles/_info` | info (+ warm-up, generator queue, pool sizes) |

Pool: keep `scramble:pool:<event>` topped up (333/222/pyram/skewb: 200; 444/sq1/clock/minx/333oh/333bf/333fm: 50; 555-777/444bf/555bf: 20) by a background loop in every replica (check LLEN, generate up to the target, `LTRIM` to cap). The loop only uses idle CPU; requests that find the pool short generate the rest on the fly.

### 9.3 solve (`/api/sessions`, `/api/solves`) - all routes require auth
| Method & path | Body / query | Response |
|---|---|---|
| GET `/api/sessions` | - | `{sessions: Session[]}` (created_at asc; `Session = {id, name, event, practice, scramble?, createdAt, updatedAt, solveCount}`). If the user has none, create a default "3x3" session (event 333) first. |
| POST `/api/sessions` | `{id?, name, event, practice?, scramble?, createdAt?}` | 201 `{session}` (idempotent on id: same id again -> 200; an id of another user -> 409). `createdAt` (ISO 8601, future values clamped to now) lets the empty session that replaces a cleared one keep its place in the list. `scramble`: one of the event's practice scramble types (400 otherwise); the session is then always a practice session. |
| PATCH `/api/sessions/:id` | `{name?, practice?}` (at least one) | `{session}` (+ `session.renamed` for a name, `session.updated` when `practice` changes). A practice session's solves count for no personal best and no leaderboard; its own session stats are unchanged. 400 for `practice: false` on a session with a `scramble`. |
| DELETE `/api/sessions/:id` | - | 204 (+ `session.deleted`) |
| POST `/api/sessions/:id/merge` | `{sourceIds: uuid[]}` (1-50, != `:id`) | `{session, merged: {sessions, solves}}` - moves all solves of the source sessions into `:id` and deletes the sources in one transaction; 404 unknown session, 409 different event or scramble type (+ `sessions.merged`). The merged solves take the target's `practice`. |
| GET `/api/sessions/:id/solves` | - | `{solves: Solve[], truncated: boolean}` all solves, created_at asc (capped at the latest 50 000) |
| POST `/api/solves` | `{id, sessionId, timeMs, penalty, scramble, comment?, source?, createdAt?, daily?: {date, index}}` | 201 `{solve, rolling: {ao5, ao12}}`; if `id` already exists for this user -> 200 same shape (idempotent). A `createdAt` in the future (fast device clock) is clamped to the server time. `daily` solves: see below. |
| PATCH `/api/solves/:id` | `{penalty?, comment?}` | `{solve}` (+ `solve.updated`) |
| DELETE `/api/solves/:id` | - | 204 (+ `solve.deleted`) |
| POST `/api/sessions/import` | `{sessions: [{name, event, practice?, scramble?, solves: [{timeMs, penalty, scramble, comment?, createdAt}]}]}` (<= 1 000 sessions, <= 100 000 solves, body <= 25 MB) | `{imported: {sessions, solves}, skipped, continued}` (+ one `solves.imported` when it added any) - bulk insert in batches inside a transaction; solves the account already has (same event, time, penalty and `createdAt` to the ms) are left out (`skipped`), and a session whose solves are already in one of the account's sessions adds the rest to that one (`continued` counts them) instead of becoming a new session; 10 imports/h per user (429, checked before the body is read); an account holds at most 250 000 solves (400 if the import would pass it; one import per account at a time) |
| GET `/api/solves/export` | - | `{exportedAt, sessions: [Session & {solves: Solve[]}]}`, streamed from one read-only snapshot in pages of 2 000 solves (memory stays flat; 200k solves = 52 MB in ~2.5 s locally); 10 exports/h per user (429) |
| POST `/api/solves/daily/start` | `{date, event, index}` | an official attempt starts (inspection, or the solve without it): 201 `{abandoned: false}`; started before and never finished (a reload, a closed tab) -> it becomes a DNF (time since that start) and 200 `{abandoned: true, attempt}`; already has its result -> 409 |
| GET `/api/solves/daily/reminders/key` | - (no auth) | `{publicKey}`: the VAPID public key a browser subscribes with (null when reminders aren't set up) |
| PUT `/api/solves/daily/reminders` | `{endpoint, keys: {p256dh, auth}, remindMinute, tz}` (the browser's PushSubscription.toJSON(), the minute of the local day 0-1439, an IANA zone Postgres knows) | 200 `{reminder: {remindMinute, tz}}`: this browser gets a daily-challenge reminder at that local time (one row per endpoint; it moves to the caller's account); 503 without VAPID keys; 30 changes/h per account. The endpoint travels in bodies only (it's a capability URL), never in a logged query string |
| DELETE `/api/solves/daily/reminders` | `{endpoint}` | 204: that browser's reminders off (only the caller's own) |
| GET `/api/solves/daily?date=` | - | `{date, events: {"333": {solves: Solve[], ao5: number\|-1\|null}, ...}}` (only events with >=1 attempt; ao5 = the official result of the five attempts: times as submitted, penalties as last set while the day was open) |
| GET `/api/solves/_info`, `/api/sessions/_info` | - | info (+ outbox backlog and relay state) |
| GET `/internal/users/:userId/solves?event=&limit=&after=` | - | `{solves: [{id, sessionId, timeMs, penalty, createdAt, practice?}], next}` ordered by session_id, created_at, id (for stats recompute; `practice: true` on a practice session's solves). With `limit` (at most 50 000) it answers a page, and `next` is the cursor of its last row (session, created_at to the microsecond, id) to pass as `after`, null on the last page; without, everything at once (`next` null). Stats reads in pages: the whole 250k-solve cap in one answer ran its 192 MB heap out |
| GET `/internal/users/:userId/sessions` | - | `{sessions: [{id, name, event, practice}]}` (stats backfills session display names) |

Daily challenge: a `daily: {date, index 0..4}` solve gets `source: 'daily'`; its session's event must
be a daily-challenge event and `date` the UTC date of yesterday, today or tomorrow (today somewhere
on Earth). Each index can be attempted once: the attempt is recorded in `solve.daily_attempts` in the
same transaction, and a second attempt for that index -> 409, even after the first solve was deleted
(a retry with the same solve id stays idempotent). Once all five attempts exist, `daily.completed`
is emitted with the ao5 of the attempts. A penalty marked after the solve (`PATCH` ok / +2 / DNF on a
daily solve) also changes its attempt while the day is still open (same window), and a finished
day's result is re-sent as `daily.updated`. Deletes, and penalty changes after the day has closed,
change neither the result nor the board. One try per scramble (decided 2026-11-26): an attempt
counts from its start (`POST /api/solves/daily/start`); starting it again after a reload or a closed
tab makes it a DNF, and on the page Esc during inspection, or leaving for another event or day, is a
DNF. Guests practise without any of this, and the five scrambles stay public.

Outbox relay: woken by the commit of new rows (a statement trigger's `pg_notify('solve_outbox')`, migration 008, on a connection that LISTENs; every 5 s as a safety net, every 250 ms while that connection is down), each replica claims unpublished rows (`FOR UPDATE SKIP LOCKED`, LIMIT 500),
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
serve any player). Handshake `auth: {token?, name?, guestKey?}` (guests choose a nickname).

client -> server (with ack callbacks `{ok:true,...}|{ok:false,error,code}`):
- `room:join {roomId}` -> ack `{ok, room: RoomState, playerId, name, servedBy, chat}` (`servedBy` = the pod holding this socket, `chat` = last 50 messages)
- `room:leave {}`
- `round:next {fromRound}` (host only; `fromRound` = the round on the host's screen: a retry or a second click answers with the round already started, a stale one gets CONFLICT; fetches 1 scramble from scramble-service, falling back to a local random-move scramble, and starts round n+1) -> ack `{ok, round}`
- `player:status {status: "idle"|"inspecting"|"solving"|"done"}` ("done" only with a result: `player:result` sets it)
- `player:result {round, timeMs, penalty}` (current round only, once per player)
- `chat:send {text}` (<= 200 chars, 5 per 10 s; a slur is refused, `text: that message has a word cubr doesn't allow`: see Moderation below)

server -> client: `room:state RoomState` (full state after every change), `chat:message {playerId, name, text, at}`.

Each socket may send 60 events per 10 s, counted as they arrive (before they queue), with at most 60
waiting; more are refused with RATE_LIMITED, and a socket that keeps sending past three times that is
disconnected.

```ts
type RoomState = { id; name; event; isPrivate: boolean; rev: number /* +1 per saved change; ignore a lower rev */;
  hostId: string|null /*playerId*/; status: "lobby"|"running"|"finished";
  round: { n: number; scramble: string; scrambleSource: "scramble-service"|"fallback"; startedAt: string } | null;
  players: { id: string; name: string; userId: string|null; status: string; connected: boolean; pods: string[] }[];
  results: Record<string /*round n*/, Record<string /*playerId*/, { timeMs: number; penalty: string }>>;
  standings: { playerId: string; name: string; wins: number; solves: number; meanMs: number|null; ao5: number|null }[];
  createdAt: string };
```
playerId = userId for logged-in users, else a guest id made from the guest's secret key
(`gst-` + 12 characters of an HMAC with the server's secret; the client keeps the key, 32 characters,
in localStorage as `cubr.guestKey` and sends it as `auth.guestKey`). Every member sees the id, and it
can't be used to play as that guest. The previous release's `auth.guestId` (the id itself, in its old
`guest-` form) is accepted until the release after this one. Rooms expire after 2 h without activity
and hold at most 16 players. A room keeps its last 25 rounds in `results` (and so in every state);
older rounds are folded into each player's totals, so `standings` still count every round. Host leaves -> oldest connected player
becomes host. Socket.IO does not keep room membership across reconnects, so the client re-emits
`room:join` on every `connect`.

**Moderation** (`packages/common/src/moderation.ts`, decided 2026-11-26): words cubr doesn't allow come from
obscenity's English list (npm `obscenity` 0.4.6, MIT), which catches spelling tricks and leaves innocent
words alone. Usernames (sign-up and sign-up with a provider, whose suggestion skips them), display
names and bios refuse the whole list (400: `is reserved, choose another`, `isn't allowed, choose
another`, `has a word cubr doesn't allow`); a guest's race name falls back to `guest-xxxx`. Race chat
refuses slurs only, so cubers can still swear at a bad solve. Reserved usernames (`admin`, `cubr`,
`support`, `wca`, `official`...) are compared without case, underscores or trailing digits. In the web
app a player can mute another in race chat for themselves (remembered on the device, `lib/moderation`),
and a profile or a race room can be reported by email to hello@cubr.dev.

Whoever runs cubr acts with `deploy/vps/moderate.sh` (the runbook's "Moderation"), which calls internal
routes from inside the service's container with its internal token: auth's `GET
/internal/moderation/users/:username` (the account, email masked) and `POST .../suspend {note?}`,
`.../unsuspend`, `.../rename {to}`, `.../clear-profile` (display name and bio), `.../remove-picture`, each
answering `{user}` and publishing `user.updated`; race's `POST /internal/moderation/rooms/:id/clear-chat`
(204: the history goes, and the room's players get `chat:cleared`). **Suspension** (`auth.users.suspended_at`
and `suspended_note`, migration 009): every token of the account is revoked, the profile turns private
(the Redis set too, or nothing changes: 503), pending reset links go, and nothing signs in while it lasts:
the password (403 `This account is suspended. Questions: hello@cubr.dev`, only after a right password),
a reset link (403, the link kept), Google, Apple or GitHub (`#error=suspended`, and the code exchange
checks again). The times stay. Lifting it lets the account sign in; the profile stays private until its
owner changes that. **The moderation log** (`auth.moderation_log`, migration 010): every action above
(and a cleared chat, which `moderate.sh` records with `POST /internal/moderation/log {action:
"clear-chat", detail}`) with its time, account and detail (a suspension's note, a rename's old and new
name), kept 2 years (the online-safety codes' records, Tier 2, decided 2026-11-26; a record outlives
a deleted account); `GET /internal/moderation/log?limit=` lists the newest first. The terms name class
1A and 1B material, and say how to report and that eSafety takes complaints.

### 9.7 wca (`/api/wca`) - values converted to ms (WCA centiseconds x 10); 333fm kept as moves (`unit:"moves"`, averages x100 in export -> divide); 333mbf excluded
| Method & path | Response |
|---|---|
| GET `/api/wca/meta` | `{exportDate, exportVersion, counts: {persons, competitions, ranksSingle, ranksAverage, countries}, tables, sizeBytes, citation}` (`citation` = the WCA attribution text to show next to the data) |
| GET `/api/wca/records` | `{records: [{event, eventName, unit, single: {value, personId, personName, countryId, holders}\|null, average: {...}\|null}]}` (`holders` lists ties) |
| GET `/api/wca/rank?event=333&kind=single\|average&value=12345&country=AU` | `{event, kind, value, world: {rank, total, percentile}, country: {rank, total, percentile, countryId}\|null, neighbours: [{personId, name, countryId, value, worldRank}]}` - rank = 1 + number of people strictly faster; percentile = % of people you beat; neighbours = 3 just faster + 3 just slower |
| GET `/api/wca/distribution?event=333&kind=single&buckets=50` | `{event, kind, total, p10, p25, p50, p75, p90, p99, min, buckets: [{from, to, count}], below, above}` (equal-width buckets between ~p0.5 and ~p99; `below`/`above` count the results outside them) |
| GET `/api/wca/persons?q=&limit=20` | `{persons: [{wcaId, name, countryId}]}` (name substring or exact WCA id; `limit` <= 50) |
| GET `/api/wca/persons/:wcaId` | `{person: {wcaId, name, countryId, countryIso2}, pbs: [{event, single: {value, worldRank, continentRank, countryRank}\|null, average: {...}\|null}]}` |
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

**The retry queue** (`cubr.queue.v1`, `lib/solves.ts`) is shared by every tab: the stored copy is the
truth, re-read before each change and followed through `storage` events, one tab sends at a time (the
Web Lock `cubr.queue`), and the op being sent is marked (`cubr.queue.inflight`) so no tab folds an edit
into it. A queued solve whose session is gone (merged or deleted on another device: "session not
found") moves, with the session's other queued solves, to a new session "<name> (recovered)".
**Settings** sync to the account 800 ms after a change; until it lands it is marked unsynced
(`cubr.settings.unsynced`, with the account's id), retried with backoff and when back online, and at the
next sign-in on that device the marked settings win over the account's. Every setting is checked as it
loads, from either side.

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

The timer bar reads: event, scramble type, session, inspection, input, sync. The event menu has the
WCA events in three columns (cubes, variants, other) and, under them, "other events": csTimer's other
puzzles and the relays, in three columns, the ones without a scrambler yet marked "soon". The
scramble menu lists the event's default ("wca" for WCA events: "counts for pbs and leaderboards")
and its practice types by group ("practice scrambles: no pbs or leaderboards"); picking one moves
to that type's own practice session ("3x3 pll", made the first time, `switchScramble`), and the bar
shows a beaker while one is in use. The session menu lists the sessions of the event and scramble
type in use. Scramble queues are per event and type; offline, a type made of random moves is made in
the browser, and one that needs the service says so ("too many new scrambles" when the service
refused for the minute: it then waits 10 s, not 30). Practice types and the other events are
fetched two at a time (each counts against the per-IP generation budget). Relays show one line per
puzzle. On phones every bar button keeps its 44 px tap target, so the default scramble shows as its
icon (a practice one as its beaker and label), icon buttons drop their chevrons, the session its
stack icon, a guest's plain "local" note goes (420 px and under; a sync warning stays) and, at 360 px
and under, the inspection toggle (it's in settings and the command line too); the bar fits at 320 px.

Scramble previews look the same for every puzzle: cubr's flat net (`ScrambleNet`), rounded stickers
on a dark plate per face, in cubr's colours or your own (settings: sticker colours, one scheme per
kind of puzzle: kilominx and gigaminx take the megaminx's, master pyraminx the pyraminx's, redi cube
and csTimer's cube-shaped puzzles the cubes', and FTO has its own). A puzzle cubing.js can't draw, or a scramble in csTimer's own
notation (`inCsTimerNotation`, lib/cubing3d: never read by cubing.js as it is, which would turn other
faces for some, e.g. csTimer's kilominx DR is cubing.js's FR), shows csTimer's drawing from the scramble service (`scrambleImageUrl`) redrawn the same
way (`DrawnNet`, `lib/drawnNet`): its shapes are read from the SVG, stickers that meet make a face
with a plate behind it (a jagged face, as a mirror block's, follows its outline), the faces are
drawn closer, and csTimer's colours become the scheme's. Square-1's relatives are drawn flat, as
square-1 is; a sliding puzzle is a board with its numbers; a clock's drawing is shown as csTimer
draws it; the icosamate's 20 colours are cubing.js's, as in 3D. The next scramble's drawing is
fetched while the current one is up. A relay shows each puzzle's own preview under its label, as
many to a row as make them biggest. The cuboids nothing else draws (floppy, tower, domino, 3x3x4 and
3x3x6) are worked out in the browser (`lib/cuboid`): one model of a puzzle's stickers for any size,
checked against cubing.js as a 3x3x3 and a 4x4x4 (face, wide and slice turns) and, for the tower and
the domino, against a 3x3x3 turned the same way; the net (U above L F R B, D below) is drawn as
csTimer's drawings are. 3x3x5 and 3x3x7 aren't drawn: their scrambles end in a 3x3 scramble after
"/", which has no clear meaning on a cuboid whose sides only half-turn. "No preview for this puzzle
(or scramble) yet" where nothing can draw it.

In 3D the preview is cubing.js's `<twisty-player>`. Some puzzles have no cubing.js puzzle of their
own, but cubing.js's puzzle geometry builds them from their shape and cuts (8x8 to 11x11,
helicopter, curvy copter, dino, pyraminx crystal, csTimer's diamond as the skewb diamond, icosamate,
and the master pyraminx with its tips for its random-move type). Some scramble types are written in
csTimer's notation (all of gigaminx; megaminx carrot, old style and random state). For both, the
scramble is rewritten move by move in cubing.js's notation (`lib/cubing3d`, `preview3D`). Every
translation is checked against csTimer's own drawings of real scrambles, sticker for sticker
(`scripts/cstimer-fixtures.ts` writes them, the web tests compare). Two differences: cubing.js's
curvy copter has a fixed centre on each face that the real puzzle hasn't. Square-1, clock and redi
cube have no 3D model in cubing.js: square-1 and redi cube show cubr's 2D net, the clock cubing.js's
drawing; the other puzzles it has no model of keep their 2D net. A relay's
puzzles are in 3D too, each in a square box (a clock's two faces in a wide one). A 3D view draws
once it is on screen. A long scramble (relays, gigaminx) scrolls inside its box, capped just above a
megaminx's seven lines, so the preview and the stats stay in view.

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
  `twitter:card summary_large_image`. Crawlers don't run the app, so each card is its page's HTML:
  the title "cubr" and `og:site_name` "cubr" on every card, the page's own description (the one
  search engines show, 10.2: each public page's HTML has its own), and `https://cubr.dev/og.png`:
  the header's logo centred on white, 1200 x 630 and opaque (`pwa-assets.mjs og`). There's no
  `og:url`, so a link shared from any page leads back to that page.
- **Service worker** `/sw.js`, from `web/src/sw/sw.ts`, built after the app by
  `web/plugins/serviceWorker.ts`:
  - It precaches the whole build (about 2.4 MB) except source maps, the `.woff` font fallbacks,
    the icons, the screenshots, the iOS launch images and the files for other sites and crawlers
    (the link preview image, `robots.txt`, `sitemap.xml`, `/.well-known/`, and the public pages'
    own copies of `index.html` in `pages/`), in the cache `cubr-app-<version>`.
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
- **Titles, descriptions and the words to rank for** (`web/src/lib/pageMeta.ts`, built in v1.5.19).
  cubr wants to be found by cubers' own words: speedcube, cube and timer, and their family
  (speedcubing, speedcubers, cubing, cubers). Each public page (the sitemap's) has, in one table:
  - a title of at most 60 characters with the brand last: the home page's is "cubr | a minimalist
    cube timer for speedcubers", About's "about cubr, a minimalist speedcube timer", the default
    board's "speedcubing leaderboards for every wca event | cubr" (the other boards are named after
    themselves, "weekly 2x2 ao5 leaderboard | cubr");
  - a description of 110 to 160 characters, the one search results and link previews show;
  - its heading as the page shows it. The timer's, "cubr: a minimalist speedcube timer", is a
    visually hidden `h1` (`.sr-only`) for screen readers and search engines.
  - `pageMeta.test.ts` keeps them within those lengths, each page's its own, in lowercase, with at
    least one of the words, and never stuffed: each word once in a title (three at most), twice in
    a description (five at most). Every other page is titled "<page> | cubr" and keeps the home
    page's description.
  - **In the app**, `lib/usePageMeta.ts` sets the page's title and `<meta name="description">` while it
    shows, and the home page's again on leaving (search engines read both after running the app).
  - **In the HTML**, for crawlers that don't run the app (AI search engines, link previews, and Bing at
    times): `index.html` carries the home page's title and description, and in `#root` a summary (the
    heading, the description and links to the public pages). The summary is hidden by a style
    attribute (out of the flow, 1 px, clipped, never `display: none`), so nothing flashes or shifts
    while the app loads, and the app replaces it as it starts. The build writes every other public
    page's copy, `pages/<page>.html`, with its own title, description, `og:description` and summary
    (`web/plugins/pageFiles.ts`); nginx serves it at the page's address
    (`try_files /pages$uri.html /index.html`), and `/pages/*` itself is a 404. The service worker
    doesn't cache the copies: offline, every page opens from `index.html` and sets its own title.
  - About's feature titles link to their pages (the timer, daily, races, leaderboards, WCA), looking
    as before, green on hover. A browser without JavaScript gets one line (`<noscript>`): what cubr
    is, and to turn JavaScript on.
- **The site's name and logo for search engines:** `index.html` carries one JSON-LD block (a data block,
  which the CSP doesn't cover):
  - a `WebSite` (`https://cubr.dev/`, name `cubr`, alternate name `cubr.dev`, the page's description);
  - its publisher, an `Organization` named `cubr`, with the logo `/icons/icon-maskable-512.png` (512 px,
    opaque, the cube clear of a round crop) and `sameAs` the GitHub repository and the Ko-fi page.
  - `structuredData.test.ts` checks it against the files and `lib/links.ts`. The Schema Markup
    Validator finds no errors or warnings.
  - No `SoftwareApplication` (or `WebApplication`): Google reports one without ratings or reviews
    as an invalid item in Search Console, and cubr has neither.
- **One address per page.** Search engines split a page's ranking between its addresses, so:
  - **nginx** (`map $cubr_canonical`) sends a page asked for with capitals or a trailing slash to its
    plain lowercase address: 301, query kept (`/About/?x=1` -> `/about?x=1`). A username and a room id
    keep their case. The canonical forms are listed first and never redirect, and every target is
    one of them, so nothing loops (`site.test.ts`).
  - **the app** adds `<link rel="canonical" href="https://cubr.dev/...">` to each page search engines
    may list (`lib/canonical.ts`): the path itself; the home page without a query; a board with only
    its event, kind and period (the default board is plain `/leaderboards`, as in the sitemap). Pages
    with `noindex` get none, profiles included.
- **Real 404s.** The app's routes (section 10, case-insensitive, optional trailing slash) get
  `index.html` with 200 (the public pages: their own copy of it, above). Usernames and room ids must look like `USERNAME_RE` and `ROOM_ID_RE`.
  Everything else is a file of the build or a 404 whose body is still `index.html`, so people see
  the app's not-found page and crawlers see the status. A well-formed name nobody has (a missing
  profile) still answers 200; its view adds `<meta name="robots" content="noindex">`, as does the
  not-found page (`lib/useNoIndex.ts`).
- **Crawlers.**
  - `robots.txt` lets search engines and AI search (OAI-SearchBot, ChatGPT-User, Claude-SearchBot,
    Claude-User, PerplexityBot...) fetch everything but `/internal/`, and names `sitemap.xml` (the
    public pages: timer, daily, leaderboards, race, WCA, about, terms, privacy). Crawlers that collect
    pages to train AI models (GPTBot, ClaudeBot, anthropic-ai, CCBot, Google-Extended,
    Applebot-Extended, Bytespider, meta-externalagent) are turned away from everything (decided
    2026-11-26). The API stays crawlable on purpose: Google renders pages without whatever
    robots.txt blocks, and the leaderboards, the daily board and About load their content from it.
    API answers say `X-Robots-Tag: noindex` (`ROBOTS_HEADERS` in common), so they never show up in
    results.
  - Personal and short-lived pages answer `X-Robots-Tag: noindex`: `/account`, `/settings`,
    `/login*`, `/reset`, `/race/<id>`, and people's profiles (`/profile/<name>`, decided 2026-11-26:
    on cubr, not in search results; the page adds the meta tag too). They aren't blocked in
    robots.txt, or crawlers couldn't see the tag.
- **licenses.txt** at `/licenses.txt`, linked from About: cubr's own licence (GPL-3.0-only) and where
  its source is, then the licence of every package the web app ships, with its full text. The build
  writes it from what actually ended up in the bundle, plus the fonts (`web/plugins/licenses.ts`).
- **security.txt** (RFC 9116) at `/.well-known/security.txt`: contact `hello@cubr.dev`, the policy
  in `SECURITY.md`. `/security.txt` redirects to it. Its `Expires` must stay under a year ahead; a
  test fails 30 days before it passes.
- **`/.well-known/change-password`** redirects (302) to `/account#change-password`, the
  change-password dialog (section 10). Other unknown `/.well-known/` paths are 404s, which browsers
  check before they trust the redirect.
- Redirects are relative (`absolute_redirect off`): behind the gateway and Cloudflare, nginx would
  build them with the wrong scheme and port.
- **While the server is down** (built in v1.5.16, live once `deploy/cloudflare/down-page/deploy.sh up`
  has run): a Cloudflare Worker (`deploy/cloudflare/down-page/worker.ts`) answers page loads the
  server can't answer with a cubr-styled "back in a moment" instead of Cloudflare's error page. The
  server can't answer when Cloudflare gets a 530 (tunnel down), a 52x (origin unreachable) or the
  gateway's 502-504. The page is a 503 with `Retry-After: 30`, `no-store` and `noindex`, and it is
  self-contained: inline styles, Lexend Deca as a data URI, white cross or white cross dark, no
  scripts. It reloads every 30 seconds. Everything else passes through untouched, so the app and the
  uptime check see the real failure. Routes skip the Worker for `/api/*`, `/socket.io/*`, `/assets/*`
  and `/healthz`, so nothing stands between the app and its data and the server still sees each
  visitor's address. The installed app doesn't need it: its service worker opens it offline.

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
- **Why the app adds it:** Cloudflare injects the beacon into the pages it serves ("automatic setup",
  on since 2026-11-26), but the offline app opens from its cached `index.html`, which never passes
  through Cloudflare; the app adds its own only where the page has none. The CSP allows both ways: the
  script host, and the injected beacon's same-origin `/cdn-cgi/rum`.
- **Global Privacy Control and Do Not Track:** the injected beacon checks neither (Cloudflare injects
  it for every request, and its script has no check). So for a browser that sends `Sec-GPC: 1` or
  `DNT: 1`, the web server's CSP leaves the beacon's hosts out (`$cubr_beacon_script` and
  `$cubr_beacon_reports` in `web/nginx/default.conf.template`) and the browser refuses to load it, as
  the privacy policy says. `web/src/__tests__/site.test.ts` checks both CSPs.

### 10.4 Themes, light and dark mode

- **Themes** (`web/src/lib/themes.ts`): 42 cube-inspired palettes of ten CSS custom properties,
  named after puzzles, methods, algorithms and competition words (17 light, 25 dark). White cross is
  the default; white cross dark is its dark twin (the logo's ink background, the same green, white
  text).
  - **High contrast** (settings > theme, and the command line; decided 2026-11-26): every theme's
    labels and other quiet text (`--sub-color`) read at 4.5:1 (WCAG AA) on the background and on
    cards, and its accent and errors on the background (`highContrastTheme`): each colour moves toward
    the theme's text colour only as far as that takes, so the themes keep their look. Off by default;
    labels change in 41 of the 42 themes, the accent in 4. The pre-paint script applies it too (it
    reads the stored colours).
  - **Order:** the light themes first, led by white cross, then the dark ones, led by white cross
    dark; pale before bold, and round the colour wheel within each. The picker and the command line
    list them in this order.
  - **What every theme keeps** (checked by `themes.test.ts`): text at 7:1 on the background, the
    accent at 3:1, errors at 4:1, labels at 2:1 and quieter than the text, cards visible but never
    loud, an error colour that never looks like the accent, and a look of its own (no two too alike
    in background and accent).
  - **The ready green** (`--timer-ready`: the timer's "let go to start", the live dot and the "ok"
    pill) comes with the theme too: `#3ec46d` wherever it reads at least 2:1, as on white cross,
    otherwise a deeper green at 3:1 (`readyColor`).
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

### 10.6 Feedback

- **Where:** "feedback" in the footer opens a popup (`web/src/components/FeedbackModal.tsx`) with three
  ways to send it: the form, an email to hello@cubr.dev (a `mailto:` link with the subject "cubr
  feedback"), or a public GitHub issue (GitHub's new-issue form, in a new tab).
- **The form** (`lib/feedbackForm.ts`), for feedback without leaving cubr:
  - an email address (optional, for a reply), the type (bug, idea, question, account help, something
    else) and the message (up to 5,000 characters), whose placeholder asks a question for the type;
  - "send" posts it to POST `/api/feedback` (auth, 9.1), which emails it to the contact inbox through
    Resend, with reply-to the sender's address, so answering is "reply". Nothing is stored, and it isn't
    linked to the account;
  - sent: the popup closes with "feedback sent, thanks". Not sent: the text stays, with the reason (no
    connection, too many, can't send right now, check the email) and a pointer to the email button;
  - what's typed stays while the popup is closed (Esc, a click outside), until it's sent; in memory only,
    so a reload starts empty.
- **Details:** all three add one line, `lib/feedbackLinks.ts`'s `feedbackDetails`: the version, the
  browser and system, whether it's the installed app, the window size and the page's path (never its
  query or hash, where reset, confirmation and sign-in tokens travel), e.g. `cubr v1.6.9 · Chrome 142 on
  macOS · 1280×800 · /daily`. The popup shows it under the buttons; in the email and the issue it's at
  the end, where it can be edited before sending.
- **Limits:** 3 messages per 10 minutes and 10 a day per IP (429), then 25 emails a day from everyone
  together, past which the form answers 503. That cap fails closed: while Redis can't count, nothing is
  emailed, so a flood can't use up the emails password resets need.
- **Logs:** no IP address with a message: the route logs no request lines and the gateway's `location =
  /api/feedback` has its access log off. The auth log says `feedback sent` with the type and whether
  there's an address to reply to (never the message or the address), or why it wasn't sent. The privacy
  policy describes it.

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
