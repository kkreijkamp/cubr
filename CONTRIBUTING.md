# Contributing

Thanks for wanting to help. cubr is run by one person, so small, focused changes are the easiest to take in.

## Before you start

- **A bug:** open an issue with the bug report form. It asks for the version at the bottom of every page and your browser.
- **An idea or a bigger change:** open an issue first, so we can agree on it before you spend time on code.
- **A security problem:** please don't open an issue; [SECURITY.md](SECURITY.md) says how to report it privately.

## Running it

Requires Docker and Node 22.

```bash
docker compose up --build -d            # the whole stack on http://localhost:8080
npm install && npm test                 # services and packages
cd web && npm install && npm run dev    # the web app, with hot reload
```

- `npm run test:integration` adds the database suites (a throwaway Postgres and Redis).
- `cd web && npm test` runs the web app's tests.
- With the stack running, `cd e2e && npm install && npm test` runs the end-to-end tests and axe in a browser
  (locally the Google Chrome you have installed).
- [`deploy/README.md`](deploy/README.md) explains the local stack, its demo users and the WCA data;
  [`docs/SPEC.md`](docs/SPEC.md) is the system's specification.

## Making a change

- Branch from `dev` and open the pull request against `dev`. `main` is what runs on cubr.dev.
- Keep the look: cubr is minimal, in Monkeytype's spirit. Refine what's there rather than adding new kinds of
  widgets.
- Everything works from the keyboard and with a screen reader. axe checks the main pages in CI.
- Before you push: `npm run lint` and `npm run format:check` (`npm run format` fixes the layout),
  `npm run typecheck` in the root and in `web/`, and the tests for what you changed. CI runs all of them, builds
  the images and runs the end-to-end tests.
- If you change an API, an event or a database schema, update `docs/SPEC.md` in the same pull request.

## Commits

A short subject with a scope, as in the history (`fix(web): ...`, `feat(solve): ...`, `docs(ops): ...`), and a
body that says why.

## Licence

cubr is free software under the [GNU GPL v3](LICENSE). By contributing, you agree that your contribution is under
the same licence.
