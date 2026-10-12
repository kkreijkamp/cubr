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

**Status:** the timer with accounts and cloud sync runs locally with docker compose.
Next: event-driven statistics and leaderboards, the daily challenge, race rooms, the WCA comparison
and the Kubernetes deployment.

## What works so far

- **Timer** — hold space until the display turns green, release to start, any key stops. 15 s WCA inspection with 8/12 s alerts and automatic +2/DNF, penalties and comments, several sessions per event, session statistics (mo3/ao5/ao12/… with WCA trimming rules), solve list and solve details.
- **Scrambles** — official random-state scrambles for all 16 WCA events (cubing.js), queued ahead; if the scramble service is unreachable a random-move scrambler takes over.
- **Guest mode** — everything works without an account; solves stay in the browser.
- **Accounts & cloud sync** — register and sign in; solves sync to the solve service through an optimistic local store and a retry queue (client-generated ids make retries safe), so timing keeps working through outages and across tabs. Logout revokes the token; login and registration are rate limited per IP.
- **Settings** — hold time, inspection, timer update mode, precision, timer size, statistics shown, …; stored locally and synced to the account.
- **Command palette** (`esc` / `ctrl+k`) for navigation, timer actions and themes (with live preview); keyboard-first UI.

## Architecture (so far)

```
browser ──▶ gateway (nginx :8080, stands in for the GKE Ingress: path routing)
              │
              ├── /                          → web       React SPA on unprivileged nginx
              ├── /api/auth, /api/users      → auth      accounts, JWT, settings
              ├── /api/scrambles             → scramble  cubing.js random-state scrambles
              └── /api/sessions, /api/solves → solve     sessions & solves
                                                  │
                         PostgreSQL 17 (one schema per service) · Redis 7 (token revocation, rate limits)
```

| Service | Responsibility | Data |
|---|---|---|
| `web` | React SPA on unprivileged nginx | – |
| `auth` | register/login (bcrypt, JWT), profile and settings, logout revocation, per-IP rate limits | `auth` schema, Redis |
| `scramble` | random-state scrambles for the 16 WCA events (cubing.js, CPU-bound) | – |
| `solve` | sessions & solves CRUD with idempotent, client-generated ids | `solve` schema |

Shared code: `packages/common` (Fastify bootstrap with health/readiness/info endpoints, error
envelope, Postgres + migrations, Redis, JWT) and `packages/cubestats` (WCA averaging rules,
formatting and event metadata — used by both the browser and the services).

## Run locally

Requirements: Docker Desktop, Node 22.

```bash
docker compose up --build -d                  # Postgres, Redis, auth, scramble, solve, web, gateway → http://localhost:8080
node scripts/smoke.mjs http://localhost:8080  # end-to-end check through the gateway
docker compose down                           # stop (-v also deletes the database volumes)
```

Frontend dev with hot reload: `cd web && npm install && npm run dev` (proxies `/api` to the gateway).
Tests: `npm install && npm test` at the root (packages and services) and `npm test` in `web/` (web
app); typecheck: `npm run typecheck` in both places.

## Credits

csTimer (inspiration for timer behaviour and statistics), Monkeytype (design language and theme
palettes), cubing.js (scrambles, MPL-2.0/GPL-3.0).
