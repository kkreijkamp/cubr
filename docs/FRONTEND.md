# cubetype web — frontend guide

The web app should feel like **Monkeytype for cubers** — minimal, fast, keyboard-first, beautiful
in every theme — with **csTimer's depth** (WCA inspection, penalties, aoN stats, sessions, import).
The API contracts it talks to are in `docs/SPEC.md` §9.

## Stack & layout
React 18 + TypeScript + Vite, react-router 6, chart.js 4, cubing.js `<twisty-player>`,
socket.io-client, lucide-react icons, Roboto Mono / Lexend Deca (bundled via @fontsource).
`@cubetype/cubestats` (shared with the backend, imported from `packages/cubestats/src` through a
Vite alias) provides averages, formatting, events and the import/export readers (cubetype, csTimer and every timer csTimer imports). The web app is not an npm
workspace: it has its own `package.json` and lockfile in `web/`.

```
web/src/
  main.tsx, App.tsx              # router (pages are lazy-loaded, timer is eager)
  styles/global.css              # design system — read it, reuse its classes
  lib/api.ts, lib/types.ts       # typed client for every endpoint (never call fetch directly); requests time out (plain GETs after 15 s)
  lib/auth.tsx                   # useAuth(): {status, user, login, register, logout, setUser}; onAuthChange()
  lib/settings.ts                # useSettings(), updateSettings(patch) (persisted + synced to account)
  lib/themes.ts                  # THEMES, applyTheme, themeLabel, cssVar
  lib/toast.ts                   # toast.success/error/notice/pb(message)
  lib/commands.ts                # useRegisterCommands(source, () => Command[], deps) → command palette
  lib/solves.ts                  # solve store: sessions & solves, local (guest) mode + cloud sync
  lib/race.ts                    # socket.io client for race rooms
  lib/store.ts                   # createStore/useStore, loadJson/saveJson
  lib/useAsync.ts                # useAsync(signal => promise, deps) → {data, error, loading, reload}
  lib/format.ts                  # formatTime, formatSolve, formatDate(Time), timeAgo, flagEmoji, utcDateKey, formatNumber, formatPercent
  lib/chunkReload.ts             # isChunkLoadError, reloadForNewRelease (once per 10 s) for tabs left open across a web rollout
  components/Layout.tsx          # header nav, footer (theme switcher, version from /_info), toasts, palette, guest-upload offer
  components/RouteError.tsx      # route errorElement: reloads when a page's chunk is gone after a rollout, else shows the error
  components/Modal.tsx           # <Modal title onClose wide center>
  components/Spinner.tsx         # <Spinner/>, <Loading/>, <ErrorState error onRetry/>
  components/ChartCanvas.tsx     # <ChartCanvas config height/>, useThemeColors(), themedScales()
  components/TwistyPreview.tsx   # <TwistyPreview puzzle scramble visualization height/> (lazy cubing/twisty)
  components/Avatar.tsx          # profile picture, or the initial in a main-colour circle
  components/timer/              # timer page parts: config bar, scramble bar, stats panel, solve list, dialogs, charts
  components/social/             # profile, leaderboard, account and about widgets
  components/live/               # daily challenge, race, WCA and cluster status widgets
  timer/useTimerEngine.ts        # the timer state machine (space/touch, hold, WCA inspection, penalties)
  timer/TimerDisplay.tsx         # the big animated time display
  timer/storeUtils.ts            # pure helpers of the solve store (ids, queue, codecs, import chunks)
  pages/*Page.tsx                # one component per route
```

`lib/auth.tsx` keeps the last signed-in user, so the app stays signed in (and the solve store in
cloud mode) while the auth service is unreachable; only a 401 signs out.

## Design rules
1. **Only theme tokens for colour** (`var(--bg-color)`, `--main-color`, `--sub-color`, `--sub-alt-color`, `--text-color`, `--error-color`…), defined at the top of `global.css`. Never hard-code colours (exception: the `--timer-ready` green): a theme is just another set of values for these tokens. Check your page in a light theme (serika, solarized_light) too.
2. **Monkeytype typography:** lowercase UI labels; labels in `--sub-color` small, values in `--main-color` big (`.stat .label/.value`); one font (`var(--font)`); `font-variant-numeric: tabular-nums` for times.
3. **Reuse global.css classes** — `.btn`, `.btn-text`, `.btn.active`, `.option-group`, `.config-card`, `.card`, `.stat`, `table.table` (odd rows sub-alt, `tr.me` main colour), `.pill`, `.h2/.h3`, `.row/.stack`, `.field`, `[data-tip]` tooltips, `.empty`, `kbd` — instead of restyling. Put page-specific CSS in a co-located `*.css` file imported by the page, using the tokens.
4. **Colour-only hover transitions (125 ms)**, no bouncy transforms. Icons from lucide-react at 16–20 px.
5. **Every async view has loading, empty and error states** (`<Loading/>`, `.empty`, `<ErrorState/>` with retry). A down microservice must degrade only its own widget, never blank the page. The timer must keep working with **all** backends down (guest/local mode + client fallbacks).
6. **Responsive** down to 360 px wide; touch works (timer: tap/hold the timer area).
7. **Keyboard-first:** palette commands for page actions; visible `kbd` keytips where relevant; Space must never activate a focused button on the timer page.
8. Accessibility basics: buttons are `<button>`, images/icons have aria-labels, focus-visible rings come from global.css.
9. Times: use `formatTime`/`formatSolve` with the user's `settings.precision`. Averages from the API: `-1` = DNF, `null` = n/a (`fromApiValue` in cubestats converts to Infinity/null).

## Development
- `cd web && npm install && npm run dev` serves the app on http://localhost:5173 with hot reload.
  The dev server proxies `/api`, `/socket.io` (WebSockets) and `/_info` to the gateway at
  http://localhost:8080 (`docker compose up -d` from the repo root; another target via
  `CUBETYPE_GATEWAY=…`). Pages must still render, with their error states, when the backend isn't
  running.
- `npm run typecheck` (tsc), `npm test` (vitest over `src/**/__tests__/*.test.ts`: pure logic such as
  the stats helpers, the store codecs and the fallback scramblers) and `npm run build` (tsc + vite
  build) must pass; CI runs all three.
- Check new UI at desktop width, at phone width (390 × 844) and in a light theme.
- `web/Dockerfile` builds the app with `npm run build` and serves `dist/` from unprivileged nginx
  (uid 101, port 8080): SPA fallback, long-lived caching for hashed assets, a static `/_info` for the
  status page, and JSON 404s for unknown `/api/*` and `/internal/*` paths.

## Page specs

### Timer `/` — the hero page
Layout (desktop, centred, max ~1100 px): **config bar** (fade-on-focus): event card (16 events, short names, active = main) · session card (select current session for this event, + new, rename, merge, delete) · toggles card (inspection, manual entry). **Scramble** (fade-on-focus): large mono text (size adapts to length; megaminx keeps newlines with `white-space: pre-line`), actions: new scramble (Tab), previous/next scramble, copy, edit/enter custom scramble. **Timer** (hero, centre, `TimerDisplay`, touch area). Under the timer (fade-on-focus): quick actions for the last solve (OK / +2 / DNF / comment / delete) and keytips. **Bottom area** (three columns, collapses on mobile): stats panel (rows = settings.statsShown + count/mean/σ, columns current/best; click an average → modal listing its solves), scramble preview (`TwistyPreview`, settings.scramblePreview), solve list (newest first, index, time with penalty, click → solve modal: time, penalty buttons, scramble + copy, comment, date, delete). **Charts** (settings.showCharts): trend (times as points + ao5/ao12 lines, Chart.js styled like Monkeytype's history chart: primary main 3px, secondary main+99 2px, points r 2) and histogram.
Behaviour: `useTimerEngine` with settings (inspection, holdMs, inspectionAlerts) — inspection only for events that have it (not for blindfolded events and FMC) — and `enabled` false while a modal/palette is open or in manual-entry mode. Focus mode: add `focus` class to `document.body` while running/inspecting if settings.focusMode; remove on stop. Scrambles: keep a queue of 5 from `api.scrambles.get(event, 5)`; fall back to a simple client-side random-move scrambler (per puzzle, marked "offline scramble" in sub colour) if the service is down. The browser never imports `cubing/scramble` (it breaks the Vite build); previews load `cubing/twisty` lazily. PB detection after each solve (single/ao5/ao12 vs session bests and previous all-time bests in this session list): `toast.pb('new pb! ao5 12.34')` + `pb` prop on TimerDisplay. Shortcuts (full table on the settings page): Tab new scramble, Alt+←/→ previous/next scramble, Alt+1/2/3 OK/+2/DNF last solve, Alt+Backspace or Alt+Z delete last (confirm per settings.confirmDelete), Alt+C comment, Alt+↑/↓ switch session, Alt+I inspection, Alt+M manual entry, Esc cancels inspection (engine) / opens palette when idle. Palette commands: Event…, Session…, New session, Rename session, Merge sessions…, Delete session, New scramble, Enter custom scramble, Copy scramble, Penalty last solve…, Comment last solve, Delete last solve, Show/hide charts, Show/hide solve list, Manual entry, Turn inspection on/off. Manual entry mode: input box replaces timer (Enter submits, `parseTimeInput`; an invalid time shakes and keeps focus). Show `pending`/`syncError` from the solve store subtly (cloud-off icon "3 unsynced"). Remember last event (settings.lastEvent). Guest banner (subtle): "sign in to save solves to the cloud, appear on leaderboards and race".
Solve store (`lib/solves.ts`): local mode in localStorage (`cubetype.local.v1`; a corrupt copy is backed up, a full storage is reported instead of losing solves), cloud mode via api.sessions/solves with optimistic updates + a persistent retry queue (`cubetype.queue.v1`, backoff, retry on `online`) and a cache of the last cloud session for offline reloads; changes in other tabs are picked up; switches mode on `onAuthChange`. After login, if guest solves exist, the layout offers to upload them via api.sessions.import and then clears the local copy.

### Settings `/settings`
Monkeytype settings page: quick-nav pills (timer, inspection, display, stats, theme, data, shortcuts, danger zone), sections with `.h3` title + description left / controls right (`.option-group` buttons). Settings: hold time, timer update mode, precision, timer size, focus mode, inspection on/off, inspection alerts, scramble preview off/2D/3D, show solve list, show charts, font, stats shown (toggle chips mo3 ao5 ao12 ao25 ao50 ao100 ao200 ao500 ao1000), confirm delete, PB sound. Theme section: search, dark/light/originals filters, random pick and a grid of theme tiles (tile bg = theme bg, name in theme text colour, main-colour dot); hovering previews (applyTheme(name,false)), click selects, mouse-leave restores. Data: import (`parseTimerFile`: cubetype, csTimer and every format csTimer imports), JSON and csTimer export. Keyboard shortcuts reference table. Danger zone: clear guest data, reset settings (confirm modals).

### Login `/login`
Two cards side by side (stack on mobile): register (username, email, password, verify password; client-side validation mirroring the SPEC §5 limits) and login (username or email, password). Show API errors inline (409 username/email taken, 401 wrong credentials, 429). On success → navigate to `?next=` or `/account`. Logged-in visitors get redirected to /account.

### Account `/account` & Profile `/profile/:username`
Shared `ProfileView` (components/social) for both; account adds edit + data tools. Sections: header card (profile picture or initial, username/displayName, country flag, "joined …", streak current/longest, total solves, total time cubing, linked WCA id → /wca person), leaderboard ranks card (api.leaderboards.userRanks: "#12 · 3x3 single"), PB cards per event the user has solves in (single / mo3 / ao5 / ao12 / ao50 / ao100 with dates on hover), activity heatmap (last 365 days from api.stats.activity; Monkeytype bucketing algorithm: trim top/bottom 10 %, mean m, thresholds floor(m/2), round(m), round(1.5m)), "N solves in the last 12 months" title, **solve history chart** (event selector; api.stats.solves: every solve as a point, toggleable rolling ao5 … ao1000 and single-PB lines, filter by session, by-date mode), time-of-day chart (api.stats.hourly bar chart: solves + mean), **WCA comparison** (for each PB single/ao5 of WCA events: "you'd rank #X in the world · top Y%" via api.wca.rank (kind average for ao5), plus a distribution chart of all WCA competitors with a vertical marker at your PB via api.wca.distribution; if wcaId linked, show official PBs side by side via api.wca.person). Account-only: edit profile modal (displayName, bio, country select with flags, WCA ID with format validation, profile picture with an in-browser crop editor that uploads a small WebP/JPEG), **data**: import solves (file input → bytes → `parseTimerFile`, which detects cubetype, csTimer JSON/CSV, Twisty Timer, Cubic Timer, Block Keeper, CubeDesk, DCTimer text/SQLite, mateus Cubetimer and GAN CubeStation → preview with format, sessions/solve counts/events and skipped multi-blind or invalid solves → confirm → `importSessions` from lib/solves → toast + summary), export for csTimer (`toCsTimerExport`, starts with `{"session1"` for csTimer's "import session(s) from other timers"), export JSON (`exportAll` → download `cubetype-export-YYYY-MM-DD.json`), logout. Unknown username → friendly 404.

### Leaderboards `/leaderboards`
Monkeytype layout: left sidebar of button groups — period (all-time, weekly, daily, daily challenge), kind (single, ao5, ao12 — hide ao12 for weekly/daily; challenge = ao5), events (short names; only events with timed results, so no FMC; the daily challenge only offers its five events), date (daily challenge: the last 7 UTC days); main: title ("all-time 3x3 single leaderboard"), subtitle (UTC day/week for daily/weekly), "your rank" card when logged in (`me`), pagination (first, prev, page n of m, next, jump to my page; ←/→ keys), table: # (crown icon for #1), name (profile picture, flag + username → /profile/:username), time (formatTime), date (formatDate + timeAgo tooltip). 50 per page. Sync selection to URL query (`?event=333&kind=single&period=all&page=1`). Empty state "no entries yet ¯\\_(ツ)_/¯".

### About `/about`
What cubetype is (csTimer + Monkeytype), feature list, live global counters (api.stats.global: users, solves, hours cubed, solves today — animated count-up), an **architecture diagram** as a themed inline SVG (browser → Google Cloud Load Balancer/Ingress → web + 7 microservices on GKE → PostgreSQL (CloudNativePG, primary+replica) & Redis (streams, cache, leaderboards); arrows for the event bus solve → stats/leaderboard), tech stack list, keyboard shortcuts, credits (csTimer, Monkeytype, cubing.js, WCA) and the WCA data citation.

### Daily challenge `/daily`
Today's UTC challenge (api.scrambles.daily): event tabs (DAILY_EVENTS), progress strip of 5 attempts (scramble 1..5 with times), current scramble + TwistyPreview, timer (useTimerEngine/TimerDisplay; inspection per settings). Logged in: each solve → `addSolve({..., source:'daily', daily:{date, index}, sessionId: (await ensureSession(event)).id})` from lib/solves (or api.solves.create directly if the store isn't ready); every scramble counts once — a submitted attempt can't be redone, even after deleting the solve. Resume progress from api.solves.daily(date); after 5: big ao5 result, rank on today's challenge board (api.leaderboards.dailyChallenge) shown beside it with your row highlighted. Guests: can practise the scrambles but see "sign in to submit". Countdown to the next challenge (UTC midnight). Past days: the last 7 days (leaderboard view only).

### Race `/race`, `/race/:roomId`
Lobby: list public rooms (api.race.rooms, poll 5 s; name, event, players, status), create room (name, event, private toggle) → navigate, join by code, guest nickname (stored in localStorage `cubetype.guestName`, guest id `cubetype.guestId` = `guest-<random>`). Room: `lib/race.ts` wraps socket.io-client (`io({ path: '/socket.io', transports: ['websocket'], auth: { token, name, guestId } })`, auto-reconnect → re-emit room:join; a `room:state` with a lower `rev` than the last one is ignored). Show: room name/event, invite link copy, "connected via pod <servedBy>" (from the join ack — demo of WebSocket load balancing), players list with live status dots (idle/inspecting/solving/done, disconnected greyed), current round scramble + preview, timer enabled only while a round is running and you haven't submitted (emit player:status on inspection start / solve start / done; emit player:result on solve; a result that couldn't be sent is re-sent after reconnecting), host button "next round" (Enter/N), results grid (rounds × players, best per round in main colour), standings (wins, mean, ao5), chat (≤200 chars). Optionally save your race solves into your session via `addSolve({source:'race'})` (toggle in the room, remembered in localStorage).

### WCA `/wca`
Tabs: **where would I rank?** (event select, single/average toggle, time input via parseTimeInput (moves for FMC), optional country select → api.wca.rank: big "#4,321 in the world · faster than 87.2 %" + country rank + neighbours list (names, flags, times) + distribution chart with a marker at your time); **records** (api.wca.records table: event, single + holder + flag, average + holder); **people** (debounced search api.wca.persons → click → person card with PBs and world/continent/country ranks). Footer: WCA citation with export date from api.wca.meta. If the API returns 503 UNAVAILABLE show "WCA data is being imported — try again in a minute".

### Cluster status `/status` — the live demo centrepiece
Purpose: make Kubernetes behaviour visible during the demo. Poll every service's `_info` (`SERVICE_INFO_PATHS`, `api.info(path)`) every 1 s (pause when tab hidden). Per service card: status dot (up/down/degraded), version, pod name (and node), uptime, deps (postgres/redis ok/down), latency (a slow pod shows as a timeout, not as down); **pods seen in the last 30 s** (distinct `pod` values with hit counts and version, newest highlighted) — during a scale-out new pods appear, during a rolling update each version gets its own colour, when a pod is deleted it disappears. An **event log** (pods appearing/disappearing, version changes, services going down and recovering) and a **node map** (which pods run on which node). A **load-balancing test** panel: pick a service, fire N (10/50/100) parallel requests to its `_info`, show a horizontal bar chart of responses per pod. A **CPU burst** panel: M parallel workers request fresh 4x4 scrambles (`/api/scrambles/444?count=5&fresh=1`) back to back for 30/60/120 s (with a stop button) to drive the scramble HPA. A small kubectl cheatsheet for the demo. A summary header: total pods seen, versions seen, all-services-healthy indicator. Monospace, dense, beautiful.
