#!/usr/bin/env bash
# Runs the backend tests, the integration suites included, against a throwaway Postgres and Redis
# (Docker containers on free ports, in memory, removed afterwards). Arguments go to vitest:
#   npm run test:integration                         # everything
#   npm run test:integration -- services/auth        # one service
#   npm run test:integration -- -t "password reset"  # tests by name
# CI runs the same suites with Postgres and Redis as service containers (.github/workflows/ci.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

PG="cubr-test-postgres-$$"
REDIS="cubr-test-redis-$$"
cleanup() { docker rm -f "$PG" "$REDIS" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# durability off: the data lives for one test run
docker run -d --rm --name "$PG" -e POSTGRES_PASSWORD=test -p 127.0.0.1::5432 --tmpfs /var/lib/postgresql/data \
  postgres:17-alpine -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=300 >/dev/null
docker run -d --rm --name "$REDIS" -p 127.0.0.1::6379 redis:7-alpine --save '' --appendonly no >/dev/null

port() { docker port "$1" "$2/tcp" | head -n1 | sed 's/.*://'; }
PG_PORT=$(port "$PG" 5432)
REDIS_PORT=$(port "$REDIS" 6379)

# over TCP: the image's first-boot server only listens on the socket while it initialises
for _ in $(seq 1 120); do
  docker exec "$PG" psql -h 127.0.0.1 -U postgres -c 'select 1' >/dev/null 2>&1 && break
  sleep 0.25
done
for _ in $(seq 1 40); do
  docker exec "$REDIS" redis-cli ping 2>/dev/null | grep -q PONG && break
  sleep 0.25
done

export TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres"
export TEST_REDIS_URL="redis://127.0.0.1:${REDIS_PORT}"
npx vitest run "$@"
