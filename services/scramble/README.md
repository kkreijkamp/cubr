# scramble-service

Official WCA **random-state** scrambles generated server-side with [cubing.js](https://js.cubing.net)
(`randomScrambleForEvent`).

| Route | Response |
|---|---|
| `GET /api/scrambles/events` | `{events: [{id, name, short, puzzle}]}` (from `@cubetype/cubestats` EVENTS) |
| `GET /api/scrambles/:event?count=1..25` | `{event, scrambles, source: "generated"}` — 404 unknown event (e.g. `333mbf`), 400 bad count, 503 on timeout/overload |
| `GET /api/scrambles/_info` | standard info + `warmup`, `generator` (queue depth, generated, timings), `memory` |

Megaminx scrambles contain `\n` line breaks (render with `white-space: pre-line`).

## Why it is CPU-bound
A random-state scramble is not a list of random moves: cubing.js picks a uniformly random puzzle
*state* and runs a solver search (Kociemba-style two-phase for 3x3x3, big pruning tables for 4x4x4)
to find a short sequence reaching it. Each request is pure CPU — no I/O to wait on — so CPU
utilisation tracks request rate almost linearly. The service keeps no state of its own, so more
instances simply mean more scrambles per second.

Measured per instance (1 search thread, Apple M-series, sequential requests): 333 ≈ 6–12 ms
(~100 req/s), pyram/minx/skewb/clock < 5 ms, **444 ≈ 150–220 ms (~5 req/s)**, sq1 ≈ 150–200 ms
(spikes ~1 s), 333fm ≈ 0.3–0.7 s (spikes ~3 s). The first search per event builds tables (444 1–3 s),
so startup runs a **warm-up** (333, 222, 444, sq1, 333fm, pyram, skewb, clock, minx) and `/readyz`
stays 503 until it finishes (~2–3 s; longer on a throttled CPU). RSS ≈ 170–240 MB after warm-up.

## How generation is organised
cubing.js runs every search on **one internal worker thread**, so the event loop stays free but
searches are sequential. `generator.ts` puts a small **queue** in front of it: every scramble has a
deadline (15 s, measured from enqueue → 503), and above 250 queued scrambles requests are shed with
503 instead of building an unbounded backlog.

## Readiness
`/readyz` gates only on the warm-up.

## Environment
Shared vars (SPEC §4); no database or Redis yet.

## Build notes
cubing.js is **external** to the esbuild bundle (`"cubetype": {"external": ["cubing"]}`) because it
spawns its search worker from its own files. The Dockerfile installs `cubing@0.65.1` (pinned to the
lockfile) into `/app/node_modules` next to `/app/dist/index.mjs`, removing the browser/CLI-only
deps (three.js, @optique, types) that `cubing/scramble` never loads.

Dev: `PORT=8082 npm run dev -w services/scramble` · Tests: `npx vitest run services/scramble`
(cubing.test.ts runs real searches) · Image: `docker build -f services/scramble/Dockerfile -t cubetype/scramble:dev .`
