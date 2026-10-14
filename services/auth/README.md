# auth service

Accounts, JWT login/logout, profiles with pictures and per-user settings (SPEC §7.1, §9.1). Owns Postgres
schema `auth` (`users`, `user_settings`, `avatars`), migrated at startup. Fastify on :8080.

| Route | Auth | Notes |
|---|---|---|
| `POST /api/auth/register` | – | `{username, email, password}` → 201 `{token, user}`; 409 if username/email taken (case-insensitive); 20/hour/IP |
| `POST /api/auth/login` | – | `{login, password}` (username or email) → `{token, user}`; 401; 429 after 10 attempts/min/IP |
| `POST /api/auth/logout` | req | 204; stores `auth:revoked:<jti>` with TTL = token's remaining life. Accepts any/empty body |
| `GET /api/auth/me` | req | `{user: PrivateUser, settings}` |
| `PATCH /api/auth/me` | req | `{displayName?, bio?, country?, wcaId?}`; `null` or `""` clears; country/wcaId are uppercased |
| `PUT /api/auth/me/settings` | req | `{settings: object}`; > 16 KB JSON → 413 `PAYLOAD_TOO_LARGE` |
| `PUT /api/auth/me/avatar` | req | raw image body (`image/webp`, `image/jpeg` or `image/png`, ≤ 300 KB, magic bytes must match the Content-Type) → `{user}`; 10/hour/user; publishes `user.updated` |
| `DELETE /api/auth/me/avatar` | req | removes the picture → `{user}`; publishes `user.updated` |
| `GET /api/users/:idOrUsername/avatar` | – | the image; `?v=<version>` matching the current picture → `Cache-Control: immutable` (1 year), else 5 min; ETag/304; `nosniff` + sandbox CSP |
| `GET /api/users/:username` | – | `{user: PublicUser}` (case-insensitive), 404 |
| `GET /api/users?ids=a,b` | – | ≤ 100 ids (400 above), invalid uuids ignored, order preserved |
| `GET /api/auth/_info`, `/api/users/_info` | – | info |

- Passwords: bcryptjs cost 10 (async). Unknown logins still run a bcrypt compare against a dummy hash
  so response time doesn't reveal whether an account exists.
- Tokens: HS256 JWTs from `@cubetype/common` (`sub` = user id, `username`, `jti`), valid for 30 days.
  Every service verifies them with `makeAuth`, which also rejects revoked `jti`s.
- Profile pictures: the browser crops/resizes to a 256×256 WebP/JPEG (≈ 20–40 KB) before uploading, so the server
  never decodes images (no native image libraries in the bundle): it checks the declared type against the file's
  magic bytes, caps the size and stores the bytes in `auth.avatars` (bytea, migration `002_avatars`).
  `users.avatar_version` (first 12 hex chars of the SHA-256) is part of `avatarUrl`, so every new picture gets a new
  URL that browsers and caches can keep forever.
- Events published: `user.registered`, `user.updated` (SPEC §8 fields incl. `avatarUrl`, eventId `auth-<uuid>`).
- Readiness gates on Postgres + migrations. Redis is soft: when it is down, register/login/profile
  still work (rate limits fail open after 500 ms, revocation checks fail open, event publishing is
  skipped with a warning after 1.5 s); only logout returns 503 because the revocation could not be stored.
- Rate-limit key uses `req.ip` (Fastify `trustProxy: true`, i.e. the left-most `X-Forwarded-For`).
- Trusted in-cluster callers (the seed job) send `X-Internal-Token: <INTERNAL_API_TOKEN>` and skip the per-IP
  register/login limits — they legitimately create many accounts from one pod IP. Disabled unless the secret is set
  (≥ 16 chars); compared in constant time.

Env: `PORT`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `INTERNAL_API_TOKEN`, `POD_NAME`, `NODE_NAME`, `APP_VERSION`, `LOG_LEVEL`.

Dev against the compose stack: `docker compose up -d postgres redis`, then
`PORT=8081 DATABASE_URL=postgres://cubetype:cubetype@localhost:55433/cubetype REDIS_URL=redis://localhost:56380 npm run dev -w services/auth`
Tests: `npx vitest run services/auth`. Image: `docker build -f services/auth/Dockerfile -t cubetype/auth:dev .`
