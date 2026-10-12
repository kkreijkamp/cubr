# solve service

The core write path of cubetype: sessions and solves CRUD. Owns the Postgres schema `solve`
(SPEC §7.2), migrated at startup. Port 8080.

## Routes (all require `Authorization: Bearer <jwt>`)
| Route | Notes |
|---|---|
| `GET /api/sessions` | creates a default `3x3`/`333` session on first call (per-user advisory lock → exactly one) |
| `POST /api/sessions` `{id?, name, event}` | 201; same id again for this user → 200 existing; id owned by someone else → 409 |
| `PATCH /api/sessions/:id` `{name}` / `DELETE /api/sessions/:id` | delete cascades to the session's solves |
| `GET /api/sessions/:id/solves` | `{solves}` ascending by `createdAt` |
| `POST /api/solves` | idempotent on `id` (`ON CONFLICT DO NOTHING`): retry → 200 with the stored solve; id of another user → 409. Returns `{solve}` |
| `PATCH /api/solves/:id` `{penalty?, comment?}` / `DELETE /api/solves/:id` | |
| `GET /api/solves/_info`, `/api/sessions/_info` | info |

Users only ever see their own rows; foreign ids return 404. A solve always gets the event of its session.
Tokens revoked by logout are rejected (Redis lookup via common's `makeAuth`; fails open while Redis is down).

## Choices worth knowing
- `id` and `scramble`/`penalty` on `POST /api/solves` are optional (server generates the id; defaults `''`/`OK`). `source` may be
  `timer|manual|race|import|seed`.
- `createdAt` more than 5 min in the future (a device clock running fast) is clamped to the server time instead of
  rejecting the solve; unparseable timestamps → 400.
- Empty bodies sent with `Content-Type: application/json` (for example a DELETE from a fetch wrapper) are accepted.

## Env / run
Standard vars (SPEC §4): `PORT DATABASE_URL REDIS_URL JWT_SECRET APP_VERSION POD_NAME NODE_NAME LOG_LEVEL`.
```
docker compose up -d postgres redis
PORT=8083 DATABASE_URL=postgres://cubetype:cubetype@localhost:55433/cubetype REDIS_URL=redis://localhost:56380 npm run dev -w services/solve
npx vitest run services/solve        # unit tests: mapping, schemas
docker build -f services/solve/Dockerfile -t cubetype/solve:dev .
```
