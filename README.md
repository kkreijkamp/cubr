# cubetype

**A cloud-native speedcubing timer — csTimer's functionality with Monkeytype's polish — built as
microservices on Google Kubernetes Engine.**

INFS3208 Cloud Computing · Individual Project (Type I: scalable & available web application) ·
Koen Kreijkamp (s4890458)

| | |
|---|---|
| Proposal | [`docs/proposal/proposal.pdf`](docs/proposal/proposal.pdf) |
| System spec (APIs, schemas, events) | [`docs/SPEC.md`](docs/SPEC.md) |
| Writing a service | [`docs/BUILDING.md`](docs/BUILDING.md) |
| Frontend guide | [`docs/FRONTEND.md`](docs/FRONTEND.md) |
| Deployment guide & demo runbook | [`deploy/README.md`](deploy/README.md) |
| Every deploy/demo command, commented | [`scripts/commands.sh`](scripts/commands.sh) |

**Status:** cubetype runs with docker compose, on a local Kubernetes cluster (kind) and on GKE.

## What works so far

- **Timer** — hold space until the display turns green, release to start, any key stops. 15 s WCA inspection with 8/12 s alerts and automatic +2/DNF, penalties and comments, several sessions per event, session statistics (mo3/ao5/ao12/… with WCA trimming rules), solve list and solve details.
- **Scrambles** — official random-state scrambles for all 16 WCA events (cubing.js), pre-generated into a shared Redis pool and queued ahead in the browser; if the scramble service is unreachable a random-move scrambler takes over.
- **Guest mode** — everything works without an account; solves stay in the browser.
- **Accounts & cloud sync** — register and sign in; solves sync to the solve service through an optimistic local store and a retry queue (client-generated ids make retries safe), so timing keeps working through outages and across tabs. Logout revokes the token; login and registration are rate limited per IP.
- **Profiles & statistics** — public profile pages with totals and streaks, personal bests per event (single, mo3, ao5, ao12, ao50, ao100), a GitHub-style activity heatmap, PB progression and time-of-day charts, and the user's leaderboard positions.
- **Leaderboards** — all-time (single, ao5, ao12), weekly and daily (single, ao5) boards per event, with paging and your own rank; results faster than the WCA world record are rejected.
- **Daily challenge** — everyone gets the same 5 scrambles per event each UTC day (3x3, 2x2, 4x4, pyraminx, skewb); one attempt per scramble, ranked by ao5 on the day's challenge board.
- **Race rooms** — real-time multiplayer rounds over WebSockets: a shared scramble per round, opponents' live status, results, standings and chat; guests join with a nickname.
- **WCA comparison** — "where would I rank?" against the official WCA results export (world and country rank, percentile, distribution), world records and competitor search; profiles compare personal bests with WCA competitors.
- **Settings** — hold time, inspection, timer update mode, precision, timer size, statistics shown, …; stored locally and synced to the account.
- **Command palette** (`esc` / `ctrl+k`) for navigation, timer actions and themes (with live preview); keyboard-first UI.

## Architecture (so far)

```
browser ──▶ gateway (nginx :8080, stands in for the GKE Ingress: path routing)
              │
              ├── /                          → web          React SPA on unprivileged nginx
              ├── /api/auth, /api/users      → auth         accounts, JWT, settings
              ├── /api/scrambles             → scramble     cubing.js random-state scrambles
              ├── /api/sessions, /api/solves → solve        sessions & solves, transactional outbox
              ├── /api/stats                 → stats        read model: PBs, heatmap, streaks
              ├── /api/leaderboards          → leaderboard  boards in Redis sorted sets
              ├── /api/race, /socket.io      → race         Socket.IO rooms, state in Redis
              └── /api/wca                   → wca          WCA results: ranks, records, distributions

   solve ─outbox─┐
   auth ─user.*──┴─▶ Redis Stream cubetype:events ─┬─▶ stats ──pb.updated──▶ leaderboard (all-time)
                                                   └──── solve.created ────▶ leaderboard (weekly/daily)

   PostgreSQL 17 (one schema per service) · Redis 7 (event stream, leaderboards, scramble pool,
   race rooms, caches, token revocation, rate limits) · job wca-import (WCA export → schema wca)
```

Statistics and leaderboards are **read models built from domain events**. solve writes each change
and its event in the same Postgres transaction (transactional outbox) and a relay publishes the
events to a Redis Stream, so a solve is never saved without its event, even while Redis is down.
stats and leaderboard consume the stream with consumer groups (at-least-once delivery, idempotent
handlers): stats is the authority for personal bests and announces changes as `pb.updated`;
leaderboard turns them into Redis sorted sets.

| Service | Responsibility | Data |
|---|---|---|
| `web` | React SPA on unprivileged nginx | – |
| `auth` | register/login (bcrypt, JWT), profile and settings, logout revocation, per-IP rate limits, `user.*` events | `auth` schema, Redis |
| `scramble` | random-state scrambles for the 16 WCA events (cubing.js, CPU-bound), pre-generated Redis pool, daily challenge scrambles | `scramble` schema, Redis lists |
| `solve` | sessions & solves CRUD with idempotent, client-generated ids, daily-challenge attempts, **transactional outbox** → Redis Stream | `solve` schema |
| `stats` | event-driven read model: PBs (authority, emits `pb.updated`), heatmap, streaks, time-of-day | `stats` schema |
| `leaderboard` | Redis sorted-set boards (all-time from `pb.updated`, daily/weekly from `solve.created`, daily challenge from `daily.completed`), WCA-record anti-cheat | Redis |
| `race` | Socket.IO rooms; state in Redis + Redis adapter, so players on different pods share a room | Redis |
| `wca` | ranks, percentiles, distributions, records, person search over the WCA export (Redis cache-aside) | `wca` schema |

Shared code: `packages/common` (Fastify bootstrap with health/readiness/info endpoints, error
envelope, Postgres + migrations, Redis, JWT, Redis Streams consumer groups with retry/reclaim/DLQ,
HTTP calls between services with timeouts) and `packages/cubestats` (WCA averaging rules,
formatting and event metadata — used by both the browser and the services).

## Data

| Dataset | Rows | Storage |
|---|---|---|
| WCA export v2 (persons, ranks_single, ranks_average, competitions, countries, continents, events) | ≈ 2.3 M | PostgreSQL `wca` schema (loaded by the `wca-import` job) |
| Seeded users / sessions / solves | ≈ 150 / 600 / 100 k | PostgreSQL `auth`, `solve`; derived rows in `stats` (created by the `seed` job) |
| Leaderboards, scramble pool, race rooms, event stream | — | Redis |

## Run locally

Requirements: Docker Desktop, Node 22.

```bash
docker compose up --build -d                       # Postgres, Redis, 7 services, web, gateway → http://localhost:8080
docker compose --profile jobs run --rm wca-import  # download and load the WCA export (see jobs/wca-import/README.md)
docker compose --profile jobs run --rm seed        # synthetic users + ~100k solves (demo login: demo / cubetype-demo)
node scripts/smoke.mjs http://localhost:8080       # end-to-end check through the gateway
docker compose down                                # stop (-v also deletes the database volumes)
```

Frontend dev with hot reload: `cd web && npm install && npm run dev` (proxies `/api` to the gateway).
Tests: `npm install && npm test` at the root (packages and services) and `npm test` in `web/` (web
app); typecheck: `npm run typecheck` in both places.

## Deploy to Kubernetes

The same images run on Kubernetes (kustomize manifests in `deploy/k8s`): one Deployment per service
with at least two replicas (HPAs for scramble, solve, race and web), PodDisruptionBudgets and
readiness/liveness probes, PostgreSQL as a CloudNativePG cluster (primary + replicas, automatic
failover) and Redis as a StatefulSet.

- **Local (kind):** `scripts/kind-up.sh` creates the cluster, installs CloudNativePG and
  metrics-server, builds and loads the images and deploys `overlays/local` (http://localhost:8090).
- **GKE:** run [`scripts/commands.sh`](scripts/commands.sh) section by section (Artifact Registry +
  Cloud Build → GKE cluster → CloudNativePG → kustomize overlay → data jobs → demos for scaling,
  load balancing, reliability, rollout & rollback).

The in-app `/status` page shows which pod and version answered each request, so scaling, load
balancing and rolling updates are visible during the demo. See [`deploy/README.md`](deploy/README.md)
for the deployment architecture, resource sizing, troubleshooting and the demo runbook.

## Credits

csTimer (inspiration for timer behaviour and statistics), Monkeytype (design language and theme
palettes), cubing.js (scrambles, MPL-2.0/GPL-3.0). This information is based on competition results
owned and maintained by the World Cube Association, published at
https://worldcubeassociation.org/results.
