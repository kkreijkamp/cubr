# scramble-service

Official WCA **random-state** scrambles generated server-side with [cubing.js](https://js.cubing.net)
(`randomScrambleForEvent`), a Redis pool of pre-generated scrambles shared by all replicas, and the
daily challenge (5 persisted scrambles per event per day).

| Route | Response |
|---|---|
| `GET /api/scrambles/events` | `{events: [{id, name, short, puzzle}]}` (from `@cubetype/cubestats` EVENTS) |
| `GET /api/scrambles/:event?count=1..25&fresh=0\|1` | `{event, scrambles, source: "pool"\|"generated"}` - 404 unknown event (e.g. `333mbf`), 400 bad count, 503 on timeout/overload |
| `GET /api/scrambles/daily?date=YYYY-MM-DD` | `{date, events: {333, 222, 444, pyram, skewb: string[5]}}` - default today (UTC), only the last 30 days; 503 while Postgres is unreachable |
| `GET /api/scrambles/_info` | standard info + `warmup`, `generator` (queue depth, generated, timings), `pool` (LLEN per event), `refill`, `memory` |

Megaminx scrambles contain `\n` line breaks (render with `white-space: pre-line`).

## Why it is CPU-bound (the HPA showcase)
A random-state scramble is not a list of random moves: cubing.js picks a uniformly random puzzle
*state* and runs a solver search (Kociemba-style two-phase for 3x3x3, big pruning tables for 4x4x4)
to find a short sequence reaching it. Each request is pure CPU - no I/O to wait on - so CPU
utilisation tracks request rate almost linearly. The service is stateless (shared state lives in
Redis/Postgres), so Kubernetes can add pods freely: the HPA demo runs a load generator against
`?fresh=1` (always generates, bypassing the pool) and watches replicas scale out on CPU.

Measured per pod (1 search thread, Apple M-series under load, `fresh=1` sequential): 333 ~6-12 ms
(~100 req/s), pyram/minx/skewb/clock < 5 ms, **444 ~150-220 ms (~5 req/s)**, sq1 ~150-200 ms
(spikes ~1 s), 333fm ~0.3-0.7 s (spikes ~3 s). One pod saturates one core under 444 load, so
`fresh=1` 444 is the HPA load-test of choice. The first search per event builds tables (444 1-3 s),
so startup runs a **warm-up** (333, 222, 444, sq1, 333fm, pyram, skewb, clock, minx) and `/readyz`
stays 503 until it finishes (~2-3 s; longer on a throttled CPU). RSS ~170-240 MB after warm-up.

## How generation is organised
- cubing.js runs every search on **one internal worker thread**, so the event loop stays free but
  searches are sequential. `generator.ts` puts a small **priority queue** in front of it: requests
  overtake background refills, every scramble has a deadline (`SCRAMBLE_TIMEOUT_MS`, measured from
  enqueue -> 503), and above `SCRAMBLE_MAX_QUEUE` queued scrambles requests are shed with 503.
- Optional `SCRAMBLE_WORKERS=N` (>1) runs N worker threads, each with its own cubing.js (~50-100 MB
  each), to use N cores per pod; a stuck search is handled by restarting its thread. Default 1:
  on Kubernetes, scaling out (more pods) is the cleaner lever.

## Redis pool (`scramble:pool:<event>`)
Targets: 333/222/pyram/skewb 200; 444/sq1/clock/minx/333oh/333bf/333fm 50; 555-777/444bf/555bf 20.
Every replica runs a refill loop: every ~2 s (+/-25 % jitter) it reads all LLENs, picks the
relatively emptiest pool and generates up to 5 scrambles (max ~300 ms of search time per cycle,
so refill stays < ~15 % of a core and does not trigger the HPA) at low priority, yielding between them,
then `RPUSH` + `LTRIM` to the target. It pauses while user requests are queued or were served in
the last second, so it only uses idle CPU. Serving does `LPOP key count`; any shortfall is
generated on the fly (`source: "generated"`). Redis is optional: commands time out after 250 ms,
a 3 s circuit breaker skips Redis after a failure, and requests simply generate directly.

## Daily challenge (schema `scramble`)
`daily_challenges(day, event, scrambles text[])`. The first request for a day generates missing
events, `INSERT ... ON CONFLICT (day, event) DO NOTHING`, then re-selects - concurrent replicas
therefore agree on one set. Responses are cached in memory for 60 s (a stale copy is served during
a DB outage). Migrations run in the background with retry; Postgres is a soft dependency.

## Readiness
`/readyz` gates only on the warm-up. `redis` and `postgres` are soft checks (shown in `_info`).

## Environment
Shared vars (SPEC section 4) plus `SCRAMBLE_WORKERS` (1), `SCRAMBLE_TIMEOUT_MS` (15000),
`SCRAMBLE_MAX_QUEUE` (250), `SCRAMBLE_REFILL` (`1`; `0` disables the loop),
`SCRAMBLE_REFILL_INTERVAL_MS` (2000), `SCRAMBLE_REFILL_BATCH` (5), `SCRAMBLE_REFILL_BUDGET_MS` (300).

## Build notes
cubing.js is **external** to the esbuild bundle (`"cubetype": {"external": ["cubing"]}`) because it
spawns its search worker from its own files. The Dockerfile installs `cubing@0.65.1` (pinned to the
lockfile) into `/app/node_modules` next to `/app/dist/index.mjs`, removing the browser/CLI-only
deps (three.js, @optique, types) that `cubing/scramble` never loads.

Dev: `docker compose up -d postgres redis`, then
`PORT=8082 DATABASE_URL=postgres://cubetype:cubetype@localhost:55433/cubetype REDIS_URL=redis://localhost:56380 npm run dev -w services/scramble` -
Tests: `npx vitest run services/scramble` (cubing.test.ts runs real searches) -
Image: `docker build -f services/scramble/Dockerfile -t cubetype/scramble:dev .`
