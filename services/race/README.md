# race-service

Real-time multiplayer race rooms (SPEC section 9.6): everybody in a room gets the same scramble each
round, sees opponents' live status (idle / inspecting / solving / done), results and standings,
and can chat. It is the project's example of **horizontally scaling stateful WebSockets**: any
number of replicas sit behind the load balancer, and two players in the same room may be
connected to different pods.

## API

| | |
|---|---|
| `GET /api/race/rooms` | `{rooms:[{id,name,event,players,status,createdAt}]}`: public rooms, most recent activity first, max 50; `players` = connected players |
| `POST /api/race/rooms` (optional auth) | `{name 1-40, event, isPrivate?}` -> 201 `{room:{id,name,event,isPrivate}}`, id = 8 chars `[a-z0-9]`; 20 creations/min per user or IP |
| `GET /api/race/_info`, `/healthz`, `/readyz` | readiness is gated on Redis (command connection + adapter subscriber) |
| Socket.IO `/socket.io` (websocket only) | handshake `auth: {token?, name?, guestId?}` |

Client -> server events, each answered through the ack with `{ok:true,...}` or `{ok:false, error, code}`:
`room:join {roomId}` -> `{room, playerId, name, servedBy, chat}` - `room:leave {}` -
`round:next {}` (host only) - `player:status {status}` - `player:result {round, timeMs, penalty}` -
`chat:send {text}` (<= 200 chars, 5 per 10 s). Server -> client: `room:state` (the full RoomState after every change) and `chat:message`.

RoomState also carries `rev` (goes up by one on every saved change; **clients should ignore a
`room:state` whose `rev` is lower than the last one they saw**), `isPrivate`,
`round.scrambleSource` (`scramble-service` | `fallback`) and `players[].pods` (the pods holding that
player's sockets; the UI can show "Alice @ race-7f9c-abcde"). The join ack includes `servedBy` and `chat` (the last 50 messages).
`status` is `lobby` before the first round, `running` during a round, and `finished` once every connected
player has a result for it. Standings are sorted by wins, then mean.
**Socket.IO does not remember room membership across reconnects**, so the web client must
re-emit `room:join` on every `connect` event, sending the same `guestId`.

## How it scales (the design)

1. **No sticky sessions.** Clients connect with `transports: ["websocket"]`. With only one HTTP
   upgrade per connection there are no long-polling requests to pin, so any pod can take any socket.
2. **State lives in Redis, not in pods.** `race:room:<id>` holds the room as JSON. Any pod can load
   it, change it and save it. A pod can die at any moment without losing a room.
3. **Broadcasts cross pods via the Redis adapter.** `io.to(roomId).emit()` on pod A is published
   on Redis pub/sub (channel prefix `race:sio`). Every race pod receives it and forwards it to
   its own sockets in that room.
4. **Safe concurrent writes: `mutateRoom(id, fn)`.** This is the only write path. It takes a per-room lock
   (`SET race:lock:<id> <token> NX PX 2000`, retried with backoff, released by a compare-and-delete
   Lua script). It then loads the room and its connection registry, applies `fn`, and enforces the
   invariants (host transfer, round completion). Next it saves room, registry and lobby entry in one `MULTI`,
   which also refreshes the 2 h TTL. Last, still under the lock, it broadcasts `room:state`. Two players on different pods
   submitting at the same moment are therefore applied one after the other.
5. **Connected flags that are correct across pods.** `race:room:<id>:conns` is a hash
   `"<pod>|<playerId>" -> open sockets`. It goes +1 on join and -1 on leave/disconnect, inside `mutateRoom`.
   A player is *connected* when some **live** pod holds a socket for them (multiple tabs and
   pods work).
6. **Pod crashes.** Each pod heartbeats into the `race:pods` zset every 5 s. Sockets on a pod whose
   heartbeat is older than 15 s stop counting at once. A janitor runs every 5 s; one pod at a time
   holds the `race:janitor` lock. It deletes a dead pod's registry entries (`race:pod:<pod>:rooms` says which rooms
   that pod served) and re-broadcasts those rooms, which also moves the host role to a connected player.
   Every 60 s, and after Redis loses data, each pod also rewrites its own entries from the sockets it really
   holds (self-healing).
7. **Rolling updates.** On SIGTERM the pod drops its websockets at the transport level, so clients
   reconnect through the load balancer to another pod. It then finishes the Redis cleanup and
   removes itself from `race:pods` before closing Redis.
8. **Redis outages.** A pod stays up while Redis is unreachable; readiness reports 503, so the load
   balancer stops routing new players to it. The adapter's two connections queue their commands
   until Redis is back instead of failing them (the adapter never handles those promises, so a
   rejection would end the process). Room changes fail with `UNAVAILABLE` because they need the room
   lock, and chat is refused. Once Redis answers again, the heartbeat and the reconcile restore
   this pod's registry entries.

Other keys: `race:rooms` (zset, the public lobby, score = last activity; rooms with nobody connected for 10 min
and expired rooms are pruned when the lobby is read) and `race:room:<id>:chat` (last 50 messages). All
room keys expire after 2 h without activity.

## Rules

The host is the oldest connected player. If the host leaves or disconnects, the role passes on.
A player who leaves on purpose is removed together with their results. A player who disconnects
stays in the list as `connected:false` and can rejoin with the same playerId. A room holds at most 16 players;
when it is full, a new joiner replaces the disconnected player who joined earliest. Results are accepted
only for the current round, once per player, with `timeMs` 1...3 600 000. Wins go to the best
effective time; tied players all get the win, and a DNF never wins. If scramble-service is
unavailable, `round:next` uses a **fallback** random-move scramble generated locally in WCA
notation (Square-1 twists are simulated so they are always legal). A small circuit breaker skips
the service for 15 s after a failure.

## Identity

A valid JWT means playerId = userId and name = username. Anyone else plays as a guest:
playerId = the client's `guestId` (`^guest-[a-z0-9]{6,24}$`, kept in localStorage) or a new one,
with the nickname sanitised to 1-20 characters. Known limitation: guest ids are bearer
identifiers, so anyone who learns one can act as that guest. That is acceptable for casual races.

## Env and dev

Common env (SPEC section 4); the service uses `REDIS_URL`, `JWT_SECRET`, `SCRAMBLE_URL` and `POD_NAME`.
To run two replicas locally against the compose stack's Redis (`docker compose up -d redis`):
`PORT=8081 POD_NAME=race-a REDIS_URL=redis://localhost:56380 npx tsx services/race/src/index.ts`
(and again with `PORT=8082 POD_NAME=race-b`). Tests: `npx vitest run services/race`.
