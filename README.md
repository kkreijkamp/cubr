<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/cubr-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/cubr-logo-light.svg">
    <img src="docs/assets/cubr-logo-light.svg" alt="cubr" width="240">
  </picture>
</p>

<p align="center">
  A minimalist speedcubing timer.<br>
  <a href="https://cubr.dev"><strong>cubr.dev</strong></a>
</p>

<p align="center">
  <a href="https://github.com/kkreijkamp/cubr/actions/workflows/ci.yml"><img src="https://github.com/kkreijkamp/cubr/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
</p>

## Features

- **Timer:** WCA inspection and penalties, sessions per event and csTimer's keyboard shortcuts.
- **Inputs:** keyboard, touch, Stackmat timers, and Bluetooth smart cubes and timers.
- **Scrambles:** official random-state scrambles, with 2D and 3D previews.
- **Statistics:** averages from mo3 to ao1000, personal bests, and import and export that work with csTimer.
- **Online:** cloud sync, leaderboards, a daily challenge, live races and comparisons with the WCA rankings.
- **App:** installable, works offline, and themes that follow your device's light or dark mode.

## Architecture

A React app served by nginx, seven TypeScript services on Fastify, PostgreSQL 17 and Redis 7.
Statistics and leaderboards are read models built from solve events (a transactional outbox
relayed to Redis Streams).

| Service | Role |
| --- | --- |
| `auth` | accounts, password and OAuth sign-in, settings |
| `scramble` | random-state scrambles (cubing.js) |
| `solve` | sessions and solves, the event outbox |
| `stats` | personal bests, streaks and activity |
| `leaderboard` | all-time, weekly and daily boards |
| `race` | real-time races (Socket.IO) |
| `wca` | WCA rankings and comparisons |

Production runs on one VM with Docker Compose behind a Cloudflare Tunnel, and the same images run
on Kubernetes.

## Development

Requires Docker and Node 22.

```bash
docker compose up --build -d            # the whole stack on http://localhost:8080
npm install && npm test                 # services and packages
cd web && npm install && npm run dev    # the web app, with hot reload
```

`npm run test:integration` adds the database suites, `npm run lint` and `npm run format:check` check the
code. With the stack running, `cd e2e && npm install && npm test` runs the end-to-end tests in a browser:
sign-up, a solve that reaches the leaderboards, a daily attempt, a two-player race, and axe on every main
page (locally in the installed Google Chrome).

## Documentation

- [`docs/SPEC.md`](docs/SPEC.md): the system specification (APIs, schemas and events)
- [`deploy/README.md`](deploy/README.md): the local stack, the WCA data and demo users, and Kubernetes
- [`deploy/vps/README.md`](deploy/vps/README.md): production
- [`SECURITY.md`](SECURITY.md): reporting a vulnerability

## Acknowledgements

- [csTimer](https://github.com/cs0x7f/cstimer) (GPL-3.0): timer behaviour and statistics. The smart
  cube and Bluetooth timer drivers, the cube model and the virtual puzzle in `web/src/input/` are
  derived from its source.
- [cubing.js](https://github.com/cubing/cubing.js): scrambles and puzzle previews.
- [Monkeytype](https://github.com/monkeytypegame/monkeytype): the design language.
- Competition results are owned and maintained by the
  [World Cube Association](https://www.worldcubeassociation.org/results).

## License

[GPL-3.0](LICENSE) © 2026 Koen Kreijkamp
