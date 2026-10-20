# cubetype

**A cloud-native speedcubing timer — csTimer's functionality with Monkeytype's polish — built as
microservices on Google Kubernetes Engine.**

INFS3208 Cloud Computing · Individual Project (Type I: scalable & available web application) ·
Koen Kreijkamp (s4890458)

| | |
|---|---|
| Proposal | [`docs/proposal/proposal.pdf`](docs/proposal/proposal.pdf) |
| System spec (APIs, schemas, events) | [`docs/SPEC.md`](docs/SPEC.md) |
| Writing a service (conventions, local development) | [`docs/BUILDING.md`](docs/BUILDING.md) |
| Frontend guide (design system, pages) | [`docs/FRONTEND.md`](docs/FRONTEND.md) |
| Deployment guide & demo runbook | [`deploy/README.md`](deploy/README.md) |
| Every deploy/demo command, commented | [`scripts/commands.sh`](scripts/commands.sh) |

## What it does

- **Timer** — WCA-compliant: hold-to-start (space or touch), 15 s inspection with 8/12 s alerts and automatic +2/DNF, penalties, sessions per event (create, rename, merge), manual entry, focus mode.
- **Scrambles** — official random-state scrambles for all 16 WCA events (cubing.js), with 2D/3D previews.
- **Statistics** — mo3/ao5/ao12/ao50/ao100/ao1000 (current & best, WCA trimming rules), mean, σ, trend & histogram charts, PB detection.
- **Accounts & sync** — solves stored in the cloud with offline-tolerant optimistic sync; import from cubetype and every timer csTimer can import (csTimer, Twisty Timer, CubeDesk, Block Keeper, DCTimer, …), JSON and csTimer export; settings follow you across devices; profile pictures.
- **Leaderboards** — all-time / weekly / daily per event (single, ao5, ao12), WCA-record anti-cheat.
- **Daily challenge** — everyone gets the same 5 scrambles each UTC day; one attempt per scramble, ranked by ao5.
- **Race rooms** — real-time multiplayer rounds over WebSockets.
- **Profiles & analytics** — PB cards, a solve history chart with rolling averages, activity heatmap, streaks, time-of-day performance.
- **WCA comparison** — "where would I rank?" against ~2.3 M rows of official WCA data (rank, percentile, distribution).
- **Cluster status page** — live view of which pod/version served each request: makes scaling, load balancing, self-healing and rolling updates visible during the demo.
- 178 themes (168 Monkeytype palettes + 10 cube-inspired cubetype originals) with search, light/dark
  filters and random pick, command palette (`esc` / `ctrl+k`), keyboard-first UI.

## Architecture

```
browser ──HTTP/WS──▶ Google Cloud Load Balancer (GKE Ingress, path routing)
                          │
   ┌──────────────────────┼─────────────────────────── GKE cluster (3 × e2-standard-2) ───────┐
   │  web   auth   scramble   solve   stats   leaderboard   race   wca     (Deployments,      │
   │  nginx  JWT   cubing.js  CRUD+   read    Redis ZSETs   Socket.IO WCA   ≥2 replicas, HPA, │
   │  SPA          (CPU, HPA) outbox  model                 (HPA)   data   PDBs, probes)      │
   │                 │          │       ▲         ▲                                           │
   │                 ▼          ▼       │ events  │                                           │
   │        PostgreSQL 17 (CloudNativePG: primary + replicas, auto-failover, schema/service)  │
   │        Redis 7 (Streams event bus, leaderboards, scramble pool, cache, race pub/sub)     │
   │        CronJob wca-import (WCA export → staging schema → atomic swap) · Job seed         │
   └──────────────────────────────────────────────────────────────────────────────────────────┘
```

The Ingress serves plain HTTP on a reserved static IP. TLS (a Google-managed certificate for a host
name pointing at that IP, plus an HTTP → HTTPS redirect) is not set up yet and would be the next step
before real users sign in.

| Service | Responsibility | Data |
|---|---|---|
| `web` | React SPA on unprivileged nginx | – |
| `auth` | register/login (bcrypt, JWT), profile, settings, profile pictures, logout revocation | `auth` schema |
| `scramble` | random-state scrambles (cubing.js), Redis pre-generated pool, daily challenge scrambles | `scramble` schema, Redis lists |
| `solve` | sessions & solves CRUD, idempotent writes, daily-challenge attempts, csTimer bulk import, export, **transactional outbox** → Redis Stream | `solve` schema |
| `stats` | event-driven read model: PBs (authority, emits `pb.updated`), heatmap, streaks, hourly, global counters | `stats` schema |
| `leaderboard` | Redis sorted-set boards (all-time from `pb.updated`, daily/weekly from `solve.created`), anti-cheat, rebuild-on-loss | Redis |
| `race` | Socket.IO rooms; state in Redis + Redis adapter so players on different pods share a room | Redis |
| `wca` | ranks, percentiles, distributions, records, person search over the WCA export (Redis cache-aside) | `wca` schema |

Statistics and leaderboards are read models built from domain events: solve writes each change and
its event in the same transaction (transactional outbox), a relay publishes the events to a Redis
Stream, and stats and leaderboard consume it with consumer groups. Service-to-service `/internal`
routes are never routed publicly and additionally require a shared token.

Shared code: `packages/common` (Fastify bootstrap with health/readiness/info endpoints, error
envelope, Postgres + migrations, Redis, JWT, Redis Streams consumer groups with retry/reclaim/DLQ,
internal-call token checks) and `packages/cubestats` (WCA averaging rules, formatting, csTimer
parser — used by both the browser and the services).

## Data

| Dataset | Rows | Storage |
|---|---|---|
| WCA export v2 (persons, ranks_single, ranks_average, competitions, countries, continents, events) | ≈ 2.3 M | PostgreSQL `wca` schema (loaded by the `wca-import` CronJob) |
| Seeded users / sessions / solves | ≈ 150 / 600 / 100 k | PostgreSQL `auth`, `solve`; derived rows in `stats` |
| Leaderboards, scramble pool, race rooms, event stream | — | Redis |

## Run locally

Requirements: Docker Desktop, Node 22.

```bash
docker compose up --build -d                      # Postgres, Redis, 7 services, web, gateway → http://localhost:8080
docker compose --profile jobs run --rm wca-import # load the WCA dataset (WCA_TSV_DIR optional, see deploy/README.md)
docker compose --profile jobs run --rm seed       # synthetic users + ~100k solves (demo login: demo / cubetype-demo)
node scripts/smoke.mjs http://localhost:8080      # end-to-end check through the gateway
```

Frontend dev with hot reload: `cd web && npm install && npm run dev` (proxies `/api` to the gateway).
Tests: `npm install && npm test` at the root (packages, services, jobs) and `npm install && npm test`
in `web/`; typecheck: `npm run typecheck` in both places. CI (`.github/workflows/ci.yml`) runs these
on every push, plus the service bundles, the web build and a render of every kustomize overlay.
See [`docs/BUILDING.md`](docs/BUILDING.md) for running a single service against the compose databases.

## Deploy to Kubernetes

- **Local (kind):** `scripts/kind-up.sh` creates a 3-node cluster, installs CloudNativePG and
  metrics-server, builds and loads the images and deploys `overlays/local` → http://localhost:8090.
- **GKE:** see [`deploy/README.md`](deploy/README.md) and run [`scripts/commands.sh`](scripts/commands.sh)
  section by section (Artifact Registry + Cloud Build → GKE cluster → CloudNativePG → kustomize
  overlay → data jobs → demos for scaling, load balancing, reliability, rollout & rollback).

## Credits

csTimer (inspiration for timer behaviour and statistics), Monkeytype (design language and theme
palettes), cubing.js (scrambles and previews, MPL-2.0/GPL-3.0). This information is based on
competition results owned and maintained by the World Cube Association, published at
https://worldcubeassociation.org/results.
