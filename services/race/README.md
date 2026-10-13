# race-service

Real-time multiplayer race rooms (SPEC §9.6): everybody in a room gets the same scramble each
round, sees opponents' live status (idle / inspecting / solving / done), results and standings,
and can chat. All room state lives in Redis, so the service can run with several replicas behind
the load balancer.

## API

| | |
|---|---|
| `GET /api/race/rooms` | `{rooms:[{id,name,event,players,status,createdAt}]}`: public rooms, most recent activity first, max 50; `players` = connected players |
| `POST /api/race/rooms` (optional auth) | `{name 1–40, event, isPrivate?}` → 201 `{room:{id,name,event,isPrivate}}`, id = 8 chars `[a-z0-9]`; 20 creations/min per user or IP |
| `GET /api/race/_info`, `/healthz`, `/readyz` | readiness is gated on Redis |
| Socket.IO `/socket.io` (websocket only) | handshake `auth: {token?, name?, guestId?}` |

Client → server events, each answered through the ack with `{ok:true,...}` or `{ok:false, error, code}`:
`room:join {roomId}` → `{room, playerId, name, chat}` · `room:leave {}` ·
`round:next {}` (host only) · `player:status {status}` · `player:result {round, timeMs, penalty}` ·
`chat:send {text}` (≤ 200 chars, 5 per 10 s). Server → client: `room:state` (the full RoomState after every change) and `chat:message`.

RoomState also carries `rev`, which goes up by one on every saved change (**clients should ignore a
`room:state` whose `rev` is lower than the last one they saw**), `isPrivate`, and
`round.scrambleSource` (`scramble-service` | `fallback`). The join ack includes `chat` (the last 50 messages).
`status` is `lobby` before the first round, `running` during a round, and `finished` once every connected
player has a result for it. Standings are sorted by wins, then mean.
**Socket.IO does not remember room membership across reconnects**, so the web client must
re-emit `room:join` on every `connect` event, sending the same `guestId`.

## Design

1. **No sticky sessions.** Clients connect with `transports: ["websocket"]`. With only one HTTP
   upgrade per connection there are no long-polling requests to pin.
2. **State lives in Redis, not in the process.** `race:room:<id>` holds the room as JSON.
3. **Safe concurrent writes: `mutateRoom(id, fn)`.** This is the only write path. It takes a per-room lock
   (`SET race:lock:<id> <token> NX PX 2000`, retried with backoff, released by a compare-and-delete
   Lua script). It then loads the room and its connection registry, applies `fn`, and enforces the
   invariants (host transfer, round completion). Next it saves room, registry and lobby entry in one `MULTI`,
   which also refreshes the 2 h TTL. Last, still under the lock, it broadcasts `room:state`. Two players
   submitting at the same moment are therefore applied one after the other.
4. **Connected flags.** `race:room:<id>:conns` is a hash `playerId → open sockets`. It goes +1 on join
   and −1 on leave/disconnect, inside `mutateRoom`. A player with several tabs stays connected until
   the last one closes.

Other keys: `race:rooms` (zset, the public lobby, score = last activity; rooms with nobody connected for 10 min
and expired rooms are pruned when the lobby is read) and `race:room:<id>:chat` (last 50 messages). All
room keys expire after 2 h without activity.

## Rules

The host is the oldest connected player. If the host leaves or disconnects, the role passes on.
A player who leaves on purpose is removed together with their results. A player who disconnects
stays in the list as `connected:false` and can rejoin with the same playerId. A room holds at most 16 players;
when it is full, a new joiner replaces the disconnected player who joined earliest. Results are accepted
only for the current round, once per player, with `timeMs` 1…3 600 000. Wins go to the best
effective time; tied players all get the win, and a DNF never wins. If scramble-service is
unavailable, `round:next` uses a **fallback** random-move scramble generated locally in WCA
notation for the cube events (2x2–7x7, including OH/BLD/FMC); other puzzles wait for the service.

## Identity

A valid JWT means playerId = userId and name = username. Anyone else plays as a guest:
playerId = the client's `guestId` (`^guest-[a-z0-9]{6,24}$`, kept in localStorage) or a new one,
with the nickname sanitised to 1–20 characters. Known limitation: guest ids are bearer
identifiers, so anyone who learns one can act as that guest. That is acceptable for casual races.

## Env and dev

Common env (SPEC §4); the service uses `REDIS_URL`, `JWT_SECRET` and `SCRAMBLE_URL`.
Dev against the compose stack's Redis (`docker compose up -d redis`):
`PORT=8081 REDIS_URL=redis://localhost:56380 npx tsx services/race/src/index.ts`.
Tests: `npx vitest run services/race`.
