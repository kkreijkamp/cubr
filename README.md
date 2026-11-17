# cubr

**A minimal, fast speedcubing timer, built as microservices. Live at [cubr.dev](https://cubr.dev).**

| | |
|---|---|
| System spec (APIs, schemas, events) | [`docs/SPEC.md`](docs/SPEC.md) |
| Production (one VM behind Cloudflare) | [`deploy/vps/README.md`](deploy/vps/README.md) |
| Kubernetes (GKE) and local compose | [`deploy/README.md`](deploy/README.md) |

## What it does

- **Timer** - WCA-compliant: hold-to-start (space or touch), 15 s inspection with 8/12 s alerts and automatic +2/DNF, penalties, sessions per event (create, rename, merge, practice sessions that count for no PB or leaderboard), manual entry, focus mode, all of csTimer's keyboard shortcuts.
- **Timer inputs** - keyboard and touch, smart cubes and timers over bluetooth, Stackmat through the audio input, and a virtual puzzle turned from the keyboard.
- **Scrambles** - official random-state scrambles for all 16 WCA events (cubing.js), with 2D/3D previews.
- **Statistics** - mo3/ao5/ao12/ao50/ao100/ao1000 (current & best, WCA trimming rules), mean, standard deviation, PB detection.
- **Accounts & sync** - sign up with a password or with Google, Apple or GitHub; solves stored in the cloud with offline-tolerant optimistic sync; import and export compatible with csTimer and most others; settings follow you across devices; profile pictures.
- **Installable app (PWA)** - install it on phones and computers: its own window, a home screen or dock icon and app shortcuts. The timer opens and works offline, and new versions download in the background with an "update ready" notice.
- **Leaderboards** - all-time / weekly / daily per event (single, ao5, ao12), WCA-record anti-cheat.
- **Daily challenge** - everyone gets the same 5 scrambles each UTC day; one attempt per scramble, ranked by ao5.
- **Race rooms** - real-time multiplayer rounds over WebSockets.
- **Profiles & analytics** - PB cards, a solve history chart with rolling averages, activity heatmap, streaks, time-of-day performance.
- **WCA comparison** - "where would I rank?" against ~2.3 M rows of official WCA data (rank, percentile, distribution).
- 11 cube-inspired themes (white cross by default, white cross dark in dark mode) that follow your device's light or dark mode, with light/dark filters and random pick, command palette (`esc` / `ctrl+k`), keyboard-first UI.

## Architecture

Production runs the whole stack with Docker Compose on one small VM, reached only through a
Cloudflare Tunnel ([`deploy/vps/README.md`](deploy/vps/README.md)):

```
browser --HTTPS/WSS--> Cloudflare --tunnel--> cloudflared --> nginx gateway --> services
                                              (one VM: Postgres + Redis + the services below)
```

The same images also run on Kubernetes when one VM is no longer enough
([`deploy/k8s`](deploy/k8s), [`deploy/README.md`](deploy/README.md)):

```
browser --HTTP/WS--> Google Cloud Load Balancer (GKE Ingress, path routing)
                          |
   +----------------------+---------------------------- GKE cluster (3x e2-standard-2) -------+
   |  web   auth   scramble   solve   stats   leaderboard   race   wca     (Deployments,      |
   |  nginx  JWT   cubing.js  CRUD+   read    Redis ZSETs   Socket.IO WCA  >=2 replicas, HPA, |
   |  SPA          (CPU, HPA) outbox  model                 (HPA)   data   PDBs, probes)      |
   |                 |          |       ^         ^                                           |
   |                 v          v       | events  |                                           |
   |        PostgreSQL 17 (CloudNativePG: primary + replicas, auto-failover, schema/service)  |
   |        Redis 7 (Streams event bus, leaderboards, scramble pool, cache, race pub/sub)     |
   |        CronJob wca-import (WCA export -> staging schema -> atomic swap) - Job seed       |
   +------------------------------------------------------------------------------------------+
```


| Service | Responsibility | Data |
|---|---|---|
| `web` | React SPA on unprivileged nginx | - |
| `auth` | register/login (bcrypt, JWT), sign-in with Google, Apple and GitHub (OAuth/OIDC), profile, settings, profile pictures, logout revocation | `auth` schema |
| `scramble` | random-state scrambles (cubing.js), Redis pre-generated pool, daily challenge scrambles | `scramble` schema, Redis lists |
| `solve` | sessions & solves CRUD, idempotent writes, daily-challenge attempts, csTimer bulk import, export, transactional outbox -> Redis Stream | `solve` schema |
| `stats` | event-driven read model: PBs (authority, emits `pb.updated`), heatmap, streaks, hourly, global counters | `stats` schema |
| `leaderboard` | Redis sorted-set boards (all-time from `pb.updated`, daily/weekly from `solve.created`), anti-cheat, rebuild-on-loss | Redis |
| `race` | Socket.IO rooms; state in Redis + Redis adapter so players on different pods share a room | Redis |
| `wca` | ranks, percentiles, distributions, records, person search over the WCA export (Redis cache-aside) | `wca` schema |

Statistics and leaderboards are read models built from domain events: solve writes each change and
its event in the same transaction (transactional outbox), a relay publishes the events to a Redis
Stream, and stats and leaderboard consume it with consumer groups. Service-to-service `/internal`
routes are never routed publicly and additionally require a shared token.

## Data

| Dataset | Rows | Storage |
|---|---|---|
| WCA export v2 (persons, ranks_single, ranks_average, competitions, countries, continents, events) | ~2.3 M | PostgreSQL `wca` schema (loaded by the `wca-import` CronJob) |
| Seeded users / sessions / solves | ~150 / 600 / 100 k | PostgreSQL `auth`, `solve`; derived rows in `stats` |
| Leaderboards, scramble pool, race rooms, event stream | - | Redis |

The WCA data (~382 MB zipped) is not included: the `wca-import` job downloads the official WCA
Results Export at deploy time from https://www.worldcubeassociation.org/export/results
(API: https://www.worldcubeassociation.org/api/v0/export/public). The seed job generates the rest
through the public APIs.

## Run locally

Requirements: Docker Desktop, Node 22.

```bash
docker compose up --build -d                      # Postgres, Redis, 7 services, web, gateway -> http://localhost:8080
docker compose --profile jobs run --rm wca-import # load the WCA dataset (WCA_TSV_DIR optional, see deploy/README.md)
docker compose --profile jobs run --rm seed       # synthetic users + ~100k solves (demo login: demo / cubr-demo)
node scripts/smoke.mjs http://localhost:8080      # end-to-end check through the gateway
```

Frontend dev with hot reload: `cd web && npm install && npm run dev` (proxies `/api` to the gateway).
Tests: `npm install && npm test` at the root (packages, services, jobs) and `npm install && npm test`
in `web/`; typecheck: `npm run typecheck` in both places. CI (`.github/workflows/ci.yml`) runs these
on every push, plus the service bundles, the web build and a render of every kustomize overlay.
To run a single service on the host against the compose databases, see the header of
[`docker-compose.yml`](docker-compose.yml).

## Deploy

- **Production:** releases are merged from `dev` to `main`, then `deploy/vps/release.sh` builds the
  images from the release tag on Cloud Build and deploys them to the VM. Only tags on `main` are
  accepted. See [`deploy/vps/README.md`](deploy/vps/README.md).
- **Kubernetes (GKE):** see [`deploy/README.md`](deploy/README.md) and run
  [`scripts/commands.sh`](scripts/commands.sh) section by section (Artifact Registry + Cloud Build ->
  GKE cluster -> CloudNativePG -> kustomize overlay -> data jobs).

## Credits

- [csTimer](https://github.com/cs0x7f/cstimer) (GPL-3.0): timer behaviour and statistics. The smart
  cube and bluetooth timer drivers, the cube model and the virtual puzzle in `web/src/input/` are
  derived from csTimer's source.
- [Monkeytype](https://github.com/monkeytypegame/monkeytype) (GPL-3.0): the design language.
- [cubing.js](https://github.com/cubing/cubing.js) (MPL-2.0 or GPL-3.0): scrambles and previews.
- This information is based on competition results owned and maintained by the World Cube
  Association, published at https://worldcubeassociation.org/results.

## License

Copyright (C) 2026 Koen Kreijkamp

cubr is free software: you can redistribute it and/or modify it under the terms of the GNU General
Public License, version 3 ([`LICENSE`](LICENSE)). It comes with no warranty. GPL-3.0 matches the
csTimer code it builds on.
