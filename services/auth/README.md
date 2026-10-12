# auth service

Accounts, JWT login and per-user settings (SPEC §7.1, §9.1). Owns Postgres schema `auth`
(`users`, `user_settings`), migrated at startup. Fastify on :8080.

| Route | Auth | Notes |
|---|---|---|
| `POST /api/auth/register` | – | `{username, email, password}` → 201 `{token, user}`; 409 if username/email taken (case-insensitive) |
| `POST /api/auth/login` | – | `{login, password}` (username or email) → `{token, user}`; 401 |
| `GET /api/auth/me` | req | `{user: PrivateUser, settings}` |
| `GET /api/auth/_info` | – | info |

- Passwords: bcryptjs cost 10 (async). Unknown logins still run a bcrypt compare against a dummy hash
  so response time doesn't reveal whether an account exists.
- Tokens: HS256 JWTs from `@cubetype/common` (`sub` = user id, `username`, `jti`), valid for 30 days.
- Readiness gates on Postgres + migrations.

Env: `PORT`, `DATABASE_URL`, `JWT_SECRET`, `POD_NAME`, `NODE_NAME`, `APP_VERSION`, `LOG_LEVEL`.

Dev against the compose database: `docker compose up -d postgres`, then
`PORT=8081 DATABASE_URL=postgres://cubetype:cubetype@localhost:55433/cubetype npm run dev -w services/auth`
Tests: `npx vitest run services/auth`. Image: `docker build -f services/auth/Dockerfile -t cubetype/auth:dev .`
