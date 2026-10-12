# cubetype web — frontend guide

The web app should feel like **Monkeytype for cubers** — minimal, fast, keyboard-first, beautiful
in every theme — with **csTimer's depth** (WCA inspection, penalties, aoN stats, sessions, import).
The API contracts it talks to are in `docs/SPEC.md` §9.

## Stack & layout
React 18 + TypeScript + Vite, react-router 6, lucide-react icons, Roboto Mono / Lexend Deca
(bundled via @fontsource). `@cubetype/cubestats` (shared with the backend, imported from
`packages/cubestats/src` through a Vite alias) provides averages, formatting and event metadata.
The web app is not an npm workspace: it has its own `package.json` and lockfile in `web/`.

```
web/src/
  main.tsx, App.tsx              # entry, router (every page renders inside <Layout/>)
  styles/global.css              # design system — read it, reuse its classes
  components/Layout.tsx          # header nav, footer
  components/CubeLogo.tsx        # the logo
  pages/NotFoundPage.tsx         # fallback route
```

## Design rules
1. **Only theme tokens for colour** (`var(--bg-color)`, `--main-color`, `--sub-color`, `--sub-alt-color`, `--text-color`, `--error-color`…), defined at the top of `global.css`. Never hard-code colours: a theme is just another set of values for these tokens, so a hard-coded colour breaks in every other theme.
2. **Monkeytype typography:** lowercase UI labels; labels in `--sub-color` small, values in `--main-color` big (`.stat .label/.value`); one font (`var(--font)`); `font-variant-numeric: tabular-nums` for times.
3. **Reuse global.css classes** — `.btn`, `.btn-text`, `.btn.active`, `.option-group`, `.card`, `.stat`, `.pill`, `.h2/.h3`, `.row/.stack`, `.field`, `.empty`, `[data-tip]` tooltips, `kbd` — instead of restyling. Put page-specific CSS in a co-located `*.css` file imported by the page, using the tokens.
4. **Colour-only hover transitions (125 ms)**, no bouncy transforms. Icons from lucide-react at 16–20 px.
5. **Every async view has loading, empty (`.empty`) and error states.** A down microservice must degrade only its own widget, never blank the page; the timer must keep working with **all** backends down.
6. **Responsive** down to 360 px wide; touch works.
7. **Keyboard-first:** every action reachable from the keyboard, with visible `kbd` keytips where relevant.
8. Accessibility basics: buttons are `<button>`, icons have aria-labels, focus-visible rings come from global.css.
9. Times: format with cubestats (`formatTime`). Averages from the API: `-1` = DNF, `null` = n/a (`fromApiValue` in cubestats converts them).

## Development
- `cd web && npm install && npm run dev` serves the app on http://localhost:5173 with hot reload.
  The dev server proxies `/api` to the gateway at http://localhost:8080 (`docker compose up -d`
  from the repo root; another target via `CUBETYPE_GATEWAY=…`). Pages must still render, with
  their error states, when the backend isn't running.
- `npm run typecheck` (tsc) and `npm run build` (tsc + vite build) must pass.
- Check new UI at desktop width and at phone width (390 × 844).
