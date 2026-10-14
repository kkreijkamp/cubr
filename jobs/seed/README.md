# seed job

Creates realistic synthetic users and practice history **through the public APIs**, so the full
event pipeline runs exactly as with real users (solve → transactional outbox → Redis Stream →
stats + leaderboard consumers).

1. registers (or logs in to) `SEED_USERS` deterministic users plus a demo account
2. bulk-imports ~a year of improving practice history per user (`POST /api/sessions/import`)
3. posts a few live solves for today (`POST /api/solves`) → daily and weekly leaderboards
4. completes today's daily challenge for ~40 % of users → daily-challenge leaderboard

Idempotent: re-running logs existing users in and skips users that already have history.

| env | default | |
|---|---|---|
| `AUTH_URL` / `SOLVE_URL` / `SCRAMBLE_URL` | `http://auth:8080` … | service base URLs |
| `SEED_USERS` | 150 | synthetic users (+1 demo) |
| `SEED_AVG_SOLVES` | 650 | average history size per user (≈ 100k solves total) |
| `SEED_CONCURRENCY` | 6 | users seeded in parallel |
| `SEED_RANDOM_SEED` | 3208 | makes usernames/history reproducible |
| `SEED_DEMO_USER` / `SEED_DEMO_PASSWORD` | `demo` / `cubetype-demo` | presentation account |

Run: `docker compose --profile jobs run --rm seed` (local) or `kubectl apply -k deploy/k8s/overlays/local/seed` (kind).
