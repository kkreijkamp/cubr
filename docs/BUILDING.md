# Building a cubetype service — conventions for contributors

`docs/SPEC.md` defines *what* the services do (API contracts, schemas, events). This guide covers
*how* a service is written, built and run, so that every service looks and behaves the same.

Requirements: Node 22 and Docker with compose v2. `npm install` at the repository root installs all
workspaces (`packages/*`, `services/*`, `jobs/*`) with one lockfile.

## Conventions
- TypeScript strict, ESM. Import local files with the `.js` suffix (`import { x } from './routes.js'`).
- Shared code comes from `@cubetype/common` and `@cubetype/cubestats`: config, the error envelope,
  health endpoints, Postgres/Redis clients, migrations, JWT verification and the averaging rules are
  implemented once there, never per service. A helper that a second service needs moves into a
  shared package. Workspaces use the shared TypeScript sources directly (no build step between
  packages); esbuild inlines them into each service bundle.
- Dependencies: `npm install <pkg> -w services/<name>` from the root, so the root
  `package-lock.json` stays the single lockfile. Pure-JS packages only (no native addons): every
  service is bundled with esbuild.
- Raw SQL with parameter placeholders (`$1`) only. Never interpolate user input into SQL.
- Validate every request body / query with zod via `parse(schema, req.body)` from common.
- Errors: throw `HttpError`s from common (`badRequest()`, `notFound()`, `conflict()`, …). The server
  turns them, and zod errors, into the JSON error envelope of SPEC §5; never build error JSON by hand.
- Return exactly the shapes in SPEC §9. Times are integer ms; averages use `-1` for DNF and `null` for n/a
  (`toApiValue` from cubestats).
- Handle dependency failures gracefully: time out calls to other services and wrap non-critical
  Redis use in try/catch, so a slow or missing dependency degrades one feature instead of the service.
- Keep code readable: small modules, a short comment above anything clever.

## Service skeleton

```
services/<name>/
  package.json          # {"name":"@cubetype/<name>","private":true,"type":"module",
                        #  "scripts":{"dev":"tsx watch src/index.ts","build":"node ../../scripts/build-service.mjs ."},
                        #  "dependencies":{"@cubetype/common":"*", ...}}
  Dockerfile
  README.md             # 10–30 lines: purpose, routes, env vars, how to run it
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
  infoPrefixes: ['/api/auth'],
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
```

`createServer` adds the error envelope, the `X-Served-By`/`X-Service` headers, `/healthz`,
`/readyz` and `<prefix>/_info` for every prefix in `infoPrefixes`; `start` listens on `PORT` and
closes the given resources on SIGTERM.

Liveness vs readiness: `/healthz` only says the process is alive and never checks dependencies
(a database outage must not restart every pod). `/readyz` runs the `checks` and decides whether the
instance gets traffic. Gate readiness on what the service *cannot* work without (usually Postgres
and its migrations); put degradable dependencies (e.g. Redis used only for rate limits) in
`softChecks`, which appear in `_info` but don't gate readiness. A service whose core data lives in
Redis gates on Redis instead.

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

## Local development
- `docker compose up --build -d` from the repo root runs the stack: Postgres, Redis, the services
  and an nginx gateway on http://localhost:8080 that mimics the planned Ingress routes
  (`deploy/gateway/nginx.conf`). `docker compose down` stops it (`-v` also deletes the data).
- Postgres and Redis are published on `127.0.0.1:55433` and `127.0.0.1:56380` (non-default ports,
  so a locally installed Postgres/Redis can't clash). To run one service on the host with hot
  reload against them, start only the databases and pick a free port (the gateway uses 8080):
  ```bash
  docker compose up -d postgres redis
  PORT=8081 DATABASE_URL=postgres://cubetype:cubetype@localhost:55433/cubetype \
    REDIS_URL=redis://localhost:56380 npm run dev -w services/auth
  ```
- Unit tests: `npm test` from the root (vitest over `packages/*/test`, `services/*/test`,
  `jobs/*/test`); one service: `npx vitest run services/<name>`. Typecheck: `npm run typecheck`.
- Bundle check: `node scripts/build-service.mjs services/<name> && node services/<name>/dist/index.mjs`
  (`npm run build:all` bundles every service).

## Definition of done for a service
1. `npm run typecheck` passes.
2. `node scripts/build-service.mjs services/<name>` succeeds and the bundle starts.
3. Unit tests for the domain logic pass (`npm test`).
4. The service runs against the compose Postgres/Redis and every route was exercised with curl,
   including the error cases (invalid body → 400 envelope, missing token → 401).
5. `docker build -f services/<name>/Dockerfile -t cubetype/<name>:dev .` succeeds, and the service
   has its entry in `docker-compose.yml` and its routes in the gateway (SPEC §3).
6. README.md written.
