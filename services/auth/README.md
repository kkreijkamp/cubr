# auth service

Accounts, JWT login/logout, sign-in with Google, Apple and GitHub, profiles with pictures and per-user settings
(SPEC section 7.1, section 9.1). Owns Postgres schema `auth` (`users`, `user_settings`, `avatars`, `password_resets`,
`supporters`, `user_identities`), migrated at startup. Fastify on :8080.

| Route | Auth | Notes |
|---|---|---|
| `POST /api/auth/register` | - | `{username, email, password}` -> 201 `{token, user}`; 409 if username/email taken (case-insensitive); 20/hour/IP |
| `POST /api/auth/login` | - | `{login, password}` (username or email) -> `{token, user}`; 401; 429 after 10 attempts/min/IP |
| `POST /api/auth/logout` | req | 204; stores `auth:revoked:<jti>` with TTL = token's remaining life. Accepts any/empty body |
| `GET /api/auth/me` | req | `{user: PrivateUser, settings}` |
| `PATCH /api/auth/me` | req | `{displayName?, bio?, country?, wcaId?}`; `null` or `""` clears; country/wcaId are uppercased |
| `PUT /api/auth/me/settings` | req | `{settings: object}`; > 16 KB JSON -> 413 `PAYLOAD_TOO_LARGE` |
| `PUT /api/auth/me/avatar` | req | raw image body (`image/webp`, `image/jpeg` or `image/png`, <= 300 KB, magic bytes must match the Content-Type) -> `{user}`; 10/hour/user; publishes `user.updated` |
| `DELETE /api/auth/me/avatar` | req | removes the picture -> `{user}`; publishes `user.updated` |
| `DELETE /api/auth/me` | req | `{password}` (or `{confirm: <username>}` for an account without a password) -> 204: deletes the account (settings and picture cascade), revokes all its tokens (`auth:revoked-user:<id>`) and publishes `user.deleted` in one transaction - if Redis can't take either, nothing is deleted (503). 403 wrong password (or username), 5 tries/10 min/user |
| `GET /api/users/:idOrUsername/avatar` | - | the image; `?v=<version>` matching the current picture -> `Cache-Control: immutable` (1 year), else 5 min; ETag/304; `nosniff` + sandbox CSP |
| `GET /api/users/:username` | - | `{user: PublicUser}` (case-insensitive), 404 |
| `GET /api/users?ids=a,b` | - | <= 100 ids (400 above), invalid uuids ignored, order preserved |
| `GET /api/auth/_info`, `/api/users/_info` | - | info |

Sign-in with providers (`/api/auth/oauth/*`, `/api/auth/me/sign-in`, `/api/auth/me/identities/:provider`) is in
SPEC section 9.1, and below.

- Passwords: bcryptjs cost 10 (async). Unknown logins still run a bcrypt compare against a dummy hash
  so response time doesn't reveal whether an account exists.
- Tokens: HS256 JWTs from `@cubr/common` (`sub` = user id, `username`, `jti`), valid for 30 days.
  Every service verifies them with `makeAuth`, which also rejects revoked `jti`s and every token of a deleted
  account (issued at or before `auth:revoked-user:<id>`).
- Profile pictures: the browser crops/resizes to a 256x256 WebP/JPEG (~20-40 KB) before uploading, so the server
  never decodes images (no native image libraries in the bundle): it checks the declared type against the file's
  magic bytes, caps the size and stores the bytes in `auth.avatars` (bytea, migration `002_avatars`).
  `users.avatar_version` (first 12 hex chars of the SHA-256) is part of `avatarUrl`, so every new picture gets a new
  URL that browsers and caches can keep forever.
- Events published: `user.registered`, `user.updated` (SPEC section 8 fields incl. `avatarUrl`, eventId `auth-<uuid>`),
  `user.deleted` (`userId, username`: solve, stats and leaderboard delete the account's data).
- Readiness gates on Postgres + migrations. Redis is soft: when it is down, register/login/profile
  still work (rate limits fail open after 500 ms, revocation checks fail open, event publishing is
  skipped with a warning after 1.5 s); only logout returns 503 because the revocation could not be stored.
- Rate-limit key uses `req.ip`: common's server trusts only a fixed number of reverse-proxy hops
  (`TRUST_PROXY_HOPS`: 1 behind the local gateway, 2 behind the GKE load balancer) when reading
  `X-Forwarded-For`, so a client can't pick its own address with a fake header.
- Trusted in-cluster callers (the seed job) send `X-Internal-Token: <INTERNAL_API_TOKEN>` - the same shared secret
  that protects the services' `/internal/*` routes - and skip the per-IP register/login limits: they legitimately
  create many accounts from one pod IP. Disabled unless the secret is set (>= 16 chars); compared in constant time
  (common's `internalTokenMatches`).

Env: `PORT`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `INTERNAL_API_TOKEN`, `TRUST_PROXY_HOPS`, `POD_NAME`, `NODE_NAME`,
`APP_VERSION`, `LOG_LEVEL`, `PUBLIC_URL`, `RESEND_API_KEY`, `MAIL_FROM` (default `cubr <no-reply@cubr.dev>`), `MAIL_REPLY_TO`
(default `hello@cubr.dev`), `KOFI_VERIFICATION_TOKEN`, and the provider variables (below).

Dev against the compose stack: `docker compose up -d postgres redis`, then
`PORT=8081 DATABASE_URL=postgres://cubr:cubr@localhost:55433/cubr REDIS_URL=redis://localhost:56380 npm run dev -w services/auth`
Tests: `npx vitest run services/auth`. Image: `docker build -f services/auth/Dockerfile -t cubr/auth:dev .`

## Sign-in with Google, Apple and GitHub

`src/oauth.ts` (the providers) and `src/routes/oauth.ts` (the routes). The authorization code flow with PKCE, a
`state` and (Google, Apple) an OpenID `nonce`, all kept in Redis for 10 minutes and used once. A cookie
(`cubr_oauth`: HttpOnly, Secure, SameSite=None so Apple's cross-site form POST carries it, path `/api/auth/oauth`)
binds the flow to the browser that started it, and then binds the one-time login code (2 min) or the sign-up id
(15 min) the same way, so a link made by someone else can't sign you in to their account. The callback hands the
SPA only that code or id, in the URL fragment (`/login/sso#...`); the SPA exchanges it for a normal cubr JWT.

- Google and Apple: the ID token from the token endpoint is verified with the provider's JWKS (`jose`):
  signature, issuer, audience = the client id, expiry and nonce. Apple's client secret is an ES256 JWT signed
  with the Sign in with Apple key, made per request (valid 5 minutes).
- GitHub: the access token reads `/user` and `/user/emails` (the primary verified email).
- An identity is `(provider, subject)` in `auth.user_identities`. A known identity signs in to its account. An
  unknown one starts a new account (the user picks the public username, suggested from the provider's name or
  login) and needs a verified email that no account has: an existing account's email is never linked automatically
  (`email_taken`), because cubr doesn't verify sign-up emails. Connecting a provider to an existing account is done
  signed in, from the account page (mode `link`).
- An account made this way has `password_hash` null (`hasPassword: false`): password login answers 401 after the
  usual dummy compare, "forgot password?" sets a password, and deleting it is confirmed with the username. Its
  last way in can't be disconnected.
- A provider is on only when all of its variables are set (no button otherwise). `PUBLIC_URL` decides the redirect
  URI, `<PUBLIC_URL>/api/auth/oauth/<provider>/callback`, which must be registered with the provider exactly.

| Var | Provider |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google (OAuth client, type "Web application") |
| `APPLE_CLIENT_ID` (the Services ID), `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (the `.p8`, newlines as `\n`) | Apple |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub (OAuth App) |
| `*_AUTH_URL`, `*_TOKEN_URL`, `GOOGLE_JWKS_URL`, `APPLE_JWKS_URL`, `GOOGLE_ISSUER`, `APPLE_ISSUER`, `GITHUB_API_URL` | overrides for tests and local stand-ins (`test/fakeProviders.ts`) |

Setting them up for cubr.dev: deploy/vps/README.md, "Sign-in providers".
