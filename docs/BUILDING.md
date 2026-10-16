# Building a cubetype service — conventions for contributors

`docs/SPEC.md` defines *what* the services do (API contracts, schemas, events). This guide covers
*how* a service is written, built, run and deployed, so that every service looks and behaves the
same. The web app has its own guide: `docs/FRONTEND.md`.

Requirements: Node 22 and Docker with compose v2 (plus kind and kubectl for the local Kubernetes
cluster). `npm install` at the repository root installs all workspaces (`packages/*`, `services/*`,
`jobs/*`) with one lockfile.

## Conventions
- TypeScript strict, ESM. Import local files with the `.js` suffix (`import { x } from './routes.js'`).
- Shared code comes from `@cubetype/common` and `@cubetype/cubestats`: config, the error envelope,
  health endpoints, Postgres/Redis clients, migrations, JWT verification, rate limits, the event
  stream, service-to-service HTTP and the averaging rules are implemented once there, never per
  service. A helper that a second service needs moves into a shared package. Workspaces use the
  shared TypeScript sources directly (no build step between packages); esbuild inlines them into
  each service bundle.
- Dependencies: `npm install <pkg> -w services/<name>` from the root, so the root
  `package-lock.json` stays the single lockfile. Pure-JS packages only (no native addons): every
  service is bundled with esbuild.
- Raw SQL with parameter placeholders (`$1`) only. Never interpolate user input into SQL.
- Validate every request body / query with zod via `parse(schema, req.body)` from common.
- Errors: throw `HttpError`s from common (`badRequest()`, `notFound()`, `conflict()`, …). The server
  turns them, and zod errors, into the JSON error envelope of SPEC §5; never build error JSON by hand.
- Return exactly the shapes in SPEC §9. Times are integer ms; averages use `-1` for DNF and `null` for n/a
  (`toApiValue` from cubestats).
- Events: publish with `publishEvent()` and consume with `consumeEvents()` (one consumer group per
  service, ack after success). Delivery is at-least-once, so every handler must be idempotent. A
  write whose event must not get lost goes through an outbox table in the same transaction (solve's
  `outbox`, stats' `pb_outbox`) instead of publishing directly.
- Service-to-service calls use `fetchJson()` from common (timeouts, retries). Routes for other
  services live under `/internal/*` with `preHandler: requireInternal(config.internalToken, app.log)`,
  and callers send `internalHeaders(config.internalToken)` (SPEC §4/§5).
- Handle dependency failures gracefully: time out calls to other services and wrap non-critical
  Redis use in try/catch, so a slow or missing dependency degrades one feature instead of the service.
- Keep code readable: small modules, a short comment above anything clever.

## Service skeleton

```
services/<name>/
  package.json          # {"name":"@cubetype/<name>","private":true,"type":"module",
                        #  "scripts":{"dev":"tsx watch src/index.ts","build":"node ../../scripts/build-service.mjs ."},
                        #  "dependencies":{"@cubetype/common":"*","@cubetype/cubestats":"*", ...}}
  Dockerfile
  README.md             # 10–30 lines: purpose, routes, events consumed/produced, env vars, how to run it
  src/index.ts          # wiring only (see template)
  src/migrations.ts     # export const migrations: Migration[] = [{ id: '001_init', sql: `...` }]
  src/routes/*.ts       # route registration functions
  src/*.ts              # domain logic (pure functions where possible → unit tests)
  test/*.test.ts        # vitest
```

### `src/index.ts` template
```ts
import {
  loadConfig, createServer, start, createPool, waitForPostgres, migrate, createRedis, makeAuth,
} from '@cubetype/common';
import { migrations } from './migrations.js';
import { registerRoutes } from './routes/index.js';

const config = loadConfig('auth');

let migrated = false;
const server = createServer(config, {
  infoPrefixes: ['/api/auth', '/api/users'],
  checks: {
    postgres: () => pool.query('select 1'),
    migrations: async () => { if (!migrated) throw new Error('migrations pending'); },
  },
  softChecks: { redis: () => redis.ping() },   // shown in _info, does not gate readiness
});
const { app } = server;
const pool = createPool(config.databaseUrl, { log: app.log });
const redis = createRedis(config.redisUrl, app.log);
const auth = makeAuth(config.jwtSecret, redis);

await registerRoutes(app, { config, pool, redis, auth });

// Listen first so liveness passes while Postgres boots; readiness stays 503 until migrated.
await start(server, config, [() => pool.end(), () => redis.quit()]);
await waitForPostgres(pool, app.log);
await migrate(pool, 'auth', migrations, app.log);
migrated = true;
// start background loops (event consumers, outbox relay, pool refill) here
```

`createServer` adds the error envelope, the `X-Served-By`/`X-Service` headers, `/healthz`,
`/readyz` and `<prefix>/_info` for every prefix in `infoPrefixes`; `start` listens on `PORT` and
closes the given resources on SIGTERM.

Liveness vs readiness: `/healthz` only says the process is alive and never checks dependencies
(a database outage must not restart every pod). `/readyz` runs the `checks` and decides whether the
instance gets traffic. Gate readiness on what the service *cannot* work without (usually Postgres
and its migrations); put degradable dependencies (Redis for solve/auth) in `softChecks`, which
appear in `_info` but don't gate readiness. Services whose core data lives in Redis (leaderboard,
race) gate on Redis; scramble gates on its warm-up.

### Dockerfile template (build context = repo root)
```dockerfile
# syntax=docker/dockerfile:1
# ---- build stage: runs natively on the build machine; output is architecture-independent JS
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /repo
COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
RUN node scripts/build-service.mjs services/auth

# ---- runtime stage: node + one bundled file, runs as the unprivileged "node" user
FROM node:22-alpine
ARG APP_VERSION=dev
ENV NODE_ENV=production SERVICE_NAME=auth APP_VERSION=${APP_VERSION} PORT=8080
WORKDIR /app
COPY --from=build /repo/services/auth/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
```
(The scramble service additionally installs `cubing` next to the bundle: it is kept external —
`"cubetype": {"external": ["cubing"]}` in its `package.json` — because it starts its search worker
from its own files.)

## Local development
- `docker compose up --build -d` from the repo root runs the whole stack: Postgres, Redis, all
  services, the web app and an nginx gateway on http://localhost:8080 with the same routes as the
  Ingress (`deploy/gateway/nginx.conf`). `docker compose ps` shows each container's health (from
  `/readyz`); `docker compose up -d --scale solve=3` puts replicas behind the gateway; the
  `X-Served-By` header shows which one answered. `docker compose down` stops it (`-v` also deletes
  the data).
- Jobs: `docker compose --profile jobs run --rm wca-import` (WCA dataset) and
  `docker compose --profile jobs run --rm seed` (demo users and solves).
- End-to-end check: `node scripts/smoke.mjs http://localhost:8080` (works against any entry point:
  compose, kind or the GKE Ingress).
- Postgres and Redis are published on `127.0.0.1:55433` and `127.0.0.1:56380` (non-default ports,
  so a locally installed Postgres/Redis can't clash). To run one service on the host with hot
  reload against them, start only the databases and pick a free port (the gateway uses 8080):
  ```bash
  docker compose up -d postgres redis
  PORT=8081 DATABASE_URL=postgres://cubetype:cubetype@localhost:55433/cubetype \
    REDIS_URL=redis://localhost:56380 npm run dev -w services/auth
  ```
  Other services are reached through their `*_URL` variables (e.g. `SOLVE_URL=http://localhost:8083`
  when stats runs next to a solve started the same way); give both the same `INTERNAL_API_TOKEN`
  (or none) so `/internal/*` calls are accepted.
- Unit tests: `npm test` from the root (vitest over `packages/*/test`, `services/*/test`,
  `jobs/*/test`); one service: `npx vitest run services/<name>`. Typecheck: `npm run typecheck`.
  The web app has its own `npm test` / `npm run typecheck` in `web/`.
- Bundle check: `node scripts/build-service.mjs services/<name> && node services/<name>/dist/index.mjs`
  (`npm run build:all` bundles every service and the seed job).
- CI (`.github/workflows/ci.yml`) runs the typecheck, the tests and the bundles, the web app's
  checks and build, renders every kustomize overlay and builds the scramble image on every push.

## Adding a service to the deployment
The images, routes and manifests are listed per service, so a new service touches:
1. `docker-compose.yml` (a block using the shared `x-service` anchor, plus its `*_URL` in
   `x-service-env`) and a location in `deploy/gateway/nginx.conf`.
2. `deploy/k8s/base/<name>.yaml`: Deployment + ClusterIP Service + PodDisruptionBudget, copied from
   an existing service (labels, probes, security context, downward-API env, resources), listed in
   `base/kustomization.yaml`; an HPA in `base/hpa.yaml` if it is CPU-bound (then without
   `spec.replicas`, so `kubectl apply` never resets a scaled-out Deployment).
3. Routing on Kubernetes: a path in `overlays/gke/ingress.yaml` with its BackendConfig and Service
   annotation, and a location in `overlays/local/gateway-nginx.conf` for kind.
4. Images: a step in `cloudbuild.yaml`, the GKE overlay's `images:` list, `ALL_IMAGES` in
   `scripts/build-local.sh` / `scripts/build-push.sh`, and the deployment lists in
   `scripts/kind-up.sh` / `scripts/commands.sh`.
5. Its `_info` path (and a short journey) in `scripts/smoke.mjs`.

`kubectl kustomize deploy/k8s/overlays/<local|gke>` must render, and `scripts/kind-up.sh` gives a
local cluster to try it on (`deploy/README.md` has the details).

## Versioning

Every commit is a release with its own version, so a deploy always pulls new images.

- `.githooks/pre-commit` runs `scripts/bump-version.sh`, which bumps the patch version in every
  file that names it:
  - the image tags in the GKE overlays
  - `VERSION` in `scripts/commands.sh`
  - the defaults in `cloudbuild.yaml` and `scripts/build-push.sh`
  - the table in `deploy/README.md`
- `.githooks/post-commit` then tags the commit `vX.Y.Z`.
- A new version is always above the highest tag. Tags are never moved or reused: images are
  pulled `IfNotPresent`, so new code pushed under an existing tag would never roll out.
- For a minor or major release, run `scripts/bump-version.sh minor` (or `major`) before
  committing. The hook keeps a version that is already above the highest tag.
- Once per clone, run `git config core.hooksPath .githooks` and
  `git config push.followTags true`. The second makes `git push` push the tags too.
- CI fails if the files name different versions, or if a pushed `vX.Y.Z` tag doesn't match them.

## Definition of done for a service
1. `npm run typecheck` passes.
2. `node scripts/build-service.mjs services/<name>` succeeds and the bundle starts.
3. Unit tests for the domain logic pass (`npm test`).
4. The service runs against the compose Postgres/Redis and every route was exercised with curl,
   including the error cases (invalid body → 400 envelope, missing token → 401).
5. `docker build -f services/<name>/Dockerfile -t cubetype/<name>:dev .` succeeds, the service runs
   in the compose stack behind the gateway, and the smoke test passes.
6. The Kubernetes manifests render and the service becomes ready on kind.
7. README.md written, and `docs/SPEC.md` updated if a contract changed.
