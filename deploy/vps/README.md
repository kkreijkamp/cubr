# cubr production: one VM behind a Cloudflare Tunnel

https://cubr.dev runs the same Docker Compose stack as local development, on one GCP e2-small
(`cubr-1`, project `cubr-app`, australia-southeast1-a). Nothing on the VM is reachable from the
internet: cloudflared dials out to Cloudflare, Cloudflare terminates HTTPS for cubr.dev and sends
requests through the tunnel to the gateway. SSH works only through Google's IAP tunnel.

```
visitor --HTTPS--> Cloudflare edge --tunnel--> cloudflared --> gateway (nginx) --> services
                                                (VM, compose network; Postgres + Redis on the VM)
```

Files here:
- `bootstrap.sh`: host setup.
- `compose.prod.yml`: production override of `docker-compose.yml`.
- `release.sh`: build a release from its tag, then deploy it.
- `deploy.sh`: copy, pull and restart.
- `.env.example`: what `/opt/cubr/.env` holds.

## Everyday: ship a release (only `main` runs in production)

Work happens on `dev`; every commit gets a patch version and tag from the hooks. A release:

1. Bump the version on `dev`: `scripts/bump-version.sh 1.2.0`, then add the patch notes for it in
   `web/src/content/patchNotes.ts` and commit. The hooks tag it `v1.2.0`.
2. Open a pull request `dev` → `main` and merge it with a merge commit, so the tag lands on main.
3. `deploy/vps/release.sh` (~3 min).

`release.sh` refuses any version whose tag isn't on `origin/main`, builds the images on Cloud
Build from the tag itself (`git archive`, never the working tree), then runs `deploy.sh`.
`deploy.sh` makes the same main-only check, copies the compose files and gateway config from the
tag to `/opt/cubr`, pulls the images, sets `CUBR_VERSION`, restarts what changed, waits for the
health checks, then checks the gateway. A changed gateway config means recreating the gateway (a second or two), which deploy.sh
does by itself: its `nginx.conf` is a single-file mount, and a running container never sees the release's
new copy of the file (found with 1.5.0, whose gateway kept the 1.4.0 routing until recreated).

Roll back to an earlier release with `deploy/vps/deploy.sh 1.1.0`. Its images are still in
Artifact Registry; if they aren't, use `release.sh 1.1.0`.

## Operating

```sh
gcloud compute ssh cubr-1 --configuration=cubr --tunnel-through-iap      # shell on the VM
cd /opt/cubr && C="docker compose -f docker-compose.yml -f deploy/vps/compose.prod.yml"
$C ps            # health of every service
$C logs -f gateway                         # access log with real visitor IPs
$C logs auth | grep '"client error"'       # errors in visitors' browsers (SPEC 10.5; no IPs)
$C logs auth | grep '"feedback'            # the feedback form: sent, or why not (SPEC 10.6; the messages are in hello@cubr.dev)
$C exec postgres psql -U cubr -d cubr      # database shell
$C --profile jobs run --rm wca-import      # refresh the WCA data now (~3 min)
```

The gateway is also on the VM's `127.0.0.1:8080`, so `curl http://127.0.0.1:8080/healthz`
works over SSH. Docker restarts crashed containers and starts the stack on boot
(`restart: unless-stopped`).

## Dependencies (the supply-chain guards, 2026-11-26)

- **No install scripts:** `.npmrc` and `web/.npmrc` set `ignore-scripts=true` (the 2025 npm worms spread
  through them). esbuild and fsevents work without theirs. A new dependency that needs its script runs
  it by hand (`npm rebuild <package>`), after reading it.
- **Only versions a week old:** Dependabot (`.github/dependabot.yml`, read from `main`) opens weekly,
  grouped PRs onto `dev` with a 7-day cooldown. By hand: `npm install <pkg> --before "$(date -v-7d +%F)"`
  (npm 10 has no `min-release-age`; npm 11.10+ does).
- **CI:** `npm audit --omit=dev --audit-level=high` fails the build; actions are pinned to commit SHAs;
  Trivy scans the scramble and auth images (it reports without failing until its first reports are
  clean, then drop `continue-on-error`).

## Rotating keys

The VM's secrets are in `/opt/cubr/.env` (mode 600; edit with `sudo -e` or `nano` on the VM); the
Mac keeps copies in the keychain (`cubr-...` items). After a change, recreate what reads it:
`$C up -d <services>` (compose reads `.env` again). Rotate after anyone else had access, after a
leak, and otherwise about once a year.

- **JWT_SECRET** (signs sign-in tokens; every service checks them), without signing anyone out:
  1. `openssl rand -base64 48` for the new key.
  2. In `.env`: `JWT_SECRET_PREVIOUS=` the current key, `JWT_SECRET=` the new one.
  3. `$C up -d auth solve stats leaderboard race`. New tokens use the new key; old ones still work.
  4. 30 days later (a token's lifetime), remove `JWT_SECRET_PREVIOUS` and recreate the same services.
  - **Leaked?** Skip step 2's `JWT_SECRET_PREVIOUS`: everyone is signed out at once and signs in again.
  - Race guests' ids are made with it too: guests in a room during the switch come back as new players.
- **INTERNAL_API_TOKEN** (service to service, never public): `openssl rand -hex 32`, then `$C up -d`
  (every service at once; calls between them fail for the seconds they restart).
- **POSTGRES_PASSWORD:** `$C exec postgres psql -U cubr -c "ALTER USER cubr PASSWORD '<new>'"`, then
  set it in `.env` and `$C up -d` (everything with a `DATABASE_URL`, the backup timer's job included).
- **Google and GitHub client secrets** (no sign-out: each provider keeps the old secret until you delete
  it). Google Cloud console > APIs & Services > Credentials > cubr's OAuth client > Add secret; GitHub >
  Settings > Developer settings > OAuth Apps > cubr > Generate a new client secret. Put it in `.env`
  (`GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`) and the keychain (`cubr-google-client-secret`,
  `cubr-github-client-secret`), `$C up -d auth`, sign in with it once, then delete the old secret.
- **RESEND_API_KEY:** Resend > API Keys > Create, with sending access for cubr.dev only. Put it in
  `.env` and the keychain (`cubr-resend-api`), `$C up -d auth`, send yourself a reset email, then
  delete the old key.
- **KOFI_VERIFICATION_TOKEN:** Ko-fi > Settings > API > the webhook's token: new one into `.env` and the
  keychain (`cubr-kofi-token`), `$C up -d auth`.
- **CLOUDFLARE_TUNNEL_TOKEN:** Zero Trust > Networks > Tunnels > cubr > refresh its token (or by API: a
  new `tunnel_secret` with `PATCH /accounts/<account>/cfd_tunnel/<id>`, then
  `GET .../cfd_tunnel/<id>/token`). Into `.env`, then `$C up -d cloudflared`; the site is away for the
  seconds it reconnects (the down page covers it).
- **The Cloudflare API token on the Mac** (`cubr-cloudflare-api`): My Profile > API Tokens > Roll, then
  `security add-generic-password -U -s cubr-cloudflare-api -a cubr -w` (it asks for the value).

## Security headers and crawler files

The web container sends a Content-Security-Policy and the other security headers on every page, and
every service sends the API's set (docs/SPEC.md 10.2 and section 3). Check them after a release:

```
curl -sI https://cubr.dev/ | grep -i -E 'content-security|x-frame|nosniff|strict-transport|permissions'
curl -s -o /dev/null -w '%{http_code}\n' https://cubr.dev/no/such/page     # 404
curl -s https://cubr.dev/robots.txt; curl -s https://cubr.dev/.well-known/security.txt
```

- **A page that breaks after a change** (something doesn't load or run): the browser console says
  which directive refused what. The inline theme script in `web/index.html` is allowed by its hash;
  `web/src/__tests__/site.test.ts` fails until the hash in `web/nginx/default.conf.template` matches.
- **security.txt expires** (its `Expires`, now 2027-11-16): the same test fails 30 days before. Move
  the date up to a year ahead and release.
- **Outside checks** (paste the site into them): MDN HTTP Observatory, securityheaders.com and
  Google Search Console (the sitemap, and the 404s it finds).

## The offline app (service worker)

cubr installs as an app and works offline: a service worker (`web/src/sw/`, docs/SPEC.md 10.1)
caches the web app in each visitor's browser. What that means for releases:

- **Browsers check `/sw.js` on every page load.** The web container sends it with
  `Cache-Control: no-cache`, which Cloudflare passes on because the zone's Browser Cache TTL is
  "Respect Existing Headers" (since 2026-11-26; Cloudflare's default, 4 hours, turned it into
  `max-age=14400`). Check it with `curl -sI https://cubr.dev/sw.js`.
- **After a release that changes the web app,** open pages show "update ready". The new version
  applies when the notice is clicked or on the next link click inside the app, never by itself.
  A tab that's never reloaded keeps running the previous version, so **keep API changes backward
  compatible for one release.**
- **A release that doesn't change the web app** builds the same `sw.js`, so nobody sees a notice.
- **Kill switch** (if the worker itself misbehaves): in `web/Dockerfile`, change
  `ARG VITE_SW=on` to `off` and release. Each browser removes the worker and its caches on its
  next visit and reloads from the network. Switch it back on in a later release.

## Sign-in providers (Google, Apple, GitHub)

"Continue with Google / Apple / GitHub" (services/auth/README.md) needs an app registered with each
provider. A provider stays off, with no button on the site, until all of its values are in
`/opt/cubr/.env`. After changing them, recreate the auth container and check:

```sh
$C up -d auth                                        # on the VM: picks up the new .env values
curl -s https://cubr.dev/api/auth/oauth/providers    # {"providers":["google",...]}
```

The redirect (callback) URLs to register, exactly:
`https://cubr.dev/api/auth/oauth/google/callback`, `.../apple/callback`, `.../github/callback`.

- **Google** (free). In the Google Cloud console (project `cubr-app`), open Google Auth Platform.
  1. Branding: app name `cubr`, support email `hello@cubr.dev`, home page `https://cubr.dev`,
     privacy policy `https://cubr.dev/privacy`, terms `https://cubr.dev/terms`, authorised
     domain `cubr.dev`. Skip the logo: adding one needs Google's brand review first.
  2. Audience: External, then publish the app. While it is in testing, only listed test users
     can sign in.
  3. Data access: only `openid`, `email` and `profile`. These need no Google verification.
  4. Clients: create a "Web application" client with the Google redirect URL above. No
     JavaScript origins are needed: the server runs the flow. Copy the client secret right away,
     because newer clients don't show it again. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- **GitHub** (free). Go to Settings, Developer settings, OAuth Apps, New OAuth App. Use name
  `cubr`, home page `https://cubr.dev` and the GitHub callback URL above. Leave device flow off.
  Generate a client secret, then set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
- **Apple** needs a paid Apple Developer Program membership (US$99 a year). In Certificates,
  Identifiers & Profiles:
  1. An App ID (an explicit bundle id such as `dev.cubr.app`) with Sign in with Apple enabled.
  2. A Services ID (for example `dev.cubr.signin`) with the description `cubr`, which people see
     when they sign in. This is `APPLE_CLIENT_ID`. Enable Sign in with Apple on it and configure
     it with the App ID above as primary, domain `cubr.dev` and the Apple return URL above. If
     Apple asks to verify the domain, it gives a file to serve at
     `/.well-known/apple-developer-domain-association.txt` (add it to `web/public/.well-known/`).
  3. A key with Sign in with Apple enabled, linked to the App ID. Download the `.p8`: Apple
     allows one download only. Its id is `APPLE_KEY_ID`. The team id at the top right is
     `APPLE_TEAM_ID`. `APPLE_PRIVATE_KEY` is the `.p8` on one line, with line breaks written
     as `\n`: `awk 'NF {printf "%s\\n", $0}' AuthKey_XXXXXXXXXX.p8`.
  4. People who pick "Hide My Email" get an `@privaterelay.appleid.com` address, and Apple
     forwards only mail from registered senders. Under Services, "Sign in with Apple for Email
     Communication", register `cubr.dev` and `no-reply@cubr.dev`. Without that, their
     password-reset emails don't arrive; signing in with Apple still works.

Accounts made with a provider have no password until they use "forgot password?". The site never
connects a provider to an existing account by matching emails. People connect providers
themselves on the account page.

## Backups and scheduled jobs

systemd timers on the VM (installed by `deploy.sh`):
- **`cubr-backup.timer`, nightly 02:30 Brisbane.** Runs `backup.sh`: a `pg_dump` of everything
  except the WCA schemas, checked with `pg_restore --list`, then copied to
  `gs://cubr-app-backups/postgres/` (Melbourne). Copies are deleted after 30 days. The VM can
  add and read backups but not delete them.
- **`cubr-wca-import.timer`, Mondays 04:00 Brisbane.** Refreshes the WCA export (about a minute).
  It runs as root, which has no registry login, so it uses the `wca-import` image already on the VM:
  `deploy.sh` pulls it with every release (it failed on 15 and 22 November 2026, before it did).
  `https://cubr.dev/api/wca/meta` shows the export loaded (`exportDate`, `importedAt`).

```sh
systemctl list-timers 'cubr-*'                         # next runs
sudo systemctl start cubr-backup.service               # back up now
sudo systemctl start cubr-wca-import.service           # refresh the WCA data now
sudo journalctl -u cubr-backup.service -n 20           # last result (sudo: the journal is root's)
gcloud storage ls -l gs://cubr-app-backups/postgres/   # what's stored
```

Restore: copy a dump to the VM, then
`$C exec -T postgres pg_restore -U cubr -d cubr --clean --if-exists < cubr-<date>.dump`,
and run the WCA import.

**The restore drill, every three months** (`deploy/vps/restore-drill.sh`, run from the Mac over SSH; it
only reads production): last night's backup into a throwaway Postgres with no network, timed, row
counts beside the live ones, then removed.
```sh
gcloud compute ssh cubr-1 --zone australia-southeast1-a --configuration=cubr --tunnel-through-iap --command 'bash -s' < deploy/vps/restore-drill.sh
```
- **2026-11-26:** the 2026-11-25 16:30 UTC backup (396 KB): fetched in 2 s, Postgres up in 3 s,
  restored in 1 s, no errors; users, sign-in links and sessions equal to live, solves and daily
  attempts short by exactly those made since. Next: about 2027-02-26.

## Daily reminders (Web Push)

People who turn them on (settings, signed in) get a notification for the daily challenge at the hour
they pick (10:00 their time unless changed), unless they've already played that day. The solve service
sends them through each browser's own push service (Google's for Chrome and Edge, Mozilla's for Firefox,
Apple's for Safari and installed iPhone apps); the message is encrypted for that browser.
- **Keys:** `deploy.sh` makes the VAPID pair on the VM the first time (`deploy/vps/vapid-keys.mjs`,
  `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in `/opt/cubr/.env`). New keys end every subscription:
  people would have to turn reminders on again, so keep them unless the private key leaked (then delete
  both lines and deploy).
- **Watching it:** `$C logs solve --since 24h | grep 'daily reminders'` (a line per pass that sent
  something: sent, played, gone, failed). `SELECT count(*) FROM solve.push_subscriptions;` counts the
  browsers that have them on.

## Alerts and logs

- **Site down:** an uptime check emails you ("cubr.dev is down").
- **Everything else** (since 2026-11-26): `cubr-watch.timer` runs `deploy/vps/watch.sh` every 15 minutes.
  It checks the disk (80 % full), the services' containers (not running, unhealthy, restarted),
  a burst of 5xx from the gateway (20 in 15 minutes), the nightly backup (none in 26 hours) and the
  weekly WCA import (none in 8 days). A problem is written to Cloud Logging (log `cubr-watch`,
  severity ERROR), and the alert policy "cubr: something on the VM needs you" emails you, at most
  hourly; the same problems are written again only after 6 hours.
  ```sh
  sudo journalctl -u cubr-watch.service -n 20      # what it found (the VM)
  sudo systemctl start cubr-watch.service          # check now
  gcloud logging read 'logName="projects/cubr-app/logs/cubr-watch"' --configuration=cubr --limit 5
  ```
  It needs the VM's service account to hold `roles/logging.logWriter` (granted 2026-11-26).
- **Logs** (visitors' IP addresses are in the gateway's): the VM's journal keeps at most 14 days and
  500 MB (`deploy/vps/journald.conf`, installed by `deploy.sh`), and the containers log to it
  (`compose.prod.yml`), so the same limit holds for them. `$C logs <service>` reads them as before.

## Moderation

When someone reports a profile or a race room (an email to hello@cubr.dev from its flag link) or
eSafety sends a removal notice (they usually expect action **within 24 hours**), act from the Mac with
`deploy/vps/moderate.sh` (docs/SPEC.md "Moderation"). Each command is one call to a service's
`/internal/moderation` route, made inside that service's container on the VM with its own internal
token; `/internal` is never routed publicly. Look before acting:

```sh
deploy/vps/moderate.sh show <username>                  # name, bio, picture, private, suspended (email masked)
deploy/vps/moderate.sh rename <username> <new-username>  # an abusive username
deploy/vps/moderate.sh clear-profile <username>         # its display name and bio
deploy/vps/moderate.sh remove-picture <username>
deploy/vps/moderate.sh clear-chat <room-id>             # a race room's chat, for the players in it too
deploy/vps/moderate.sh suspend <username> [note]        # every session ends, sign-in refused, profile private
deploy/vps/moderate.sh unsuspend <username>             # it can sign in again (the profile stays private)
```

A suspended account keeps its times. Its owner is told "This account is suspended. Questions:
hello@cubr.dev" when signing in. Every action goes into the moderation log, kept 2 years
(`deploy/vps/moderate.sh log [n]`), and into the auth or race log with the account's id
(`$C logs auth | grep moderation`). `--local` first runs a command on the local stack.

**The procedure** (Tier 2 under the online-safety codes, decided 2026-11-26; the terms say it publicly):

1. Acknowledge the report (a short reply from hello@cubr.dev), then look: `show`, the profile, the room.
2. Act within 24 hours when it breaks the terms. Child sexual exploitation, pro-terror, or extreme
   crime, violence or drug material (class 1A and 1B): clear it and `suspend` at once, and keep the
   person out (a new account of theirs gets the same).
3. Tell the reporter what you did, without naming them to the person reported. They can complain to
   eSafety (esafety.gov.au/report) if they aren't happy; the terms say so.
4. Away for more than a day? Put an auto-reply on hello@cubr.dev saying reports may take longer, and
   suspend first, review later.
5. Before a release that adds a social feature (follows, feeds, messages, comments, uploads), redo the
   online-safety self-assessment (`A4/cubr-online-safety-self-assessment-2026-11-26.md`); if the risk
   goes up, tell eSafety.

## Dead letters (events a service couldn't handle)

The services pass events over one Redis stream (docs/SPEC.md section 8). An event a service fails to
handle is retried on its own schedule (a minute, then doubling to every 10 minutes), so an outage of
the service it depends on loses nothing. One that still fails a day after the first failure moves to
the dead-letter stream, with an `event moved to dead-letter stream` error in that service's log
(`$C logs stats | grep dead-letter`). Find the cause in the log, fix it (a release, or the dependency
back up), then put them back for that service alone:

```sh
deploy/vps/dead-letters.sh list stats                   # its dead letters: type, error, attempts, first failure, data
deploy/vps/dead-letters.sh replay stats [id...]         # back on the stream for stats only: all, or those ids
```

The services are `stats`, `leaderboard` and `solve`. A replayed event that fails again starts a new
day of retries. `--local` first runs a command on the local stack.

## How the pieces fit

- **Secrets** live only in `/opt/cubr/.env` (mode 600): `deploy.sh init` generated the Postgres
  password, JWT secret and internal token on the VM; the tunnel token comes from Cloudflare's API.
  Changing `JWT_SECRET` alone signs everyone out ("Rotating keys" keeps the old one valid meanwhile). `RESEND_API_KEY` (only the auth container gets it)
  sends the account emails (password resets, email confirmations, change notices) from
  `cubr <no-reply@cubr.dev>`, with replies going to `hello@cubr.dev`, and the feedback form's messages
  to `hello@cubr.dev`, with replies going to the sender; without it they are only logged.
  To score one, open mail-tester.com and send the reset email to the address it shows, from the repo:
  `RESEND_API_KEY="$(security find-generic-password -s cubr-resend-api -w)" npx tsx scripts/test-email.ts <address>`.
  The sign-in providers' client secrets and Apple's key are there too ("Sign-in providers").
- **Email DNS** (Cloudflare): `cubr.dev` MX to iCloud+ (`hello@cubr.dev`, a custom-domain address),
  SPF for iCloud, Apple's domain TXT and DKIM CNAME (`sig1._domainkey`), `_dmarc` (report-only for
  now: `p=none`, with Cloudflare's DMARC Management address as `rua` since 2026-11-26, so receivers'
  aggregate reports show under Email > DMARC Management), and Resend's records (`resend._domainkey`,
  `send` MX/TXT, `rsend` CNAME). Tighten `p=` once the reports show only iCloud and Resend passing.
- **www.cubr.dev** redirects to `https://cubr.dev` at Cloudflare's edge, with the same path and query
  (301): a proxied `AAAA www 100::` record (no origin) and a Redirect Rule (Rules > Redirect Rules,
  `http.host eq "www.cubr.dev"`). Its requests never reach the VM; the HTTPS certificate covers it as
  `*.cubr.dev`.
- **Login flood guard** at Cloudflare's edge (Security > WAF > Rate limiting rules, the free plan's
  one rule): more than 5 requests to `/api/auth/login` in 10 s from one IP (per Cloudflare data
  centre) are blocked for 10 s with a JSON 429 in the app's error format ("Too many login attempts,
  try again in a few seconds"). It stops bursts before they reach the VM; the auth service's own
  limit (10 a minute per IP) still applies behind it.
- **Zone settings** (Cloudflare, SSL/TLS and Security > Settings): Always Use HTTPS, minimum TLS 1.2,
  TLS 1.3, Automatic HTTPS Rewrites and Browser Integrity Check are on; Browser Cache TTL is "Respect
  Existing Headers" (Caching > Configuration). Web Analytics' automatic setup is on (since 2026-11-26):
  Cloudflare injects the beacon into pages it serves, and the app adds its own only for loads from the
  installed app's cache (docs/SPEC.md 10.3). Check the TLS floor with
  `curl -sSI --tlsv1.1 --tls-max 1.1 https://cubr.dev/`, which must fail with "alert protocol version".
- **Bot Fight Mode stays off.** The free plan can't exempt anything from it, so it may challenge
  Google Cloud's uptime check (`/healthz`), Ko-fi's webhook (`/api/supporters/kofi`) and
  `scripts/smoke.mjs`, none of which can answer a challenge. It also forces Cloudflare's JavaScript
  detections on: an inline script in every page, which the CSP refuses unless its header carries a
  nonce.
- **Down page** (`deploy/cloudflare/down-page/`, docs/SPEC.md 10.2): a Cloudflare Worker shows
  visitors a cubr-styled "back in a moment" instead of Cloudflare's error page while the server is
  down. `deploy.sh up` builds and uploads it and routes `cubr.dev/*` through it (`/api/*`,
  `/socket.io/*`, `/assets/*` and `/healthz` skip it). `deploy.sh status` shows the routes, and
  `deploy.sh down` deletes them, which serves the site as before. The `cubr.dev/*` route's request
  limit failure mode is **Fail open** (set in the dashboard on 2026-11-19: cubr.dev > Workers Routes).
  Past the free plan's 100,000 Worker runs a day, failing closed would show error 1027 instead of the
  site. `deploy.sh status` shows the setting, and `up` leaves routes that are already right alone, so
  a redeploy keeps it.
- **Logs rotate.** Every container logs through `json-file` with at most 3 x 10 MB (`x-logging` in
  `compose.prod.yml`), so the gateway's access log, which holds visitors' IPs, is overwritten as it
  fills up. The privacy policy (`/privacy`) relies on this.
- **Real client IPs.** Cloudflare sends the visitor's address in `CF-Connecting-IP`; the gateway
  (`deploy/gateway/nginx.conf`) uses it only for requests from Docker networks, so the per-IP rate
  limits (login 10/min, sign-up 20/h, race rooms 20/min) count visitors, not the tunnel.
- **Memory.** About 1.3 GB of the 2 GB is in use; `bootstrap.sh` adds 2 GB of swap and the
  override caps each Node heap at 192 MB.
- **Images** are built by `cloudbuild.yaml` on Cloud Build and stored in Artifact Registry
  (`australia-southeast1-docker.pkg.dev/cubr-app/cubr`). The VM pulls with its own service
  account; no registry keys exist.

## Rebuilding the VM from scratch

1. `gcloud compute instances create cubr-1 --configuration=cubr --machine-type=e2-small
   --image-family=debian-13 --image-project=debian-cloud --boot-disk-size=20GB
   --boot-disk-type=pd-balanced --tags=cubr-vm --metadata=enable-oslogin=TRUE
   --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring`
   (the `allow-ssh-from-iap` firewall rule targets the `cubr-vm` tag).
2. `gcloud compute ssh cubr-1 --configuration=cubr --tunnel-through-iap --command 'sudo bash -s -- "$USER"' < deploy/vps/bootstrap.sh`
3. `deploy/vps/deploy.sh init`, then put the tunnel token into `/opt/cubr/.env`
   (`CLOUDFLARE_TUNNEL_TOKEN=`).
4. `deploy/vps/deploy.sh`, then restore the latest database backup and run the WCA import.
